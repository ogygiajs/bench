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
}

interface Comment {
	id: number;
	body?: string | null;
}

const PAGE = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	};
}

/** The oldest comment on the issue that carries the marker. */
async function find_comment(
	request: ReturnType<typeof client>,
	repo: string,
	issue: number
): Promise<Comment | null> {
	for (let page = 1; ; page++) {
		const comments = await request<Comment[]>(
			'GET',
			`/repos/${repo}/issues/${issue}/comments?per_page=${PAGE}&page=${page}`
		);
		const found = comments.find((c) => c.body?.includes(MARKER));
		if (found) return found;
		if (comments.length < PAGE) return null;
	}
}

/**
 * Set one section of the benchmark comment, creating the comment when the PR has none. Every other
 * section is kept, and a comment from before sections is migrated (see sections.ts).
 */
export async function upsertComment(opts: UpsertOptions): Promise<UpsertResult> {
	const request = client(opts);
	const tries = opts.tries ?? 3;
	const settle_ms = opts.settleMs ?? 5000;
	const ours = sectionOf(upsertSection(null, opts.section, opts.content), opts.section);
	let created = false;
	for (let write = 1; ; write++) {
		const found = await find_comment(request, opts.repo, opts.issue);
		const before = sectionOf(found?.body, opts.section);
		const body = upsertSection(found?.body, opts.section, opts.content);
		let id: number;
		if (found) {
			id = found.id;
			if (body !== found.body)
				await request('PATCH', `/repos/${opts.repo}/issues/comments/${id}`, { body });
		} else {
			id = (
				await request<Comment>('POST', `/repos/${opts.repo}/issues/${opts.issue}/comments`, {
					body
				})
			).id;
			created = true;
		}
		if (write >= tries) return { id, created, writes: write };
		if (settle_ms > 0) await sleep(settle_ms);
		// Read back. Our section put back to what we replaced (or gone) means another writer saved
		// the copy it had read before our write: write again. Any other content is a newer write of
		// this section (a later run), which wins.
		const now = await find_comment(request, opts.repo, opts.issue);
		const current = sectionOf(now?.body, opts.section);
		const reverted = now === null || current === null || (current !== ours && current === before);
		if (!reverted) return { id, created, writes: write };
	}
}
