import { handleCart } from '../../shared/visitor.ts';

export const prerender = false;

export const POST = ({ request }) => handleCart(request);
