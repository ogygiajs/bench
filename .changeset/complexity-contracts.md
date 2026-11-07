---
'heisenbench': minor
---

pr: 0

A function can declare how fast it may grow (`/** @heisenbench linear in items */`), and `heisenbench contracts` fails when it grows faster or nothing measures it.
