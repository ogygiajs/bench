---
'heisenbench': minor
---

pr: 65

`prove` takes a method of a top-level class (`'Cache > get'`, `'Cache > static of'`), with the recorded `this` rebuilt on each side's own class.
