---
'heisenbench': patch
---

pr: 66

`heisenbench history --reports` reads run files written as a manifest of content-hashed shards (the results branch's `heisenbench/shards/`), checking each shard's size and hash, and still reads whole run files.
