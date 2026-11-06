import { error } from '@sveltejs/kit';
import products from '$lib/shared/data/products.json';
import { productPage } from '$lib/shared/catalog.ts';

export const load = ({ params }) => productPage(products, params.id) ?? error(404, 'Not found');
