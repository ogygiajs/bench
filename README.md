# ogygia bench

Benchmarks for [ogygia](https://github.com/ogygiajs/ogygia). One pnpm workspace:

- [`suites/apps`](suites/apps/README.md): the app benchmark. The same apps built with ogygia and
  other Svelte frameworks, measured the same way. Its blog is a port of
  [Stanislav Khromov's interactive-blogs-benchmark](https://github.com/khromov/interactive-blogs-benchmark).
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
`main/<sha>.json`, `pr/<number>.json` and `commit/<sha>.json`.

## License

MIT. See [LICENSE](LICENSE).
