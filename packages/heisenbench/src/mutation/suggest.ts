import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import type { FunctionResult, MutantResult } from './index.ts';
import type { ModulePlan, PlannedFunction } from './operators.ts';

/*
 * What bench case would catch a missed mutant: a skeleton to start from, with the input it needs.
 *
 *   no case runs it        a new case that calls it, in the bench file of its package, with a
 *                          `scale` when it has a loop (so CI grows it);
 *   quadratic, missed      the cases that run it: which one to give a `scale`, and what that scale
 *                          must grow (the collection the loop walks, and the argument it comes in);
 *                          when growing that case's whole input the generic way caught the mutant,
 *                          it says so;
 *   cache, missed          no case calls it twice with the same input in one run (every run starts
 *                          from fresh module state), so the memo never hits;
 *   alloc, missed          the loop never ran on the case's input.
 */

export interface Suggestion {
	reason: string;
	/** Markdown: a sentence or two and a code block. */
	text: string;
}

function common_dirs(a: string, b: string): number {
	const x = a.split('/');
	const y = b.split('/');
	let n = 0;
	while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
	return n;
}

/** The bench file nearest a module: the most directories in common, then name order. */
function nearest_bench(module: string, benches: readonly string[]): string | null {
	let best: string | null = null;
	let score = -1;
	for (const b of [...benches].sort()) {
		const s = common_dirs(module, b);
		if (s > score) {
			best = b;
			score = s;
		}
	}
	return best;
}

/** How the bench file imports `bench` (its own line), or the package's. */
function bench_import(root: string, file: string | null): string {
	if (file) {
		try {
			const line = readFileSync(posix.join(root, file), 'utf8')
				.split('\n')
				.find((l) => /^import \{[^}]*\bbench\b[^}]*\} from /.test(l));
			if (line) return line;
		} catch {
			/* the default below */
		}
	}
	return "import { bench } from 'heisenbench/bench';";
}

function exported(source: string, name: string): boolean {
	const n = name.replace(/[$]/g, '\\$');
	return (
		new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`).test(source) ||
		new RegExp(`export\\s+(?:const|let|var|class)\\s+${n}\\b`).test(source) ||
		new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(source)
	);
}

/** How a bench file reaches a top-level function: its export, or the hidden `__heisenbench` one. */
function import_line(plan: ModulePlan, name: string, from: string | null): string {
	const spec = from ? posix.relative(dirname(from), plan.module) : plan.module;
	const rel = spec.startsWith('.') ? spec : `./${spec}`;
	return exported(plan.source, name)
		? `import { ${name} } from '${rel}';`
		: `import { __heisenbench } from '${rel}';\nconst { ${name} } = __heisenbench;`;
}

function args_of(f: PlannedFunction): string {
	return f.params.join(', ');
}

/** The argument a collection comes in (`argument 1 (\`routes\`)`), or how else it is reached. */
function source_of(coll: string, f: PlannedFunction): string {
	const head = coll.split(/[.[]/)[0];
	const i = f.params.findIndex((p) => p.replace(/^\.\.\./, '') === head);
	if (i !== -1) return `argument ${i + 1} (\`${f.params[i]}\`)`;
	if (head === 'this') return 'the object it is called on';
	return `\`${head}\`, which it reads from outside`;
}

const name_of = (key: string) => key.slice(key.indexOf(' > ') + 3);
const file_of = (key: string) => key.slice(0, key.indexOf(' > '));

export function suggest(
	fr: FunctionResult,
	plan: ModulePlan,
	f: PlannedFunction,
	benches: readonly string[],
	root = ''
): Suggestion | null {
	const missed = (op: string) =>
		fr.mutants.find(
			(m) => m.operator === op && (m.status === 'missed' || m.status === 'unreached')
		);
	const top = !f.path.includes(' > ');
	const name = f.path;
	if (fr.cases.length === 0) {
		const at = nearest_bench(plan.module, benches);
		const loop = f.loops.find((l) => l.coll !== null) ?? null;
		// a nested function or a method is reached through the top-level binding it lives in
		const outer = top ? name : name.split(' > ')[0];
		const names = f.params.map((p) => p.replace(/^\.\.\./, ''));
		const head = top
			? `bench('${name}: <the input it gets on a real page>', (${names.length > 0 ? `{ ${names.join(', ')} }` : ''}) => ${name}(${args_of(f)}), {`
			: `bench('${outer}: <an input that reaches line ${f.line}>', (ctx) => /* drive ${outer} so it runs ${name.slice(outer.length + 3)} */ undefined, {`;
		const lines = [
			bench_import(root, at),
			import_line(plan, outer, at),
			'',
			head,
			top
				? `\tsetup: () => ({ ${names.map((p) => `${p}: /* ... */ undefined`).join(', ')} })${loop ? ',' : ''}`
				: `\tsetup: () => ({ /* what ${outer} needs */ })${loop ? ',' : ''}`,
			...(loop
				? [
						`\t// grows ${source_of(loop.coll!, f)}, the collection its loop at line ${loop.line} walks`,
						`\tscale: (ctx, k) => ({ ...ctx /* with ${loop.coll} k times longer */ })`
					]
				: []),
			'});'
		];
		return {
			reason: 'no bench case runs it',
			text: [
				`No bench case runs it${at ? `; a case in \`${at}\` would` : ''}${top ? '' : ` (it is \`${name.slice(outer.length + 3)}\` inside \`${outer}\`, at line ${f.line})`}:`,
				'',
				'```ts',
				...lines,
				'```'
			].join('\n')
		};
	}
	const q = missed('quadratic') as MutantResult | undefined;
	if (q && q.noticed_steps === false) {
		return {
			reason: 'its loop never runs',
			text: `The cases that run it (${fr.cases.map((k) => `\`${name_of(k)}\``).join(', ')}) never enter its loop at line ${q.line}: their input never takes that path, so no size of it can show the loop's growth. A case whose input reaches the loop, with a \`scale\` that grows what it walks, would.`
		};
	}
	if (q) {
		const loop =
			f.loops.find((l) => l.line === q.line && l.coll !== null) ??
			f.loops.find((l) => l.coll !== null)!;
		const coll = loop?.coll ?? 'its input';
		const hot = q.generic?.case ?? name_of(fr.cases[0]);
		const generic_caught =
			q.generic && q.generic.base && q.generic.mutant && q.generic.base !== q.generic.mutant;
		const lead =
			fr.scale_cases.length === 0
				? `None of the cases that run it (${fr.cases.map((k) => `\`${name_of(k)}\``).join(', ')}) declares \`scale\`, so CI never grows them; at their one size the extra pass over \`${coll}\` (line ${q.line}) is a constant cost.`
				: `The cases that declare \`scale\` (${fr.scale_cases.map((k) => `\`${name_of(k)}\``).join(', ')}) do not grow \`${coll}\`, the collection the loop at line ${q.line} walks.`;
		const check = q.generic
			? generic_caught
				? ` Growing \`${q.generic.case}\`'s whole input the generic way turns it from ${q.generic.base} to ${q.generic.mutant} with the mutant: a \`scale\` there catches it.`
				: ` Growing \`${q.generic.case}\`'s whole input the generic way keeps it ${q.generic.mutant ?? 'unfitted'}: the scale must grow \`${coll}\` itself.`
			: '';
		return {
			reason:
				fr.scale_cases.length === 0
					? 'no case that runs it declares scale'
					: 'its scale does not grow the loop',
			text: [
				lead + check,
				'',
				'```ts',
				`// ${file_of(fr.cases.find((k) => name_of(k) === hot) ?? fr.cases[0])}`,
				`bench('${hot}', fn, {`,
				'\tsetup,',
				`\t// grow ${source_of(coll, f)} of \`${name}\` k times`,
				`\tscale: (ctx, k) => ({ ...ctx /* ${coll} k times longer */ })`,
				'});',
				'```'
			].join('\n')
		};
	}
	const c = missed('cache');
	if (c) {
		const hot = name_of(fr.cases[0]);
		return {
			reason: 'its memo never hits',
			text: [
				`No case calls it twice with the same input in one run, so its memo (${c.what}) never hits: every run starts from fresh module state.`,
				'',
				'```ts',
				`// ${file_of(fr.cases[0])}`,
				`bench('${hot}: the same input again (memoized)', (ctx) => {`,
				'\tfn(ctx);',
				'\treturn fn(ctx);',
				'}, { setup });',
				'```'
			].join('\n')
		};
	}
	const a = missed('alloc');
	if (a) {
		return {
			reason: 'its loop never runs',
			text: `The cases that run it (${fr.cases.map((k) => `\`${name_of(k)}\``).join(', ')}) never enter the loop at line ${a.line}: give one an input where it iterates.`
		};
	}
	return null;
}
