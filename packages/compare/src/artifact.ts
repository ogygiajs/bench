// Reading a measure job's artifact in the publish job. The measure job runs code from the PR
// (installs, builds, bench files), so everything it uploads is untrusted data: only files with
// names fixed here are read, each must be a regular file under its size limit, JSON must parse
// and say what the plan said (kind, commit, PR), and nothing in it is ever run or used as a path.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	SHARDS_DIR,
	SHARD_LIMITS,
	SHARD_NAME,
	ShardError,
	check_manifest,
	is_manifest,
	join_shards
} from './shards.ts';

const MiB = 1 << 20;

/** The largest file of each kind the publish job takes. */
export const LIMITS = {
	/**
	 * A Heisenbench result.json from before shards: two merged reports and the diff. A manifest is
	 * held to shards.ts's SHARD_LIMITS (its own size, each shard, the count and the total).
	 */
	result: 50 * MiB,
	/** The app benchmark's run.json. */
	run: 20 * MiB,
	/** Real-app weights. */
	weights: 20 * MiB,
	/** A comment section (the comment itself is capped at 65,536 characters). */
	markdown: 1 * MiB
} as const;

const SECTION_MARKERS = ['<!-- section:', '<!-- /section:'];
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class ArtifactError extends Error {}

const fail = (msg: string): never => {
	throw new ArtifactError(msg);
};

/**
 * The bytes of `name` in `dir`: a fixed name or a shard's sha256 name (no directories), a regular
 * file (not a link), at most `max` bytes. Null when it is not there and `optional`.
 */
export function read_bytes(
	dir: string,
	name: string,
	max: number,
	optional = false
): Uint8Array | null {
	if (!/^[a-z][a-z0-9-]*\.(json|md)$/.test(name) && !SHARD_NAME.test(name))
		fail(`not a file name the artifact may hold: ${name}`);
	const path = join(dir, name);
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return optional ? null : fail(`${name} is missing`);
	}
	if (!st.isFile()) fail(`${name} is not a regular file`);
	if (st.size > max) fail(`${name} is ${st.size} bytes, over the ${max} byte limit`);
	const bytes = readFileSync(path);
	if (bytes.length > max) fail(`${name} grew past the ${max} byte limit while it was read`);
	return bytes;
}

/**
 * The text of `name` in `dir`: read_bytes, and valid UTF-8. Null when it is not there and
 * `optional`.
 */
export function read_file(dir: string, name: string, max: number, optional = false): string | null {
	const bytes = read_bytes(dir, name, max, optional);
	if (bytes === null) return null;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return fail(`${name} is not UTF-8`);
	}
}

function parse(text: string, name: string): Record<string, unknown> {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		return fail(`${name} is not JSON: ${(e as Error).message}`);
	}
	if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${name} is not a JSON object`);
	return v as Record<string, unknown>;
}

function object_at(o: Record<string, unknown>, key: string, name: string): Record<string, unknown> {
	const v = o[key];
	if (v === null || typeof v !== 'object' || Array.isArray(v))
		fail(`${name}: ${key} is not an object`);
	return v as Record<string, unknown>;
}

function expect_equal(got: unknown, want: unknown, what: string): void {
	if (got !== want)
		fail(`${what} is ${JSON.stringify(got)}, the plan says ${JSON.stringify(want)}`);
}

/** A comment section: text, no section markers (they would break the shared comment). */
function section_text(text: string, name: string): string {
	if (SECTION_MARKERS.some((m) => text.includes(m))) fail(`${name} holds section markers`);
	return text;
}

/** What the plan job decided; the artifact must agree. Empty strings mean "none". */
export interface Plan {
	kind: string;
	sha: string;
	base_sha?: string;
	pr?: string;
}

function plan_pr(plan: Plan): number | null {
	if (!plan.pr) return null;
	if (!/^[1-9][0-9]*$/.test(plan.pr)) fail(`bad PR number in the plan: ${plan.pr}`);
	return Number(plan.pr);
}

export interface HeisenbenchArtifact {
	/** result.json, as uploaded (it parsed and matched the plan): the manifest, or a whole result. */
	result: string;
	/** The manifest's shards by name, each checked against it (empty for a whole result). */
	shards: Map<string, Uint8Array>;
	section: string;
}

/**
 * The result a manifest describes, from the artifact's shards/: only the manifest's shards, each
 * read through read_bytes at most at the size the manifest gives it, and nothing else there.
 */
function sharded(dir: string, manifest: Record<string, unknown>, text: string) {
	const shards_dir = join(dir, SHARDS_DIR);
	try {
		if (Buffer.byteLength(text) > SHARD_LIMITS.manifest)
			fail(`result.json is a manifest over the ${SHARD_LIMITS.manifest} byte limit`);
		const m = check_manifest(manifest);
		let st;
		try {
			st = lstatSync(shards_dir);
		} catch {
			return fail(`${SHARDS_DIR}/ is missing`);
		}
		if (!st.isDirectory()) fail(`${SHARDS_DIR} is not a directory`);
		const listed = new Set(m.shards.map((e) => e.name));
		for (const name of readdirSync(shards_dir))
			if (!listed.has(name)) fail(`${SHARDS_DIR}/${name} is not in the manifest`);
		return join_shards(m, (name, max) => read_bytes(shards_dir, name, max)!);
	} catch (e) {
		if (e instanceof ShardError) fail(`result.json: ${e.message}`);
		throw e;
	}
}

/**
 * suites/ogygia's output: result.json (schema ogygia-heisenbench/1), as a manifest with its
 * shards/ (shards.ts) or as one file from before shards, and section.md.
 */
export function validate_heisenbench(dir: string, plan: Plan): HeisenbenchArtifact {
	if (!SHA.test(plan.sha)) fail(`bad sha in the plan: ${plan.sha}`);
	const result = read_file(dir, 'result.json', LIMITS.result)!;
	let r = parse(result, 'result.json');
	let shards = new Map<string, Uint8Array>();
	if (is_manifest(r)) {
		const joined = sharded(dir, r, result);
		r = joined.result;
		shards = joined.files;
	} else if (existsSync(join(dir, SHARDS_DIR))) {
		fail(`${SHARDS_DIR}/ is there, but result.json is not a manifest`);
	}
	expect_equal(r.schema, 'ogygia-heisenbench/1', 'result.json schema');
	const meta = object_at(r, 'meta', 'result.json');
	expect_equal(meta.kind, plan.kind, 'meta.kind');
	expect_equal(meta.sha, plan.sha, 'meta.sha');
	expect_equal(meta.base, plan.base_sha || null, 'meta.base');
	expect_equal(meta.pr, plan_pr(plan), 'meta.pr');
	const section = section_text(read_file(dir, 'section.md', LIMITS.markdown)!, 'section.md');
	return { result, shards, section };
}

export interface AppsArtifact {
	run: string;
	/** comment.md (a PR or an A/B run), or null. */
	comment: string | null;
	/** The file name the run is kept under on the results branch: the sha, else `v<version>`. */
	name: string;
}

/** The app benchmark's output: run.json (its `meta` block) and, for a comparison, comment.md. */
export function validate_apps(dir: string, plan: Plan): AppsArtifact {
	if (plan.sha && !SHA.test(plan.sha)) fail(`bad sha in the plan: ${plan.sha}`);
	const run = read_file(dir, 'run.json', LIMITS.run)!;
	const meta = object_at(parse(run, 'run.json'), 'meta', 'run.json');
	expect_equal(meta.mode, plan.kind, 'meta.mode');
	expect_equal(meta.sha, plan.sha || null, 'meta.sha');
	const pr = plan_pr(plan);
	expect_equal(meta.pr ?? null, pr, 'meta.pr');
	let name = plan.sha;
	if (!name) {
		// The weekly run installs a release, which has no commit: it is kept under its version.
		const version = meta.ogygia;
		if (typeof version !== 'string' || !VERSION.test(version))
			fail(`meta.ogygia is not a version: ${JSON.stringify(version)}`);
		name = `v${version as string}`;
	}
	const text = read_file(dir, 'comment.md', LIMITS.markdown, plan.kind !== 'pr');
	return { run, comment: text === null ? null : section_text(text, 'comment.md'), name };
}

/** Real-app weights (heisenbench-app-weights/1), counted on the plan's commit. */
export function validate_weights(dir: string, plan: Plan): string {
	if (!SHA.test(plan.sha)) fail(`bad sha in the plan: ${plan.sha}`);
	const text = read_file(dir, 'app-weights.json', LIMITS.weights)!;
	const w = parse(text, 'app-weights.json');
	expect_equal(w.schema, 'heisenbench-app-weights/1', 'app-weights.json schema');
	expect_equal(object_at(w, 'source', 'app-weights.json').sha, plan.sha, 'source.sha');
	object_at(w, 'units', 'app-weights.json');
	object_at(w, 'functions', 'app-weights.json');
	return text;
}
