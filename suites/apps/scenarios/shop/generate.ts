// Generate the shop scenario's catalog: 48 products with prices, colors, descriptions and specs.
// Deterministic (seeded).
//
//   node scenarios/shop/generate.ts   → scenarios/shop/shared/data/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./shared/data/', import.meta.url));
let seed = 8080;
const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
const pick = (xs) => xs[next() % xs.length];

const ADJ = ['Classic', 'Everyday', 'Trail', 'Studio', 'Compact', 'Weekend', 'Urban', 'Field'];
const NOUN = ['Backpack', 'Jacket', 'Mug', 'Lamp', 'Notebook', 'Headphones', 'Bottle', 'Chair'];
const COLORS = [
	'#2563eb',
	'#16a34a',
	'#dc2626',
	'#9333ea',
	'#ea580c',
	'#0891b2',
	'#4b5563',
	'#ca8a04'
];
const WORDS =
	'made to last with a light frame and soft finish it fits a busy day and packs away small when you are done so you can take it anywhere'.split(
		' '
	);
const sentence = (n) => {
	const w = Array.from({ length: n }, () => pick(WORDS)).join(' ');
	return w[0].toUpperCase() + w.slice(1) + '.';
};

const products = Array.from({ length: 48 }, (_, i) => {
	const name = `${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length) % NOUN.length]}`;
	return {
		id: `p${String(i + 1).padStart(2, '0')}`,
		name,
		price: 19 + (next() % 280) + 0.99,
		color: pick(COLORS),
		rating: 3 + (next() % 21) / 10,
		description: [sentence(14), sentence(12), sentence(16)].join(' '),
		specs: [
			['Weight', `${200 + (next() % 1800)} g`],
			['Material', pick(['Recycled nylon', 'Cotton', 'Steel', 'Oak', 'Aluminium'])],
			['Warranty', `${1 + (next() % 4)} years`],
			['Ships in', `${1 + (next() % 5)} days`]
		]
	};
});

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'public', 'api'), { recursive: true });
writeFileSync(join(OUT, 'products.json'), JSON.stringify(products));
// What the client-rendered SPA fetches; the server apps import products.json directly.
writeFileSync(join(OUT, 'public', 'api', 'products.json'), JSON.stringify(products));
console.log(`  shop: ${products.length} products`);
