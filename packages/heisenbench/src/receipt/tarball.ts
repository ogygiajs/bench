import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { run_process } from '../proc.ts';
import { one_line } from '../report.ts';

/*
 * A package tarball (`.tgz`, as npm publishes it): its bytes, its integrity (the same `sha512-…`
 * string npm keeps as `dist.integrity`) and the name and version its package.json says.
 */

export interface Tarball {
	bytes: Buffer;
	integrity: string;
	name: string;
	version: string;
	/** Where it was fetched from (a URL), or null for a local file. */
	url: string | null;
}

/** npm's integrity of a tarball: `sha512-` and the base64 digest of its bytes. */
export function integrity_of(bytes: Uint8Array): string {
	return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function tar_string(b: Buffer, at: number, len: number): string {
	const s = b.subarray(at, at + len);
	const end = s.indexOf(0);
	return s.subarray(0, end === -1 ? len : end).toString('utf8');
}

/**
 * One file of a tarball by its path below the top directory (npm packs everything under
 * `package/`, some tools under another name): its bytes, or null. Reads ustar headers, with the
 * long names of pax and GNU headers.
 */
export function tar_file(tgz: Uint8Array, path: string): Buffer | null {
	const tar = gunzipSync(tgz);
	let at = 0;
	let long_name: string | null = null;
	while (at + 512 <= tar.length) {
		if (tar[at] === 0) break;
		const size = parseInt(tar_string(tar, at + 124, 12).trim() || '0', 8);
		const type = String.fromCharCode(tar[at + 156] || 48);
		const body = at + 512;
		const short = tar_string(tar, at, 100);
		const prefix = tar_string(tar, at + 345, 155);
		const name = long_name ?? (prefix ? `${prefix}/${short}` : short);
		long_name = null;
		if (type === 'L') {
			long_name = tar_string(tar, body, size);
		} else if (type === 'x') {
			const m = /\d+ path=([^\n]*)\n/.exec(tar.subarray(body, body + size).toString('utf8'));
			if (m) long_name = m[1];
		} else if (type === '0' || type === '\0') {
			const rest = name.slice(name.indexOf('/') + 1);
			if (name.includes('/') && rest === path) return Buffer.from(tar.subarray(body, body + size));
		}
		at = body + Math.ceil(size / 512) * 512;
	}
	return null;
}

/** A tarball read from disk: its integrity and the name and version it says. */
export function read_tarball(path: string, url: string | null = null): Tarball {
	const bytes = readFileSync(path);
	let manifest: Buffer | null;
	try {
		manifest = tar_file(bytes, 'package.json');
	} catch (e) {
		throw new Error(`heisenbench: ${path} is not a package tarball (${one_line(e)})`);
	}
	if (manifest === null) throw new Error(`heisenbench: ${path} has no package.json`);
	const pkg = JSON.parse(manifest.toString('utf8')) as { name?: unknown; version?: unknown };
	if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
		throw new Error(`heisenbench: the package.json in ${path} has no name or version`);
	return { bytes, integrity: integrity_of(bytes), name: pkg.name, version: pkg.version, url };
}

/** What npm says of a published version: its tarball and integrity, or null when it is not there. */
export async function npm_dist(
	name: string,
	version: string
): Promise<{ integrity: string; tarball: string } | null> {
	try {
		const { stdout } = await run_process('npm', ['view', `${name}@${version}`, 'dist', '--json'], {
			timeout_ms: 60_000
		});
		if (stdout.trim() === '') return null;
		const d = JSON.parse(stdout) as { integrity?: string; tarball?: string };
		if (typeof d.integrity !== 'string' || typeof d.tarball !== 'string') return null;
		return { integrity: d.integrity, tarball: d.tarball };
	} catch {
		return null;
	}
}

/**
 * The tarball a spec names, saved in `dir`: a `.tgz` on disk, a URL (`https://pkg.pr.new/…`), or
 * `name@version` (`npm pack`, so the registry and auth of npm's own config apply).
 */
export async function fetch_tarball(spec: string, dir: string): Promise<Tarball> {
	if (/^https?:\/\//.test(spec)) {
		const res = await fetch(spec, { redirect: 'follow' });
		if (!res.ok) throw new Error(`heisenbench: ${spec}: HTTP ${res.status}`);
		const file = join(dir, 'download.tgz');
		writeFileSync(file, Buffer.from(await res.arrayBuffer()));
		return read_tarball(file, spec);
	}
	if (existsSync(spec) && statSync(spec).isFile()) return read_tarball(resolve(spec));
	const before = new Set(readdirSync(dir));
	try {
		await run_process('npm', ['pack', spec, '--pack-destination', dir, '--silent'], {
			timeout_ms: 5 * 60_000
		});
	} catch (e) {
		throw new Error(`heisenbench: npm pack ${spec} failed: ${one_line(e)}`);
	}
	const made = readdirSync(dir).filter((f) => f.endsWith('.tgz') && !before.has(f));
	if (made.length !== 1) throw new Error(`heisenbench: npm pack ${spec} made no tarball`);
	const t = read_tarball(join(dir, made[0]));
	const dist = await npm_dist(t.name, t.version);
	return { ...t, url: dist?.tarball ?? null };
}
