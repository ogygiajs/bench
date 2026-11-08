---
'heisenbench': patch
---

pr: 65

`prove` grows an argument only up to 4,000,000 units of input, stopping at the largest factor that fits and saying so, instead of running out of memory at 100x.
