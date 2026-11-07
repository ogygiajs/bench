import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve_peer } from '../peer.ts';
import { show } from './equal.ts';
import { CandidateError, fmt, profile_original, prove_candidate } from './index.ts';
import type { ProveOptions, ProveReport, Target } from './index.ts';
import type { Sample } from '../coverage/recorder.ts';
import type { ProveChildResult } from './types.ts';
import { declaration_text } from './splice.ts';

/*
 * `heisenbench prove --propose`: a model proposes candidates for a flagged function, and each one
 * goes through the same proof as a hand-written candidate. Only proven ones are reported, and
 * the ones proven at scale, each under its own verdict; a rejected one never is.
 *
 * What the model is sent: the function's source, the lines with the most steps (line blame from
 * the original counted on its own inputs) and its growth. Recorded inputs are sent only with
 * `--send-inputs`: a test's inputs can hold secrets (tokens, keys, customer data in a fixture).
 * What comes back is source only; it is checked (safety.ts) and run only in the sandboxed child.
 *
 * The provider is a seam: tests inject one; the default calls the Claude API through the
 * Anthropic SDK (`@anthropic-ai/sdk`, installed by the project that proposes; Heisenbench does
 * not depend on it) with ANTHROPIC_API_KEY.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface ProposalRequest {
	function_id: string;
	/** The function's declaration as written. */
	source: string;
	/** The lines with the most steps at the largest input, with their text. */
	blame: Array<{ at: string; steps: number; share: number; text: string }>;
	/** The growth of the function's steps, in words. */
	growth: string;
	/** A few recorded inputs, as text (only with --send-inputs). */
	inputs: string[];
	/** Earlier proposals of this run and why each was not proven (no inputs unless --send-inputs). */
	tried: Array<{ source: string; outcome: string }>;
}

export interface Provider {
	name: string;
	/** One candidate's source (top-level declarations), or null when the model gave none. */
	propose(req: ProposalRequest): Promise<string | null>;
}

export const SETUP_MESSAGE = `heisenbench prove --propose asks a model for candidates, and needs an API key for it.

  1. Install the SDK in the project:   npm i -D @anthropic-ai/sdk
  2. Set the key (from https://platform.claude.com):   export ANTHROPIC_API_KEY=...
  3. Run again:   heisenbench prove <module> <function> --propose [--proposals 3] [--model ${DEFAULT_MODEL}]

What is sent: the function's source, its line blame and its growth. Recorded inputs are sent only
with --send-inputs (they can hold secrets). Nothing was sent and nothing was run.`;

/** Whether a key for the default provider is set. */
export function has_key(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You make one JavaScript or TypeScript function do less work while it behaves exactly the same.

"The same" is checked by running the original and your version on thousands of inputs: recorded ones, the same grown 10 and 100 times, and edge cases (empty, one element, duplicates, unsorted, ties, NaN, -0, very large numbers, unicode strings). Return values are compared deeply (Map and Set order, key order, undefined vs a missing key, -0 vs 0), errors by type and message, and the arguments after the call (do not change an argument the original does not change). Then both are counted: your version may not cost more steps than the original on any recorded input, and must cost fewer in total or grow more slowly.

Rules for the code:
- Keep the function's name, parameters and return type.
- You may add new top-level helper functions or constants next to it; give each a new name.
- No imports, no require, no dynamic import(), no process, globalThis, fetch, eval, Function, constructor or __proto__. It runs in a sandbox without them.
- Answer with the replacement declarations only, in one \`\`\`ts code block, nothing else.`;

function user_prompt(req: ProposalRequest): string {
	const parts = [
		`Function: ${req.function_id}`,
		'',
		'```ts',
		req.source,
		'```',
		'',
		`Growth: ${req.growth}`,
		''
	];
	if (req.blame.length > 0) {
		parts.push('The lines with the most steps at the largest input:');
		for (const b of req.blame)
			parts.push(`- ${b.at} (${Math.round(b.share * 100)}%, ${fmt(b.steps)} steps): ${b.text}`);
		parts.push('');
	}
	if (req.inputs.length > 0) {
		parts.push('Some recorded inputs (arguments):');
		for (const i of req.inputs) parts.push('```js', i, '```');
		parts.push('');
	}
	for (const [n, t] of req.tried.entries()) {
		parts.push(`Proposal ${n + 1} was not proven: ${t.outcome}`, '```ts', t.source, '```', '');
	}
	parts.push('Write the faster version.');
	return parts.join('\n');
}

/** The first fenced code block of a reply (or the whole reply when it has none). */
export function code_of(reply: string): string | null {
	const m = /```(?:ts|typescript|js|javascript)?[^\n]*\n([\s\S]*?)```/.exec(reply);
	const text = (m ? m[1] : reply).trim();
	return text === '' ? null : text + '\n';
}

interface MessageStream {
	finalMessage(): Promise<{
		stop_reason: string | null;
		content: Array<{ type: string; text?: string }>;
	}>;
}

interface Client {
	beta: { messages: { stream(params: Record<string, unknown>): MessageStream } };
}

/** The Claude API, through the Anthropic SDK the project installs. */
export async function claude_provider(model = DEFAULT_MODEL): Promise<Provider> {
	let file: string;
	try {
		file = resolve_peer('@anthropic-ai/sdk', 'heisenbench prove --propose');
	} catch {
		// not a dependency of Heisenbench: the project that proposes installs it
		throw new Error(
			'heisenbench prove --propose needs the Anthropic SDK in the project: npm i -D @anthropic-ai/sdk'
		);
	}
	type Ctor = new () => Client;
	const sdk = (await import(pathToFileURL(file).href)) as { default: Ctor | { default: Ctor } };
	// the CommonJS entry is the class, or an object whose default is
	const Anthropic = typeof sdk.default === 'function' ? sdk.default : sdk.default.default;
	const client = new Anthropic();
	return {
		name: model,
		async propose(req) {
			const stream = client.beta.messages.stream({
				model,
				max_tokens: 64000,
				// a declined request is run again on the model recommended for its category
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
				thinking: { type: 'adaptive' },
				output_config: { effort: 'high' },
				system: SYSTEM,
				messages: [{ role: 'user', content: user_prompt(req) }]
			});
			const msg = await stream.finalMessage();
			if (msg.stop_reason === 'refusal') return null;
			const text = msg.content
				.filter((b) => b.type === 'text')
				.map((b) => b.text ?? '')
				.join('\n');
			return code_of(text);
		}
	};
}

/** What one proposal came to. */
export interface ProposalOutcome {
	n: number;
	/** `proven`, `rejected: ...`, `the candidate is refused: ...` (the safety check), `no candidate`. */
	outcome: string;
	report: ProveReport | null;
}

/** The growth of the original in words, from its own count. */
function growth_words(p: ProveChildResult): string {
	const g = p.growth;
	if (g) {
		const rows = g.rows.map(
			(r) =>
				`${r.k}x: ${r.original ? fmt(r.original.steps) : 'past the cap'} steps at input size ${fmt(r.size)}`
		);
		return `n^${g.original.exponent.toFixed(2)} in argument ${g.argument} (${g.kind}); ${rows.join(', ')}`;
	}
	if (p.recorded_curve)
		return `n^${p.recorded_curve.original.power.toFixed(2)} over the recorded input sizes`;
	return 'unknown';
}

/**
 * Ask `provider` for up to `count` candidates, one at a time (each sees why the ones before it
 * were not proven), and prove each. Returns every outcome; the proven ones carry their report.
 */
export async function run_proposals(
	o: ProveOptions,
	t: Target,
	samples: Sample[],
	provider: Provider,
	opts: { count: number; send_inputs: boolean; log?: (line: string) => void }
): Promise<ProposalOutcome[]> {
	const log = opts.log ?? (() => {});
	const original = readFileSync(t.file, 'utf8');
	const source = declaration_text(t.file, original, t.path);
	if (source === null) throw new Error(`heisenbench prove: ${t.module} has no top-level ${t.path}`);
	const profile = await profile_original(o, t, samples);
	const lines = original.split('\n');
	const blame = profile.blame.original.slice(0, 8).map((b) => {
		const at = b.at.lastIndexOf(':');
		const mod = b.at.slice(0, at);
		const line = Number(b.at.slice(at + 1));
		return { ...b, text: mod === t.module ? (lines[line - 1] ?? '').trim() : '' };
	});
	const size = (s: Sample) => (s.sizes ?? []).reduce((a, b) => a + b, 0);
	// the smallest few: they show the shape without much of the data
	const inputs = opts.send_inputs
		? [...samples]
				.sort((a, b) => size(a) - size(b))
				.slice(0, 3)
				.map((s) => show(s.args, 4))
		: [];
	const req: ProposalRequest = {
		function_id: t.id,
		source,
		blame,
		growth: growth_words(profile),
		inputs,
		tried: []
	};
	const out: ProposalOutcome[] = [];
	for (let n = 1; n <= opts.count; n++) {
		const cand = await provider.propose(req);
		if (cand === null) {
			out.push({ n, outcome: 'no candidate', report: null });
			log(`proposal ${n}: no candidate`);
			continue;
		}
		let outcome: ProposalOutcome;
		try {
			const report = await prove_candidate(
				o,
				t,
				samples,
				cand,
				`${provider.name} proposal ${n}`,
				n
			);
			const kind = report.verdict.kind;
			outcome = { n, outcome: kind === 'proven' ? 'proven' : report.verdict.reason, report };
			// a later proposal is told what this one came to: costlier on small inputs is worth fixing too
			let why = kind === 'proven at scale' ? report.headline : report.verdict.reason;
			if (report.verdict.minimal) {
				why += `; ${report.verdict.minimal.difference}`;
				if (opts.send_inputs) why += ` on ${report.verdict.minimal.input}`;
			}
			req.tried.push({ source: cand, outcome: why });
		} catch (e) {
			if (!(e instanceof CandidateError)) throw e;
			outcome = { n, outcome: e.message, report: null };
			req.tried.push({ source: cand, outcome: e.message });
		}
		out.push(outcome);
		log(`proposal ${n}: ${outcome.report ? outcome.report.headline : outcome.outcome}`);
	}
	return out;
}
