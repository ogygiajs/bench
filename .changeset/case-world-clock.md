---
'heisenbench': patch
---

A bench file's top level, `setup`, `scale` and `teardown` read the same clock and randomness the measuring window does (from 2024-01-01, the same seed), so a case whose input is built from `Date.now()` or `Math.random()` counts the same in every run and every process instead of moving each time.
