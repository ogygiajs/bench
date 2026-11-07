/*
 * The reproduction an upstream report carries: one TypeScript file a maintainer runs with plain
 * Node on each version of their package, and the bench file Heisenbench counts the same calls
 * with. Both are built from the same pieces, so what the report counts is what the script times.
 */

export interface ReproSpec {
	/** The package and its two versions. */
	name: string;
	from: string;
	to: string;
	/**
	 * What one call is: the package's export (`specifier` and `export_name`) called with the
	 * arguments `input(n)` returns, or, when `specifier` is null, the input's own `call(...args)`.
	 */
	specifier: string | null;
	export_name: string;
	/** Source that defines `function input(n: number): unknown[]` (and `call` with no specifier). */
	input: string;
	sizes: number[];
	/** Other packages the input imports, at the version installed with each side (`npm i`). */
	extra: Array<{ name: string; version: string }>;
	/** The function whose work changed, and its file in the package, for the comment at the top. */
	function: string;
	file: string;
}

/** The input's import lines first (ESM hoists them anyway), then the rest of it. */
function split_imports(src: string): { imports: string[]; rest: string } {
	const imports: string[] = [];
	const rest: string[] = [];
	const lines = src.trim().split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!/^import[\s{*'"]/.test(lines[i])) {
			rest.push(lines[i]);
			continue;
		}
		// one import, over as many lines as it takes to reach its specifier
		const parts = [lines[i]];
		while (!/['"]\s*(?:with\s*\{[^}]*\}\s*)?;?\s*$/.test(parts.at(-1)!) && i + 1 < lines.length)
			parts.push(lines[++i]);
		imports.push(parts.join('\n'));
	}
	return { imports, rest: rest.join('\n').trim() };
}

export function install_line(s: ReproSpec, version: string): string {
	return `npm i ${[`${s.name}@${version}`, ...s.extra.map((e) => `${e.name}@${e.version}`)].join(' ')}`;
}

/** The standalone script. `probe`: each size in a try, failures printed (to find the sizes that run). */
export function repro_script(s: ReproSpec, probe = false): string {
	const call = `await ${s.export_name}(...args)`;
	const body = [
		'\tconst args = input(n);',
		`\tfor (let i = 0; i < 3; i++) ${call};`,
		'\tconst times: number[] = [];',
		'\tconst end = performance.now() + TIME_MS;',
		'\twhile (times.length < 5 || performance.now() < end) {',
		'\t\tconst t0 = performance.now();',
		`\t\t${call};`,
		'\t\ttimes.push(performance.now() - t0);',
		'\t}',
		'\ttimes.sort((a, b) => a - b);',
		'\tconst median = times[times.length >> 1];',
		`\tconsole.log(\`${s.name} \${version}  n=\${n}  median \${median.toPrecision(4)} ms  (\${times.length} runs)\`);`
	];
	const loop = probe
		? [
				'for (const n of SIZES) {',
				'\ttry {',
				...body.map((l) => '\t' + l),
				'\t} catch (e) {',
				'\t\tconsole.log(`n=${n} failed: ${String((e as Error)?.message ?? e).split("\\n")[0]}`);',
				'\t}',
				'}'
			]
		: ['for (const n of SIZES) {', ...body, '}'];
	const { imports, rest } = split_imports(s.input);
	const what = s.specifier ? `\`${s.export_name}\`` : '`call`';
	return [
		`// Does \`${s.function}\` (${s.file}) do more work in ${s.name} ${s.to} than in ${s.from}?`,
		'//',
		`//   ${install_line(s, s.from)} && node repro.ts`,
		`//   ${install_line(s, s.to)} && node repro.ts`,
		'//',
		`// Node 22.18 or newer runs this file as it is. \`input(n)\` builds the arguments of one call to`,
		`// ${what}; each size is timed for about a second after a warm-up, and the median is printed.`,
		"import * as fs from 'node:fs';",
		"import * as path from 'node:path';",
		"import * as url from 'node:url';",
		...(s.specifier ? [`import { ${s.export_name} } from '${s.specifier}';`] : []),
		...imports,
		'',
		rest,
		'',
		'function installed_version(): string {',
		`\tlet dir = path.dirname(url.fileURLToPath(import.meta.resolve('${s.specifier ?? s.name}')));`,
		'\tfor (;;) {',
		'\t\ttry {',
		"\t\t\tconst pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));",
		`\t\t\tif (pkg.name === '${s.name}') return pkg.version;`,
		'\t\t} catch {}',
		'\t\tconst up = path.dirname(dir);',
		"\t\tif (up === dir) return 'unknown';",
		'\t\tdir = up;',
		'\t}',
		'}',
		'',
		`const SIZES = [${s.sizes.join(', ')}];`,
		'const TIME_MS = Number(process.env.REPRO_TIME_MS ?? 1000);',
		'const version = installed_version();',
		...loop,
		''
	].join('\n');
}

/** A bench file that counts the same calls (`heisenbench run count.bench.ts`). */
export function count_bench(s: ReproSpec, bench_url: string): string {
	const { imports, rest } = split_imports(s.input);
	return [
		`import { bench } from ${JSON.stringify(bench_url)};`,
		...(s.specifier ? [`import { ${s.export_name} } from '${s.specifier}';`] : []),
		...imports,
		'',
		rest,
		'',
		`for (const n of [${s.sizes.join(', ')}]) {`,
		`\tbench(\`n=\${n}\`, async ({ args }) => {`,
		`\t\tawait ${s.export_name}(...args);`,
		'\t}, { setup: () => ({ args: input(n) }) });',
		'}',
		''
	].join('\n');
}
