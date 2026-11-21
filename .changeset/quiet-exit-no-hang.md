---
'heisenbench': patch
---

`heisenbench run` and the processes it starts no longer hang at the end of a run with a big report (a deadlock between V8's background compiler and the exit). A timer or socket a bench leaves open is now named on stderr before the run exits, and reports are written in pieces, without one big string in memory.
