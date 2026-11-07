import { parse, stringify } from 'devalue';

export function round_trip(value: unknown): unknown {
	return parse(stringify(value));
}
