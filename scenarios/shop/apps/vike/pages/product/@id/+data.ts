import { render } from 'vike/abort';
import products from '../../../src/lib/shared/data/products.json';
import { productPage } from '../../../src/lib/shared/catalog.ts';
import { visitorOf } from '../../visitor.ts';

export const data = (pageContext) => {
	const page = productPage(products, pageContext.routeParams.id);
	if (!page) throw render(404);
	return { ...page, visitor: visitorOf(pageContext) };
};
