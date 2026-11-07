import { readFileSync } from 'node:fs';
import {
	compile_svelte,
	is_svelte_module,
	is_ts,
	module_id,
	transform,
	ts_to_js
} from '../transform/index.ts';
import { load_prices } from '../prices.ts';
import type { Report } from '../report.ts';
import { cell, code } from '../md.ts';
import type { FunctionRecord, ReplayResult } from './recorder.ts';

/*
 * Which functions of a source tree have a measurement source (spec 8), and the CI gate on it.
 *
 * A function is measured when
 *
 *   bench      a bench case ran it (the counted report has calls for it), or
 *   recorded   the test suite ran it with the input recorder on (record-transform.ts) and its
 *              recorded inputs replay to the same output (recorder.ts `replay`): those inputs are a
 *              measurement source of their own.
 *
 * Everything else is unmeasured, with the reason: `tests only` (the tests ran it, but its inputs do
 * not stand alone: hidden state, not cloneable, not replayable, async or a generator) or `never ran`.
 *
 * The gate fails on NEW unmeasured functions only: those the PR's tree has and the base's does not
 * (by identity, `module > path`), unless an exemption names them with a reason. Functions that were
 * already unmeasured on the base are listed, not failed, so the gate is adoptable on a codebase
 * with unmeasured code today.
 */

export interface SourceFunction {
	id: string;
	module: string;
	path: string;
	line: number;
	end_line: number;
}

export interface SourceInventory {
	functions: SourceFunction[];
	/** Files the transform could not read (listed, never silently dropped). */
	errors: Array<{ file: string; error: string }>;
}

/** Every function of `files` (absolute), as the counting transform names them for `root`. */
export function source_inventory(root: string, files: readonly string[]): SourceInventory {
	const prices = load_prices();
	const functions: SourceFunction[] = [];
	const errors: SourceInventory['errors'] = [];
	for (const file of files) {
		try {
			const source = readFileSync(file, 'utf8');
			let code = source;
			let input_map = null;
			if (is_svelte_module(file)) {
				const out = compile_svelte(source, file, 'server');
				code = out.code;
				input_map = out.map;
			} else if (is_ts(file)) {
				const out = ts_to_js(source, file);
				code = out.code;
				input_map = out.map;
			}
			const id = module_id(file, root);
			const r = transform(code, { filename: file, id, input_map, prices, expose: false });
			for (const f of r.meta.functions) {
				if (f.kind !== 'function') continue;
				functions.push({
					id: `${id} > ${f.path}`,
					module: id,
					path: f.path,
					line: f.line,
					end_line: f.end_line
				});
			}
		} catch (e) {
			errors.push({ file: module_id(file, root), error: (e as Error).message.split('\n')[0] });
		}
	}
	functions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { functions, errors };
}

/** Function ids a counted report ran (calls > 0 in any case). */
export function bench_reached(reports: readonly Report[]): Set<string> {
	const out = new Set<string>();
	for (const r of reports) {
		for (const c of r.cases) {
			if (c.error) continue;
			for (const f of c.functions) if (f.calls > 0) out.add(f.id);
		}
	}
	return out;
}

/** `module -> [paths]` of the functions no bench reached: what the recorder should wrap. */
export function record_targets(
	inv: SourceInventory,
	reached: ReadonlySet<string>
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const f of inv.functions) if (!reached.has(f.id)) (out[f.module] ??= []).push(f.path);
	return out;
}

export type UnmeasuredReason =
	| 'never ran'
	| 'hidden state'
	| 'not cloneable'
	| 'not replayable'
	| 'not recorded';

export interface MeasuredFunction extends SourceFunction {
	/** `bench`, `recorded`, or both. */
	sources: Array<'bench' | 'recorded'>;
	/** Why it has no source (null when measured). */
	reason: UnmeasuredReason | null;
	/** Calls seen while the tests ran with the recorder on. */
	test_calls: number;
}

/**
 * Each function of the inventory with its measurement sources. `records` and `replays` come from a
 * test run with the recorder on (absent: only benches count). A function the recorder skipped
 * (async, a generator, destructured arrow parameters) and that no bench ran is `not recorded`.
 */
export function measurement_sources(
	inv: SourceInventory,
	reached: ReadonlySet<string>,
	records: readonly FunctionRecord[] = [],
	replays: readonly ReplayResult[] = [],
	/** Ids the recording transform left alone (async, generators, ...). */
	skipped: ReadonlySet<string> = new Set()
): MeasuredFunction[] {
	const rec = new Map(records.map((r) => [r.id, r]));
	const rep = new Map(replays.map((r) => [r.id, r]));
	return inv.functions.map((f) => {
		const sources: MeasuredFunction['sources'] = [];
		if (reached.has(f.id)) sources.push('bench');
		const r = rec.get(f.id);
		const p = rep.get(f.id);
		if (p?.status === 'reproduced') sources.push('recorded');
		let reason: UnmeasuredReason | null = null;
		if (sources.length === 0) {
			if (!r) reason = skipped.has(f.id) ? 'not recorded' : 'never ran';
			else if (r.calls === 0) reason = 'never ran';
			else if (p?.status === 'hidden state') reason = 'hidden state';
			else if (p?.status === 'not cloneable' || (r.samples.length === 0 && r.uncloneable > 0))
				reason = 'not cloneable';
			else reason = 'not replayable';
		}
		return { ...f, sources, reason, test_calls: r?.calls ?? 0 };
	});
}

export interface Exemption {
	id: string;
	reason: string;
	/**
	 * An exemption covers the function and every function nested in it (its closures and
	 * callbacks, `total > reduce:0`). `false`: only the function itself.
	 */
	nested?: boolean;
}

export function read_exemptions(path: string): Exemption[] {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as { exempt?: Exemption[] } | Exemption[];
	const list = Array.isArray(raw) ? raw : (raw.exempt ?? []);
	for (const e of list) {
		if (typeof e.id !== 'string' || typeof e.reason !== 'string' || e.reason.trim() === '')
			throw new Error(
				`heisenbench: every exemption needs an id and a reason (${JSON.stringify(e)})`
			);
		if (e.nested !== undefined && typeof e.nested !== 'boolean')
			throw new Error(
				`heisenbench: an exemption's "nested" is true or false (${JSON.stringify(e)})`
			);
	}
	return list;
}

/** The exemption that covers `id`: its own, else the closest enclosing one that covers nested. */
function exemption_for(id: string, exempt: ReadonlyMap<string, Exemption>): Exemption | undefined {
	const own = exempt.get(id);
	if (own) return own;
	let at = id.lastIndexOf(' > ');
	while (at !== -1) {
		const outer = exempt.get(id.slice(0, at));
		// `module > fn`: the module part is never an exemption on its own
		if (outer && outer.nested !== false) return outer;
		at = id.lastIndexOf(' > ', at - 1);
	}
	return undefined;
}

export interface GateOptions {
	/** Base module -> PR module for files the PR moved or renamed (git rename detection). */
	renames?: ReadonlyMap<string, string>;
	/** Files of the PR's tree the transform could not read and the base could (they fail the gate). */
	unreadable?: ReadonlyArray<{ file: string; error: string }>;
}

export interface GateResult {
	functions: number;
	measured: number;
	/** Unmeasured, new on this tree (not on the base), not exempt: these fail the gate. */
	new_unmeasured: MeasuredFunction[];
	/** Unmeasured on the base already: listed, not failed. */
	old_unmeasured: MeasuredFunction[];
	exempted: Array<MeasuredFunction & { exemption: string }>;
	/** Exemptions that name no unmeasured function any more (measured now, or gone). */
	stale_exemptions: Exemption[];
	/** New files nothing could read: their functions are unknown, so the gate cannot pass. */
	unreadable: Array<{ file: string; error: string }>;
	pass: boolean;
}

export function gate(
	head: readonly MeasuredFunction[],
	base_ids: ReadonlySet<string> | null,
	exemptions: readonly Exemption[] = [],
	o: GateOptions = {}
): GateResult {
	const exempt = new Map(exemptions.map((e) => [e.id, e]));
	const used = new Set<string>();
	// A function in a moved file was on the base under its old module.
	const moved_from = new Map<string, string>();
	for (const [from, to] of o.renames ?? []) moved_from.set(to, from);
	const on_base = (f: MeasuredFunction): boolean => {
		if (base_ids === null || base_ids.has(f.id)) return true;
		const from = moved_from.get(f.module);
		return from !== undefined && base_ids.has(`${from} > ${f.path}`);
	};
	const out: GateResult = {
		functions: head.length,
		measured: 0,
		new_unmeasured: [],
		old_unmeasured: [],
		exempted: [],
		stale_exemptions: [],
		unreadable: [...(o.unreadable ?? [])],
		pass: true
	};
	for (const f of head) {
		if (f.reason === null) {
			out.measured++;
			continue;
		}
		const e = exemption_for(f.id, exempt);
		if (e !== undefined) {
			used.add(e.id);
			out.exempted.push({ ...f, exemption: e.reason });
		} else if (on_base(f)) out.old_unmeasured.push(f);
		else out.new_unmeasured.push(f);
	}
	out.stale_exemptions = exemptions.filter((e) => !used.has(e.id));
	out.pass = out.new_unmeasured.length === 0 && out.unreadable.length === 0;
	return out;
}

const loc = (f: SourceFunction) => `${code(`${f.module}:${f.line}`)} ${code(f.path)}`;

export function render_gate(g: GateResult, o: { top?: number } = {}): string {
	const top = o.top ?? 30;
	const pct = g.functions === 0 ? 0 : Math.round((g.measured / g.functions) * 1000) / 10;
	const by_reason = new Map<string, number>();
	for (const f of [...g.new_unmeasured, ...g.old_unmeasured])
		by_reason.set(f.reason!, (by_reason.get(f.reason!) ?? 0) + 1);
	const out = [
		'### Heisenbench: functions with no measurement source',
		'',
		`${g.measured} of ${g.functions} functions measured (${pct}%): a bench ran them, or the tests ran them with inputs that replay.`,
		''
	];
	if (by_reason.size > 0) {
		out.push(
			`Unmeasured: ${[...by_reason].map(([r, n]) => `${n} ${r}`).join(', ')}; ${g.exempted.length} exempt.`,
			''
		);
	}
	if (g.new_unmeasured.length > 0) {
		out.push(
			`**${g.new_unmeasured.length} new function${g.new_unmeasured.length === 1 ? '' : 's'} with no measurement source.** Add a bench case that runs it, a test that calls it with inputs that replay, or an exemption with a reason (internal/heisenbench/unmeasured.json):`,
			'',
			'| Function | Why | Tests ran it |',
			'| --- | --- | ---: |'
		);
		for (const f of g.new_unmeasured) out.push(`| ${loc(f)} | ${f.reason} | ${f.test_calls} |`);
		out.push('');
	} else {
		out.push('No new function without a measurement source.', '');
	}
	if (g.unreadable.length > 0) {
		out.push(
			`**${g.unreadable.length} new file${g.unreadable.length === 1 ? '' : 's'} Heisenbench could not read**, so their functions are unknown:`,
			''
		);
		for (const u of g.unreadable) out.push(`- ${code(u.file)}: ${cell(u.error)}`);
		out.push('');
	}
	if (g.stale_exemptions.length > 0) {
		out.push('Exemptions that no longer apply (measured now, or gone):', '');
		for (const e of g.stale_exemptions) out.push(`- \`${e.id}\``);
		out.push('');
	}
	if (g.old_unmeasured.length > 0) {
		const biggest = [...g.old_unmeasured]
			.sort((a, b) => b.end_line - b.line - (a.end_line - a.line) || (a.id < b.id ? -1 : 1))
			.slice(0, top);
		out.push(
			`<details><summary>${g.old_unmeasured.length} unmeasured on the base already (largest ${biggest.length})</summary>`,
			'',
			'| Function | Lines | Why |',
			'| --- | ---: | --- |'
		);
		for (const f of biggest) out.push(`| ${loc(f)} | ${f.end_line - f.line + 1} | ${f.reason} |`);
		out.push('', '</details>', '');
	}
	return out.join('\n');
}
