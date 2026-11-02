import { handleChat } from '../../shared/stream.ts';

export const POST = ({ request }) => handleChat(request);
