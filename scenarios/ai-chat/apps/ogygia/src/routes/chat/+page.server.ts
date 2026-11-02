import history from '$lib/shared/data/history.json';

export const csr = false;

export const load = () => ({ messages: history });
