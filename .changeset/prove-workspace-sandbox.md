---
'heisenbench': patch
---

pr: 65

`prove`'s sandbox reads the `node_modules`, `package.json` and `svelte.config` files above the root, so a package of a workspace can be proven.
