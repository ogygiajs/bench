import { error } from '@sveltejs/kit';
import pages from '$lib/shared/data/pages.json';

export const entries = () =>
	Object.keys(pages).map((slug) => {
		const [section, page] = slug.split('/');
		return { section, page };
	});

export const load = ({ params }) => {
	const page = pages[`${params.section}/${params.page}`];
	if (!page) error(404, 'Not found');
	return { page };
};
