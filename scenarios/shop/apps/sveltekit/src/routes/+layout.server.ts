import { visitorFrom } from '$lib/shared/visitor.ts';

export const load = ({ cookies }) => ({ visitor: visitorFrom((name) => cookies.get(name)) });
