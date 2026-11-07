export function heavy(n) {
	let s = 0;
	for (let i = 0; i < n; i++) s += i % 7;
	return s;
}
export class Box {
	constructor(n) {
		this.v = heavy(n);
	}
	get twice() {
		let s = 0;
		for (let i = 0; i < 3e5; i++) s += i & 3;
		return s;
	}
}
export const light = (n) =>
	[1, 2, 3].map((x) => {
		let s = 0;
		for (let i = 0; i < n; i++) s += x;
		return s;
	});
