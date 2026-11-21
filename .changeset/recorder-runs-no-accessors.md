---
'heisenbench': patch
---

Recording no longer runs a getter or a Proxy trap on a call's inputs or output. Sizing, the depth check and the clone read only own data properties, so code that watches which keys are read (a request wrapped to see which headers or cookies a render reads) sees the same reads recorded as unrecorded. An input or output with a Proxy or an own getter anywhere in it is now counted as not cloneable instead of kept with the getter's value frozen into the sample.
