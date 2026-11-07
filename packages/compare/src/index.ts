// Types are re-exported on their own (`export type`), so a declaration bundler that builds this
// package into another (Abax's npm build) keeps them.
export { MIN_REPEATS, floorOf, judge, median, spreadOf } from './noise.ts';
export type { Rule, Verdict } from './noise.ts';
export { markOf, range, signed } from './format.ts';
export type { Format } from './format.ts';
export {
	COMMENT_LIMIT,
	COMMENT_TARGET,
	HEADING,
	LEGACY_SECTION,
	MARKER,
	SECTION_ORDER,
	endMarker,
	fitSections,
	parseComment,
	renderComment,
	sectionOf,
	startMarker,
	truncateSection,
	upsertSection
} from './sections.ts';
export type { FitOptions, Section } from './sections.ts';
export { ACTIONS_BOT, upsertComment } from './github.ts';
export type { UpsertOptions, UpsertResult } from './github.ts';
