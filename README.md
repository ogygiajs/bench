# ogygia bench

Benchmarks for [ogygia](https://github.com/ogygiajs/ogygia). One pnpm workspace:

- [`suites/apps`](suites/apps/README.md): the app benchmark. The same apps built with ogygia and
  other Svelte frameworks, measured the same way. Its blog is a port of
  [Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark).
- [`suites/ogygia`](suites/ogygia): Abax on ogygia's own source. It runs the bench files in
  ogygia's `packages/*/bench` on a commit and, for a PR, on the commit it branched from (counted,
  then timed with both taking turns), and writes the `abax` section of the PR comment.
- [`packages/abax`](packages/abax): Abax, the function-level benchmark engine. It counts steps,
  allocations and calls per function and line, exactly, so one run of each side decides.
- [`packages/compare`](packages/compare): the noise rule for a PR build against its base, and the
  one benchmark comment on an ogygia PR.

## Run it

You need Node 22.18 or newer and pnpm. Scripts are TypeScript run by plain `node`.

```bash
pnpm install
pnpm build:fast        # build the ogygia and sveltekit apps
pnpm benchmark:fast    # measure them
pnpm test              # unit tests
pnpm lint && pnpm format:check
```

The app benchmark's README has every option, Docker, and what each metric means.

Abax on two ogygia commits (a clone of ogygia, or a local checkout's path as `--repo`):

```bash
node suites/ogygia/src/cli.ts --sha <pr commit> --base <base commit> --out suites/ogygia/out
cat suites/ogygia/out/section.md   # the comment section; result.json has the reports and the diff
```

Leave out `--base` to count every bench file of one commit.

## The PR comment

Each ogygia PR gets one comment, found by `<!-- ogygia-benchmarks -->`. Each suite owns one
section of it and rewrites only that section:

```md
<!-- ogygia-benchmarks -->
### ogygia benchmarks

<!-- section:abax -->
...
<!-- /section:abax -->

<!-- section:apps -->
...
<!-- /section:apps -->
```

The workflow writes a section with
`node packages/compare/src/upsert-comment.ts --repo <owner/name> --pr <n> --section <name> --file <md>`
(token in `GH_TOKEN`). A comment from before sections is read as the `apps` section.

## Results

The `bench` workflow keeps every run on the orphan `results` branch: `main/latest.json`,
`main/<sha>.json`, `pr/<number>.json` and `commit/<sha>.json`. The `abax` workflow keeps its runs
beside them in the same layout under `abax/`.

## License

MIT. See [LICENSE](LICENSE).
