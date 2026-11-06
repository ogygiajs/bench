/** Coverage of the app scenarios (spec 8) and the input recorder for what they leave. */
export { build_coverage, render_coverage, COVERAGE_SCHEMA } from './report.ts';
export type {
	CoverageFunction,
	CoverageReport,
	CoverageStatus,
	PackageCoverage
} from './report.ts';
export { loaded_inventory, package_inventory } from './inventory.ts';
export type { Inventory, InventoryFunction } from './inventory.ts';
export { record_transform } from './record-transform.ts';
export type { RecordTransformOptions, RecordTransformResult } from './record-transform.ts';
export { abax_record_plugin } from './plugin.ts';
export type { RecordPluginOptions } from './plugin.ts';
export { Recorder, load_records, recorder, replay } from './recorder.ts';
export type { FunctionRecord, ReplayResult, ReplayStatus, Sample } from './recorder.ts';
