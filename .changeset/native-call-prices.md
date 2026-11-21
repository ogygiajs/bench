---
'heisenbench': minor
---

Prices v5 give native calls their measured cost instead of a plain call's 4 steps: `new URL()`, `node:crypto` (`createHmac`, with a Buffer key's per-call key object priced apart, `createHash`, `update`, `digest`, `hash`, `timingSafeEqual`, `randomBytes`, `randomUUID`), WebCrypto's `getRandomValues` and `randomUUID`, and Node's module loader (`import()` and `require()` as op kinds of their own), so keeping a key object, a loaded module or a string path in place of a URL parse now shows in steps; a price key can name a `node:` module's export or a constructor, and `calibrate prices --step-ns` keeps the file's step time.
