import { get_runtime } from '../runtime/index.ts';
import { Builtins } from '../runtime/builtins.ts';
import { serialize_snapshot } from './snapshot.ts';
import type { PageCounts } from './snapshot.ts';

/*
 * The runtime of a counted page (client build, see vite.ts): the counting runtime, the priced
 * built-ins installed for the page's life (a wrapper charges only while counted code is on the
 * shadow stack, so the page's other code and the harness pass through), and `globalThis.__heisenbench`,
 * which the harness reads the counts from between phases of a session.
 *
 * The counts are cumulative: the harness takes one reading per phase and subtracts (snapshot.ts),
 * so nothing is reset under a suspended async function.
 */

export { get_runtime };

export const PAGE_GLOBAL = '__heisenbench';

export interface PageApi {
	/** Counts so far; `metas_from`: module metas from that index on (the earlier ones were read). */
	read(metas_from: number): PageCounts;
}

const g = globalThis as unknown as Record<string, PageApi | undefined>;
if (!g[PAGE_GLOBAL]) {
	const rt = get_runtime();
	new Builtins(rt).install();
	g[PAGE_GLOBAL] = {
		read: (metas_from) => serialize_snapshot(rt, rt.snapshot(), metas_from)
	};
}
