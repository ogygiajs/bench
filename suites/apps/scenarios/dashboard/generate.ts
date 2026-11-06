// Generate the dashboard scenario's data: 1,000 orders, revenue by region, and the starting point
// of the live panel. Deterministic (seeded).
//
//   node scenarios/dashboard/generate.ts   → scenarios/dashboard/shared/data/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./shared/data/', import.meta.url));
let seed = 424242;
const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const pick = (xs) => xs[next() % xs.length];

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const PRODUCTS = [
	'Starter plan',
	'Team plan',
	'Business plan',
	'Add-on seats',
	'Support pack',
	'Storage 1 TB'
];
const STATUSES = ['paid', 'paid', 'paid', 'pending', 'refunded', 'failed'];
const FIRST = [
	'Ada',
	'Grace',
	'Alan',
	'Linus',
	'Margaret',
	'Ken',
	'Barbara',
	'Dennis',
	'Frances',
	'Edsger',
	'Radia',
	'Tim'
];
const LAST = [
	'Lovelace',
	'Hopper',
	'Turing',
	'Torvalds',
	'Hamilton',
	'Thompson',
	'Liskov',
	'Ritchie',
	'Allen',
	'Dijkstra',
	'Perlman',
	'Berners-Lee'
];

const START = Date.UTC(2026, 9, 1);
const orders = Array.from({ length: 1000 }, (_, i) => ({
	id: `ORD-${String(10000 + i)}`,
	customer: `${pick(FIRST)} ${pick(LAST)}`,
	region: pick(REGIONS),
	product: pick(PRODUCTS),
	status: pick(STATUSES),
	amount: 20 + (next() % 4980) + (next() % 100) / 100,
	date: new Date(START + (next() % (30 * 86400)) * 1000).toISOString().slice(0, 10)
}));

const regions = REGIONS.map((name) => ({
	name,
	revenue: Math.round(
		orders.filter((o) => o.region === name && o.status === 'paid').reduce((s, o) => s + o.amount, 0)
	)
}));

// The live panel: four KPIs and the last 60 points of revenue per minute.
const live = {
	seed: 99,
	kpis: [
		{ id: 'revenue', label: 'Revenue today', value: 48210 },
		{ id: 'orders', label: 'Orders today', value: 312 },
		{ id: 'aov', label: 'Average order', value: 154.5 },
		{ id: 'active', label: 'Active users', value: 1873 }
	],
	series: Array.from({ length: 60 }, () => 600 + (next() % 400))
};

const dashboard = { orders, regions, live };
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'public', 'api'), { recursive: true });
writeFileSync(join(OUT, 'dashboard.json'), JSON.stringify(dashboard));
// What the client-rendered SPA fetches; the server apps import dashboard.json directly.
writeFileSync(join(OUT, 'public', 'api', 'dashboard.json'), JSON.stringify(dashboard));
console.log(
	`  dashboard: ${orders.length} orders, ${(JSON.stringify(dashboard).length / 1024).toFixed(0)} KB`
);
