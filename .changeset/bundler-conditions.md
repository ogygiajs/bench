---
'heisenbench': minor
---

pr: 0

`--conditions svelte` (or `svelte,browser`) resolves packages with the export conditions your bundler uses, for the code under test only, and an import with no extension inside a package (`./helpers`) loads as a bundler would load it.
