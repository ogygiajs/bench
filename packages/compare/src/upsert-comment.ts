#!/usr/bin/env node
// Set one section of the benchmark comment on a PR, keeping the other sections.
//
//   GH_TOKEN=... node packages/compare/src/upsert-comment.ts \
//     --repo ogygiajs/ogygia --pr 123 --section apps (--file comment.md | --body 'text')
//
// The comment is the PR's comment with the `<!-- ogygia-benchmarks -->` marker, written by the
// token's own login; it is created when the PR has none. See sections.ts for the layout.
//
//   --bot-login <login>   the login the token comments as (or BENCH_BOT_LOGIN); default from
//                         GET /user, else github-actions[bot] (see github.ts)
//   --run-url <url>       linked from the note when the section is cut to fit GitHub's limit
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { upsertComment } from './github.ts';

const { values } = parseArgs({
	options: {
		repo: { type: 'string' },
		pr: { type: 'string' },
		section: { type: 'string' },
		file: { type: 'string' },
		body: { type: 'string' },
		'bot-login': { type: 'string' },
		'run-url': { type: 'string' }
	}
});

const usage =
	'usage: node upsert-comment.ts --repo <owner/name> --pr <n> --section <name> (--file <md> | --body <text>) [--bot-login <login>] [--run-url <url>]';
const pr = Number(values.pr);
if (!values.repo || !values.section || !Number.isInteger(pr) || pr <= 0) throw new Error(usage);
if ((values.file === undefined) === (values.body === undefined)) throw new Error(usage);
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('set GH_TOKEN (or GITHUB_TOKEN)');

const content = values.file === undefined ? (values.body ?? '') : readFileSync(values.file, 'utf8');
const result = await upsertComment({
	repo: values.repo,
	issue: pr,
	section: values.section,
	content,
	token,
	botLogin: values['bot-login'] || process.env.BENCH_BOT_LOGIN || undefined,
	runUrl: values['run-url'] || undefined,
	api: process.env.GITHUB_API_URL
});
console.log(
	`${result.created ? 'created' : 'updated'} comment ${result.id} on ${values.repo}#${pr} as ${result.login}: section ${values.section}${result.writes > 1 ? ` (${result.writes} writes)` : ''}`
);
