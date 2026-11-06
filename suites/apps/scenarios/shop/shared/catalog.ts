// Catalog lookups every app uses: a product and the four after it as "related".
export function productPage(products, id) {
	const i = products.findIndex((p) => p.id === id);
	if (i < 0) return null;
	const related = [1, 2, 3, 4].map((k) => products[(i + k) % products.length]);
	return { product: products[i], related };
}
