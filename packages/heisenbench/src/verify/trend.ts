import { detect_trend } from '../trend/index.ts';
import { PLANTED_TRENDS, planted_series, trend_answer } from '../trend/planted.ts';
import type { PlantedTrend } from '../trend/planted.ts';
import type { Check } from './types.ts';

/*
 * The trend model on planted series of main commits (src/trend/planted.ts): a creep is found where
 * it starts, a step is a step and never a creep, a flat or churning series says nothing.
 */

function say(e: PlantedTrend['expect']): string {
	const creeps = e.creeps.map((c) => `${c.start} ${c.status}`).join(', ');
	return `${e.verdict}${creeps ? `; creep at ${creeps}` : ''}${e.steps.length > 0 ? `; step at ${e.steps.join(', ')}` : ''}`;
}

export function trend_checks(): Check[] {
	return PLANTED_TRENDS.map((p) => ({
		layer: 'trend',
		name: p.name,
		what: p.what,
		planted: p.expect.creeps.length > 0,
		expect: say(p.expect),
		exclusive: false,
		run: async () => {
			const got = trend_answer(detect_trend(planted_series(p.moves)));
			return { pass: JSON.stringify(got) === JSON.stringify(p.expect), got: say(got) };
		}
	}));
}
