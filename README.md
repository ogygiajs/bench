# ogygia bench

Benchmarks for [ogygia](https://github.com/ogygiajs/ogygia). One pnpm workspace:

- [`suites/apps`](suites/apps/README.md): the app benchmark. The same apps built with ogygia and
  other Svelte frameworks, measured the same way. Its blog is a port of
  [Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark).
- [`suites/ogygia`](suites/ogygia): Heisenbench on ogygia's own source. It runs the bench files in
  ogygia's `packages/*/bench` on a commit and, for a PR, on the commit it branched from (counted,
  then timed with both taking turns), and writes the `heisenbench` section of the PR comment.
- [`packages/heisenbench`](packages/heisenbench): Heisenbench, the function-level benchmark engine. It counts steps,
  allocations and calls per function and line, exactly, so one run of each side decides.
- [`packages/compare`](packages/compare): the noise rule for a PR build against its base, and the
  one benchmark comment on an ogygia PR.

## Heisenbench

[Heisenbench](packages/heisenbench/README.md) is the function-level half of this repository. It rewrites
ogygia's source so every function counts its own work, block by block, with built-ins priced by
input size and the clock, randomness, timers and IO made deterministic. The same code with the
same input gives the same count on every run, so one run of a PR and one of its base show which
line got slower, with no repeats and no noise floor. Engine health, time, real bytes, leaks,
growth and a worst-case search run next to the count and cover what counting cannot see.

On every ogygia PR, Heisenbench writes the first section of the benchmark comment. It counts from source,
so it does not wait for the published preview the app benchmark needs. `heisenbench verify` checks 34 planted cases on every change to this
repository. [packages/heisenbench/README.md](packages/heisenbench/README.md) has the details, the limits and
the numbers.

## Run it

You need Node 26.4 or newer and pnpm. Scripts are TypeScript run by plain `node`. CI runs the
tests on Node 26.4.0 and on the newest 26. It builds and measures the apps on Node 22, the Node
the published app numbers come from; Heisenbench itself does not run on Node 22.

```bash
pnpm install
pnpm build:fast        # build the ogygia and sveltekit apps
pnpm benchmark:fast    # measure them
pnpm test              # unit tests
pnpm lint && pnpm format:check
```

The app benchmark's README has every option, Docker, and what each metric means.

Heisenbench on two ogygia commits (a clone of ogygia, or a local checkout's path as `--repo`):

```bash
node suites/ogygia/src/cli.ts --sha <pr commit> --base <base commit> --out suites/ogygia/out
cat suites/ogygia/out/section.md   # the comment section; result.json has the reports and the diff
```

Leave out `--base` to count every bench file of one commit.

## Releasing Heisenbench

Releases are automated with Changesets (`.changeset/README.md`). A PR that changes what
`heisenbench` users get runs `pnpm changeset` and commits the file it writes. Merged changesets
open the **update versions** PR; merging it publishes to npm. Every push and PR also gets a preview
build on pkg.pr.new. Add the `ship` label to a PR to merge it once CI is green.

## The PR comment

Each ogygia PR gets one comment, found by `<!-- ogygia-benchmarks -->`. Each suite owns one
section of it and rewrites only that section:

```md
<!-- ogygia-benchmarks -->
### ogygia benchmarks

<!-- section:heisenbench -->
...
<!-- /section:heisenbench -->

<!-- section:apps -->
...
<!-- /section:apps -->
```

The workflow writes a section with
`node packages/compare/src/upsert-comment.ts --repo <owner/name> --pr <n> --section <name> --file <md>`
(token in `GH_TOKEN`). A comment from before sections is read as the `apps` section.

## Results

The `bench` workflow keeps every run on the orphan `results` branch: `main/latest.json`,
`main/<sha>.json`, `pr/<number>.json` and `commit/<sha>.json`. The `heisenbench` workflow keeps its runs
beside them in the same layout under `heisenbench/`.

## License

MIT. See [LICENSE](LICENSE).
