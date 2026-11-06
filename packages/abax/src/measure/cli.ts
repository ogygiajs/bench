import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { UsageError } from '../usage.ts';
import { relative, resolve, sep } from 'node:path';
import type { Report } from '../report.ts';
import { measure_layers, parse_layers } from './index.ts';
import { run_child } from './spawn.ts';
import type { TimeComparison } from './time.ts';
import { render_time } from './markdown.ts';
import {
	CORPUS_FILES,
	CORPUS_ROOT,
	calibrate_prices,
	calibrate_weights
} from '../calibrate/index.ts';
import { agree_files } from '../calibrate/agree.ts';
import { measure_points, read_points, write_points } from '../calibrate/points.ts';
import { DEFAULT_WEIGHTS_PATH } from '../calibrate/weights.ts';

/*
 * The CLI parts of the plain-build layers and calibration (cli.ts hands these over):
 *
 *   abax run <files> --measure time,bytes,leaks|all     the layers over the counted report
 *   abax time <files> --base dir --pr dir [--repeats 5] [--time-ms 300] [--out time.json] [--md time.md]
 *   abax diff <base.json> <pr.json> --time time.json    adds the time table to the section
 *   abax calibrate prices|weights [...]                  see scripts/calibrate.ts
 */

export const MEASURE_USAGE = `abax run <bench files...> --measure time,bytes,leaks|all
abax time <bench files...> --base dir --pr dir [--repeats 5] [--time-ms 300] [--filter text] [--out time.json] [--md time.md]
abax diff <base.json> <pr.json> --time time.json
abax calibrate prices [--keys a,b] [--sizes 16,64,256] [--out prices.json] [--time-ms 100]
abax calibrate weights [bench files...] [--root dir] [--out weights.json] [--time-ms 150] [--repeats 3]
abax calibrate weights --points a.json,b.json [--out weights.json]     fit points measured before
abax calibrate points [bench files...] [--root dir] [--out points.json] [--time-ms 150] [--repeats 3]
abax calibrate agree <a.json> <b.json> [--tolerance 3] [--shift 5]     two point sets or two price files`;

type Flags = Map<string, string>;

const num = (flags: Flags, k: string): number | undefined =>
	flags.has(k) ? Number(flags.get(k)) : undefined;

/** `abax run --measure ...`: run the layers and write the report again with them. */
export async function measure_run(report: Report, files: string[], flags: Flags): Promise<void> {
	const layers = parse_layers(flags.get('measure'));
	if (layers.length === 0) return;
	await measure_layers(report, {
		root: flags.get('root') ?? process.cwd(),
		files,
		filter: flags.get('filter'),
		layers,
		time: { time_ms: num(flags, 'time-ms') },
		log: (l) => console.log(l)
	});
	writeFileSync(flags.get('out') ?? 'abax-report.json', JSON.stringify(report, null, '\t') + '\n');
}

/** `--time time.json` on `abax diff`: the time table to append, or ''. */
export function time_section(flags: Flags): string {
	const path = flags.get('time');
	if (!path) return '';
	return render_time(JSON.parse(readFileSync(path, 'utf8')) as TimeComparison);
}

export async function measure_command(
	cmd: string,
	positional: string[],
	flags: Flags
): Promise<number | null> {
	if (cmd === 'time') {
		const base = flags.get('base');
		const pr = flags.get('pr');
		if (!base || !pr) throw new UsageError('--base <dir> and --pr <dir> are required');
		const roots = [resolve(base), resolve(pr)];
		const rel = (root: string) =>
			positional.map((f) => relative(root, resolve(root, f)).split(sep).join('/'));
		// The files are named once and read on both trees; the PR's are the ones that must exist.
		for (const f of positional)
			if (!existsSync(resolve(roots[1], f))) throw new UsageError(`no such file in --pr: ${f}`);
		const t = await run_child<TimeComparison>({
			kind: 'time_ab',
			roots,
			files: [rel(roots[0]), rel(roots[1])],
			filter: flags.get('filter') ?? null,
			options: { repeats: num(flags, 'repeats'), time_ms: num(flags, 'time-ms') }
		});
		writeFileSync(flags.get('out') ?? 'abax-time.json', JSON.stringify(t, null, '\t') + '\n');
		const md = render_time(t);
		const md_out = flags.get('md');
		if (md_out) writeFileSync(md_out, md + '\n');
		else console.log(md);
		return t.errors.length > 0 ? 1 : 0;
	}
	if (cmd === 'calibrate') {
		const [what, ...files] = positional;
		const log = (l: string) => console.log(l);
		if (what === 'prices') {
			const r = await calibrate_prices({
				keys: flags.get('keys')?.split(','),
				sizes: flags.get('sizes')?.split(',').map(Number),
				out: flags.get('out'),
				time_ms: num(flags, 'time-ms'),
				log
			});
			log(
				`step = ${r.step_ns.toFixed(3)} ns; prices v${r.version}${r.changed ? ' (written)' : ' (unchanged)'}`
			);
			return 0;
		}
		if (what === 'points') {
			const root = flags.get('root') ?? (files.length > 0 ? process.cwd() : CORPUS_ROOT);
			const set = await measure_points({
				root,
				files: files.length > 0 ? files : CORPUS_FILES,
				filter: flags.get('filter'),
				time_ms: num(flags, 'time-ms'),
				repeats: num(flags, 'repeats'),
				log
			});
			const out = flags.get('out') ?? 'abax-points.json';
			write_points(out, set);
			log(
				`${set.points.length} points (${set.repeats} repeats, load ${set.machine.load}) -> ${out}`
			);
			return 0;
		}
		if (what === 'agree') {
			if (files.length !== 2) throw new UsageError('calibrate agree takes two files');
			const tol = { shape_pct: num(flags, 'tolerance') ?? 3, shift_pct: num(flags, 'shift') ?? 5 };
			const a = agree_files(files[0], files[1], tol);
			for (const line of a.lines) log(line);
			log(
				`${a.pass ? 'agree' : 'DISAGREE'} (allowed: ${tol.shape_pct}% case-to-case, ${tol.shift_pct}% shift)`
			);
			return a.pass ? 0 : 1;
		}
		if (what === 'weights') {
			const sets = flags.get('points')?.split(',').map(read_points);
			const { weights } = await calibrate_weights({
				root: flags.get('root'),
				files: files.length > 0 ? files : undefined,
				out: flags.get('out') ?? DEFAULT_WEIGHTS_PATH,
				time_ms: num(flags, 'time-ms'),
				repeats: num(flags, 'repeats'),
				points: sets?.flatMap((s) => s.points),
				machine: sets?.[0].machine,
				log
			});
			log(`weights v${weights.version}: R^2 ${weights.fit.r2} over ${weights.fit.points} points`);
			return 0;
		}
		throw new UsageError(
			`calibrate takes prices, points, agree or weights, not ${JSON.stringify(what)}`
		);
	}
	return null;
}
