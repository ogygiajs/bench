# results

Written by the `bench` workflow; nothing here is edited by hand.

- `main/latest.json`: the newest baseline run (a push to ogygia main, or the weekly `ogygia@latest` run)
- `main/<sha>.json`: every run for an ogygia main commit (`main/v<version>.json` for the weekly run)
- `pr/<number>.json`: the newest run for that ogygia PR
- `commit/<sha>.json`: the newest run of that ogygia commit (full sha), from a PR run or a main run alike;
  `meta.sha` is the commit, `meta.pr` the PR of a PR run, `meta.base` the base commit measured beside it
