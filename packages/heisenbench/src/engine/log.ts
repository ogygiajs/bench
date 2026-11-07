/*
 * Reads the V8 log the health child writes (`--log-code --log-ic --log-deopt --log-function-events`)
 * and keeps the events about measured modules.
 *
 * Code objects are known by address range (`code-creation`, moved by `code-move`); an inline-cache
 * event carries the pc it ran at, which falls inside the code object (bytecode or machine code) of
 * the function it belongs to. A function is known by its module and the script offset V8 starts it
 * at (the `line:col` at the end of a code-creation name).
 *
 * Measuring windows are marked by the child: it compiles a function whose body is the string
 * `"heisenbench:open:N"` before a run and `"heisenbench:close:N"` after it, which the log records as script
 * sources, in order with everything else.
 */

/** How a window marker's script source starts; the child writes it, the parser reads past it. */
export const MARKER_PREFIX = '"heisenbench:';

export interface LogModule {
	/** file: URL the module was loaded from. */
	url: string;
	/** The same file as a path (V8 names some scripts by path). */
	path: string;
	/** The exact code V8 ran. */
	code: string;
}

export type TierMarker = 'interpreted' | 'baseline' | 'maglev' | 'turbofan';

export interface LogCode {
	tier: TierMarker;
	osr: boolean;
	window: number;
	address: number;
}

export interface LogFunction {
	module: number;
	/** Script offset V8 starts the function at. */
	offset: number;
	name: string;
	codes: LogCode[];
	/** Something showed the function running inside a measuring window. */
	in_window: boolean;
}

export interface LogIc {
	module: number;
	/** Offset of the function the IC belongs to. */
	fn: number;
	type: string;
	/** Script line and column (1-based). */
	line: number;
	col: number;
	state: string;
	map: string;
	key: string;
	window: number;
}

export interface LogDeopt {
	/** The optimized function the code belonged to. */
	module: number;
	fn: number;
	address: number;
	kind: string;
	reason: string;
	/** Where it happened (may be inside an inlined function), or null outside measured modules. */
	at: { module: number; line: number; col: number } | null;
	window: number;
}

export interface LogFacts {
	functions: Map<string, LogFunction>;
	ics: LogIc[];
	deopts: LogDeopt[];
	/** V8 script id -> module index. */
	scripts: Map<number, number>;
	/** Optimized code (of any function) that inlined measured functions. */
	inlined: Array<{ address: number; tier: TierMarker; fns: string[] }>;
	windows: number;
}

interface CodeEntry {
	start: number;
	size: number;
	/** Function key (`module:offset`) or null for code outside measured modules. */
	fn: string | null;
	tier: TierMarker | null;
}

export function fn_key(module: number, offset: number): string {
	return `${module}:${offset}`;
}

/** Undo V8's log escaping (`\x2C` for commas, `\n`, `\\`, `\uXXXX`). */
export function unescape_field(s: string): string {
	if (s.indexOf('\\') === -1) return s;
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch !== '\\' || i === s.length - 1) {
			out += ch;
			continue;
		}
		const next = s[i + 1];
		if (next === 'x' && i + 3 < s.length) {
			out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
			i += 3;
		} else if (next === 'u') {
			out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
			i += 5;
		} else if (next === 'n') {
			out += '\n';
			i += 1;
		} else {
			out += next;
			i += 1;
		}
	}
	return out;
}

function tier_of(marker: string): { tier: TierMarker; osr: boolean } | null {
	let m = marker;
	let osr = false;
	if (m.startsWith('o')) {
		osr = true;
		m = m.slice(1);
	}
	switch (m[0]) {
		case '~':
			return { tier: 'interpreted', osr };
		case '^':
			return { tier: 'baseline', osr };
		case '+':
			return { tier: 'maglev', osr };
		case '*':
			return { tier: 'turbofan', osr };
		default:
			return null;
	}
}

class Lines {
	starts: number[];
	constructor(code: string) {
		const starts = [0];
		for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
		this.starts = starts;
	}
	/** 1-based line and column to offset. */
	offset(line: number, col: number): number {
		const s = this.starts[line - 1];
		return (s ?? 0) + col - 1;
	}
}

/** `...name url:line:col` -> [prefix, line, col]. */
function split_position(s: string): [string, number, number] | null {
	const c2 = s.lastIndexOf(':');
	if (c2 === -1) return null;
	const c1 = s.lastIndexOf(':', c2 - 1);
	if (c1 === -1) return null;
	const line = Number(s.slice(c1 + 1, c2));
	const col = Number(s.slice(c2 + 1));
	if (!Number.isInteger(line) || !Number.isInteger(col)) return null;
	return [s.slice(0, c1), line, col];
}

class Codes {
	#by_start = new Map<number, CodeEntry>();
	#sorted: CodeEntry[] | null = null;

	add(e: CodeEntry): void {
		this.#by_start.set(e.start, e);
		this.#sorted = null;
	}

	move(from: number, to: number): void {
		const e = this.#by_start.get(from);
		if (!e) return;
		this.#by_start.delete(from);
		this.#by_start.set(to, { ...e, start: to });
		this.#sorted = null;
	}

	get(start: number): CodeEntry | undefined {
		return this.#by_start.get(start);
	}

	find(pc: number): CodeEntry | null {
		if (!this.#sorted)
			this.#sorted = [...this.#by_start.values()].sort((a, b) => a.start - b.start);
		const list = this.#sorted;
		let lo = 0;
		let hi = list.length - 1;
		let hit = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].start <= pc) {
				hit = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (hit === -1) return null;
		const e = list[hit];
		return pc < e.start + e.size ? e : null;
	}
}

export function parse_v8_log(text: string, modules: LogModule[]): LogFacts {
	const lines = modules.map((m) => new Lines(m.code));
	const by_url = new Map<string, number>();
	modules.forEach((m, i) => {
		by_url.set(m.url, i);
		by_url.set(m.path, i);
	});
	/** `name url` -> [module index, function name], or null outside measured modules. */
	const module_of_name = (prefix: string): [number, string] | null => {
		for (let i = 0; i < modules.length; i++) {
			const m = modules[i];
			for (const u of [m.url, m.path]) {
				if (!prefix.endsWith(u)) continue;
				const rest = prefix.length - u.length;
				if (rest === 0) return [i, ''];
				if (prefix[rest - 1] === ' ') return [i, prefix.slice(0, rest - 1)];
			}
		}
		return null;
	};

	const facts: LogFacts = {
		functions: new Map(),
		ics: [],
		deopts: [],
		scripts: new Map(),
		inlined: [],
		windows: 0
	};
	const codes = new Codes();
	/** SharedFunctionInfo address -> measured function key. */
	const sfis = new Map<number, string>();
	let window = -1;

	const fn_at = (module: number, offset: number, name: string): LogFunction => {
		const k = fn_key(module, offset);
		let f = facts.functions.get(k);
		if (!f) {
			f = { module, offset, name, codes: [], in_window: false };
			facts.functions.set(k, f);
		}
		return f;
	};

	let pos = 0;
	while (pos < text.length) {
		let end = text.indexOf('\n', pos);
		if (end === -1) end = text.length;
		const line = text.slice(pos, end);
		pos = end + 1;
		const comma = line.indexOf(',');
		if (comma === -1) continue;
		const head = line.slice(0, comma);

		if (head === 'code-creation') {
			const f = line.split(',');
			const start = parseInt(f[4], 16);
			const size = Number(f[5]);
			const type = f[1];
			let fn: string | null = null;
			let tier: TierMarker | null = null;
			if ((type === 'JS' || type === 'Script') && f.length >= 9) {
				const name = unescape_field(f[6]);
				const sp = split_position(name);
				const t = tier_of(f[8]);
				if (t) tier = t.tier;
				if (sp && t) {
					const named = module_of_name(sp[0]);
					if (named) {
						const mi = named[0];
						const offset = lines[mi].offset(sp[1], sp[2]);
						const lf = fn_at(mi, offset, named[1]);
						lf.codes.push({ tier: t.tier, osr: t.osr, window, address: start });
						if (window >= 0 && t.tier !== 'interpreted') lf.in_window = true;
						fn = fn_key(mi, offset);
						sfis.set(parseInt(f[7], 16), fn);
					}
				}
			}
			codes.add({ start, size, fn, tier });
		} else if (head === 'code-move') {
			const f = line.split(',');
			codes.move(parseInt(f[1], 16), parseInt(f[2], 16));
		} else if (head === 'sfi-move') {
			const f = line.split(',');
			const k = sfis.get(parseInt(f[1], 16));
			if (k !== undefined) sfis.set(parseInt(f[2], 16), k);
		} else if (head === 'code-source-info') {
			const f = line.split(',');
			const inl = f[7] ?? '';
			if (inl.length === 0) continue;
			const address = parseInt(f[1], 16);
			const e = codes.get(address);
			if (!e || (e.tier !== 'maglev' && e.tier !== 'turbofan')) continue;
			const fns: string[] = [];
			for (const part of inl.split('S')) {
				if (part.length === 0) continue;
				const k = sfis.get(parseInt(part, 16));
				if (k !== undefined && k !== e.fn && !fns.includes(k)) fns.push(k);
			}
			if (fns.length > 0) facts.inlined.push({ address, tier: e.tier, fns });
		} else if (head.endsWith('IC')) {
			const f = line.split(',');
			const e = codes.find(parseInt(f[1], 16));
			if (!e || e.fn === null) continue;
			const lf = facts.functions.get(e.fn)!;
			if (window >= 0) lf.in_window = true;
			facts.ics.push({
				module: lf.module,
				fn: lf.offset,
				type: head,
				line: Number(f[3]),
				col: Number(f[4]),
				state: f[6],
				map: f[7],
				key: unescape_field(f[8] ?? ''),
				window
			});
		} else if (head === 'code-deopt') {
			const f = line.split(',');
			const address = parseInt(f[3], 16);
			const e = codes.get(address) ?? codes.find(address);
			const loc = f[7] ?? '';
			let at: LogDeopt['at'] = null;
			if (loc.startsWith('<') && loc.endsWith('>')) {
				const sp = split_position(unescape_field(loc.slice(1, -1)));
				if (sp) {
					const mi = by_url.get(sp[0]);
					if (mi !== undefined) at = { module: mi, line: sp[1], col: sp[2] };
				}
			}
			const owner = e && e.fn !== null ? facts.functions.get(e.fn)! : null;
			if (!owner && !at) continue;
			if (owner && window >= 0) owner.in_window = true;
			facts.deopts.push({
				module: owner ? owner.module : -1,
				fn: owner ? owner.offset : -1,
				address,
				kind: f[6] ?? '',
				reason: unescape_field(f.slice(8).join(',')),
				at,
				window
			});
		} else if (head === 'function') {
			const f = line.split(',');
			if (!f[1].startsWith('first-execution')) continue;
			const mi = facts.scripts.get(Number(f[2]));
			if (mi === undefined) continue;
			const lf = fn_at(mi, Number(f[3]), unescape_field(f[7] ?? ''));
			if (window >= 0) lf.in_window = true;
		} else if (head === 'script-details' || head === 'script-source') {
			const c2 = line.indexOf(',', comma + 1);
			const c3 = line.indexOf(',', c2 + 1);
			const id = Number(line.slice(comma + 1, c2));
			const url = unescape_field(line.slice(c2 + 1, c3 === -1 ? line.length : c3));
			const mi = by_url.get(url);
			if (mi !== undefined) facts.scripts.set(id, mi);
			if (head === 'script-source' && c3 !== -1 && mi === undefined) {
				const src = line.slice(c3 + 1);
				const at = src.indexOf(MARKER_PREFIX);
				if (at !== -1 && src.length - at < 64) {
					const from = at + MARKER_PREFIX.length;
					const end = src.indexOf('"', from);
					const marker = src.slice(from, end === -1 ? src.length : end);
					if (marker.startsWith('open:')) {
						window = Number(marker.slice(5));
						facts.windows = Math.max(facts.windows, window + 1);
					} else if (marker.startsWith('close:')) {
						window = -1;
					}
				}
			}
		}
	}
	return facts;
}
