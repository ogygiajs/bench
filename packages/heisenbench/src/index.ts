/**
 * Heisenbench: a deterministic function-level benchmark engine.
 *
 * Public API (camelCase); the modules behind it use snake_case internally.
 */
export { bench } from './bench.ts';
export type { BenchCase, BenchOptions } from './bench.ts';
export { transform } from './transform/index.ts';
export type { TransformOptions, TransformResult } from './transform/index.ts';
export { heisenbench_plugin as heisenbench } from './plugin.ts';
export type { HeisenbenchPluginOptions } from './plugin.ts';
export { register_heisenbench as registerHeisenbench } from './loader/register.ts';
export type { LoaderConfig } from './loader/register.ts';
export { run_benches as runBenches } from './runner.ts';
export type { RunOptions } from './runner.ts';
export { diff_reports as diffReports } from './diff/index.ts';
export type { DiffResult, Finding, FunctionChange } from './diff/index.ts';
export { render_markdown as renderMarkdown, SECTION_MARKER } from './diff/markdown.ts';
export { git_diff as gitDiff } from './diff/git.ts';
export { code as markdownCode, cell as markdownCell } from './md.ts';
export { env_mismatch as envMismatch, environment } from './report.ts';
export type { Environment, LoadError as ReportLoadError } from './report.ts';
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
export {
	run_recorded_growth as runRecordedGrowth,
	render_recorded_growth as renderRecordedGrowth,
	recorded_findings as recordedFindings
} from './growth/recorded.ts';
export type {
	RecordedGrowth,
	RecordedGrowthReport,
	RecordedGrowthOptions
} from './growth/recorded.ts';
export { run_search as runSearch, diff_search as diffSearch } from './search/index.ts';
export {
	run_audit as runAudit,
	merge_audits as mergeAudits,
	locate_findings as locateAuditFindings
} from './audit/index.ts';
export type { AuditOptions } from './audit/index.ts';
export { analyze_audit as analyzeAudit } from './audit/fit.ts';
export type { AuditReport, AuditCase, AuditFinding, AuditInput } from './audit/fit.ts';
export { render_audit as renderAudit } from './audit/markdown.ts';
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
