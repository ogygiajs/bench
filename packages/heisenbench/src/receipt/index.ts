import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { first_difference } from '../prove/equal.ts';
import { load_prices } from '../prices.ts';
import { environment } from '../report.ts';
import { PACKAGE_NAME } from '../own.ts';
import { engine_package_version, engine_source, engine_version, sha256 } from './engine.ts';
import { ISOLATION, RECEIPT_ENV, RECEIPT_SIZES, count_tree } from './count.ts';
import type { ReceiptCase, ReceiptGrowth } from './count.ts';
import { fetch_tarball, npm_dist } from './tarball.ts';
import type { Tarball } from './tarball.ts';
import { install, locked_packages, make_root, new_root, safe_path, write_files } from './tree.ts';
import type { Lockfile } from './tree.ts';

export type { ReceiptCase, ReceiptFunction, ReceiptGrowth } from './count.ts';

/*
 * Release receipts. Counts are the same on every machine, so a release can say what its code costs
 * and anyone can check it: the receipt names the package's tarball (its npm integrity), the bench
 * files (their text), the dependency tree (npm's lockfile), the engine (its version and the hash of
 * its code, prices and weights) and the Node that counted, then lists every case's counts and
 * growth. `verify-receipt` rebuilds the same tree from a tarball and the receipt, counts it the
 * same way (each case in a process of its own, count.ts) and says "matches" or the first
 * difference.
 *
 * Hashed, not signed. `hash` is the sha256 of the receipt's canonical JSON (keys sorted, `hash`
 * left out): it says the receipt is whole, not who made it. What makes it trustworthy is that it
 * can be checked by counting again, on any machine, by anyone. Who published it is the job of the
 * place it is published from: a release workflow attests the file with the provenance it already
 * has (sigstore through GitHub's OIDC token, as npm provenance does), so no key is kept anywhere
 * (docs/receipts.md).
 */

export const RECEIPT_SCHEMA = 'heisenbench-receipt/1';

export interface ReceiptPackage {
	name: string;
	version: string;
	/** npm's `dist.integrity` of the tarball (sha512 of its bytes). */
	integrity: string;
	/** Where the tarball can be downloaded (npm's tarball URL, or the URL it came from). */
	tarball: string | null;
	/**
	 * `published`: npm has this version with this integrity. `not published`: npm has no such
	 * version (a preview build). `not checked`: the receipt was made with `--npm off`.
	 */
	npm: 'published' | 'not published' | 'not checked';
}

export interface Receipt {
	schema: typeof RECEIPT_SCHEMA;
	created: string;
	package: ReceiptPackage;
	/** Every other package installed, from the lockfile. */
	dependencies: Array<{ name: string; version: string; integrity: string | null }>;
	install: { manager: 'npm'; scripts: 'ignored'; lockfile: Lockfile };
	bench: { files: Array<{ path: string; sha256: string; text: string }> };
	engine: {
		name: string;
		version: string;
		/** `npm`, or `checkout <commit>` (engine.ts engine_source). */
		source: string;
		/** engine.ts: its code, package files and dependency versions. */
		hash: string;
		prices: { version: number; hash: string };
		weights: { version: number; hash: string } | null;
	};
	node: { version: string; v8: string; platform: string; arch: string };
	counting: {
		/** How cases were kept apart: each one counted, and grown, in a process of its own. */
		isolation: typeof ISOLATION;
		/** Every run of a case on a fresh copy of its modules (fresh.ts). */
		state: 'fresh';
		/** Every dependency counted. */
		deps: 'all';
		/** Environment variables every counting process had. */
		env: Record<string, string>;
		/**
		 * `virtual`: the counted code saw the root as the virtual root (runtime/paths.ts), so the
		 * tree counts the same wherever it is.
		 */
		paths?: 'virtual';
		/**
		 * A receipt made before the virtual root: the characters and directories of the root it was
		 * counted in, which its check pads a root to (tree.ts `make_root`).
		 */
		root_length?: number;
		root_depth?: number;
		/** Growth: the sizes every case that declares `scale` was grown to. */
		sizes: number[];
		/** Files of the receipt every counting process imported first (`--import`). */
		preload: string[];
	};
	cases: ReceiptCase[];
	growth: ReceiptGrowth[];
	/** `sha256-<hex>` of the canonical JSON of everything else. */
	hash: string;
}

/** JSON with every object's keys sorted: one text for one value. */
export function canonical_json(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map((x) => canonical_json(x ?? null)).join(',')}]`;
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical_json(o[k])}`).join(',')}}`;
}

export function receipt_hash(r: Omit<Receipt, 'hash'> & { hash?: string }): string {
	const { hash: _, ...rest } = r;
	return `sha256-${sha256(canonical_json(rest))}`;
}

function engine_info(): Receipt['engine'] {
	const p = load_prices();
	return {
		name: PACKAGE_NAME,
		version: engine_package_version(),
		source: engine_source(),
		hash: engine_version(),
		prices: { version: p.prices.version, hash: p.hash },
		weights: environment().weights
	};
}

function node_info(): Receipt['node'] {
	return {
		version: process.version,
		v8: process.versions.v8,
		platform: process.platform,
		arch: process.arch
	};
}

/** A scratch directory of this run (under `work` when given), removed at its end. */
function scratch(work?: string): string {
	if (work !== undefined) mkdirSync(work, { recursive: true });
	return realpathSync(mkdtempSync(join(work ?? tmpdir(), 'heisenbench-receipt-')));
}

export interface ReceiptOptions {
	/** The package: a `.tgz`, a URL, or `name@version` (npm pack). */
	package: string;
	/** Bench files (and `include`: files they read or import), paths from `root`. */
	bench: readonly string[];
	include?: readonly string[];
	/** Files every counting process imports first (`--import`), kept in the receipt like the bench files. */
	preload?: readonly string[];
	/** Where the bench files' paths start (default: cwd). Their paths in the tree are the same. */
	root?: string;
	/** Check the tarball against npm (default true). */
	npm?: boolean;
	work?: string;
	jobs?: number;
	log?: (line: string) => void;
}

/** Count the package's tarball with the bench files and write it all down. */
export async function make_receipt(o: ReceiptOptions): Promise<Receipt> {
	const log = o.log ?? (() => {});
	const base = resolve(o.root ?? process.cwd());
	const tree_path = (f: string) => safe_path(relative(base, resolve(f)).split(sep).join('/'));
	const seen = new Set<string>();
	const files = [...o.bench, ...(o.include ?? []), ...(o.preload ?? [])].flatMap((f) => {
		const path = tree_path(f);
		if (seen.has(path)) return [];
		seen.add(path);
		const text = readFileSync(resolve(f), 'utf8');
		return [{ path, sha256: sha256(text), text }];
	});
	const bench_paths = o.bench.map(tree_path);
	const preload = (o.preload ?? []).map(tree_path);
	const work = scratch(o.work);
	try {
		mkdirSync(join(work, 'download'));
		const t = await fetch_tarball(o.package, join(work, 'download'));
		let npm: ReceiptPackage['npm'] = 'not checked';
		let tarball = t.url;
		if (o.npm !== false) {
			const dist = await npm_dist(t.name, t.version);
			if (dist === null) npm = 'not published';
			else if (dist.integrity !== t.integrity)
				throw new Error(
					`heisenbench: this tarball is not npm's ${t.name}@${t.version} (npm has ${dist.integrity}, the tarball is ${t.integrity})`
				);
			else {
				npm = 'published';
				tarball = dist.tarball;
			}
		}
		log(`receipt  ${t.name}@${t.version} (${t.integrity.slice(0, 19)}…, npm: ${npm})`);
		const root = new_root(work);
		write_files(root, files);
		const lockfile = await install(root, t);
		log(
			`receipt  installed with npm: ${Object.keys(lockfile.packages ?? {}).length - 1} package(s)`
		);
		mkdirSync(join(work, 'jobs'));
		const counted = await count_tree({
			root,
			files: bench_paths,
			preload,
			work: join(work, 'jobs'),
			jobs: o.jobs,
			log
		});
		if (counted.failed.length > 0) {
			const f = counted.failed[0];
			throw new Error(
				`heisenbench: ${counted.failed.length} case(s) did not count, so no receipt: ${f.name} (${f.file}): ${f.error}`
			);
		}
		const body: Omit<Receipt, 'hash'> = {
			schema: RECEIPT_SCHEMA,
			created: new Date().toISOString(),
			package: { name: t.name, version: t.version, integrity: t.integrity, tarball, npm },
			dependencies: locked_packages(lockfile, t.name),
			install: { manager: 'npm', scripts: 'ignored', lockfile },
			bench: { files },
			engine: engine_info(),
			node: node_info(),
			counting: {
				isolation: ISOLATION,
				state: 'fresh',
				deps: 'all',
				env: { ...RECEIPT_ENV },
				paths: 'virtual',
				sizes: RECEIPT_SIZES,
				preload
			},
			cases: counted.cases,
			growth: counted.growth
		};
		return { ...body, hash: receipt_hash(body) };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** A receipt from JSON, or an error saying why it is not one. */
export function parse_receipt(text: string, where: string): Receipt {
	let r: unknown;
	try {
		r = JSON.parse(text);
	} catch {
		throw new Error(`heisenbench: ${where} is not JSON`);
	}
	if (r === null || typeof r !== 'object' || (r as Receipt).schema !== RECEIPT_SCHEMA)
		throw new Error(`heisenbench: ${where} is not a receipt (no "schema": "${RECEIPT_SCHEMA}")`);
	const x = r as Receipt;
	if (!Array.isArray(x.cases) || !Array.isArray(x.bench?.files) || !x.package?.name)
		throw new Error(`heisenbench: ${where} is not a whole receipt`);
	return x;
}

export interface Check {
	what: 'receipt' | 'tarball' | 'engine' | 'node' | 'counts' | 'growth';
	ok: boolean;
	text: string;
}

export interface VerifyResult {
	package: { name: string; version: string };
	/** Every count the receipt lists was counted again and is the same. */
	matches: boolean;
	checks: Check[];
	/** The first difference in the counts: the case and where in it. */
	first_difference: string | null;
	/** Cases whose counts differ, of the receipt's. */
	differing: { cases: number; of: number; growth: number; growth_of: number };
}

const key = (x: { file: string; name: string }) => `${x.file}\0${x.name}`;

/** Compare counted cases (or growth curves) with the receipt's, in the receipt's order. */
function compare<T extends { file: string; name: string }>(
	want: readonly T[],
	got: readonly T[],
	failed: ReadonlyMap<string, string>,
	label: string
): { first: string | null; differ: number } {
	const by = new Map(got.map((g) => [key(g), g]));
	let first: string | null = null;
	let differ = 0;
	for (const w of want) {
		const g = by.get(key(w));
		const at = `${label} ${JSON.stringify(w.name)} (${w.file})`;
		const where = g === undefined ? null : first_difference(w, g, '');
		const d =
			g === undefined
				? `${at}: not counted (${failed.get(key(w)) ?? 'not found in the bench files'})`
				: where === null
					? null
					: `${at}: ${where.replace(/^\./, '')}`;
		if (d === null) continue;
		differ++;
		first ??= d;
	}
	return { first, differ };
}

export interface VerifyOptions {
	/** The tarball to check: a `.tgz`, a URL, or `name@version`. */
	tarball: string;
	work?: string;
	jobs?: number;
	log?: (line: string) => void;
}

/**
 * Count a tarball the way the receipt was counted and compare. Every check is reported; the
 * counts are counted even when the tarball or the engine is not the receipt's, so a changed
 * tarball names the first case its change reaches.
 */
export async function verify_receipt(receipt: Receipt, o: VerifyOptions): Promise<VerifyResult> {
	const log = o.log ?? (() => {});
	const checks: Check[] = [];
	const hash = receipt_hash(receipt);
	checks.push(
		hash === receipt.hash
			? { what: 'receipt', ok: true, text: `whole (${receipt.hash.slice(0, 19)}…)` }
			: {
					what: 'receipt',
					ok: false,
					text: `changed after it was made: its content hashes to ${hash.slice(0, 19)}…, it says ${String(receipt.hash).slice(0, 19)}…`
				}
	);
	for (const f of receipt.bench.files) {
		if (sha256(f.text) !== f.sha256)
			checks.push({
				what: 'receipt',
				ok: false,
				text: `bench file ${f.path} is not the one hashed`
			});
	}
	const work = scratch(o.work);
	try {
		mkdirSync(join(work, 'download'));
		const t: Tarball = await fetch_tarball(o.tarball, join(work, 'download'));
		if (t.name !== receipt.package.name)
			throw new Error(
				`heisenbench: the tarball is ${t.name}@${t.version}, the receipt is for ${receipt.package.name}`
			);
		const same_tarball = t.integrity === receipt.package.integrity;
		checks.push({
			what: 'tarball',
			ok: same_tarball && t.version === receipt.package.version,
			text: same_tarball
				? `${t.name}@${t.version}, the receipt's (${t.integrity.slice(0, 19)}…)`
				: `${t.name}@${t.version} is not the receipt's tarball: ${t.integrity.slice(0, 19)}… vs ${receipt.package.integrity.slice(0, 19)}… (counted anyway)`
		});
		const e = engine_info();
		const engine_same =
			e.hash === receipt.engine.hash && e.prices.hash === receipt.engine.prices.hash;
		const theirs = receipt.engine;
		const how =
			theirs.source === 'npm'
				? `npx ${theirs.name}@${theirs.version} verify-receipt`
				: `the bench repo at ${theirs.source.replace(/^checkout /, '')}`;
		checks.push({
			what: 'engine',
			ok: engine_same,
			text: engine_same
				? `${e.name} ${e.version}, ${e.source} (${e.hash.slice(0, 12)}), the receipt's`
				: `${e.name} ${e.version}, ${e.source} (${e.hash.slice(0, 12)}, prices ${e.prices.hash.slice(0, 8)}) counted it; the receipt's was ${theirs.version}, ${theirs.source} (${theirs.hash.slice(0, 12)}, prices ${theirs.prices.hash.slice(0, 8)}): check with that one (${how})`
		});
		const n = node_info();
		const node_same = n.version === receipt.node.version;
		// A note, not a failure: V8 decides how often it calls back into counted code (a sort's
		// comparator), so another Node can count differently, and the counts say whether it did.
		checks.push({
			what: 'node',
			ok: true,
			text: node_same
				? `${n.version}, the receipt's`
				: `${n.version}; the receipt was counted on ${receipt.node.version} (a difference below can be V8's)`
		});

		const { root_length, root_depth } = receipt.counting;
		const root =
			root_length !== undefined && root_depth !== undefined
				? make_root(root_length, root_depth, work)
				: new_root(work);
		write_files(root, receipt.bench.files);
		await install(root, t, receipt.install.lockfile);
		log(`verify   installed the receipt's lockfile with npm ci`);
		mkdirSync(join(work, 'jobs'));
		const bench_paths = [...new Set(receipt.cases.map((c) => c.file))];
		const counted = await count_tree({
			root,
			files: bench_paths,
			preload: receipt.counting.preload ?? [],
			work: join(work, 'jobs'),
			sizes: receipt.counting.sizes,
			jobs: o.jobs,
			log
		});
		const failed = new Map(counted.failed.map((f) => [key(f), f.error]));
		const cases = compare(receipt.cases, counted.cases, failed, 'case');
		const growth = compare(receipt.growth, counted.growth, failed, 'growth of');
		checks.push({
			what: 'counts',
			ok: cases.differ === 0,
			text:
				cases.differ === 0
					? `${receipt.cases.length} case(s), each counted in a process of its own: every count is the receipt's`
					: `${cases.differ} of ${receipt.cases.length} case(s) count differently`
		});
		checks.push({
			what: 'growth',
			ok: growth.differ === 0,
			text:
				growth.differ === 0
					? `${receipt.growth.length} growth curve(s): every one is the receipt's`
					: `${growth.differ} of ${receipt.growth.length} growth curve(s) differ`
		});
		const first = cases.first ?? growth.first;
		return {
			package: { name: receipt.package.name, version: receipt.package.version },
			matches: checks.every((c) => c.ok),
			checks,
			first_difference: first,
			differing: {
				cases: cases.differ,
				of: receipt.cases.length,
				growth: growth.differ,
				growth_of: receipt.growth.length
			}
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The result in words: one line per check, then "matches" or the first difference. */
export function render_verify_receipt(r: VerifyResult): string {
	const lines = [`heisenbench verify-receipt: ${r.package.name}@${r.package.version}`];
	for (const c of r.checks) lines.push(`  ${c.ok ? 'ok  ' : 'NO  '} ${c.what.padEnd(8)} ${c.text}`);
	if (r.matches) lines.push('matches');
	else if (r.first_difference !== null) lines.push(`differs: ${r.first_difference}`);
	else lines.push(`differs: ${r.checks.find((c) => !c.ok)?.text ?? 'see above'}`);
	return lines.join('\n');
}
