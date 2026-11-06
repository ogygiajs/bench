import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register_abax } from '../src/loader/register.ts';
import { get_runtime } from '../src/runtime/index.ts';
import { Builtins } from '../src/runtime/builtins.ts';
import { build_case_report } from '../src/report.ts';
import type { CaseReport, FunctionReport } from '../src/report.ts';

export function temp_dir(prefix = 'abax-'): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function write_files(dir: string, files: Record<string, string>): void {
	for (const [name, text] of Object.entries(files)) {
		const p = join(dir, name);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, text);
	}
}

let root: string | null = null;

/** One temp root per test process, with the loader registered on it. */
export function loader_root(): string {
	if (!root) {
		root = temp_dir();
		register_abax({ root });
	}
	return root;
}

let counter = 0;

/** Write a module into the loader root and import it (instrumented). */
export async function load_module<T = Record<string, (...args: never[]) => unknown>>(
	source: string,
	ext = '.ts'
): Promise<T> {
	const dir = loader_root();
	const name = `m${++counter}${ext}`;
	write_files(dir, { [name]: source });
	return (await import(pathToFileURL(join(dir, name)).href)) as T;
}

export const rt = get_runtime();
export const builtins = new Builtins(rt);

/** Run `fn` from uninstrumented code with fresh counters; return the case report. */
export async function measure(fn: () => unknown, with_builtins = false): Promise<CaseReport> {
	rt.reset();
	if (with_builtins) builtins.install();
	try {
		await fn();
	} finally {
		if (with_builtins) builtins.uninstall();
	}
	const snap = rt.snapshot();
	return build_case_report(rt, snap, {
		name: 'test',
		file: '',
		stable: true,
		timers: 0,
		runaway: false,
		error: null
	});
}

export function fn_of(report: CaseReport, path: string): FunctionReport {
	const f = report.functions.find((x) => x.path === path);
	if (!f)
		throw new Error(`no function ${path} in [${report.functions.map((x) => x.id).join(', ')}]`);
	return f;
}

/** Block counts keyed by original line (summed when several blocks start on one line). */
export function counts_by_line(f: FunctionReport): Record<number, number> {
	const out: Record<number, number> = {};
	for (const b of f.blocks) out[b.line] = (out[b.line] ?? 0) + b.count;
	return out;
}
