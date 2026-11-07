/** A small seeded generator (sfc32, seeded through splitmix32): the same seed, the same program. */
export class Rng {
	#s = new Uint32Array(4);

	constructor(seed: number) {
		let x = seed >>> 0;
		const next = (): number => {
			x = (x + 0x9e3779b9) >>> 0;
			let z = x;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		for (let i = 0; i < 4; i++) this.#s[i] = next();
		for (let i = 0; i < 12; i++) this.u32();
	}

	u32(): number {
		const s = this.#s;
		const t = (((s[0] + s[1]) >>> 0) + s[3]) >>> 0;
		s[3] = (s[3] + 1) >>> 0;
		s[0] = s[1] ^ (s[1] >>> 9);
		s[1] = (s[2] + (s[2] << 3)) >>> 0;
		s[2] = (s[2] << 21) | (s[2] >>> 11);
		s[2] = (s[2] + t) >>> 0;
		return t;
	}

	/** 0 <= n < max. */
	int(max: number): number {
		return max <= 0 ? 0 : this.u32() % max;
	}

	/** True with probability p. */
	chance(p: number): boolean {
		return this.u32() / 4294967296 < p;
	}

	pick<T>(xs: readonly T[]): T {
		return xs[this.int(xs.length)];
	}

	/** Pick by weight: `[[weight, value], ...]`. */
	weighted<T>(xs: ReadonlyArray<readonly [number, T]>): T {
		let total = 0;
		for (const [w] of xs) total += w;
		let r = (this.u32() / 4294967296) * total;
		for (const [w, v] of xs) {
			if (r < w) return v;
			r -= w;
		}
		return xs[xs.length - 1][1];
	}
}
