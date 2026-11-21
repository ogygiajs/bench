import { setFlagsFromString } from 'node:v8';

/*
 * V8 flags every Heisenbench process sets for itself, first thing (each entry point imports this
 * module before any other; test/exit.test.ts checks that).
 *
 * `--no-concurrent-sparkplug`: Sparkplug compiles on the main thread, not on a V8 worker thread.
 * A worker-thread compile that runs out of heap waits for the main thread to collect garbage.
 * When the main thread is then leaving (process.exit joins the worker threads, and a natural exit
 * drains their tasks: nodejs/node#54918), neither side moves and the process hangs at 0% CPU after
 * its work is done. Big heaps make it likely: a run that writes a 200 MB report hung about one
 * time in three. Counts do not change: Heisenbench counts its own instrumentation, not what V8
 * compiled. NODE_OPTIONS refuses V8 flags, so it is set here; Node does not freeze V8's flags
 * after start, and new compile batches read the flag when they start.
 */
export const V8_FLAGS: readonly string[] = ['--no-concurrent-sparkplug'];

for (const flag of V8_FLAGS) setFlagsFromString(flag);
