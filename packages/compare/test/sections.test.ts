import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	HEADING,
	MARKER,
	parseComment,
	renderComment,
	sectionOf,
	upsertSection
} from '../src/sections.ts';

const APPS = '#### Apps\n\n✅ **No regressions beyond noise.**\n\n| a | b |\n|---|---|\n| 1 | 2 |';
const ABAX = '#### Abax\n\nNo function got slower.';

test('a comment that does not exist yet gets the marker, the heading and the one section', () => {
	const body = upsertSection(null, 'apps', APPS);
	assert.equal(
		body,
		`${MARKER}\n${HEADING}\n\n<!-- section:apps -->\n${APPS}\n<!-- /section:apps -->\n`
	);
	assert.deepEqual(parseComment(body), [{ name: 'apps', content: APPS }]);
});

test('abax comes first, whichever section was written first', () => {
	const apps_first = upsertSection(upsertSection(null, 'apps', APPS), 'abax', ABAX);
	const abax_first = upsertSection(upsertSection(null, 'abax', ABAX), 'apps', APPS);
	assert.equal(apps_first, abax_first);
	assert.deepEqual(
		parseComment(apps_first).map((s) => s.name),
		['abax', 'apps']
	);
	assert.ok(
		apps_first.indexOf('<!-- section:abax -->') < apps_first.indexOf('<!-- section:apps -->')
	);
});

test('upserting one section keeps the other section byte for byte', () => {
	const tricky = 'line one\n\n  indented\n\n```\ncode -->\n```\n<!-- some other note -->';
	const body = upsertSection(upsertSection(null, 'abax', tricky), 'apps', APPS);
	const next = upsertSection(body, 'apps', '#### Apps\n\nnew numbers');
	assert.equal(sectionOf(next, 'abax'), tricky);
	assert.equal(sectionOf(next, 'apps'), '#### Apps\n\nnew numbers');
	const again = upsertSection(next, 'abax', ABAX);
	assert.equal(sectionOf(again, 'apps'), '#### Apps\n\nnew numbers');
});

test('the same upsert twice gives the same body', () => {
	const once = upsertSection(upsertSection(null, 'abax', ABAX), 'apps', APPS);
	assert.equal(upsertSection(once, 'apps', APPS), once);
	assert.equal(upsertSection(once, 'abax', ABAX), once);
});

test('a comment from before sections becomes the apps section', () => {
	const legacy = `${MARKER}\n${HEADING}\n\n✅ **No regressions beyond noise.**\n\nmore\n\n[Benchmark run](https://example.test/1)\n`;
	assert.deepEqual(parseComment(legacy), [
		{
			name: 'apps',
			content:
				'✅ **No regressions beyond noise.**\n\nmore\n\n[Benchmark run](https://example.test/1)'
		}
	]);
	// abax upserted into it: the old body is kept, as the apps section.
	const with_abax = upsertSection(legacy, 'abax', ABAX);
	assert.deepEqual(
		parseComment(with_abax).map((s) => s.name),
		['abax', 'apps']
	);
	assert.ok(sectionOf(with_abax, 'apps')?.startsWith('✅ **No regressions'));
	// apps upserted into it: the old body is replaced, nothing else is added.
	const with_apps = upsertSection(legacy, 'apps', APPS);
	assert.deepEqual(parseComment(with_apps), [{ name: 'apps', content: APPS }]);
});

test('the old failure comment migrates too', () => {
	const failed = `${MARKER}\n${HEADING}\n\n⚠️ The benchmark run for \`abc1234\` failed before it produced numbers.\n`;
	const body = upsertSection(failed, 'abax', ABAX);
	assert.equal(
		sectionOf(body, 'apps'),
		'⚠️ The benchmark run for `abc1234` failed before it produced numbers.'
	);
});

test('a CRLF body parses like an LF body', () => {
	const body = upsertSection(upsertSection(null, 'abax', ABAX), 'apps', APPS).replaceAll(
		'\n',
		'\r\n'
	);
	assert.equal(sectionOf(body, 'abax'), ABAX);
	assert.equal(sectionOf(body, 'apps'), APPS);
});

test('unknown sections are kept, after the known ones, in their order', () => {
	let body = upsertSection(null, 'zeta', 'z');
	body = upsertSection(body, 'apps', APPS);
	body = upsertSection(body, 'alpha', 'a');
	body = upsertSection(body, 'abax', ABAX);
	assert.deepEqual(
		parseComment(body).map((s) => s.name),
		['abax', 'apps', 'zeta', 'alpha']
	);
});

test('a section without its end marker runs to the end; a repeated name keeps the first', () => {
	const body = [
		MARKER,
		'<!-- section:abax -->',
		'first',
		'<!-- /section:abax -->',
		'<!-- section:abax -->',
		'second',
		'<!-- /section:abax -->',
		'<!-- section:apps -->',
		'no end'
	].join('\n');
	assert.deepEqual(parseComment(body), [
		{ name: 'abax', content: 'first' },
		{ name: 'apps', content: 'no end' }
	]);
});

test('text outside the sections is dropped on rewrite; the marker and heading are rendered', () => {
	const body = `${MARKER}\nstray\n<!-- section:apps -->\nx\n<!-- /section:apps -->\ntrailing`;
	assert.equal(
		upsertSection(body, 'abax', ABAX),
		renderComment([
			{ name: 'abax', content: ABAX },
			{ name: 'apps', content: 'x' }
		])
	);
});

test('leading blank lines and trailing whitespace of a section are not kept', () => {
	const body = upsertSection(null, 'apps', '\n\n  \n#### Apps\n\nx\n\n\n');
	assert.equal(sectionOf(body, 'apps'), '#### Apps\n\nx');
});

test('bad names and content that holds a section marker are refused', () => {
	assert.throws(() => upsertSection(null, 'Apps', 'x'), /bad section name/);
	assert.throws(() => upsertSection(null, 'a b', 'x'), /bad section name/);
	assert.throws(() => upsertSection(null, 'apps', 'x <!-- /section:apps --> y'), /markers/);
	assert.throws(() => upsertSection(null, 'apps', '<!-- section:abax -->'), /markers/);
});

test('an empty or missing body has no sections', () => {
	assert.deepEqual(parseComment(null), []);
	assert.deepEqual(parseComment(''), []);
	assert.deepEqual(parseComment(MARKER), []);
	assert.deepEqual(parseComment(`${MARKER}\n${HEADING}\n`), []);
});
