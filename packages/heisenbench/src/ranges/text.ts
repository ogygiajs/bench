/*
 * How a range reads next to the exact steps: `1.2 ms, likely 0.9 to 1.6`. Both ends are in the
 * estimate's unit, so the three numbers compare at a glance. A change is signed:
 * `+1.2 ms, likely +0.3 to +4.8`.
 */

/** A time estimate with its 10-90% range, in ns. */
export interface RangeValue {
	ns: number;
	range: [number, number];
}

const UNITS: Array<[number, string]> = [
	[1e6, 'ms'],
	[1e3, 'µs'],
	[1, 'ns']
];

function unit_of(ns: number): [number, string] {
	const a = Math.abs(ns);
	for (const u of UNITS) if (a >= u[0]) return u;
	return UNITS[UNITS.length - 1];
}

/** Two significant digits, whole numbers from 10 up (`5,043`). */
function num(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 10) return Math.round(a).toLocaleString('en-US');
	return String(Number(a.toPrecision(2)));
}

function signed_num(v: number, signed: boolean): string {
	const s = v < 0 ? '−' : signed && v > 0 ? '+' : '';
	return s + num(v);
}

/** `1.2 ms, likely 0.9 to 1.6`; `signed` for a change. */
export function range_text(r: RangeValue, signed = false): string {
	const [div, unit] = unit_of(r.ns);
	const [lo, hi] = r.range;
	return `${signed_num(r.ns / div, signed)} ${unit}, likely ${signed_num(lo / div, signed)} to ${signed_num(hi / div, signed)}`;
}

/** Rounded the way reports keep it: four significant digits. */
export function round_range(r: RangeValue): RangeValue {
	const sig = (v: number) => (v === 0 || !Number.isFinite(v) ? v : Number(v.toPrecision(4)));
	return { ns: sig(r.ns), range: [sig(r.range[0]), sig(r.range[1])] };
}
