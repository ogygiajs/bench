---
'heisenbench': minor
---

A variable a nested function uses costs a property read or write on every use, as V8 keeps it in a context object (a module variable nothing reassigns stays free), and a getter or setter costs a call when it runs, so state moved from a closure to class fields no longer reads as slower.
