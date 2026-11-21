import {
	closeSync,
	existsSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/*
 * A report on disk is `JSON.stringify(report, null, '\t') + '\n'`. A big one (hundreds of MB) as
 * one string doubles the heap at the end of a run and makes V8 collect garbage hard while it
 * leaves. write_json writes the same bytes piece by piece: the top levels of the value are walked
 * here, and each value below them is stringified on its own and indented to its place
 * (JSON.stringify never puts a raw line break inside a string, so the indent can go after every
 * line break). It writes to a temporary file next to the target and renames it, so a failure
 * (a cycle, a BigInt, a full disk) leaves the old file as it was.
 */

/** Levels walked here; each value below them is one JSON.stringify call. */
const WALKED_LEVELS = 3;
/** Bytes gathered before each write. */
const CHUNK = 1 << 20;

class Sink {
	#fd: number;
	#parts: string[] = [];
	#size = 0;
	constructor(fd: number) {
		this.#fd = fd;
	}
	push(s: string): void {
		this.#parts.push(s);
		this.#size += s.length;
		if (this.#size >= CHUNK) this.flush();
	}
	flush(): void {
		if (this.#parts.length === 0) return;
		const text = this.#parts.join('');
		this.#parts = [];
		this.#size = 0;
		const bytes = Buffer.from(text, 'utf8');
		let at = 0;
		while (at < bytes.length) at += writeSync(this.#fd, bytes, at);
	}
}

/** What JSON.stringify serializes in place of `value` under `key`: `toJSON` applied. */
function to_json(value: unknown, key: string): unknown {
	if ((typeof value === 'object' && value !== null) || typeof value === 'bigint') {
		const f = (value as { toJSON?: unknown }).toJSON;
		if (typeof f === 'function') return f.call(value, key) as unknown;
	}
	return value;
}

/** Values JSON.stringify leaves out of an object (and writes as null in an array). */
function skipped(value: unknown): boolean {
	return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

/** An array or a plain object: walked here. Anything else goes to JSON.stringify whole. */
function walkable(value: unknown): value is Record<string, unknown> | unknown[] {
	if (typeof value !== 'object' || value === null) return false;
	if (Array.isArray(value)) return true;
	const proto = Object.getPrototypeOf(value) as unknown;
	return proto === Object.prototype || proto === null;
}

function emit(value: unknown, indent: string, level: number, out: Sink): void {
	if (level >= WALKED_LEVELS || !walkable(value)) {
		const s = JSON.stringify(value, null, '\t') as string | undefined;
		out.push(s === undefined ? 'undefined' : indent === '' ? s : s.replaceAll('\n', '\n' + indent));
		return;
	}
	const inner = indent + '\t';
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.push('[]');
			return;
		}
		out.push('[');
		for (let i = 0; i < value.length; i++) {
			out.push(i === 0 ? '\n' + inner : ',\n' + inner);
			const v = to_json(value[i], String(i));
			if (skipped(v)) out.push('null');
			else emit(v, inner, level + 1, out);
		}
		out.push('\n' + indent + ']');
		return;
	}
	let first = true;
	for (const key of Object.keys(value)) {
		const v = to_json(value[key], key);
		if (skipped(v)) continue;
		out.push((first ? '{\n' : ',\n') + inner + JSON.stringify(key) + ': ');
		first = false;
		emit(v, inner, level + 1, out);
	}
	out.push(first ? '{}' : '\n' + indent + '}');
}

/**
 * Write `JSON.stringify(value, null, '\t') + '\n'` to `path`, the same bytes, without building
 * the whole text in memory. A regular file is replaced whole or not at all; anything else
 * (`--out /dev/null`) is written in place.
 */
export function write_json(path: string, value: unknown): void {
	const exists = existsSync(path);
	if (exists && !statSync(path).isFile()) {
		const fd = openSync(path, 'w');
		try {
			write_to(fd, value);
		} finally {
			closeSync(fd);
		}
		return;
	}
	// a symlink keeps pointing where it did: the file it names is the one replaced
	const target = exists ? realpathSync(path) : path;
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	try {
		const fd = openSync(temp, 'w');
		try {
			write_to(fd, value);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, target);
	} catch (e) {
		rmSync(temp, { force: true });
		throw e;
	}
}

function write_to(fd: number, value: unknown): void {
	const out = new Sink(fd);
	emit(to_json(value, ''), '', 0, out);
	out.push('\n');
	out.flush();
}
