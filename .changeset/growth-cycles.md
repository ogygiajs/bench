---
'heisenbench': patch
---

pr: 38

The generic growth scaler keeps a circular input circular instead of following it until the stack overflows.
