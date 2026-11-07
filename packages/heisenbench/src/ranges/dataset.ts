import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { input_steps } from './features.ts';
import type { EngineSide, RangeInput } from './features.ts';
import type { TrainChange } from './model.ts';

/*
 * The training data (calibration/data/training.md) as observations of the range model: every
 * timed pair gives two, its base side and its PR side, each one call of some code with its counts
 * and its measured time (the median over the rounds of each round's p50, the time the PR comment
 * shows).
 *
 * Groups keep a held-out evaluation honest:
 *
 *   change  the same change is never on both sides: a commit of ogygia's history is one group;
 *           a planted change is one group with all its sizes and its undo (`extra-loop` and
 *           `undo-extra-loop` of one template)
 *   code    stricter, the same code is never on both sides: a bench file of the history is one
 *           group over all its commits; a planted template is one group
 *
 * Version 1 was timed on a busy machine (load average 7 to 20 on 16 cores), version 2 on a quiet
 * one (2 to 4 on 4 cores, mostly the timing's own processes). Each observation carries its
 * group's mean load; training weighs a row by `LOAD_REFERENCE / load`, so the quieter groups
 * count more (on version 2 too: weighed alike, the held-out log error went from 0.046 to 0.053),
 * and the same code timed many times (an unchanged case at every commit) counts once in all
 * (`weight` below). A model trains on one version: the two machines' clocks differ.
 */

export const COUNTS_SCHEMA = 'heisenbench-training-counts/1';
export const TIMES_SCHEMA = 'heisenbench-training-times/1';

interface TrainingSide {
	steps: number;
	allocations: number;
	bytes: number;
	calls: number;
	steps_by_kind: Record<string, number>;
	builtin_calls: Record<string, number>;
	input_size: number | null;
}

interface CountsRow {
	id: string;
	source: 'planted' | 'history';
	file: string;
	name: string;
	template?: string;
	variant?: string;
	size?: number;
	commit?: string;
	base: TrainingSide;
	pr: TrainingSide;
	engine: { base: EngineSide; pr: EngineSide } | null;
}

interface TimesRow {
	id: string;
	group: string;
	base: Array<Array<number | null>>;
	pr: Array<Array<number | null>>;
	label: string;
}

interface TimesFile {
	schema: string;
	machine: { node: string };
	sample_fields: string[];
	groups: Array<{ id: string; load: { mean: number } }>;
	rows: TimesRow[];
}

export interface Observation {
	/** `<pair id> @base` or `@pr`. */
	id: string;
	pair: string;
	side: 'base' | 'pr';
	source: 'planted' | 'history';
	input: RangeInput;
	/** Measured ns per call. */
	ns: number;
	/** The timing run's mean 1-minute load average. */
	load: number;
	/** Held-out groups (see above). */
	change: string;
	code: string;
	/** The same counts of the same case: one fingerprint. */
	fingerprint: string;
	/** The pair's time verdict under the noise rule (`slower`, `faster`, `same`). */
	label: string;
}

export interface Dataset {
	version: number;
	node: string;
	observations: Observation[];
}

/** The load the weights are relative to: a row timed at this load weighs 1. */
export const LOAD_REFERENCE = 10;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** The planted change a variant belongs to: its undo is the same change the other way. */
function planted_change(template: string, variant: string): string {
	return `planted/${template}/${variant.replace(/^undo-/, '')}`;
}

export function load_dataset(dir: string, version: number): Dataset {
	const counts = JSON.parse(readFileSync(join(dir, `training-counts-${version}.json`), 'utf8')) as {
		schema: string;
		rows: CountsRow[];
	};
	const times = JSON.parse(
		readFileSync(join(dir, `training-times-${version}.json`), 'utf8')
	) as TimesFile;
	if (counts.schema !== COUNTS_SCHEMA || times.schema !== TIMES_SCHEMA)
		throw new Error(`heisenbench: training data ${version} has an unknown schema`);
	const p50 = times.sample_fields.indexOf('p50_ns');
	const load = new Map(times.groups.map((g) => [g.id, g.load.mean]));
	const by_id = new Map(counts.rows.map((r) => [r.id, r]));
	const observations: Observation[] = [];
	for (const t of [...times.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		const c = by_id.get(t.id);
		if (!c) continue;
		const change =
			c.source === 'planted'
				? planted_change(c.template ?? '', c.variant ?? '')
				: `history/${c.commit ?? ''}`;
		const code = c.source === 'planted' ? `planted/${c.template ?? ''}` : `history/${c.file}`;
		for (const side of ['base', 'pr'] as const) {
			const s = c[side];
			const ns = median(
				t[side].map((x) => x[p50]).filter((v): v is number => typeof v === 'number' && v > 0)
			);
			if (!(ns > 0)) continue;
			observations.push({
				id: `${t.id} @${side}`,
				pair: t.id,
				side,
				source: c.source,
				input: {
					steps_by_kind: s.steps_by_kind,
					builtin_calls: s.builtin_calls,
					allocations: s.allocations,
					bytes: s.bytes,
					calls: s.calls,
					input_size: s.input_size,
					engine: c.engine?.[side] ?? null,
					node: times.machine.node
				},
				ns,
				load: load.get(t.group) ?? LOAD_REFERENCE,
				change,
				code,
				// planted variants of one template share their base program
				fingerprint:
					c.source === 'planted'
						? `planted/${c.template ?? ''} > ${s.steps}`
						: `${c.file} > ${c.name} > ${s.steps}`,
				label: t.label
			});
		}
	}
	return { version, node: times.machine.node, observations };
}

/**
 * The pairs whose time moved beyond noise, as changes: steps PR minus base, the side with more
 * steps as the code the change lives in, and the measured change. `group` names its held-out group.
 */
export function changes_of(
	obs: readonly Observation[],
	group: (o: Observation) => string
): Array<TrainChange & { id: string }> {
	const by = new Map<string, Observation[]>();
	for (const o of obs) by.set(o.pair, [...(by.get(o.pair) ?? []), o]);
	const out: Array<TrainChange & { id: string }> = [];
	for (const [pair, sides] of by) {
		const base = sides.find((o) => o.side === 'base');
		const pr = sides.find((o) => o.side === 'pr');
		if (!base || !pr || base.label === 'same') continue;
		const b = input_steps(base.input);
		const p = input_steps(pr.input);
		if (b === p) continue;
		out.push({
			id: pair,
			delta_steps: p - b,
			context: p >= b ? pr.input : base.input,
			measured: pr.ns - base.ns,
			group: group(pr)
		});
	}
	return out;
}

/** Training weight of each observation: quieter groups more, repeats of one code once in all. */
export function weights_of(obs: readonly Observation[]): number[] {
	const n = new Map<string, number>();
	for (const o of obs) n.set(o.fingerprint, (n.get(o.fingerprint) ?? 0) + 1);
	return obs.map((o) => LOAD_REFERENCE / Math.max(o.load, 1) / n.get(o.fingerprint)!);
}
