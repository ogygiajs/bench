import products from '../../src/lib/shared/data/products.json';
import { visitorOf } from '../visitor.ts';

export const data = (pageContext) => ({ products, visitor: visitorOf(pageContext) });
