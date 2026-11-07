import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS_BOT, upsertComment } from '../src/github.ts';
import {
	COMMENT_LIMIT,
	MARKER,
	HEADING,
	parseComment,
	sectionOf,
	upsertSection
} from '../src/sections.ts';

interface Comment {
	id: number;
	body: string;
	user: { login: string };
}

const BOT = 'bench-bot';

/** A comment by `login` (default: the token's own login). */
const by = (id: number, body: string, login = BOT): Comment => ({ id, body, user: { login } });

/**
 * A fake of the GitHub endpoints the upsert uses, over one PR's comments. `me` is the login the
 * token writes as; `user_status` what GET /user answers (200 with `me`, or an error status).
 */
function fake_github(
	initial: Comment[],
	hooks: {
		afterWrite?: (comments: Comment[]) => void;
		me?: string;
		user_status?: number;
	} = {}
) {
	const comments = initial.map((c) => ({ ...c }));
	const calls: string[] = [];
	const me = hooks.me ?? BOT;
	let next_id = 1000;
	const fetch_fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		calls.push(`${method} ${url.pathname}${url.search}`);
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { 'content-type': 'application/json' }
			});
		const list = url.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
		const one = url.pathname.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/);
		if (url.pathname === '/user' && method === 'GET') {
			const status = hooks.user_status ?? 200;
			return status === 200
				? json({ login: me })
				: json({ message: 'Resource not accessible by integration' }, status);
		}
		if (list && method === 'GET') {
			const per_page = Number(url.searchParams.get('per_page'));
			const page = Number(url.searchParams.get('page'));
			return json(comments.slice((page - 1) * per_page, page * per_page));
		}
		if (list && method === 'POST') {
			const body = JSON.parse(String(init?.body)).body as string;
			if (body.length > COMMENT_LIMIT) return json({ message: 'Body is too long' }, 422);
			const c = by(next_id++, body, me);
			comments.push(c);
			hooks.afterWrite?.(comments);
			return json(c, 201);
		}
		if (one && method === 'PATCH') {
			const c = comments.find((x) => x.id === Number(one[1]));
			if (!c) return json({ message: 'Not Found' }, 404);
			// GitHub logins are case-insensitive
			if (c.user.login.toLowerCase() !== me.toLowerCase())
				return json({ message: 'Forbidden' }, 403);
			const body = JSON.parse(String(init?.body)).body as string;
			if (body.length > COMMENT_LIMIT) return json({ message: 'Body is too long' }, 422);
			c.body = body;
			hooks.afterWrite?.(comments);
			return json(c);
		}
		return json({ message: 'unexpected' }, 500);
	};
	return { comments, calls, fetch: fetch_fn as typeof fetch };
}

const base = { repo: 'o/r', issue: 7, token: 't', api: 'https://api.test', settleMs: 0 };

test('no comment yet: one is created with the section', async () => {
	const gh = fake_github([by(1, 'unrelated', 'someone')]);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'fast' });
	assert.equal(r.created, true);
	assert.equal(gh.comments.length, 2);
	assert.deepEqual(parseComment(gh.comments[1].body), [{ name: 'heisenbench', content: 'fast' }]);
});

test('the existing comment is edited in place and keeps the other section', async () => {
	const gh = fake_github([
		by(1, 'unrelated', 'someone'),
		by(2, upsertSection(null, 'heisenbench', 'heisenbench numbers'))
	]);
	const r = await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'apps',
		content: 'app numbers'
	});
	assert.deepEqual(r, { id: 2, created: false, writes: 1, login: BOT });
	assert.equal(gh.comments.length, 2);
	assert.equal(sectionOf(gh.comments[1].body, 'heisenbench'), 'heisenbench numbers');
	assert.equal(sectionOf(gh.comments[1].body, 'apps'), 'app numbers');
});

test('an old single-body comment is migrated: its body becomes the apps section', async () => {
	const legacy = `${MARKER}\n${HEADING}\n\nold app numbers\n`;
	const gh = fake_github([by(5, legacy)]);
	await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'heisenbench numbers' });
	assert.deepEqual(parseComment(gh.comments[0].body), [
		{ name: 'heisenbench', content: 'heisenbench numbers' },
		{ name: 'apps', content: 'old app numbers' }
	]);
});

test('the marker comment is found past the first page', async () => {
	const filler = Array.from({ length: 150 }, (_, i) => by(i + 1, `c${i}`, 'someone'));
	const gh = fake_github([...filler, by(500, upsertSection(null, 'apps', 'x'))]);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'y' });
	assert.equal(r.id, 500);
	assert.ok(gh.calls.some((c) => c.includes('page=2')));
});

test('an unchanged section is not written again', async () => {
	const body = upsertSection(null, 'apps', 'same');
	const gh = fake_github([by(3, body)]);
	await upsertComment({ ...base, fetch: gh.fetch, section: 'apps', content: 'same' });
	assert.equal(gh.calls.filter((c) => c.startsWith('PATCH')).length, 0);
});

test('a writer that saved its stale copy over ours is repaired by writing again', async () => {
	const start = upsertSection(null, 'apps', 'app numbers');
	let clobbered = false;
	const gh = fake_github([by(9, start)], {
		// Right after our first write, another suite saves the body it read before it.
		afterWrite: (comments) => {
			if (clobbered) return;
			clobbered = true;
			comments[0].body = upsertSection(start, 'apps', 'newer app numbers');
		}
	});
	const r = await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'heisenbench',
		content: 'heisenbench numbers'
	});
	assert.equal(r.writes, 2);
	assert.equal(sectionOf(gh.comments[0].body, 'heisenbench'), 'heisenbench numbers');
	assert.equal(sectionOf(gh.comments[0].body, 'apps'), 'newer app numbers');
});

test('a newer write of the same section wins over ours', async () => {
	let replaced = false;
	const gh = fake_github([by(9, upsertSection(null, 'apps', 'old'))], {
		afterWrite: (comments) => {
			if (replaced) return;
			replaced = true;
			comments[0].body = upsertSection(comments[0].body, 'apps', 'from a later run');
		}
	});
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'apps', content: 'ours' });
	assert.equal(r.writes, 1);
	assert.equal(sectionOf(gh.comments[0].body, 'apps'), 'from a later run');
});

test('a failed request is an error', async () => {
	const failing = (async () => new Response('nope', { status: 500 })) as typeof fetch;
	await assert.rejects(
		upsertComment({ ...base, fetch: failing, section: 'apps', content: 'x' }),
		/500/
	);
});

test('a marker planted by someone else is neither edited nor adopted', async () => {
	const planted = upsertSection(null, 'heisenbench', 'fake numbers');
	const gh = fake_github([by(1, planted, 'mallory'), by(2, `${MARKER}\nme too`, 'mallory')]);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'real' });
	assert.equal(r.created, true);
	assert.equal(gh.comments.length, 3);
	assert.equal(gh.comments[0].body, planted);
	assert.equal(sectionOf(gh.comments[2].body, 'heisenbench'), 'real');
	assert.equal(gh.calls.filter((c) => c.startsWith('PATCH')).length, 0);
	// and the next run edits its own comment, not the planted one
	await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'newer' });
	assert.equal(gh.comments.length, 3);
	assert.equal(sectionOf(gh.comments[2].body, 'heisenbench'), 'newer');
});

test('logins compare without case', async () => {
	const gh = fake_github([by(4, upsertSection(null, 'apps', 'x'), 'Bench-Bot')], {
		me: 'bench-bot'
	});
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'y' });
	assert.equal(r.id, 4);
});

test('a token GET /user refuses (GITHUB_TOKEN, an App) comments as github-actions[bot]', async () => {
	const gh = fake_github(
		[
			by(1, upsertSection(null, 'apps', 'planted'), 'mallory'),
			by(2, upsertSection(null, 'apps', 'a'), ACTIONS_BOT)
		],
		{ me: ACTIONS_BOT, user_status: 403 }
	);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'heisenbench', content: 'b' });
	assert.deepEqual(r, { id: 2, created: false, writes: 1, login: ACTIONS_BOT });
});

test('an explicit bot login wins, and GET /user is not asked', async () => {
	const gh = fake_github([by(1, upsertSection(null, 'apps', 'a'), 'bench-app[bot]')], {
		me: 'bench-app[bot]',
		user_status: 403
	});
	const r = await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'heisenbench',
		content: 'b',
		botLogin: 'bench-app[bot]'
	});
	assert.equal(r.id, 1);
	assert.equal(gh.calls.filter((c) => c === 'GET /user').length, 0);
});

test('an App token without --bot-login: the created comment tells the real author', async () => {
	const gh = fake_github([], { me: 'bench-app[bot]', user_status: 403 });
	const r = await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'heisenbench',
		content: 'b',
		tries: 2
	});
	// the read-back found the comment under its real author: one write, no second comment
	assert.equal(r.login, 'bench-app[bot]');
	assert.equal(r.writes, 1);
	assert.equal(gh.comments.length, 1);
});

test('a section too long for GitHub is cut with a note, and the other section is kept', async () => {
	const apps = '#### App benchmark\n\n| a |\n| --- |\n| 1 |';
	const gh = fake_github([by(1, upsertSection(null, 'apps', apps))]);
	const rows = Array.from({ length: 5000 }, (_, i) => `| row ${i} | ${'x'.repeat(20)} |`);
	const huge = [
		'#### Heisenbench',
		'',
		'<details><summary>All</summary>',
		'',
		...rows,
		'',
		'</details>'
	].join('\n');
	await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'heisenbench',
		content: huge,
		runUrl: 'https://example.test/run/9'
	});
	const body = gh.comments[0].body;
	assert.ok(body.length <= COMMENT_LIMIT, `body is ${body.length}`);
	assert.equal(sectionOf(body, 'apps'), apps);
	const heisenbench = sectionOf(body, 'heisenbench')!;
	assert.ok(heisenbench.startsWith('#### Heisenbench'));
	assert.match(
		heisenbench,
		/Cut here: .* \[The run\]\(https:\/\/example\.test\/run\/9\) has the full text\.$/
	);
	// the <details> the cut left open is closed before the note
	assert.equal((heisenbench.match(/<details>/g) ?? []).length, (heisenbench.match(/<\/details>/g) ?? []).length);
});
