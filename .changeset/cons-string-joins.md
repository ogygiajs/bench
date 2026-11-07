---
'heisenbench': patch
---

pr: 20

Long joins are cons strings, so building a string in a loop counts as linear, not quadratic.
