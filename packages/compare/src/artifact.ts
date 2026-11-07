// Reading a measure job's artifact in the publish job. The measure job runs code from the PR
// (installs, builds, bench files), so everything it uploads is untrusted data: only files with
// names fixed here are read, each must be a regular file under its size limit, JSON must parse
// and say what the plan said (kind, commit, PR), and nothing in it is ever run or used as a path.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MiB = 1 << 20;

/** The largest file of each kind the publish job takes. */
export const LIMITS = {
	/** An Heisenbench result.json: two merged reports and the diff. */
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
 * The text of `name` in `dir`: a plain file name (no directories), a regular file (not a link),
 * at most `max` bytes, valid UTF-8. Null when it is not there and `optional`.
 */
export function read_file(dir: string, name: string, max: number, optional = false): string | null {
	if (!/^[a-z][a-z0-9-]*\.(json|md)$/.test(name))
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
	/** result.json, as uploaded (it parsed and matched the plan). */
	result: string;
	section: string;
}

/** suites/ogygia's output: result.json (schema ogygia-heisenbench/1) and section.md. */
export function validate_heisenbench(dir: string, plan: Plan): HeisenbenchArtifact {
	if (!SHA.test(plan.sha)) fail(`bad sha in the plan: ${plan.sha}`);
	const result = read_file(dir, 'result.json', LIMITS.result)!;
	const r = parse(result, 'result.json');
	expect_equal(r.schema, 'ogygia-heisenbench/1', 'result.json schema');
	const meta = object_at(r, 'meta', 'result.json');
	expect_equal(meta.kind, plan.kind, 'meta.kind');
	expect_equal(meta.sha, plan.sha, 'meta.sha');
	expect_equal(meta.base, plan.base_sha || null, 'meta.base');
	expect_equal(meta.pr, plan_pr(plan), 'meta.pr');
	const section = section_text(read_file(dir, 'section.md', LIMITS.markdown)!, 'section.md');
	return { result, section };
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
