# Fork ledger

`@wernerglinka/metalsmith` is a personal build of
[metalsmith/metalsmith](https://github.com/metalsmith/metalsmith). It exists so
that sites can run a current Metalsmith with working watch mode while the
upstream fixes wait for a release. It is a rebase target, not a divergence: every
delta below is its own commit, is offered upstream where it makes sense, and is
dropped the moment upstream absorbs it.

Consume it with an npm alias so imports and the CLI keep the `metalsmith` name:

```json
"metalsmith": "npm:@wernerglinka/metalsmith@^2.8.0"
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
| `commander` 11 → 15; CLI `--debug [namespaces]` actually takes the documented namespaces value (was a boolean that enabled all, with the namespace silently dropped) | next commit                   | the `--debug` fix is a candidate for upstream; the major bump needs Node 22.12 |

## Accepted advisories

None recorded yet. Updated in the dependency phase.
