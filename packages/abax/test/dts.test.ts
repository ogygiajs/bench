import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { write_private_dts } from '../src/dts.ts';
import { temp_dir, write_files } from './helpers.ts';

const require = createRequire(import.meta.url);

test('the sidecar d.ts types private functions for bench files', () => {
	const ts = require('typescript') as typeof import('typescript');
	const dir = temp_dir('abax-dts-');
	write_files(dir, {
		'src/match.ts': `import type { Route } from './types.ts';
interface Opts {
	deep: boolean;
}
function normalize(path: string, opts: Opts): string {
	return opts.deep ? path.toLowerCase() : path;
}
const WEIGHTS = [1, 2, 3] as const;
let hits = 0;
class Matcher {
	constructor(public routes: Route[]) {}
	first(): Route | undefined {
		hits++;
		return this.routes[0];
	}
}
export function match(routes: Route[], path: string): Route | undefined {
	return new Matcher(routes).first() ?? routes.find((r) => r.path === normalize(path, { deep: true }));
}
`,
		'src/types.ts': `export interface Route {
	path: string;
}
`,
		'bench/match.bench.ts': `import { __abax } from '../src/match.ts';
const a: string = __abax.normalize('/A', { deep: true });
const b: readonly [1, 2, 3] = __abax.WEIGHTS;
const c: number = __abax.hits;
const m = new __abax.Matcher([{ path: '/' }]);
const d: string | undefined = m.first()?.path;
const wrong: number = __abax.normalize('/A', { deep: true });
__abax.normalize('/A', { deep: 'yes' });
export { a, b, c, d, wrong };
`
	});
	const out = join(dir, 'bench', 'abax-private.d.ts');
	write_private_dts({ files: [join(dir, 'src/match.ts')], out });

	const program = ts.createProgram([join(dir, 'bench/match.bench.ts'), out], {
		strict: true,
		noEmit: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		skipLibCheck: false
	});
	const errors = ts.getPreEmitDiagnostics(program).map((d) => {
		const where = d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0;
		return `${d.file ? d.file.fileName.slice(dir.length) : ''}:${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
	});
	assert.equal(errors.length, 2, errors.join('\n'));
	assert.ok(errors[0].startsWith('/bench/match.bench.ts:7 '), errors[0]);
	assert.ok(errors[1].startsWith('/bench/match.bench.ts:8 '), errors[1]);
});
