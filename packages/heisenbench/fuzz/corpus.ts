import { execFile } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseSync } from 'oxc-parser';
import { instrument } from '../src/transform/instrument.ts';
import { compile_svelte, is_ts, module_specifier, strip_types } from '../src/transform/index.ts';
import { load_prices } from '../src/prices.ts';
import type { Failure } from './check.ts';
import { generate } from './gen.ts';
import { component_of } from './maps.ts';

/*
 * Oracle 8 on real code:
 *
 * - every .js/.ts file under the corpus directories (ogygia's packages, and the packages Heisenbench
 *   instruments as dependencies: svelte, devalue, esm-env...) and every .svelte component goes
 *   through the transform without throwing, and what comes out parses;
 * - Svelte's compiler and devalue run instrumented and plain in two processes (real.ts) on the
 *   same work (the corpus's components plus generated ones, random devalue values): the outputs
 *   must be identical.
 */

const run_file = promisify(execFile);
const require = createRequire(import.meta.url);
const REAL = fileURLToPath(new URL('./real.ts', import.meta.url));

/** The packages Heisenbench counts as dependencies, as installed for it. */
function dep_dirs(): string[] {
	const out: string[] = [];
	for (const name of [
		'svelte',
		'devalue',
		'esm-env',
		'magic-string',
		'zimmerframe',
		'acorn',
		'esrap'
	]) {
		try {
			out.push(
				dirname(
					require.resolve(`${name}/package.json`, {
						paths: [require.resolve('svelte/package.json')]
					})
				)
			);
		} catch {
			// not installed here
		}
	}
	return out;
}

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'types')
			continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (/\.(m?js|m?ts|svelte)$/.test(name) && !name.endsWith('.d.ts') && st.size < 2_000_000)
			out.push(p);
	}
}

export interface CorpusResult {
	files: number;
	runs: number;
	failures: Failure[];
}

export async function check_corpus(dirs: string[]): Promise<CorpusResult> {
	const roots = dirs.length > 0 ? dirs.map((d) => resolve(d)) : default_dirs();
	const files: string[] = [];
	for (const d of roots) if (existsSync(d)) walk(d, files);
	const failures: Failure[] = [];
	const p = load_prices();
	const components: Array<{ name: string; source: string }> = [];
	let transformed = 0;
	for (const f of files) {
		const source = readFileSync(f, 'utf8');
		let code = source;
		let map = null;
		try {
			if (f.endsWith('.svelte')) {
				components.push({ name: f, source });
				const c = compile_svelte(source, f, 'server');
				code = c.code;
				map = c.map;
			} else if (is_ts(f)) code = strip_types(source);
		} catch {
			continue; // the compiler or Node's type stripping does not take it: not ours to check
		}
		const lang = f.endsWith('.svelte') ? 'js' : 'js';
		if (parseSync(f, code, { sourceType: 'module', lang }).errors.length > 0) continue;
		transformed++;
		try {
			const r = instrument(code, {
				id: f,
				filename: f.endsWith('.svelte') ? f + '.js' : f,
				input_map: map,
				prices: p.prices,
				prices_hash: p.hash,
				module_specifier: module_specifier(f),
				lang
			});
			const errors = parseSync('out.mjs', r.code, { sourceType: 'module', lang: 'js' }).errors;
			if (errors.length > 0)
				failures.push({
					oracle: 'corpus',
					detail: `${f}: the transform's output does not parse: ${errors[0].message}`
				});
		} catch (e) {
			failures.push({
				oracle: 'corpus',
				detail: `${f}: the transform threw: ${(e as Error).message}`
			});
		}
	}

	// real-world differential runs
	for (let s = 1; s <= 20; s++)
		components.push({
			name: `/fuzz/G${s}.svelte`,
			source: component_of(generate(s, { lang: 'js' }).source, 'js')
		});
	const dir = mkdtempSync(join(tmpdir(), 'heisenbench-corpus-'));
	let runs = 0;
	try {
		const list = join(dir, 'components.json');
		writeFileSync(list, JSON.stringify(components));
		const go = async (mode: 'on' | 'off'): Promise<string[]> => {
			const { stdout } = await run_file(process.execPath, ['--no-warnings', REAL, mode, list], {
				maxBuffer: 1 << 28,
				cwd: dirname(REAL)
			});
			return JSON.parse(stdout) as string[];
		};
		const [plain, counted] = await Promise.all([go('off'), go('on')]);
		runs = plain.length;
		for (let i = 0; i < Math.max(plain.length, counted.length); i++) {
			if (plain[i] !== counted[i]) {
				failures.push({
					oracle: 'corpus',
					detail: `instrumented svelte/devalue differ: ${String(plain[i]).slice(0, 200)} vs ${String(counted[i]).slice(0, 200)}`
				});
				break;
			}
		}
	} catch (e) {
		failures.push({
			oracle: 'corpus',
			detail: `real-world run failed: ${(e as Error).message.slice(0, 1000)}`
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return { files: transformed, runs, failures };
}

/** ogygia's packages when the checkout is next door, and the dependencies Heisenbench instruments. */
function default_dirs(): string[] {
	const here = fileURLToPath(new URL('../../../', import.meta.url));
	const ogygia = [
		join(here, '..', 'sk-islands', 'packages'),
		process.env.OGYGIA_DIR ? join(process.env.OGYGIA_DIR, 'packages') : ''
	];
	return [...ogygia.filter((d) => d && existsSync(d)), ...dep_dirs()];
}
