# Changesets

Releases of `heisenbench` are automated (`.github/workflows/release.yml`, the Changesets GitHub
Action). The other workspace packages (`@bench/compare`, `suites/*`) are private and never
released.

1. A PR that changes what `heisenbench` users get adds a changeset: `pnpm changeset`, pick
   `heisenbench` and the bump (patch / minor / major), and write one line that says what changed
   for users. That line is the changelog entry; `@changesets/changelog-github` adds the PR link and
   its author. A PR with several independent fixes adds one changeset per fix. A PR that only
   touches the suites, the workflows or the tests needs none.
2. Merged to `main`: the **update versions** PR opens (or updates) with the new version and
   changelog.
3. Merging that PR publishes to npm under `latest` (trusted publishing, with provenance), and
   creates the tag and the GitHub release.

Every push and PR also publishes a preview build to pkg.pr.new (`.github/workflows/pkg-pr-new.yml`),
named as the next patch's prerelease of that commit (`0.0.1-next.cb18746`):
`pnpm add https://pkg.pr.new/ogygiajs/bench/heisenbench@<sha-or-branch>`.

A PR into `main` merges by itself once CI is green when it carries the `ship` label
(`.github/workflows/ship.yml`); removing the label cancels.
