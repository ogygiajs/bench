// Garbage collection of a results tree: the run files under a root (heisenbench/ on the results
// branch) and the shards they share (shards.ts, <root>/shards/).
//
//   scan      every .json file under the root (but shards/) is a run file: a manifest is checked
//             with every shard it lists (there, its size, its sha256); any other JSON file (a run
//             file from before shards, a weights file) is a run file that lists no shard. A file
//             that is not JSON, a manifest that does not check out, a shard it lists that is
//             missing or changed, or a file in shards/ that is not named by a sha256 is an error.
//   plan      the run files a retention policy drops (given as input: this module has no policy),
//             then every shard no kept run file lists. Refused when the scan had any error: a
//             run file that cannot be read may list shards, so nothing is swept around it.
//   apply     deletes the dropped run files first, then the shards.
//
// A shard a kept run file lists is never deleted, whatever the input says: only run files are
// named by the policy, and shards are only swept when unlisted.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SHARDS_DIR, SHARD_NAME, ShardError, check_manifest, is_manifest } from './shards.ts';

export class GcError extends Error {}

export interface RunFile {
	/** Relative to the root, with `/`. */
	path: string;
	bytes: number;
	/** A manifest of shards (false: a whole file). */
	sharded: boolean;
	/** The file's `meta` (a manifest's copy), when it has one. */
	meta: Record<string, unknown> | null;
	/** The shards it lists, each once. */
	shards: string[];
}

export interface Scan {
	root: string;
	files: RunFile[];
	/** Every shard in shards/, by name, with its size. */
	shards: Map<string, number>;
	/** What could not be read; a plan is refused while there is any. */
	errors: string[];
}

const sha256_file = (path: string): string =>
	createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every run file under `root` and every shard in `root/shards`, each checked. */
export function scan_results(root: string): Scan {
	const files: RunFile[] = [];
	const errors: string[] = [];
	const shards = new Map<string, number>();
	const shards_dir = join(root, SHARDS_DIR);
	let names: string[] = [];
	try {
		names = readdirSync(shards_dir);
	} catch {
		// no shards yet
	}
	for (const name of names.sort()) {
		const st = lstatSync(join(shards_dir, name));
		if (!SHARD_NAME.test(name) || !st.isFile()) errors.push(`${SHARDS_DIR}/${name}: not a shard`);
		else shards.set(name, st.size);
	}
	// each shard is hashed once, however many manifests list it
	const hashed = new Map<string, string>();
	const check_shard = (name: string, bytes: number, hash: string): string | null => {
		const size = shards.get(name);
		if (size === undefined) return `${SHARDS_DIR}/${name} is missing`;
		if (size !== bytes) return `${SHARDS_DIR}/${name} is ${size} bytes, the manifest says ${bytes}`;
		let got = hashed.get(name);
		if (got === undefined) hashed.set(name, (got = sha256_file(join(shards_dir, name))));
		return got === hash ? null : `${SHARDS_DIR}/${name} does not hash to its name`;
	};

	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			const st = lstatSync(p);
			if (st.isDirectory()) {
				if (p !== shards_dir) walk(p);
				continue;
			}
			if (!name.endsWith('.json')) continue;
			const path = relative(root, p).split(sep).join('/');
			if (!st.isFile()) {
				errors.push(`${path}: not a regular file`);
				continue;
			}
			let v: unknown;
			try {
				v = JSON.parse(readFileSync(p, 'utf8'));
			} catch {
				errors.push(`${path}: not JSON`);
				continue;
			}
			const o =
				v !== null && typeof v === 'object' && !Array.isArray(v)
					? (v as Record<string, unknown>)
					: {};
			const meta =
				o.meta !== null && typeof o.meta === 'object' && !Array.isArray(o.meta)
					? (o.meta as Record<string, unknown>)
					: null;
			if (!is_manifest(v)) {
				files.push({ path, bytes: st.size, sharded: false, meta, shards: [] });
				continue;
			}
			let listed: string[];
			try {
				const m = check_manifest(v);
				const seen = new Map(m.shards.map((e) => [e.name, e]));
				listed = [...seen.keys()];
				const bad = [...seen.values()]
					.map((e) => check_shard(e.name, e.bytes, e.sha256))
					.filter((x) => x !== null);
				if (bad.length) {
					errors.push(...bad.map((b) => `${path}: ${b}`));
					continue;
				}
			} catch (e) {
				if (!(e instanceof ShardError)) throw e;
				errors.push(`${path}: ${e.message}`);
				continue;
			}
			files.push({ path, bytes: st.size, sharded: true, meta, shards: listed });
		}
	};
	walk(root);
	return { root, files, shards, errors };
}

/** A run file the retention policy drops, and why. */
export interface Drop {
	path: string;
	why: string;
}

export interface GcPlan {
	drop_files: Array<Drop & { bytes: number }>;
	drop_shards: Array<{ name: string; bytes: number }>;
	kept_files: number;
	kept_shards: number;
	bytes_freed: number;
}

/**
 * What a sweep removes: the run files `drops` names, then every shard no kept run file lists.
 * Throws a GcError when the scan had errors, or a drop names no run file of the scan.
 */
export function plan_gc(scan: Scan, drops: Drop[]): GcPlan {
	if (scan.errors.length)
		throw new GcError(
			`${scan.errors.length} problems in the results tree; nothing is deleted:\n${scan.errors.map((e) => `  ${e}`).join('\n')}`
		);
	const by_path = new Map(scan.files.map((f) => [f.path, f]));
	const dropping = new Map<string, Drop & { bytes: number }>();
	for (const d of drops) {
		const f = by_path.get(d.path);
		if (!f)
			throw new GcError(`the policy drops ${JSON.stringify(d.path)}, which is not a run file`);
		dropping.set(d.path, { path: d.path, why: d.why, bytes: f.bytes });
	}
	const marked = new Set<string>();
	for (const f of scan.files) if (!dropping.has(f.path)) for (const s of f.shards) marked.add(s);
	const drop_shards = [...scan.shards]
		.filter(([name]) => !marked.has(name))
		.map(([name, bytes]) => ({ name, bytes }));
	const drop_files = [...dropping.values()];
	const bytes_freed =
		drop_files.reduce((n, f) => n + f.bytes, 0) + drop_shards.reduce((n, s) => n + s.bytes, 0);
	return {
		drop_files,
		drop_shards,
		kept_files: scan.files.length - drop_files.length,
		kept_shards: scan.shards.size - drop_shards.length,
		bytes_freed
	};
}

/** Deletes what the plan says: the run files first, then the shards. */
export function apply_gc(root: string, plan: GcPlan): void {
	for (const f of plan.drop_files) rmSync(join(root, ...f.path.split('/')));
	for (const s of plan.drop_shards) {
		if (!SHARD_NAME.test(s.name)) throw new GcError(`not a shard name: ${s.name}`);
		rmSync(join(root, SHARDS_DIR, s.name));
	}
}

/** Reads a policy's output: `{ "drop": [{ "path": "...", "why": "..." }] }`. */
export function parse_drops(text: string): Drop[] {
	const v = JSON.parse(text) as { drop?: unknown };
	if (!Array.isArray(v?.drop)) throw new GcError('the policy file has no "drop" list');
	return v.drop.map((d, i) => {
		const o = d as Partial<Drop>;
		if (typeof o?.path !== 'string' || typeof o.why !== 'string')
			throw new GcError(`drop ${i} needs a path and a why`);
		return { path: o.path, why: o.why };
	});
}

const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

/** The plan in a few lines (and every file it drops). */
export function render_gc(plan: GcPlan, dry_run: boolean): string {
	const lines = [
		`${dry_run ? 'would delete' : 'deleted'}: ${plan.drop_files.length} run files and ${plan.drop_shards.length} shards, ${mb(plan.bytes_freed)}`,
		`kept: ${plan.kept_files} run files and ${plan.kept_shards} shards`
	];
	for (const f of plan.drop_files) lines.push(`  - ${f.path} (${mb(f.bytes)}): ${f.why}`);
	if (plan.drop_shards.length)
		lines.push(
			`  - ${plan.drop_shards.length} shards no kept run file lists (${mb(plan.drop_shards.reduce((n, s) => n + s.bytes, 0))})`
		);
	return lines.join('\n');
}
