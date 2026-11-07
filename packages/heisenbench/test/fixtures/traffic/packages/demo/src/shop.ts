export interface Item {
	price: number;
	qty: number;
}

export function total(items: Item[]): number {
	return items.reduce((sum: number, it: Item) => sum + it.price * it.qty, 0);
}

export class Cart {
	items: Item[] = [];

	add(item: Item): void {
		this.items.push(item);
	}

	cheapest(): Item | undefined {
		return [...this.items].sort((a: Item, b: Item) => a.price - b.price)[0];
	}
}
