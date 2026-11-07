/**
 * The input size of every case of some bench files, on the plain build:
 *
 *   node sizes-child.ts <root> <out.json> <bench files...>
 *
 * A case's input is what its setup returns; its size is the growth layer's measure (strings,
 * elements, entries and keys, recursively; `input_size` in packages/heisenbench/src/growth/
 * scale.ts). Writes `{ "<file> > <name>": size }`, null for a case whose setup threw. A bench file
 * that fails to load has no entries. Run in its own process: the plain loader is process wide.
 */
import { writeFileSync } from 'node:fs';
import { register_plain } from '../../../packages/heisenbench/src/measure/plain.ts';
import { load_cases } from '../../../packages/heisenbench/src/measure/cases.ts';
import { SIZE_BUDGET, input_size } from '../../../packages/heisenbench/src/growth/scale.ts';

const [root, out, ...files] = process.argv.slice(2);
register_plain({ roots: [root] });
const sizes: Record<string, number | null> = {};
for (const file of files) {
	let list;
	try {
		list = await load_cases(root, [file]);
	} catch {
		continue;
	}
	for (const c of list) {
		try {
			const ctx = c.setup ? await c.setup() : undefined;
			sizes[`${c.file} > ${c.name}`] =
				ctx === undefined ? 0 : input_size(ctx, new Set(), SIZE_BUDGET);
			if (c.teardown) await c.teardown(ctx);
		} catch {
			sizes[`${c.file} > ${c.name}`] = null;
		}
	}
}
writeFileSync(out, JSON.stringify(sizes));
// a timer or socket a bench module left open must not keep the child alive
process.exit(0);
