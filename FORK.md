# Fork ledger

`@wernerglinka/metalsmith` is a personal build of
[metalsmith/metalsmith](https://github.com/metalsmith/metalsmith). It exists so
that sites can run a current Metalsmith with working watch mode while the
upstream fixes wait for a release. It is a rebase target, not a divergence: every
delta below is its own commit, is offered upstream where it makes sense, and is
dropped the moment upstream absorbs it.

It is not published to npm. Sites install it from this repository by tag; npm
treats it as an alias, so imports and the CLI keep the `metalsmith` name and the
plugins' `metalsmith` peer ranges resolve against it:

```json
"metalsmith": "git+https://github.com/wernerglinka/metalsmith.git#v2.8.0"
```

Exit criterion: when upstream ships the watch fix and a Node floor of 20 or
higher, sites move back to `metalsmith` and this package is deprecated.

## Base

Upstream `master` at `9190ff2` (v2.7.0 plus CI chore, 2026-02-09).

## Deltas versus upstream

| Delta                                                                                                                                                                | Commit(s)                     | Upstream status                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Watch mode: glob patterns expanded for chokidar 4, FSEvents settle delay, `watch(false)` return fix                                                                  | `e7a3830` `b4ac48a` `bc11b97` | PR [#413](https://github.com/metalsmith/metalsmith/pull/413), open             |
| Watch mode: rebuilds serialized, no concurrent builds on a two-wave event batch                                                                                      | `722a401`                     | PR #413                                                                        |
| Watch mode: watch-path dedup fixed on Windows                                                                                                                        | `6fdfeb7`                     | PR #413                                                                        |
| Package renamed to `@wernerglinka/metalsmith`, version 2.8.0, fork metadata                                                                                          | `a67065c`                     | never, fork identity                                                           |
| Node floor raised to `>=22.12.0`, CI on 22 and 24, `lodash.clonedeepwith` replaced by a small prototype-preserving clone                                             | `1cca49c`                     | candidate for an upstream proposal                                             |
| `commander` 11 → 15; CLI `--debug [namespaces]` actually takes the documented namespaces value (was a boolean that enabled all, with the namespace silently dropped) | `6dba104`                     | the `--debug` fix is a candidate for upstream; the major bump needs Node 22.12 |
| `chokidar` 4 → 5 (ESM-only, loaded via `require(esm)`). Globs are still unsupported in 5, so `normalizeWatchPaths` stays                                             | `32b77a9`                     | needs Node 20.19+ upstream                                                     |
| `picomatch` 2.3.1 → 2.3.2 (lockfile only)                                                                                                                            | `827b2e1`                     | upstream can take this as a lockfile refresh                                   |
| Frontmatter excerpt is stripped from `contents` by slicing at the separator instead of a RegExp built from the excerpt text (prose with `$ ( [` broke it or threw)   | next commit                   | candidate for upstream                                                         |
| CLI `--env NAME=value` keeps everything after the first `=` (connection strings, base64, query strings were truncated)                                               | next commit                   | candidate for upstream                                                         |
| Watch mode: statik paths kept out of the pipeline, statik map kept in sync on add/unlink (platform path keys); `rm()` retries transient `ENOTEMPTY`                  | `9c5f732` `15488ba`           | PR #413                                                                        |

## Notes for sites that consume the fork

- **Bumping the tag.** After changing `#vX.Y.Z` in `package.json`, a plain
  `npm install` reports "up to date" and leaves the lockfile on the old commit.
  Run `npm install metalsmith@git+https://github.com/wernerglinka/metalsmith.git#vX.Y.Z`
  instead, then check `node_modules/metalsmith/package.json` for the version.
- **Lockfile portability.** npm records the dependency as `git+ssh://` when SSH
  to GitHub works locally. `npm ci` on a host without SSH keys still succeeds:
  npm falls back to https for GitHub-hosted URLs (verified with an empty cache).
- **statik and development builds.** `build()` copies every static file on every
  build. With `clean(true)` in watch mode that means recopying all of them on
  each rebuild. Use `clean(false)` in development; the watcher writes only what
  changed and removes what disappeared. Large caches that only production needs
  (e.g. responsive image variants) can be ignored in development only.
- **statik and watch.** Static paths never enter the pipeline while watching; a
  file added under one is copied on the next rebuild, a removed one is no longer
  copied (2.8.1).

## Accepted advisories

Production-only audit (`npm audit --omit=dev`) after the dependency phase, 2026-10-14.
Baseline before the phase was 6 advisories; 5 remain, all denial-of-service class
in code paths that only ever see input the site author wrote.

| Advisory                                                              | Package                               | Why it stays                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GHSA-vfj7-8cjw-p6xm, stack exhaustion on deeply nested brace patterns | `braces` ≤3.0.3 via `micromatch`      | No fixed release exists (3.0.3 is latest). Patterns come from the site's own `ignore()`/`match()` calls.                              |
| js-yaml merge-key and `!!omap` quadratic CPU (3 advisories)           | `js-yaml` 3.x via `gray-matter` 4.0.3 | gray-matter pins js-yaml 3 and calls its removed-in-4 `safeLoad`, so an override breaks parsing. Input is the site's own frontmatter. |
| sprintf-js unbounded precision, argparse via sprintf-js               | `argparse` 1.x via `js-yaml` 3        | Same chain as above; goes away when gray-matter moves to js-yaml 4.                                                                   |

Re-check on every rebase: `npm audit --omit=dev`.
