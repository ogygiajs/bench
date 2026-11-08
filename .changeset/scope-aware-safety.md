---
'heisenbench': patch
---

pr: 65

`prove`'s safety check follows scopes: a local named like a global, `typeof window`, a harmless `globalThis` property, a class's `this.constructor` and a `'__proto__'` string that is no key no longer refuse a candidate.
