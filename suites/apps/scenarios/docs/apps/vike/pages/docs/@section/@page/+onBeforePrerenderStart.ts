import pages from '../../../../src/lib/shared/data/pages.json';

export const onBeforePrerenderStart = () => Object.keys(pages).map((slug) => `/docs/${slug}`);
