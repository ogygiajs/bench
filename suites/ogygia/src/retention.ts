#!/usr/bin/env node
/**
 * How long the results branch keeps ogygia's Heisenbench runs: the policy `heisenbench gc` applies
 * (the weekly results-gc workflow).
 *
 *   node suites/ogygia/src/retention.ts --root <results>/heisenbench --ogygia <ogygia clone>
 *       [--repo ogygiajs/ogygia] [--out drops.json]
 *
 * The rules (RETENTION, the one place to change them):
 *
 *   a PR's runs     (`meta.kind` pr: pr/<n>.json and commit/<sha>.json) are kept while the PR is
 *                   open, and for `pr_days` days after it closed or merged (GitHub's API, through
 *                   `gh`). A PR whose state cannot be read is kept.
 *   main's runs     (`meta.kind` main: main/<sha>.json and commit/<sha>.json) are kept for
 *                   `main_days` days after their commit (its committer date in the ogygia clone);
 *                   older, only the newest commit of each month is kept, for good. Run files do
 *                   not say which release they were (no version in `meta`), so the month stands
 *                   in for it. A commit the clone does not have is kept.
 *   anything else   (main/latest.json, the weights files, the registry) is kept.
 *
 * Writes `{ "drop": [{ "path", "why" }] }` for `heisenbench gc --drop`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scan_results } from '@bench/compare';
import type { Drop, RunFile } from '@bench/compare';

export const RETENTION = {
	/** Days a closed or merged PR's runs are kept. */
	pr_days: 30,
	/** Days a main run is kept; after that, the newest of each month only. */
	main_days: 180
} as const;

export type Retention = { [K in keyof typeof RETENTION]: number };

export interface PrState {
	state: 'open' | 'closed';
	/** ISO time it closed or merged (null while open). */
	closed_at: string | null;
}

const DAY = 86_400_000;

/** The run files the policy drops. Pure: PR states and commit dates are given. */
export function retention_drops(
	files: RunFile[],
	prs: ReadonlyMap<number, PrState>,
	dates: ReadonlyMap<string, string>,
	now: Date,
	policy: Retention = RETENTION
): Drop[] {
	const drops: Drop[] = [];
	// main runs past main_days, by commit, for the newest-of-the-month rule
	const old_main = new Map<string, { date: string; files: RunFile[] }>();
	for (const f of files) {
		if (f.path.endsWith('/latest.json') || f.path === 'latest.json') continue;
		const m = f.meta;
		if (m?.kind === 'pr' && typeof m.pr === 'number') {
			const s = prs.get(m.pr);
			if (s?.state !== 'closed' || !s.closed_at) continue;
			const days = (now.getTime() - Date.parse(s.closed_at)) / DAY;
			if (days > policy.pr_days)
				drops.push({ path: f.path, why: `PR #${m.pr} closed ${Math.floor(days)} days ago` });
		} else if (m?.kind === 'main' && typeof m.sha === 'string') {
			const date = dates.get(m.sha);
			if (!date) continue;
			if ((now.getTime() - Date.parse(date)) / DAY <= policy.main_days) continue;
			const e = old_main.get(m.sha) ?? { date, files: [] };
			e.files.push(f);
			old_main.set(m.sha, e);
		}
	}
	const newest = new Map<string, { sha: string; date: string }>();
	for (const [sha, { date }] of old_main) {
		const month = new Date(date).toISOString().slice(0, 7);
		const n = newest.get(month);
		if (!n || date > n.date || (date === n.date && sha > n.sha)) newest.set(month, { sha, date });
	}
	const kept = new Set([...newest.values()].map((n) => n.sha));
	for (const [sha, { date, files: fs }] of old_main) {
		if (kept.has(sha)) continue;
		const month = new Date(date).toISOString().slice(0, 7);
		for (const f of fs)
			drops.push({
				path: f.path,
				why: `main ${sha.slice(0, 7)} of ${date.slice(0, 10)}, over ${policy.main_days} days and not the newest of ${month}`
			});
	}
	return drops.sort((a, b) => a.path.localeCompare(b.path));
}

/** Each PR's state from GitHub (`gh api`); a PR that cannot be read is left out (kept). */
export function pr_states(repo: string, numbers: Iterable<number>): Map<number, PrState> {
	const out = new Map<number, PrState>();
	for (const n of numbers) {
		try {
			const text = execFileSync(
				'gh',
				['api', `repos/${repo}/pulls/${n}`, '--jq', '{state: .state, closed_at: .closed_at}'],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
			);
			const v = JSON.parse(text) as PrState;
			if (v.state === 'open' || v.state === 'closed') out.set(n, v);
		} catch {
			// unknown: kept
		}
	}
	return out;
}

/** Each commit's committer date in the clone at `repo`; a commit it lacks is left out (kept). */
export function commit_dates(repo: string, shas: Iterable<string>): Map<string, string> {
	const out = new Map<string, string>();
	const list = [...new Set(shas)].filter((s) => /^[0-9a-f]{40}$/.test(s));
	for (let i = 0; i < list.length; i += 500) {
		const text = execFileSync(
			'git',
			[
				'log',
				'--no-walk=unsorted',
				'--ignore-missing',
				'--format=%H %cI',
				...list.slice(i, i + 500)
			],
			{ cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }
		);
		for (const line of text.split('\n')) {
			const [sha, date] = line.split(' ');
			if (sha && date) out.set(sha, date);
		}
	}
	return out;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			root: { type: 'string' },
			ogygia: { type: 'string' },
			repo: { type: 'string', default: 'ogygiajs/ogygia' },
			out: { type: 'string', default: 'drops.json' }
		}
	});
	if (!values.root || !values.ogygia) {
		console.error(
			'usage: retention.ts --root <results>/heisenbench --ogygia <clone> [--out drops.json]'
		);
		process.exit(2);
	}
	const scan = scan_results(resolve(values.root));
	// a tree gc would refuse: the policy is not worked out around it either
	if (scan.errors.length) {
		console.error(
			`the results tree has ${scan.errors.length} problems:\n${scan.errors.join('\n')}`
		);
		process.exit(1);
	}
	const metas = scan.files.map((f) => f.meta).filter((m) => m !== null);
	const prs = pr_states(
		values.repo,
		new Set(metas.filter((m) => m.kind === 'pr').map((m) => m.pr as number))
	);
	const dates = commit_dates(
		resolve(values.ogygia),
		metas.filter((m) => m.kind === 'main').map((m) => m.sha as string)
	);
	const drops = retention_drops(scan.files, prs, dates, new Date());
	writeFileSync(values.out, JSON.stringify({ drop: drops }, null, '\t') + '\n');
	console.log(
		`retention: ${drops.length} of ${scan.files.length} run files dropped (${prs.size} PRs read, ${dates.size} main commits dated)`
	);
}

if (import.meta.main) await main();
