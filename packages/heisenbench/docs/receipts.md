# Release receipts

Counts are the same on every machine, so a release can say what its code costs, and anyone can
check it. A receipt is a JSON file that names a package's published tarball, the bench files that
count it, everything else the counts depend on, and the counts. `heisenbench verify-receipt`
counts the tarball again the way the receipt was made and says `matches`, or names the first case
that differs and where.

```bash
heisenbench receipt receipts/transform.bench.ts --package heisenbench@0.0.0 --out receipt.json
heisenbench verify-receipt receipt.json heisenbench@0.0.0
heisenbench registry receipts/*.json --out index.html
```

## Bench files for a receipt

A receipt's bench files are ordinary bench files with two rules:

- `bench` comes from `heisenbench/bench`. In every process that counts a receipt that one import is
  the engine doing the counting, whatever the scratch tree has installed under the name (a receipt
  for Heisenbench itself installs the released Heisenbench there).
- The package is imported by its name and its public entry points (`import { compile } from
  '@ogygia/router'`), never from source: only the tarball is there.

Cases that declare `scale` are grown too (1×, 10×, 100×), and the receipt keeps their growth class.

`--include a,b` adds files the bench files import or read (fixtures, helpers). `--preload a.ts`
adds a file every counting process imports first (`node --import`): resolve hooks for specifiers
only a bundler serves. ogygia's packages import `virtual:ogygia/*` and `$app/*`, so their receipts
preload a hook that maps those to stubs, the way `internal/heisenbench/src/preload.ts` does for
ogygia's own bench runs. Every one of these files is kept in the receipt, text and hash.

`--package` takes a `.tgz`, a URL (`https://pkg.pr.new/...`), or `name@version` (`npm pack`, so
npm's own registry and auth settings apply). The tarball's integrity is checked against npm's
`dist.integrity` for that name and version: a tarball npm has with other bytes is refused, one npm
does not have (a preview build) is marked `not published`. `--npm off` skips the check.

## What a receipt holds

| Field          | What                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`      | Name, version, integrity (`sha512-…`, the same string as npm's `dist.integrity`), the tarball's URL, and whether npm has it (`published`, `not published`, `not checked`).                                       |
| `dependencies` | Every other installed package: name, version, integrity.                                                                                                                                                         |
| `install`      | npm's whole lockfile. Install scripts never run.                                                                                                                                                                 |
| `bench`        | Every bench, include and preload file: path, sha256, text.                                                                                                                                                       |
| `engine`       | Heisenbench's version, where it ran from (`npm`, or `checkout <commit>`), the hash of its code, package files and dependency versions, and the prices and weights hashes.                                        |
| `node`         | Node, V8, platform, arch.                                                                                                                                                                                        |
| `counting`     | How the cases were kept apart (`process per case`), `state: fresh`, `deps: all`, the environment every counting process had, the root's length and depth, the growth sizes, the preloads.                        |
| `cases`        | Per case: totals (steps, allocations, bytes, calls), every function it ran (id, calls, self and inclusive steps, allocations, bytes), and the sha256 of its whole report (blocks, lines, built-ins, call edges). |
| `growth`       | Per grown case: sizes, input sizes, steps, class, exponent, the likeliest shape and its odds.                                                                                                                    |
| `hash`         | `sha256-…` of the canonical JSON of everything else (keys sorted).                                                                                                                                               |

Heisenbench's receipt for `heisenbench@0.0.0` (2 cases, 1 grown) is 72 KB, most of it the lockfile
and the function lists.

## How it is counted, both times

`receipt` and `verify-receipt` build the same scratch tree and count it the same way:

1. **The tree.** A new directory with a `package.json` that depends on the tarball as
   `file:package.tgz`, the bench files at their paths, and the package installed with npm:
   `npm install` for the receipt, which writes the lockfile it keeps, and `npm ci` from that
   lockfile for the check. So both count the same dependency tree, down to every integrity.
2. **The root.** Its path is 200 characters long and 16 directories deep on every machine
   (directories are added and the last one padded). Code that walks or splits its own
   `import.meta.url` does work per character and per directory, and a checker's temp directory is
   not the maker's. The published Heisenbench is such code: its transform writes the runtime's
   file URL into every module it makes, and `transform: a module of 20 functions` counts 1,636,997
   steps under a 160-character root and 1,637,437 under a 200-character one.
3. **The environment.** No `NODE_OPTIONS` from the caller; `NODE_ENV=production`, `TZ=UTC`,
   `LC_ALL=C`.
4. **Each case alone.** The cases are listed once, then each case is counted in a process of its
   own (blame's recount child, which runs `heisenbench run` on the one case, with a fresh copy of
   its modules for every run), and each case with `scale` is grown in another. A count is then a
   function of the case and the tree only. State a case leaves in a global, or in any cache a fresh
   module copy does not reset, never reaches another case, and the order of the cases does not
   matter. In one process it does: in the planted test, a package keeps the keys it saw in a
   `globalThis` set, and the case that runs second walks both keys under `heisenbench run`, one key
   in its receipt (`test/receipt.test.ts`). The receipt records this as
   `counting.isolation: "process per case"`.

`verify-receipt` then compares the counts with the receipt's, case by case in the receipt's order,
then growth curve by curve, and prints the first difference by its place in the case
(`totals.steps`, then `functions[i]`, then the report hash for a change below the function level).

```
heisenbench verify-receipt: heisenbench@0.0.0
  ok   receipt  whole (sha256-86f85db4f06e…)
  NO   tarball  heisenbench@0.0.0 is not the receipt's tarball: sha512-jwcW3frPQeRo… vs sha512-DxwMyVMsy2GU… (counted anyway)
  ok   engine   heisenbench 0.0.0, checkout 09601291aa33 (009c0041409d), the receipt's
  ok   node     v26.4.0, the receipt's
  NO   counts   2 of 2 case(s) count differently
  NO   growth   1 of 1 growth curve(s) differ
differs: case "transform: a module of 20 functions" (receipts/transform.bench.ts): totals.steps: 1637437.15625 vs 1637277.75
```

That is the receipt of `heisenbench@0.0.0` checked against its own tarball with one character
changed (`nm !== -1` to `nm === -1` in `module_id`). Exit 0 is `matches`, exit 1 is a difference.

Every check is said, and the counts are counted even when an earlier check failed:

- **receipt**: the content still hashes to `hash` (an edited count is caught here, and again by
  the count it differs from).
- **tarball**: the given tarball's integrity is the receipt's. A different one is counted anyway,
  so a change names the first case it reaches.
- **engine**: the same engine hash and prices. A different one says which engine to check with
  (`npx heisenbench@<version> verify-receipt`, or the bench repo at the receipt's commit).
- **node**: a note, not a failure. V8 decides how often it calls back into counted code (a sort's
  comparator), so another Node can count differently, and the counts then say so.

## Hashed, not signed

A receipt carries a content hash (sha256 of its canonical JSON), not a signature. The hash says
the receipt is whole. It does not say who made it, and it does not need to: the claim in a receipt
is checkable by counting again, on any machine, by anyone. A forged receipt fails
`verify-receipt`.

Who published a receipt is the job of where it is published from. A release workflow that attaches
the receipt to its GitHub release can attest it with the provenance it already has:
[`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance) signs the
file with sigstore through the workflow's OIDC token, as npm provenance signs the package, and
`gh attestation verify receipt.json --repo <owner>/<repo>` checks it. No key is made, stored or
rotated. A key file (ed25519) would add a secret to keep and a public key to publish for a claim
that is already checkable.

## The registry

`heisenbench registry <receipts...> --out index.html` writes one static page:

- **Per package**, every version with a receipt, oldest first: each case's steps, the change from
  the version before and its growth class. Then, for the newest version, the functions the steps
  are in, matched across versions by place (a dependency's module without its version, a function's
  path without its shape hash), so a function keeps its row through an upgrade.
- **Across packages**: cases with the same name in receipts of different packages are one row,
  fewest steps first. Two markdown parsers whose bench files both have a case `parse: a README`
  line up here; that is the way to compare libraries.
- **The receipts**: each tarball's integrity, the engine, Node, the receipt hash and a link to the
  file.

On the results branch, receipts live at `heisenbench/registry/receipts/<name>/<version>.json`
(`@scope/name` as a directory) and the page at `heisenbench/registry/index.html`:

```bash
git clone --branch results --single-branch --depth 1 https://github.com/ogygiajs/bench.git results
mkdir -p results/heisenbench/registry/receipts/@ogygia/router
cp receipt.json results/heisenbench/registry/receipts/@ogygia/router/0.12.0.json
heisenbench registry $(find results/heisenbench/registry/receipts -name '*.json') \
  --out results/heisenbench/registry/index.html
git -C results add heisenbench/registry && git -C results commit -m "registry: @ogygia/router 0.12.0" && git -C results push
```

## Attaching a receipt to an ogygia release

Not wired yet: ogygia's release workflow is unchanged. This is how it would be done.

1. Each package keeps receipt bench files next to its bench files, say
   `packages/router/receipt/router.bench.ts`, importing the package by name, plus the preload and
   stubs above for packages that import `virtual:ogygia/*`.
2. After `changeset publish`, for each package it published, the release job makes the receipt from
   the version npm now has, attests it and attaches it to the GitHub release:

   ```yaml
   permissions:
     contents: write
     id-token: write # sigstore, as for npm provenance
     attestations: write
   steps:
     - name: Receipts
       run: |
         for pkg in $(jq -r '.[] | "\(.name)@\(.version)"' <<< '${{ steps.changesets.outputs.publishedPackages }}'); do
           dir="packages/$(basename "${pkg%@*}")"
           [ -d "$dir/receipt" ] || continue
           npx heisenbench@<pinned> receipt "$dir"/receipt/*.bench.ts \
             --include "$(ls "$dir"/receipt/stubs/*.ts | paste -sd, -)" \
             --preload "$dir/receipt/preload.ts" --package "$pkg" --out "receipts/${pkg//\//-}.json"
         done
     - uses: actions/attest-build-provenance@v3
       with:
         subject-path: receipts/*.json
     - run: gh release upload "<tag>" receipts/*.json
   ```

   The receipt is made from `name@version`, so npm's integrity check applies: it counts the
   tarball npm serves, not the local build.

3. The release job then sends a `repository_dispatch` to this repository (as ogygia's CI already
   does for counts) and a job here stores the receipt on the results branch and makes the page
   again, as in the commands above.

## Limits

- **npm only.** The tree is installed with npm, whatever the project uses. A package that only
  installs with another manager's features (pnpm's `catalog:` left in a published manifest) does not
  install.
- **Install scripts never run.** A package that needs its `postinstall` to work (downloading a
  binary) does not count.
- **The network.** Both commands download the tarball and the dependencies.
- **The root's characters.** Its length and depth are fixed, its characters are not: code that
  compares its own path character by character with something else can still count differently.
- **Node.** A different Node can count differently where V8 calls back into counted code; the
  receipt says which Node counted it.
- **Engine.** A receipt checks with the engine that made it. A newer Heisenbench may price or
  count differently, and says so instead of comparing.
- **Windows** is untested: npm is run as `npm`, and the root's depth counts `\`.
