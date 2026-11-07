# Heisenbench in any repo's CI

[ci.md](ci.md) is the ogygia suite: a dispatch to this repository, a results branch, sections
shared with the app benchmark. A library that wants one thing, "count the PR and its base, and
post the difference", needs none of that. This page is the whole recipe: one workflow file, two
jobs.

## The workflow

`.github/workflows/heisenbench.yml`, for a package at `packages/mylib` with its bench files in
`bench/`, installed with pnpm. Change `PKG`, `BENCH` and the install lines to fit.

```yaml
name: Heisenbench

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: heisenbench-${{ github.event.pull_request.number }}
  cancel-in-progress: true

env:
  PKG: packages/mylib # the package whose devDependencies have heisenbench
  BENCH: bench/*.bench.ts # relative to PKG

jobs:
  count:
    # Runs the PR's code, so it can write nothing: no token is left in the checkout.
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Count the PR and its base
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          out="$RUNNER_TEMP/heisenbench"
          mkdir -p "$out"
          base=$(git merge-base "$BASE_SHA" HEAD)
          cd "$PKG"
          # A bench file that does not load, or a case that fails, is in the report: not fatal.
          npx heisenbench run $BENCH --out "$out/head.json" || true
          if git ls-tree -r --name-only "$base" -- bench | grep -q '\.bench\.'; then
            # the base has bench files of its own: count it in its own checkout
            git worktree add -q "$RUNNER_TEMP/base" "$base"
            (cd "$RUNNER_TEMP/base" && pnpm install --frozen-lockfile &&
              cd "$PKG" && npx heisenbench run $BENCH --out "$out/base.json") || true
          else
            # the first PR: this PR's bench files on the base's code
            npx heisenbench run $BENCH --source-from "$base" --out "$out/base.json" || true
          fi
          npx heisenbench diff "$out/base.json" "$out/head.json" --repo "$GITHUB_WORKSPACE" \
            --out "$out/section.md"
          cat "$out/section.md" >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        with:
          name: heisenbench
          path: ${{ runner.temp }}/heisenbench/section.md

  comment:
    # Holds the write token and runs nothing from the PR: it reads section.md as text.
    needs: count
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: heisenbench
      - name: Post or update the comment
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          marker='<!-- heisenbench-comment -->'
          body="$(printf '%s\n\n%s' "$marker" "$(head -c 60000 section.md)")"
          id=$(gh api "repos/$GH_REPO/issues/$PR/comments" --paginate \
            --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)
          if [ -n "$id" ]; then
            gh api -X PATCH "repos/$GH_REPO/issues/comments/$id" -f body="$body" > /dev/null
          else
            gh api "repos/$GH_REPO/issues/$PR/comments" -f body="$body" > /dev/null
          fi
```

Pin the actions to commits (`actions/checkout@<sha> # v4.2.2`) if the repository pins its other
workflows.

## What each part is for

- **Node 26 in its own job.** Heisenbench needs Node 26.4 or newer; the library's own tests stay
  on whatever Node it supports. The counts are as valid: they depend on the code and its input,
  not on the Node version.
- **The merge base.** The PR is compared with the commit it branched from, not the tip of its
  base branch, so commits that landed on main since do not show up as the PR's.
- **The first PR.** The PR that adds Heisenbench is the one whose base has no bench files.
  `heisenbench run --source-from <base>` counts this PR's bench files on the base's code: every
  counted file the base commit has is read as it is there (from git, the working tree is not
  touched), and what only the PR has (the bench files, a `bench/data.ts` helper) from disk. The
  first comment then compares the two versions of the code instead of saying there is nothing to
  compare. It counts only (no `--measure`), and a file the PR deleted or renamed is not found:
  that is what the own-checkout branch above is for, once the base has bench files.
- **A file that does not load on one side.** The diff lists it under "Did not run" with its error
  and how many of its cases were not compared; those cases are not "new" or "removed".
- **Nothing changed.** Most PRs change no counted function. The section then shows the PR's own
  counts: the ten heaviest cases, the function and the line with the most steps in each, the
  growth class when the report has one (`heisenbench growth $BENCH --out "$out/head.json"` after
  the `run`), and every case that grows faster than linear.
- **The two jobs.** The count job runs the PR's code (its install scripts, its bench files), so
  it holds no token. The comment job holds the write token and runs nothing from the PR. A PR
  from a fork gets the job summary but no comment, because `github.token` cannot write to the
  base repository from a fork's PR.
- **One comment, updated.** The marker on its first line finds it again on the next push. GitHub
  cannot pin a comment on a pull request (`pinIssueComment` answers "Issue cannot be a pull
  request"); put a link to it in the PR body if it must be easy to find.

## Next to a timer

A small real slowdown can show in steps and not in time. neotraverse's `forEach` on an array of
256 objects, with one extra pass planted in `descend_children`, counted 6.3% more steps (342,055
to 363,559), and `heisenbench time` on the same two trees (5 turns, both in one process) gave
59.0 to 62.8 µs before and 59.8 to 64.0 µs after: within noise. Both are right. A count sees any
change in the work the code asks for; a timer sees a change only above the spread of its own
runs, which was about 6% on that machine for that case. When the two disagree, read the step
change as the code doing more, and the time result as "not larger than what this machine can
tell apart". A timer's spread on a shared CI runner is wider still.
