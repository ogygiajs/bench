// Upsert one section of the benchmark comment on a GitHub issue or PR, through the REST API.
import { MARKER, sectionOf, upsertSection } from './sections.ts';

export interface UpsertOptions {
	/** `owner/name` of the repository the PR is in. */
	repo: string;
	/** The PR (or issue) number. */
	issue: number;
	section: string;
	content: string;
	token: string;
	/**
	 * The login the token comments as. Only a comment by this login is taken as the benchmark
	 * comment. Default: the login `GET /user` returns, or, for a token that endpoint refuses
	 * (an Actions GITHUB_TOKEN, a GitHub App installation token), `github-actions[bot]`. A GitHub
	 * App's token comments as `<app-slug>[bot]`: pass that here.
	 */
	botLogin?: string;
	/** Linked from the note on a section cut to fit GitHub's comment size limit. */
	runUrl?: string;
	/** Default `https://api.github.com`. */
	api?: string;
	/** Default the global fetch. */
	fetch?: typeof fetch;
	/**
	 * How long to wait before reading the comment back. Two suites can upsert at the same moment;
	 * the read-back finds a section another writer put back to its older content and writes again.
	 */
	settleMs?: number;
	/** How many times to write before giving up on a section that keeps being put back. */
	tries?: number;
}

export interface UpsertResult {
	id: number;
	created: boolean;
	/** How many writes it took. */
	writes: number;
	/** The login comments were matched against. */
	login: string;
}

interface Comment {
	id: number;
	body?: string | null;
	user?: { login?: string | null } | null;
}

const PAGE = 100;

/** Who an Actions GITHUB_TOKEN comments as. */
export const ACTIONS_BOT = 'github-actions[bot]';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

function client(opts: UpsertOptions) {
	const api = (opts.api ?? 'https://api.github.com').replace(/\/$/, '');
	const do_fetch = opts.fetch ?? fetch;
	return async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await do_fetch(`${api}${path}`, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${opts.token}`,
				'x-github-api-version': '2022-11-28',
				'user-agent': 'ogygia-bench',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok)
			throw new GitHubError(`${method} ${path}: ${res.status} ${await res.text()}`, res.status);
		return (await res.json()) as T;
	};
}

type Request = ReturnType<typeof client>;

/**
 * The login this token comments as. `GET /user` answers for a user token (a personal access
 * token); an installation token or the Actions GITHUB_TOKEN gets 403 ("Resource not accessible
 * by integration"), and those comment as a bot.
 */
async function own_login(request: Request, explicit: string | undefined): Promise<string> {
	if (explicit) return explicit;
	try {
		const user = await request<{ login?: string }>('GET', '/user');
		if (user.login) return user.login;
	} catch (e) {
		if (!(e instanceof GitHubError) || (e.status !== 403 && e.status !== 401)) throw e;
	}
	return ACTIONS_BOT;
}

const same_login = (a: string | null | undefined, b: string) =>
	typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The oldest comment on the issue that carries the marker and was written by `login`. Anyone can
 * paste the marker into a comment of their own; such a comment is never edited or adopted.
 */
async function find_comment(
	request: Request,
	repo: string,
	issue: number,
	login: string
): Promise<Comment | null> {
	for (let page = 1; ; page++) {
		const comments = await request<Comment[]>(
			'GET',
			`/repos/${repo}/issues/${issue}/comments?per_page=${PAGE}&page=${page}`
		);
		const found = comments.find(
			(c) => same_login(c.user?.login, login) && c.body?.includes(MARKER)
		);
		if (found) return found;
		if (comments.length < PAGE) return null;
	}
}

/**
 * Set one section of the benchmark comment, creating the comment when the PR has none. Every other
 * section is kept, and a comment from before sections is migrated (see sections.ts). A body that
 * would pass GitHub's size limit has its longest sections cut, with a note.
 */
export async function upsertComment(opts: UpsertOptions): Promise<UpsertResult> {
	const request = client(opts);
	const tries = opts.tries ?? 3;
	const settle_ms = opts.settleMs ?? 5000;
	let login = await own_login(request, opts.botLogin);
	const run = opts.runUrl ? ` [The run](${opts.runUrl}) has the full text.` : '';
	const fit = {
		note: (name: string) =>
			name === opts.section
				? `⚠️ Cut here: this section is longer than a GitHub comment holds.${run || ' The run that wrote it has the full text.'}`
				: `⚠️ The \`${name}\` section was cut here to make room: the run that wrote it has the full text.`
	};
	let created = false;
	for (let write = 1; ; write++) {
		const found = await find_comment(request, opts.repo, opts.issue, login);
		const before = sectionOf(found?.body, opts.section);
		const body = upsertSection(found?.body, opts.section, opts.content, fit);
		const ours = sectionOf(body, opts.section);
		let id: number;
		if (found) {
			id = found.id;
			if (body !== found.body)
				await request('PATCH', `/repos/${opts.repo}/issues/comments/${id}`, { body });
		} else {
			const c = await request<Comment>(
				'POST',
				`/repos/${opts.repo}/issues/${opts.issue}/comments`,
				{
					body
				}
			);
			id = c.id;
			created = true;
			// The token comments as someone else than assumed (an App's own bot): the next run would
			// not find this comment and post another one.
			const author = c.user?.login;
			if (author && !same_login(author, login)) {
				console.warn(
					`::warning title=Comment author::the token comments as ${author}, not ${login}; pass --bot-login ${author} (or set BENCH_BOT_LOGIN) so later runs edit this comment`
				);
				login = author;
			}
		}
		if (write >= tries) return { id, created, writes: write, login };
		if (settle_ms > 0) await sleep(settle_ms);
		// Read back. Our section put back to what we replaced (or gone) means another writer saved
		// the copy it had read before our write: write again. Any other content is a newer write of
		// this section (a later run), which wins.
		const now = await find_comment(request, opts.repo, opts.issue, login);
		const current = sectionOf(now?.body, opts.section);
		const reverted = now === null || current === null || (current !== ours && current === before);
		if (!reverted) return { id, created, writes: write, login };
	}
}
