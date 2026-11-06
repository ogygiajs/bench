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
