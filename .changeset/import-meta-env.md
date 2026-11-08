---
'heisenbench': minor
---

pr: 60

Code that reads `import.meta.env` runs in every build, defined as a Vite production build defines it, and a project changes the env with `heisenbench.importMetaEnv` in its package.json.
