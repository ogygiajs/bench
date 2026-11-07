import { createRequire } from 'node:module';
import type { SourceMapInput } from '@jridgewell/trace-mapping';
import { parseSync } from 'oxc-parser';
import { instrument } from '../src/transform/instrument.ts';
import { compile_svelte } from '../src/transform/index.ts';
import { load_prices } from '../src/prices.ts';
import type { Program } from './gen.ts';
import type { Failure } from './check.ts';

/*
 * Oracle 7, lines through a compiler: a TS program transpiled by TypeScript (it prints the code
 * again, so offsets move), and the same code as the script of a Svelte component compiled by
 * Svelte. Each block's reported line must be a line of the source that holds the block's code:
 * the first token of the code the block starts at, in the compiled output.
 *
 * Blocks in code the compiler made up (Svelte's own helpers) have no source line (0), or a line
 * near the code they serve: they are counted, not checked.
 */

const require = createRequire(import.meta.url);

interface Ts {
	transpileModule(
		source: string,
		o: { compilerOptions: Record<string, unknown>; fileName?: string }
	): { outputText: string; sourceMapText?: string };
	ScriptTarget: { ESNext: number };
	ModuleKind: { ESNext: number };
}

let ts: Ts | null = null;

function typescript(): Ts {
	ts ??= require('typescript') as Ts;
	return ts;
}

/** The first token of `code` at `at`: a word, `?.`, or one character. */
function token_at(code: string, at: number): string {
	let i = at;
	while (i < code.length && (code[i] === ' ' || code[i] === '\t' || code[i] === '(')) i++;
	if (code.startsWith('?.', i)) return '?.';
	let j = i;
	while (j < code.length && /[\w$#]/.test(code[j])) j++;
	return j > i ? code.slice(i, j) : code.slice(i, i + 1);
}

/**
 * `tok` as a whole token of `text` (`$` in `$state` is not the token `$`; `if` in `{#if}` is the
 * token `if`, the compiled `if` of that block).
 */
function has_token(text: string, tok: string): boolean {
	const word = /[\w$]/;
	for (let at = text.indexOf(tok); at !== -1; at = text.indexOf(tok, at + 1)) {
		const before = at > 0 ? text[at - 1] : ' ';
		const after = at + tok.length < text.length ? text[at + tok.length] : ' ';
		if (tok === '?.' || (!word.test(before) && !word.test(after))) return true;
	}
	return false;
}

interface Checked {
	failures: Failure[];
	blocks: number;
	/** Compiler outputs that were not valid JS (counted, not checked). */
	compiler_errors: number;
}

function check_blocks(
	what: string,
	compiled: string,
	map: SourceMapInput,
	filename: string,
	source: string,
	out: Checked
): void {
	const p = load_prices();
	// A compiler can print code that is not valid JS (TypeScript drops the parentheses of
	// `(-x) ** y`; Svelte's own TS stripping leaves some casts): not the transform's to take.
	if (parseSync('out.mjs', compiled, { sourceType: 'module', lang: 'js' }).errors.length > 0) {
		out.compiler_errors++;
		return;
	}
	const r = instrument(compiled, {
		id: filename,
		filename,
		input_map: map,
		prices: p.prices,
		prices_hash: p.hash,
		module_specifier: 'heisenbench:fuzz',
		lang: 'js'
	});
	const lines = source.split('\n');
	for (let b = 0; b < r.meta.blocks.length; b++) {
		const blk = r.meta.blocks[b];
		const o = r.origins[b];
		const tok = token_at(compiled, o.start);
		// code the compiler made up: nothing in the source to point at; a body's `{` is checked
		// through the blocks inside it
		if (blk.line === 0 || !/^([\w$#]+|\?\.)$/.test(tok) || !has_token(source, tok)) continue;
		out.blocks++;
		const line = lines[blk.line - 1] ?? '';
		if (!has_token(line, tok)) {
			out.failures.push({
				oracle: 'maps',
				detail: `${what}: block ${b} (${o.kind}) starts with \`${tok}\` but points at line ${blk.line}: ${line.trim().slice(0, 120)}`
			});
			return;
		}
	}
}

/** The generated program as a component: its code in the script, its values in the markup. */
export function component_of(source: string, lang: 'js' | 'ts'): string {
	// a component has no exports of its own
	const script = source
		.replace('export async function main', 'async function main')
		.replace(/^export default .*$/m, '');
	return `<script${lang === 'ts' ? ' lang="ts"' : ''}>
${script}
let count = $state(0);
</script>

{#if fuel > 0}
	<p>{g0} {count}</p>
{:else if depth > 2}
	<span>{depth}</span>
{:else}
	<b>none</b>
{/if}
{#each [1, 2, 3] as x, i (x)}
	<i>{x + i}</i>
{/each}
<button onclick={() => (count += 1, main(() => {}))}>go</button>
`;
}

export function check_maps(prog: Program): Checked {
	const out: Checked = { failures: [], blocks: 0, compiler_errors: 0 };
	if (prog.lang === 'ts') {
		const t = typescript();
		const r = t.transpileModule(prog.source, {
			fileName: 'p.ts',
			compilerOptions: {
				target: t.ScriptTarget.ESNext,
				module: t.ModuleKind.ESNext,
				sourceMap: true,
				useDefineForClassFields: true
			}
		});
		const map = JSON.parse(r.sourceMapText!) as SourceMapInput;
		check_blocks('typescript', r.outputText, map, 'p.ts', prog.source, out);
	}
	const component = component_of(prog.source, prog.lang);
	for (const generate of ['server', 'client'] as const) {
		let c: { code: string; map: SourceMapInput };
		try {
			c = compile_svelte(component, '/fuzz/P.svelte', generate);
		} catch (e) {
			// syntax Svelte's parser does not take yet (`using`): not the transform's to check
			if ((e as { code?: string }).code === 'js_parse_error') break;
			throw e;
		}
		check_blocks(`svelte ${generate}`, c.code, c.map, '/fuzz/P.svelte', component, out);
	}
	return out;
}
