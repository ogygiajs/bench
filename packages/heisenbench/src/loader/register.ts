import { registerHooks } from 'node:module';
import { LoaderCore } from './core.ts';
import type { LoaderConfig } from './core.ts';
import { register_source_resolve } from './resolve.ts';

export type { LoaderConfig } from './core.ts';

/**
 * Instrument every module loaded from now on, in this thread (`module.registerHooks`). The runner
 * uses this; `hooks.ts` is the same loader for `module.register` / `--import`. These hooks run
 * for `require` as well as `import`, so a CommonJS dependency is counted like an ES module.
 */
export function register_heisenbench(config: LoaderConfig): LoaderCore {
	const core = new LoaderCore(config);
	// first, so the hooks below see `./x.js` already resolved to `./x.ts` (resolve.ts)
	register_source_resolve();
	registerHooks({
		resolve(specifier, context, next) {
			if (core.is_virtual(specifier)) return { url: specifier, shortCircuit: true };
			const r = next(specifier, context);
			core.note_resolved(r.url, context.parentURL, context.conditions);
			const url = core.with_generation(r.url, context.parentURL);
			return url === r.url ? r : { ...r, url };
		},
		load(url, context, next) {
			if (core.is_virtual(url)) {
				return { format: 'module', source: core.virtual_source(url), shortCircuit: true };
			}
			if (!core.should_instrument(url)) {
				if (!core.is_plain_typescript(url)) return next(url, context);
				return { format: 'module', source: core.plain_typescript(url), shortCircuit: true };
			}
			if (core.needs_own_read(url)) {
				const out = core.instrument(url, core.read(url), null);
				return { format: 'module', source: out?.code ?? '', shortCircuit: true };
			}
			const r = next(url, context);
			if (r.source == null) return r;
			const src =
				typeof r.source === 'string'
					? r.source
					: Buffer.from(r.source as Uint8Array).toString('utf8');
			const out = core.instrument(url, src, r.format);
			if (out === null) return r;
			return { format: out.format, source: out.code, shortCircuit: true };
		}
	});
	return core;
}
