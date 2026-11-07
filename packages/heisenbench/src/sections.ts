import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { FileDiff } from './diff/git.ts';
import { diff_engine, render_engine_markdown } from './engine/diff.ts';
import type { EngineDiff } from './engine/diff.ts';
import { diff_growth } from './growth/index.ts';
import type { GrowthDiff } from './growth/index.ts';
import { diff_search } from './search/index.ts';
import type { SearchFinding } from './search/index.ts';
import { load_prices } from './prices.ts';
import { REPORT_SCHEMA, environment } from './report.ts';
import { code } from './md.ts';
import type { Report } from './report.ts';

/*
 * The report sections next to the step counts: `engine` (heisenbench health), `growth` (heisenbench growth) and
 * `search` (heisenbench search). Each command writes its section into the report file (creating a report
 * with no cases when there is none yet), so one JSON per commit holds everything; `heisenbench diff`
 * renders an "Engine" and a "Growth" part under the step table.
 */

type Section = 'engine' | 'growth' | 'search';

function git(root: string, args: string[]): string | null {
	try {
		return execFileSync('git', args, {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

/** Write one section into `out` (an heisenbench report), keeping everything else in it. */
export function write_section<K extends Section>(
	out: string,
	key: K,
	value: NonNullable<Report[K]>,
	info: { root: string; sha?: string | null }
): Report {
	let report: Report;
	if (existsSync(out)) {
		report = JSON.parse(readFileSync(out, 'utf8')) as Report;
		if (report.schema !== REPORT_SCHEMA) throw new Error(`heisenbench: ${out} is not an heisenbench report`);
		// One report holds one environment: its layers must not mix Node versions.
		if (report.node !== process.version) {
			throw new Error(
				`heisenbench: ${out} was counted on Node ${report.node}; this is Node ${process.version} (write to another --out)`
			);
		}
		report.env ??= environment();
	} else {
		const root = resolve(info.root);
		const top = git(root, ['rev-parse', '--show-toplevel']);
		report = {
			schema: REPORT_SCHEMA,
			prices: { version: load_prices().prices.version, hash: load_prices().hash },
			node: process.version,
			env: environment(),
			git: {
				sha: info.sha ?? git(root, ['rev-parse', 'HEAD']),
				prefix: top ? relative(top, root).split(sep).join('/') : ''
			},
			cases: []
		};
	}
	report[key] = value;
	writeFileSync(out, JSON.stringify(report, null, '\t') + '\n');
	return report;
}

export interface SectionsDiff {
	engine: EngineDiff | null;
	growth: GrowthDiff | null;
	search: SearchFinding[] | null;
}

export function diff_sections(base: Report, pr: Report, files: FileDiff[] | null): SectionsDiff {
	// What V8 did is only comparable on one V8: across Node versions the engine part is left out.
	const same_engine = base.node === pr.node && base.env?.v8 === pr.env?.v8;
	return {
		engine:
			base.engine && pr.engine && same_engine
				? diff_engine(base.engine, pr.engine, {
						files,
						base_prefix: base.git.prefix,
						pr_prefix: pr.git.prefix
					})
				: null,
		growth: base.growth && pr.growth ? diff_growth(base.growth, pr.growth) : null,
		search: base.search && pr.search ? diff_search(base.search, pr.search) : null
	};
}

/** The "Engine" and "Growth" parts (empty when neither side has those sections). */
export function render_sections(d: SectionsDiff): string {
	const parts: string[] = [];
	if (d.engine) parts.push(render_engine_markdown(d.engine));
	if (d.growth || d.search) {
		const lines: string[] = ['#### Growth', ''];
		const g = d.growth;
		if (g) {
			if (g.findings.length === 0)
				lines.push('No case changed how its steps grow with input size.', '');
			else {
				for (const f of g.findings) lines.push(`- ${f.text}`);
				lines.push('');
			}
			if (g.better.length > 0) {
				lines.push('Better:', '');
				for (const f of g.better) lines.push(`- ${f.text}`);
				lines.push('');
			}
			if (g.same.length > 0) {
				lines.push(
					'<details><summary>Same growth, different steps at the largest size</summary>',
					''
				);
				for (const s of g.same)
					lines.push(`- ${code(s.case)}: still ${s.class}, ${s.ratio}x the steps`);
				lines.push('', '</details>', '');
			}
			if (g.failed.length > 0) lines.push(`**Failed**: ${g.failed.map(code).join(', ')}`, '');
		}
		if (d.search) {
			if (d.search.length === 0) lines.push('No new slow input found.', '');
			else {
				lines.push('Slow inputs:', '');
				for (const f of d.search) lines.push(`- ${f.text}`);
				lines.push('');
			}
		}
		parts.push(lines.join('\n'));
	}
	return parts.join('\n');
}
