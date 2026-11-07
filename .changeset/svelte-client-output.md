---
'heisenbench': minor
---

pr: 0

`--svelte client` counts Svelte components as client output (hydration, mounting, updates on a DOM a preload brings), and `run --append` adds a second run's cases to the same report, so server and client benches diff as one.
