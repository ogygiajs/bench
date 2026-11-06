#!/usr/bin/env bash
# Build the frameworks, start mochi (full runs only), run the benchmark, write results/.
# OGYGIA_SPEC, BENCH_FAST and BENCH_PASSES come from the environment (see docker-compose.yml).
set -euo pipefail
cd /bench

echo "▸ build frameworks"
node build-all.ts

if [ -z "${BENCH_FAST:-}" ]; then
	echo "▸ start mochi on :3335"
	(
		cd frameworks/mochi
		PORT=3335 MOCHI_KEY="${MOCHI_KEY:-dGVzdC1rZXktMzItYnl0ZXMtYmFzZTY0dXJsISEh}" bun run start
	) &
	MOCHI_PID=$!

	cleanup() {
		kill "$MOCHI_PID" 2>/dev/null || true
	}
	trap cleanup EXIT

	echo "▸ wait for mochi"
	for i in $(seq 1 60); do
		if curl -sf "http://127.0.0.1:3335/posts/small" >/dev/null; then
			break
		fi
		sleep 1
		if [ "$i" -eq 60 ]; then
			echo "mochi failed to start"
			exit 1
		fi
	done
fi

echo "▸ run benchmark"
node benchmark.ts --config frameworks.config.json --out results/latest.md --json

echo "✓ done — see results/latest.md"
