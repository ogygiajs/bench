---
'heisenbench': patch
---

`heisenbench run` names the counted files that differ from the commit (changed, staged or not tracked) in the report's `git.changed` and on the console, so a count from a checkout with uncommitted changes is never read as that commit's.
