import { bench } from 'heisenbench/bench';
import { transform } from 'heisenbench/transform';

/*
 * The receipt bench of Heisenbench's own releases (docs/receipts.md): the counting transform, the
 * code every counted module goes through, on generated modules. It imports only the package's
 * public entry points, so it counts any released version the same way.
 */

function module_of(functions: number): string {
	const out: string[] = [];
	for (let i = 0; i < functions; i++) {
		out.push(
			`export function f${i}(x, ys) {`,
			`\tif (x > ${i}) return x * 2;`,
			`\tfor (const y of ys) x += y;`,
			`\treturn x;`,
			`}`
		);
	}
	return out.join('\n');
}

const SWITCH = [
	'export function kind(token) {',
	'\tswitch (token.type) {',
	"\t\tcase 'open': return token.depth + 1;",
	"\t\tcase 'close': return token.depth - 1;",
	'\t\tdefault: {',
	'\t\t\tlet n = 0;',
	'\t\t\twhile (n < token.depth) n++;',
	'\t\t\treturn n;',
	'\t\t}',
	'\t}',
	'}'
].join('\n');

bench(
	'transform: a module of 20 functions',
	({ code }) => transform(code, { filename: '/project/src/m.js', root: '/project' }),
	{
		setup: () => ({ code: module_of(20) }),
		scale: (_ctx, factor) => ({ code: module_of(20 * factor) })
	}
);

bench(
	'transform: a switch and a loop',
	({ code }) => transform(code, { filename: '/project/src/kind.js', root: '/project' }),
	{ setup: () => ({ code: SWITCH }) }
);
