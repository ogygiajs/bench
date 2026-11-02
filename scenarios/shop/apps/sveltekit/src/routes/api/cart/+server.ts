import { handleCart } from '$lib/shared/visitor.ts';

export const POST = ({ request }) => handleCart(request);
