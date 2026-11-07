import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register_heisenbench } from '../src/loader/register.ts';
import { show } from './show.ts';
import { Rng } from './rng.ts';

/*
 * Real-world code through the counting build: `node real.ts <on|off> <components.json>`. With `on`,
 * Svelte's compiler and devalue are instrumented (blamed under their package names); with `off`
 * they load as they are. Both runs print the same JSON when the instrumented code does what the
 * plain code does: every component compiled (server and client), and devalue round trips of
 * random values.
 */

const [mode, list] = process.argv.slice(2);
if (mode === 'on') {
	register_heisenbench({
		root: realpathSync(mkdtempSync(join(tmpdir(), 'heisenbench-real-'))),
		deps: ['svelte', 'devalue', 'esm-env', 'zimmerframe', 'acorn', 'magic-string', 'esrap']
	});
}

const svelte = (await import('svelte/compiler')) as {
	compile: (src: string, o: object) => { js: { code: string }; css: { code: string } | null };
};
const devalue = (await import('devalue')) as {
	stringify: (v: unknown) => string;
	parse: (s: string) => unknown;
	uneval: (v: unknown) => string;
};

const out: string[] = [];
const components = JSON.parse(readFileSync(list, 'utf8')) as Array<{
	name: string;
	source: string;
}>;
for (const c of components) {
	for (const generate of ['server', 'client']) {
		try {
			const r = svelte.compile(c.source, { filename: c.name, generate, dev: false });
			out.push(
				`${c.name} ${generate}: ${r.js.code.length} ${hash(r.js.code)} ${r.css ? hash(r.css.code) : ''}`
			);
		} catch (e) {
			out.push(`${c.name} ${generate}: error ${(e as Error).message.split('\n')[0]}`);
		}
	}
}

function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(16);
}

const rng = new Rng(7);
function value(depth: number): unknown {
	const k = rng.int(depth > 2 ? 6 : 11);
	switch (k) {
		case 0:
			return rng.int(1000) - 500;
		case 1:
			return ['', 'a', 'é"', '</script>', 'x'.repeat(rng.int(40))][rng.int(5)];
		case 2:
			return rng.chance(0.5);
		case 3:
			return [null, undefined, NaN, -0, Infinity][rng.int(5)];
		case 4:
			return BigInt(rng.int(1e6));
		case 5:
			return new Date(Date.UTC(2020, rng.int(12), 1 + rng.int(28)));
		case 6:
			return Array.from({ length: rng.int(5) }, () => value(depth + 1));
		case 7: {
			const o: Record<string, unknown> = {};
			for (let i = 0, n = rng.int(5); i < n; i++) o[`k${i}`] = value(depth + 1);
			return o;
		}
		case 8:
			return new Map([[value(depth + 1), value(depth + 1)]]);
		case 9:
			return new Set([value(depth + 1), value(depth + 1)]);
		default: {
			const shared = { s: rng.int(9) };
			return [shared, shared];
		}
	}
}
for (let i = 0; i < 300; i++) {
	const v = value(0);
	try {
		const s = devalue.stringify(v);
		out.push(`devalue ${i}: ${s} ${show(devalue.parse(s))} ${devalue.uneval(v)}`);
	} catch (e) {
		out.push(`devalue ${i}: error ${(e as Error).message}`);
	}
}
process.stdout.write(JSON.stringify(out));
