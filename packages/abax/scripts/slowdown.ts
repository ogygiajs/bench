/**
 * How much slower instrumented code runs than the original, on a sample workload.
 *
 *   node scripts/slowdown.ts [--words 4000] [--rounds 7]
 *
 * Three timings of the same function, median of rounds:
 *   plain     the uninstrumented module
 *   counting  the instrumented module (block counters, call stack, dynamic costs)
 *   window    instrumented, inside the measuring window (priced built-ins + deterministic env)
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register_abax } from '../src/loader/register.ts';
import { get_runtime } from '../src/runtime/index.ts';
import { Builtins } from '../src/runtime/builtins.ts';
import { Determinism } from '../src/runtime/determinism.ts';

type Workload = typeof import('./sample/workload.ts');

function arg(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const words = arg('words', 4000);
const rounds = arg('rounds', 7);
const here = fileURLToPath(new URL('.', import.meta.url));
const file = pathToFileURL(join(here, 'sample', 'workload.ts')).href;

const plain = (await import(file)) as Workload;
register_abax({ root: here });
const counted = (await import(file + '?abax')) as Workload;

const input = plain.make_input(words);
const real_now = performance.now.bind(performance);

function time(w: Workload, iterations: number): number {
	const t0 = real_now();
	for (let i = 0; i < iterations; i++) w.run(input);
	return real_now() - t0;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[s.length >> 1];
}

// pick an iteration count that runs ~200 ms uninstrumented
let iterations = 1;
while (time(plain, iterations) < 200) iterations *= 2;

const rt = get_runtime();
const builtins = new Builtins(rt);
const det = new Determinism();
const plain_ms: number[] = [];
const counting_ms: number[] = [];
const window_ms: number[] = [];
for (let r = 0; r < rounds; r++) {
	plain_ms.push(time(plain, iterations));
	rt.reset();
	counting_ms.push(time(counted, iterations));
	rt.reset();
	det.open('replay');
	builtins.install();
	try {
		window_ms.push(time(counted, iterations));
	} finally {
		builtins.uninstall();
		det.close();
	}
}
const steps = rt.snapshot().steps / iterations;
const p = median(plain_ms);
const c = median(counting_ms);
const w = median(window_ms);
console.log(
	`workload: ${words} words, ${iterations} iterations x ${rounds} rounds, ${Math.round(steps)} steps per run`
);
console.log(`plain     ${p.toFixed(1)} ms`);
console.log(`counting  ${c.toFixed(1)} ms   ${(c / p).toFixed(2)}x`);
console.log(`window    ${w.toFixed(1)} ms   ${(w / p).toFixed(2)}x`);
