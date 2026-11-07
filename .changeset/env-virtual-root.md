---
'heisenbench': patch
---

pr: 55

Environment variables that name the checkout (`NODE_OPTIONS` with an `--import` preload, `INIT_CWD`) read as `/heisenbench/root` inside the measuring window, so code that reads them counts the same in every checkout.
