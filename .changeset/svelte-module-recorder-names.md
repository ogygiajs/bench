---
'heisenbench': patch
---

The recording build no longer breaks a `.svelte.ts` / `.svelte.js` module: the names it injects no longer start with `$`, which Svelte reserves.
