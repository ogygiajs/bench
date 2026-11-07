---
'heisenbench': patch
---

pr: 36

`./x.js` imports of `x.ts` files, and imports with no extension (`./core`, `./parser`), load without a preload.
