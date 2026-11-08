---
'heisenbench': patch
---

pr: 65

A recorded input nested deeper than 1,000 levels is counted and not kept, so `prove` no longer crashes reading back a deep walk's recording.
