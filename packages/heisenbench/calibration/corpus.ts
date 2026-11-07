/*
 * The default steps -> ns calibration corpus: small functions, each leaning on a few op kinds, so
 * the fit can tell the kinds apart. Real calibration adds ogygia's own bench files (scripts/
 * calibrate.ts takes any bench files); every case there named `<family> @<size>` is one point of
 * a family, and the fit quality (R^2) is reported per family.
 */

export function reference(n: number): number {
	// the step reference: plain reads, arithmetic, compares, no built-ins
	const xs = { a: 1, b: 2, c: 3 };
	let s = 0;
	for (let i = 0; i < n; i++) {
		s = s + xs.a * i - xs.b;
		if (s > 1000000) s = s - xs.c;
	}
	return s;
}

export function fib(n: number): number {
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

class Point {
	x: number;
	y: number;
	constructor(x: number, y: number) {
		this.x = x;
		this.y = y;
	}
	len(): number {
		return this.x * this.x + this.y * this.y;
	}
}

export function points(n: number): number {
	let s = 0;
	for (let i = 0; i < n; i++) s += new Point(i, i + 1).len();
	return s;
}

export function objects(n: number): number {
	const out: Array<{ id: number; name: string; tags: number[] }> = [];
	for (let i = 0; i < n; i++) out.push({ id: i, name: 'n', tags: [i, i + 1] });
	return out.length;
}

export function writes(n: number): number {
	const o: Record<string, number> = { a: 0, b: 0, c: 0 };
	for (let i = 0; i < n; i++) {
		o.a = i;
		o.b = o.a + 1;
		o.c = o.b * 2;
	}
	return o.c;
}

export function strings(n: number): number {
	let s = '';
	for (let i = 0; i < n; i++) s += `<li id="${i}">${i % 7 === 0 ? 'x' : 'y'}</li>`;
	return s.length;
}

export function iterate(xs: number[]): number {
	let s = 0;
	for (const x of xs) s += x;
	return s;
}

export function keys(o: Record<string, number>): number {
	let s = 0;
	for (const k in o) s += o[k];
	return s;
}

export function logic(xs: Array<{ a?: number; b?: { c?: number } }>): number {
	let s = 0;
	for (let i = 0; i < xs.length; i++) {
		const x = xs[i];
		s += (x.a ?? 1) + (x.b?.c ?? 2) + (x.a && x.b ? 3 : 4);
	}
	return s;
}

export function closures(n: number): number {
	const fs: Array<() => number> = [];
	for (let i = 0; i < n; i++) fs.push(() => i * 2);
	let s = 0;
	for (const f of fs) s += f();
	return s;
}

export function sorting(xs: number[]): number {
	return xs.toSorted((a, b) => a - b).slice(0, 3).length;
}

export function mapping(xs: number[]): string {
	return xs
		.map((x) => x * 2)
		.filter((x) => x % 3 !== 0)
		.join(',');
}

export function json(xs: number[]): number {
	return JSON.parse(JSON.stringify({ xs })).xs.length;
}

export function maps(n: number): number {
	const m = new Map<number, number>();
	for (let i = 0; i < n; i++) m.set(i, i * 2);
	let s = 0;
	for (let i = 0; i < n; i++) if (m.has(i)) s += m.get(i)!;
	return s;
}

export function* gen(n: number): Generator<number> {
	for (let i = 0; i < n; i++) yield i;
}

export function generators(n: number): number {
	let s = 0;
	for (const x of gen(n)) s += x;
	return s;
}

export function throws(n: number): number {
	let s = 0;
	for (let i = 0; i < n; i++) {
		try {
			if (i % 2 === 0) throw new Error('x');
			s++;
		} catch {
			s += 2;
		}
	}
	return s;
}

export function spreads(xs: number[]): number {
	const o = { a: 1, b: 2, c: 3 };
	let s = 0;
	for (let i = 0; i < xs.length; i++) {
		const p = { ...o, d: xs[i] };
		s += [...xs.slice(0, 4), p.d].length;
	}
	return s;
}
