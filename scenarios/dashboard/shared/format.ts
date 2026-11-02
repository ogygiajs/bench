// Number formatting shared by every dashboard component (same output on server and client).
export const money = (n) =>
	'$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const whole = (n) => Math.round(n).toLocaleString('en-US');

/** The live panel's deterministic random walk: the same ticks in every app. */
export function walker(seed) {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return (s % 2001) / 1000 - 1; // -1 … 1
	};
}

/** The table's filter, also used by the scenario script to know the expected row counts. */
export function filterOrders(orders, q, status) {
	const needle = q.trim().toLowerCase();
	return orders.filter(
		(o) =>
			(status === 'all' || o.status === status) &&
			(!needle ||
				o.id.toLowerCase().includes(needle) ||
				o.customer.toLowerCase().includes(needle) ||
				o.region.toLowerCase().includes(needle) ||
				o.product.toLowerCase().includes(needle))
	);
}
