---
'heisenbench': patch
---

A bench case that never returns no longer hangs `heisenbench run` in silence. Every measured run has a step ceiling (4 billion steps, and for the two replay runs 10 times what the case's own recording run counted): past it the case fails with `HB_RUNAWAY`, naming the case, its file and the function it was spinning in, and the other cases still count (the run exits 1). A case stuck in code Heisenbench does not count is stopped after 10 minutes on the real clock with `HB_STALLED` on stderr, naming the case and its file.
