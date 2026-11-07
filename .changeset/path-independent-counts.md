---
'heisenbench': patch
---

pr: 53

A count no longer depends on where the project lives: every path the counted code reads (`import.meta`, `__filename`, `require.resolve`, stacks, `process.cwd()`) names the root `/heisenbench/root`, and receipts no longer pad their root to a fixed length.
