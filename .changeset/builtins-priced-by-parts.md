---
'heisenbench': minor
---

pr: 33

`split`, `replace`, `replaceAll`, `match`, `join` and `Array.from` are priced by the parts, matches, callbacks and items they make, not only by length, so their counts follow measured time.
