---
'heisenbench': minor
---

pr: 63

`mutate` takes `--import`, `--conditions` and `--svelte` like every command that loads bench files, and exits 1 when a bench file did not load or a case threw on the root.
