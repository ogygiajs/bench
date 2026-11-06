/**
 * Abax: a deterministic function-level benchmark engine.
 *
 * Public API (camelCase); the modules behind it use snake_case internally.
 */
export { bench } from './bench.ts';
export type { BenchCase, BenchOptions } from './bench.ts';
export { transform } from './transform/index.ts';
export type { TransformOptions, TransformResult } from './transform/index.ts';
export { abax_plugin as abax } from './plugin.ts';
export type { AbaxPluginOptions } from './plugin.ts';
export { register_abax as registerAbax } from './loader/register.ts';
export type { LoaderConfig } from './loader/register.ts';
export { run_benches as runBenches } from './runner.ts';
export type { RunOptions } from './runner.ts';
export { diff_reports as diffReports } from './diff/index.ts';
export type { DiffResult, Finding, FunctionChange } from './diff/index.ts';
export { render_markdown as renderMarkdown, SECTION_MARKER } from './diff/markdown.ts';
export { git_diff as gitDiff } from './diff/git.ts';
export { private_dts as privateDts, write_private_dts as writePrivateDts } from './dts.ts';
export { REPORT_SCHEMA } from './report.ts';
export type { Report, CaseReport, FunctionReport } from './report.ts';
export { engine_health as engineHealth } from './engine/health.ts';
export type { HealthOptions } from './engine/health.ts';
export { diff_engine as diffEngine } from './engine/diff.ts';
export type { EngineDiff, EngineFinding } from './engine/diff.ts';
export type { EngineReport, EngineCase, EngineFunction, EngineSite } from './engine/types.ts';
export { run_growth as runGrowth, diff_growth as diffGrowth } from './growth/index.ts';
export type { GrowthReport, GrowthCase, GrowthOptions } from './growth/index.ts';
export { scale_input as scaleInput } from './growth/scale.ts';
export { run_search as runSearch, diff_search as diffSearch } from './search/index.ts';
export type { SearchReport, SearchCase, SearchOptions } from './search/index.ts';
export { diff_sections as diffSections, render_sections as renderSections } from './sections.ts';
export { measure_layers as measureLayers } from './measure/index.ts';
export type { Layer, MeasureOptions } from './measure/index.ts';
export type { CaseMeasure, Estimate, BytesMeasure } from './measure/types.ts';
export { render_time as renderTime } from './measure/markdown.ts';
export type { TimeComparison, TimeStats } from './measure/time.ts';
export type { LeakResult } from './measure/leak.ts';
export { recount, align_prices as alignPrices } from './recount.ts';
export { load_prices as loadPrices } from './prices.ts';
export type { Units } from './units.ts';
export {
	calibrate_prices as calibratePrices,
	calibrate_weights as calibrateWeights
} from './calibrate/index.ts';
export type { Weights } from './calibrate/weights.ts';
