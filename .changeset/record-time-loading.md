---
'heisenbench': patch
---

pr: 65

`record` and `prove --bench` resolve `./x.js` to `x.ts` and extensionless imports, and `record` and `time` load `.svelte` files from packages.
