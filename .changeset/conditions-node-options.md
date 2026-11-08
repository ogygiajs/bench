---
'heisenbench': patch
---

pr: 62

`--conditions` keeps the engine's loader out of the `NODE_OPTIONS` the code under test reads, so counts no longer depend on where Heisenbench is installed.
