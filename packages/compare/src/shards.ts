// A Heisenbench run file in shards. One result.json of two whole reports outgrows what one file
// should be (the publish job's limit, the results branch), so a run is written as a small
// manifest (result.json) and shards named by their content's sha256 (shards/<sha256>.json):
//
//   body          the result with the reports' `cases` and `engine.cases` emptied
//   head.cases    a run of the head report's cases from one bench file (`group`), in order
//   head.engine   the same for the head's engine cases; base.cases and base.engine for the base
//
// A group over the shard size is cut into parts (`part` 0, 1, ...). A bench file whose counts did
// not change writes the same bytes, so its shard keeps its name from run to run and between the
// two sides of a PR: the results branch stores it once.
//
// Reading checks everything against the manifest before it is used: each shard's name is its
// sha256 (nothing else can be a name: no paths), its size and hash are what the manifest says,
// the shards are at most SHARD_LIMITS.count and their sizes add up to at most
// SHARD_LIMITS.total (counted per entry, so one shard listed many times cannot blow up the result).
// A run file without `format` is the single-file layout from before shards, read as it is.
//
// No dependencies but Node's own: the publish job runs this file without an install.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MiB = 1 << 20;

export const SHARDS_FORMAT = 'heisenbench-shards/1';

export const SHARD_LIMITS = {
	/** The manifest itself. */
	manifest: 1 * MiB,
	/** One shard: a group over it is cut into parts. */
	shard: 40 * MiB,
	/** Entries in a manifest. */
	count: 1024,
	/** The sizes of every entry added up: the most a whole result can be. */
	total: 200 * MiB
} as const;

export type ShardLimits = { [K in keyof typeof SHARD_LIMITS]: number };

/** A shard's file name: its content's sha256, nothing else. */
export const SHARD_NAME = /^[0-9a-f]{64}\.json$/;

/** The directory the shards are in, next to the manifest. */
export const SHARDS_DIR = 'shards';

const SIDES = ['head', 'base'] as const;
const OFS = ['body', 'head.cases', 'head.engine', 'base.cases', 'base.engine'] as const;
export type ShardOf = (typeof OFS)[number];

export interface ShardEntry {
	name: string;
	sha256: string;
	bytes: number;
	of: ShardOf;
	/** The bench file the entries came from ('' for the body). */
	group: string;
	/** Which part of the group (0 when it fits one shard). */
	part: number;
}

export interface ShardManifest {
	format: typeof SHARDS_FORMAT;
	/** Copies of the result's own, so a reader can check them without the shards. */
	schema: unknown;
	meta: unknown;
	shards: ShardEntry[];
}

export class ShardError extends Error {}

const fail = (msg: string): never => {
	throw new ShardError(msg);
};

type Obj = Record<string, unknown>;

const is_obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const sha256 = (bytes: Uint8Array | string): string =>
	createHash('sha256').update(bytes).digest('hex');

/** The arrays a result is cut along: [of, the object that holds `cases`]. */
function arrays_of(r: Obj): Array<[ShardOf, Obj]> {
	const out: Array<[ShardOf, Obj]> = [];
	for (const side of SIDES) {
		const rep = r[side];
		if (!is_obj(rep) || !Array.isArray(rep.cases)) continue;
		out.push([`${side}.cases`, rep]);
		if (is_obj(rep.engine) && Array.isArray(rep.engine.cases))
			out.push([`${side}.engine`, rep.engine]);
	}
	return out;
}

export interface Split {
	manifest: ShardManifest;
	/** result.json: the manifest's text. */
	text: string;
	/** Each shard's text by its file name. */
	files: Map<string, string>;
}

/**
 * The result as a manifest and its shards. Throws when one entry (a case) alone is over `max`:
 * it cannot be cut.
 */
export function split_result(result: Obj, max: number = SHARD_LIMITS.shard): Split {
	const files = new Map<string, string>();
	const shards: ShardEntry[] = [];
	const add = (text: string, of: ShardOf, group: string, part: number): void => {
		const bytes = Buffer.byteLength(text);
		if (bytes > max) fail(`${of} ${group || ''} is ${bytes} bytes, over the ${max} byte shard`);
		const hash = sha256(text);
		const name = `${hash}.json`;
		files.set(name, text);
		shards.push({ name, sha256: hash, bytes, of, group, part });
	};

	const body: Obj = { ...result };
	const cut: Array<[ShardOf, unknown[]]> = [];
	for (const side of SIDES) {
		const rep = result[side];
		if (!is_obj(rep) || !Array.isArray(rep.cases)) continue;
		const copy: Obj = { ...rep, cases: [] };
		cut.push([`${side}.cases`, rep.cases]);
		if (is_obj(rep.engine) && Array.isArray(rep.engine.cases)) {
			copy.engine = { ...rep.engine, cases: [] };
			cut.push([`${side}.engine`, rep.engine.cases]);
		}
		body[side] = copy;
	}
	add(JSON.stringify(body), 'body', '', 0);

	for (const [of, items] of cut) {
		// consecutive entries of one bench file make a group; a group is cut where it reaches max
		let group: string | null = null;
		let part = 0;
		let open: string[] = [];
		let size = 2;
		const flush = (): void => {
			if (open.length) add(`[${open.join(',')}]`, of, group!, part++);
			open = [];
			size = 2;
		};
		for (const item of items) {
			const file = is_obj(item) && typeof item.file === 'string' ? item.file : '';
			if (file !== group) {
				flush();
				group = file;
				part = 0;
			}
			const text = JSON.stringify(item);
			const grown = size + Buffer.byteLength(text) + (open.length ? 1 : 0);
			if (open.length && grown > max) flush();
			size += Buffer.byteLength(text) + (open.length ? 1 : 0);
			open.push(text);
		}
		flush();
	}

	const manifest: ShardManifest = {
		format: SHARDS_FORMAT,
		schema: result.schema,
		meta: result.meta,
		shards
	};
	return { manifest, text: JSON.stringify(manifest) + '\n', files };
}

/** Whether parsed JSON is a manifest (else it is a run file from before shards). */
export function is_manifest(v: unknown): boolean {
	return is_obj(v) && 'format' in v;
}

/** The manifest, checked: its format, every entry, the count and the total. */
export function check_manifest(v: unknown, limits: ShardLimits = SHARD_LIMITS): ShardManifest {
	if (!is_obj(v)) return fail('the manifest is not a JSON object');
	if (v.format !== SHARDS_FORMAT) fail(`unknown run file format ${JSON.stringify(v.format)}`);
	if (!Array.isArray(v.shards)) fail('the manifest has no shard list');
	const list = v.shards as unknown[];
	if (list.length > limits.count)
		fail(`the manifest lists ${list.length} shards, over the ${limits.count} limit`);
	let total = 0;
	list.forEach((e, i) => {
		if (!is_obj(e)) return fail(`shard ${i} is not an object`);
		const { name, sha256: hash, bytes, of, group, part } = e;
		if (typeof name !== 'string' || !SHARD_NAME.test(name))
			fail(`shard ${i} has a name that is not a sha256: ${JSON.stringify(name)}`);
		if (name !== `${String(hash)}.json`) fail(`shard ${i}: ${name} is not named by its sha256`);
		if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) fail(`shard ${i} has no byte size`);
		if ((bytes as number) > limits.shard)
			fail(`shard ${name} is ${String(bytes)} bytes, over the ${limits.shard} byte limit`);
		if (!(OFS as readonly unknown[]).includes(of)) fail(`shard ${i} is of ${JSON.stringify(of)}`);
		if ((of === 'body') !== (i === 0)) fail('the body must be the first shard, and the only one');
		if (typeof group !== 'string' || !Number.isSafeInteger(part) || (part as number) < 0)
			fail(`shard ${i} has no group or part`);
		total += bytes as number;
	});
	if (list.length === 0) fail('the manifest lists no shards');
	if (total > limits.total)
		fail(`the shards add up to ${total} bytes, over the ${limits.total} byte limit`);
	return v as unknown as ShardManifest;
}

/**
 * Reads a shard's bytes: `max` is the size the manifest gives it, and a reader refuses more (it
 * should check before it reads everything, as the artifact's reader does).
 */
export type ShardReader = (name: string, max: number) => Uint8Array;

export interface Joined {
	result: Obj;
	/** The unique shards' bytes by name, as read and checked. */
	files: Map<string, Uint8Array>;
}

/** The result a checked manifest describes: every shard read once, checked, and put in place. */
export function join_shards(
	manifest: ShardManifest,
	read: ShardReader,
	limits: ShardLimits = SHARD_LIMITS
): Joined {
	const m = check_manifest(manifest, limits);
	const files = new Map<string, Uint8Array>();
	const texts = new Map<string, string>();
	const text_of = (e: ShardEntry): string => {
		const known = texts.get(e.name);
		if (known !== undefined) return known;
		const bytes = read(e.name, e.bytes);
		if (bytes.length !== e.bytes)
			fail(`shard ${e.name} is ${bytes.length} bytes, the manifest says ${e.bytes}`);
		if (sha256(bytes) !== e.sha256) fail(`shard ${e.name} does not hash to its name`);
		let text: string;
		try {
			text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			return fail(`shard ${e.name} is not UTF-8`);
		}
		files.set(e.name, bytes);
		texts.set(e.name, text);
		return text;
	};
	const parse = (e: ShardEntry): unknown => {
		const text = text_of(e);
		try {
			return JSON.parse(text);
		} catch {
			return fail(`shard ${e.name} is not JSON`);
		}
	};

	const [first, ...rest] = m.shards;
	const result = parse(first);
	if (!is_obj(result)) return fail('the body shard is not a JSON object');
	if (JSON.stringify(result.schema) !== JSON.stringify(m.schema))
		fail('the body shard has another schema than the manifest');
	if (JSON.stringify(result.meta) !== JSON.stringify(m.meta))
		fail('the body shard has other meta than the manifest');
	const holders = new Map(arrays_of(result));
	for (const [of, holder] of holders)
		if ((holder.cases as unknown[]).length !== 0) fail(`the body holds ${of} itself`);
	for (const e of rest) {
		const holder = holders.get(e.of);
		if (!holder) fail(`shard ${e.name} is of ${e.of}, which the body does not have`);
		const items = parse(e);
		if (!Array.isArray(items)) fail(`shard ${e.name} is not a JSON array`);
		(holder!.cases as unknown[]).push(...(items as unknown[]));
	}
	return { result, files };
}

/** A reader of the shards in `dir`: regular files only, at most the manifest's size. */
export function dir_reader(dir: string): ShardReader {
	return (name, max) => {
		if (!SHARD_NAME.test(name)) fail(`not a shard name: ${name}`);
		const path = join(dir, name);
		let st;
		try {
			st = lstatSync(path);
		} catch {
			return fail(`shard ${name} is missing`);
		}
		if (!st.isFile()) fail(`shard ${name} is not a regular file`);
		if (st.size > max) fail(`shard ${name} is ${st.size} bytes, the manifest says ${max}`);
		return readFileSync(path);
	};
}

/**
 * A run file's result from its text: a manifest is joined with `read`, a run file from before
 * shards is the parsed JSON as it is. Text that is not JSON throws JSON.parse's SyntaxError; a
 * manifest that does not check out throws a ShardError.
 */
export function load_result(text: string, read: ShardReader): Obj {
	const v: unknown = JSON.parse(text);
	if (!is_manifest(v)) return v as Obj;
	if (Buffer.byteLength(text) > SHARD_LIMITS.manifest)
		fail(`the manifest is over ${SHARD_LIMITS.manifest} bytes`);
	return join_shards(v as ShardManifest, read).result;
}

/**
 * Where the shards of the run file at `path` are: `shards/` next to it (an artifact, the checked
 * copy), else next to its directory (the results branch: heisenbench/pr/<n>.json and
 * heisenbench/shards/).
 */
export function shards_dir_of(path: string): string {
	const here = join(dirname(path), SHARDS_DIR);
	if (existsSync(here) && statSync(here).isDirectory()) return here;
	return join(dirname(dirname(path)), SHARDS_DIR);
}

/** The result of the run file at `path`, either layout. */
export function load_result_file(path: string): Obj {
	return load_result(readFileSync(path, 'utf8'), dir_reader(shards_dir_of(path)));
}
