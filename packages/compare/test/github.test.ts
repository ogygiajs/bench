import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertComment } from '../src/github.ts';
import { MARKER, HEADING, parseComment, sectionOf, upsertSection } from '../src/sections.ts';

interface Comment {
	id: number;
	body: string;
}

/** A fake of the three GitHub endpoints the upsert uses, over one PR's comments. */
function fake_github(
	initial: Comment[],
	hooks: { afterWrite?: (comments: Comment[]) => void } = {}
) {
	const comments = initial.map((c) => ({ ...c }));
	const calls: string[] = [];
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
		if (list && method === 'GET') {
			const per_page = Number(url.searchParams.get('per_page'));
			const page = Number(url.searchParams.get('page'));
			return json(comments.slice((page - 1) * per_page, page * per_page));
		}
		if (list && method === 'POST') {
			const c = { id: next_id++, body: JSON.parse(String(init?.body)).body };
			comments.push(c);
			hooks.afterWrite?.(comments);
			return json(c, 201);
		}
		if (one && method === 'PATCH') {
			const c = comments.find((x) => x.id === Number(one[1]));
			if (!c) return json({ message: 'Not Found' }, 404);
			c.body = JSON.parse(String(init?.body)).body;
			hooks.afterWrite?.(comments);
			return json(c);
		}
		return json({ message: 'unexpected' }, 500);
	};
	return { comments, calls, fetch: fetch_fn as typeof fetch };
}

const base = { repo: 'o/r', issue: 7, token: 't', api: 'https://api.test', settleMs: 0 };

test('no comment yet: one is created with the section', async () => {
	const gh = fake_github([{ id: 1, body: 'unrelated' }]);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'abax', content: 'fast' });
	assert.equal(r.created, true);
	assert.equal(gh.comments.length, 2);
	assert.deepEqual(parseComment(gh.comments[1].body), [{ name: 'abax', content: 'fast' }]);
});

test('the existing comment is edited in place and keeps the other section', async () => {
	const gh = fake_github([
		{ id: 1, body: 'unrelated' },
		{ id: 2, body: upsertSection(null, 'abax', 'abax numbers') }
	]);
	const r = await upsertComment({
		...base,
		fetch: gh.fetch,
		section: 'apps',
		content: 'app numbers'
	});
	assert.deepEqual(r, { id: 2, created: false, writes: 1 });
	assert.equal(gh.comments.length, 2);
	assert.equal(sectionOf(gh.comments[1].body, 'abax'), 'abax numbers');
	assert.equal(sectionOf(gh.comments[1].body, 'apps'), 'app numbers');
});

test('an old single-body comment is migrated: its body becomes the apps section', async () => {
	const legacy = `${MARKER}\n${HEADING}\n\nold app numbers\n`;
	const gh = fake_github([{ id: 5, body: legacy }]);
	await upsertComment({ ...base, fetch: gh.fetch, section: 'abax', content: 'abax numbers' });
	assert.deepEqual(parseComment(gh.comments[0].body), [
		{ name: 'abax', content: 'abax numbers' },
		{ name: 'apps', content: 'old app numbers' }
	]);
});

test('the marker comment is found past the first page', async () => {
	const filler = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: `c${i}` }));
	const gh = fake_github([...filler, { id: 500, body: upsertSection(null, 'apps', 'x') }]);
	const r = await upsertComment({ ...base, fetch: gh.fetch, section: 'abax', content: 'y' });
	assert.equal(r.id, 500);
	assert.ok(gh.calls.some((c) => c.includes('page=2')));
});

test('an unchanged section is not written again', async () => {
	const body = upsertSection(null, 'apps', 'same');
	const gh = fake_github([{ id: 3, body }]);
	await upsertComment({ ...base, fetch: gh.fetch, section: 'apps', content: 'same' });
	assert.equal(gh.calls.filter((c) => c.startsWith('PATCH')).length, 0);
});

test('a writer that saved its stale copy over ours is repaired by writing again', async () => {
	const start = upsertSection(null, 'apps', 'app numbers');
	let clobbered = false;
	const gh = fake_github([{ id: 9, body: start }], {
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
		section: 'abax',
		content: 'abax numbers'
	});
	assert.equal(r.writes, 2);
	assert.equal(sectionOf(gh.comments[0].body, 'abax'), 'abax numbers');
	assert.equal(sectionOf(gh.comments[0].body, 'apps'), 'newer app numbers');
});

test('a newer write of the same section wins over ours', async () => {
	let replaced = false;
	const gh = fake_github([{ id: 9, body: upsertSection(null, 'apps', 'old') }], {
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
	const failing = (async () => new Response('nope', { status: 403 })) as typeof fetch;
	await assert.rejects(
		upsertComment({ ...base, fetch: failing, section: 'apps', content: 'x' }),
		/403/
	);
});
