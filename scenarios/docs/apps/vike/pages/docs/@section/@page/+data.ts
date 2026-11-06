import pages from '../../../../src/lib/shared/data/pages.json';

export const data = (pageContext) => ({
	page: pages[`${pageContext.routeParams.section}/${pageContext.routeParams.page}`]
});
