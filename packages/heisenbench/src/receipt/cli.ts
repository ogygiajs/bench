import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { UsageError } from '../usage.ts';
import { make_receipt, parse_receipt, render_verify_receipt, verify_receipt } from './index.ts';
import type { Receipt } from './index.ts';
import { render_registry } from './registry.ts';

/**
 * `heisenbench receipt <bench files...> --package <tgz | url | name@version>`: count a release
 * and write its receipt.
 */
export async function receipt_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	const pkg = flags.get('package');
	if (pkg === undefined)
		throw new UsageError('--package <tarball, URL or name@version> is required');
	const npm = flags.get('npm');
	const list = (k: string): string[] => {
		const xs = flags.get(k)?.split(',').filter(Boolean) ?? [];
		for (const f of xs)
			if (!existsSync(f) || !statSync(f).isFile())
				throw new UsageError(`--${k} ${f}: no such file`);
		return xs;
	};
	const include = list('include');
	const preload = list('preload');
	const out = flags.get('out') ?? 'heisenbench-receipt.json';
	const r = await make_receipt({
		package: pkg,
		bench: positional,
		include,
		preload,
		root: flags.get('root'),
		npm: npm !== 'off',
		work: flags.get('work'),
		jobs: flags.has('jobs') ? Number(flags.get('jobs')) : undefined,
		log: (l) => console.log(l)
	});
	writeFileSync(out, JSON.stringify(r, null, '\t') + '\n');
	console.log(
		`receipt  ${r.package.name}@${r.package.version}: ${r.cases.length} case(s), ${r.growth.length} grown, ${r.hash.slice(0, 19)}… → ${out}`
	);
	return 0;
}

function read_receipt(path: string): Receipt {
	if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`no such file: ${path}`);
	try {
		return parse_receipt(readFileSync(path, 'utf8'), path);
	} catch (e) {
		throw new UsageError((e as Error).message.replace(/^heisenbench: /, ''));
	}
}

/** `heisenbench verify-receipt <receipt.json> <tgz | url | name@version>`: exit 0 when it matches. */
export async function verify_receipt_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	const receipt = read_receipt(positional[0]);
	const result = await verify_receipt(receipt, {
		tarball: positional[1],
		work: flags.get('work'),
		jobs: flags.has('jobs') ? Number(flags.get('jobs')) : undefined,
		log: (l) => console.log(l)
	});
	console.log('\n' + render_verify_receipt(result));
	const json = flags.get('json');
	if (json) writeFileSync(json, JSON.stringify(result, null, '\t') + '\n');
	return result.matches ? 0 : 1;
}

/** `heisenbench registry <receipts...> --out index.html`: the static registry page. */
export async function registry_command(
	positional: string[],
	flags: Map<string, string>
): Promise<number> {
	const out = resolve(flags.get('out') ?? 'index.html');
	const links = new Map<Receipt, string>();
	const receipts = positional.map((p) => {
		const r = read_receipt(p);
		links.set(r, relative(dirname(out), resolve(p)).split(sep).join('/'));
		return r;
	});
	writeFileSync(out, render_registry(receipts, links));
	console.log(`registry ${receipts.length} receipt(s) → ${out}`);
	return 0;
}
