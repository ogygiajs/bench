import { bench } from '../../../src/bench.ts';
import { round_trip } from './lib.ts';

bench('devalue round trip', ({ value }) => round_trip(value), {
	setup: () => ({
		value: { list: [1, 2, 3], when: new Map([['a', { deep: true }]]), name: 'x' }
	})
});
