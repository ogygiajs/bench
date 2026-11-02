import { handleChat } from '$lib/shared/stream.ts';

export const POST = ({ request }) => handleChat(request);
