---
'heisenbench': minor
---

A package's settings (`importMetaEnv`) live in a `heisenbench.config.ts` next to its package.json, typed with the new `defineConfig`, so nothing about benches ships to npm; the package.json `heisenbench.importMetaEnv` field is no longer read, and a package.json that still sets it is an error that says where to move it.
