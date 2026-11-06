// The blog (khromov's interactive blog): the apps in frameworks/, unchanged. Lighthouse, JS and
// HTML size stay in the top-level blog result; this adds the browser-session metrics.
const h1 = (text) => `document.querySelector('h1')?.textContent?.includes(${JSON.stringify(text)})`;

export default {
	title: 'Blog: long static posts with five counters',
	routes: { small: '/posts/small', medium: '/posts/medium', large: '/posts/large' },
	ready: '/posts/small',
	stepNames: ['counter'],
	lighthouse: [],
	fidelity: {
		paths: ['/posts/medium'],
		print: () =>
			[
				document.querySelector('h1')?.textContent?.trim(),
				document.querySelectorAll('h2').length,
				document.querySelectorAll('.bench-counter').length
			].join('|')
	},
	async session(s) {
		await s.goto('/posts/large');
		// Each of the five counters once, top to bottom (the click scrolls it into view first).
		const buttons = s.page.locator('.bench-counter');
		for (let i = 0; i < 5; i++) {
			const before = await buttons.nth(i).textContent();
			const n = Number(before.replace(/\D+/g, '')) + 1;
			await buttons.nth(i).scrollIntoViewIfNeeded();
			await s.ready();
			await s.interact(
				'counter',
				() => buttons.nth(i).click(),
				`document.querySelectorAll('.bench-counter')[${i}]?.textContent?.trim() === 'count: ${n}'`
			);
		}
		// A short visit: the index, then each post from its link.
		await s.goto('/');
		for (const id of ['small', 'medium']) {
			await s.nav(id, (p) => p.click(`a[href="/posts/${id}"]`), h1('Benchmark post'));
			await s.page.goBack();
			await s.until(() => document.querySelector('a[href="/posts/large"]'));
			await s.ready();
		}
	},
	async long(s) {
		await s.goto('/posts/medium');
		const first = s.page.locator('.bench-counter').first();
		for (let i = 0; i < 50; i++) await first.click();
	}
};
