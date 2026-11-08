---
'heisenbench': minor
---

pr: 62

`Object.keys`, `values`, `entries` and `assign` are priced linear in the keys (prices v4), with the keys of a wide object at V8's dictionary rate, so a wide object no longer reads as quadratic.
