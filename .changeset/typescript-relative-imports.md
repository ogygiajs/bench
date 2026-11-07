---
'heisenbench': patch
---

pr: PR_NUMBER

`./x.js` imports of `x.ts` files, and imports with no extension (`./core`, `./parser`), load without a preload.
