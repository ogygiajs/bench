---
'heisenbench': patch
---

A bench file that does not load now fails the command instead of quietly dropping out of it. `growth`, `search`, `growth --recorded`, `record`, `prove --bench` and `coverage` exit 1 when a bench file (or a recorded or package module) does not load, and the `growth`, `search`, `recorded_growth`, `contracts` and coverage reports name each one with its error in a new `failed` (coverage: `unreadable`) list. `contracts` fails when a report it reads has such a file, or when a source file cannot be read, and a growth diff lists those files as failed.
