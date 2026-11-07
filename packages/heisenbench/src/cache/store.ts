import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { IoEntry, ModuleEntry } from './key.ts';
import { sha256 } from './normalize.ts';

/*
 * The cache on disk: content-addressed, so any number of trees, commits and runs can share one
 * directory, and a CI cache can restore an older one and add to it.
 *
 *   v1/values/<k2>/<key>.json.gz          a case's report section under its key (Value)
 *   v1/files/<hash of path>/<keys>.json.gz  a run of one bench file (the newest few are kept):
 *                                          each case's manifest, what its key is computed from
 *                                          (FileEntry)
 *
 * A value is never changed in place: one key always names the same counts. A run that uses a
 * value touches its file, so `prune` keeps what is in use.
 */

const VERSION = 'v1';
/** Runs of a bench file kept: a PR's head and base, and a few older commits. */
export const ENTRIES_PER_FILE = 6;

export interface CaseManifest {
	name: string;
	key: string;
	/** A short hash of each part every key of the run shares (key.ts), to say which one changed. */
	global: Record<string, string>;
	modules: ModuleEntry[];
	io: IoEntry[];
}

export interface FileEntry {
	at: string;
	cases: CaseManifest[];
}

export interface Value<T = unknown> {
	key: string;
	/** The case's section of the layer's report (a `CaseReport` for counts, a `GrowthCase`...). */
	report: T;
	/**
	 * Per module id of the project, where each line the report names starts in the normalized
	 * text (rebase.ts), and the bytes it was counted on.
	 */
	lines: Record<string, { raw: string; at: Record<string, number | null> }>;
}

function write_atomic(path: string, data: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

function read_gz<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T;
	} catch {
		return null;
	}
}

function touch(path: string): void {
	try {
		const now = new Date();
		utimesSync(path, now, now);
	} catch {
		// a read-only cache still serves
	}
}

export class CacheStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = join(dir, VERSION);
	}

	#value_path(key: string): string {
		return join(this.dir, 'values', key.slice(0, 2), `${key}.json.gz`);
	}

	#file_dir(file: string): string {
		return join(this.dir, 'files', sha256(file).slice(0, 32));
	}

	has_value(key: string): boolean {
		return existsSync(this.#value_path(key));
	}

	get_value<T>(key: string): Value<T> | null {
		const p = this.#value_path(key);
		const v = read_gz<Value<T>>(p);
		if (v === null || v.key !== key) return null;
		touch(p);
		return v;
	}

	put_value<T>(v: Value<T>): void {
		write_atomic(this.#value_path(v.key), gzipSync(JSON.stringify(v)));
	}

	delete_value(key: string): void {
		rmSync(this.#value_path(key), { force: true });
	}

	/** The runs of `file`, newest first. */
	entries(file: string): FileEntry[] {
		const dir = this.#file_dir(file);
		if (!existsSync(dir)) return [];
		const out: Array<{ at: number; e: FileEntry }> = [];
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.json.gz')) continue;
			const p = join(dir, name);
			const got = read_gz<{ file: string; entry: FileEntry }>(p);
			if (got === null || got.file !== file) continue;
			out.push({ at: Date.parse(got.entry.at) || 0, e: got.entry });
		}
		return out.sort((a, b) => b.at - a.at).map((x) => x.e);
	}

	/**
	 * A run of `file`, one file per set of keys (two trees counted side by side never overwrite
	 * each other's entry); the oldest past ENTRIES_PER_FILE go.
	 */
	put_entry(file: string, entry: FileEntry): void {
		const dir = this.#file_dir(file);
		const name = `${sha256(entry.cases.map((c) => c.key).join('\0')).slice(0, 32)}.json.gz`;
		write_atomic(join(dir, name), gzipSync(JSON.stringify({ file, entry })));
		const all = readdirSync(dir)
			.filter((n) => n.endsWith('.json.gz'))
			.map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		for (const old of all.slice(ENTRIES_PER_FILE)) rmSync(join(dir, old.n), { force: true });
	}
}

export interface PruneResult {
	removed: number;
	kept: number;
	bytes: number;
}

/** Drop what no run used in `max_age_days`: the cache a CI job saves stays bounded. */
export function prune_cache(dir: string, max_age_days: number, now = Date.now()): PruneResult {
	const out: PruneResult = { removed: 0, kept: 0, bytes: 0 };
	const root = join(dir, VERSION);
	if (!existsSync(root)) return out;
	const limit = now - max_age_days * 86_400_000;
	const visit = (d: string): void => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) visit(p);
			else if (st.mtimeMs < limit || name.endsWith('.tmp')) {
				rmSync(p, { force: true });
				out.removed++;
			} else {
				out.kept++;
				out.bytes += st.size;
			}
		}
	};
	visit(root);
	return out;
}
