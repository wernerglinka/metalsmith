# Issue 407: Integrate segmentio/ware

`metalsmith` depends on [`segmentio/ware`](https://github.com/segmentio/ware)
to run the plugin stack. `ware` has been unmaintained for years, and it is not
a single dependency but the head of a three-package chain of equally
unmaintained code:

```
ware@1.3.0  ->  wrap-fn@0.1.5  ->  co@3.1.0
```

This change removes that dependency by vendoring the small amount of behavior
Metalsmith actually uses into an internal module, `lib/run.js`. No new
dependencies are introduced, and the existing plugin contract is preserved.

## What Metalsmith actually used from ware

The entire surface area was two lines in `lib/index.js`:

```js
const ware = new Ware(plugins)
const run = ware.run.bind(ware)
```

One constructor and one `run` call. None of ware's other API (`.use`
chaining, the `Ware` instance, the array/instance overloads of the
constructor) was touched. Everything else ware ships exists to support that
single `run`.

## The dependency chain

`wrap-fn` is the piece that lets ware accept plugins in different shapes
(callback, sync, promise, generator). It does so by inspecting function arity
and, for generator functions, delegating to `co`. `co@3.1.0` is generator-based
flow control from ~2014 and is the deepest, oldest link in the chain.

Generator-function plugins are:

- not part of the public `Plugin` type
  (`types/index.d.ts`: `(files, metalsmith, callback) => void | Promise<void>`),
- not documented in the README, and
- not exercised by a single test (a search for `function*` / `yield` / `co(`
  across `lib/`, `test/`, and `bin/` returns nothing).

So roughly a third of the dependency chain exists to support a feature
Metalsmith does not expose, document, or test.

## The contract that must be preserved

From `wrap-fn` and the existing test suite, plugins dispatch on **arity**:

1. **Callback** — `fn(files, metalsmith, done)`, detected by `fn.length > 2`;
   the `done` callback is appended and the plugin must call it.
2. **Synchronous** — `fn(files, metalsmith)`; the plugin mutates `files` and
   returns nothing.
3. **Promise** — `async fn(files, metalsmith)` returning a thenable, which is
   awaited.

In addition: a synchronously thrown error becomes a plugin error, a returned
`Error` instance becomes a plugin error, the `done` callback is guarded so a
plugin cannot resolve twice, and any error short-circuits the remaining stack.

One subtlety worth noting: ware threads the **same** `(files, metalsmith)` pair
through every plugin and discards plugin return values. Plugins mutate `files`
in place. The new module preserves this exactly.

## Why vendor rather than adopt `trough`

The issue comment suggested investigating [`wooorm/trough`](https://github.com/wooorm/trough)
as a replacement. `trough` does the same arity-based dispatch, so on the surface
it fits. There is one real semantic difference, however: `trough` propagates a
middleware's non-null return value as the input to the next middleware, whereas
`ware` always threads the original arguments through unchanged. Metalsmith's
contract is "mutate `files` in place, return nothing", so in theory this never
fires — but a third-party plugin that happens to `return` a truthy value would
be silently ignored under `ware` and would replace the `files` object under
`trough`. Adopting `trough` would therefore need an adapter and careful
regression testing against the plugin ecosystem.

Vendoring instead:

- removes all three packages (`ware`, `wrap-fn`, `co`) and adds **zero** new
  dependencies,
- is promise-native, matching the rest of the modern codebase,
- drops the dead generator path cleanly, and
- gives the project full control over the middleware layer, which is the
  stated motivation in the issue (for example, formally disallowing
  `metalsmith.use([a, b])` multi-plugin calls later becomes a one-line guard in
  `use`, rather than a fork of an upstream library).

## Fix: internal middleware runner (Completed)

### File: `lib/run.js` (new)

A single, dependency-free function that replicates the preserved contract:

```js
function run(fns, files, metalsmith) {
  return new Promise((resolve, reject) => {
    let i = 0

    function next(err) {
      if (err) return reject(err)

      const fn = fns[i++]
      if (!fn) return resolve(files)

      // guard against a plugin calling its `done` more than once
      let called = false
      const done = (err) => {
        if (called) return
        called = true
        next(err)
      }

      try {
        if (fn.length > 2) {
          // callback style: plugin(files, metalsmith, done)
          fn.call(metalsmith, files, metalsmith, done)
        } else {
          // synchronous or promise style: plugin(files, metalsmith)
          const ret = fn.call(metalsmith, files, metalsmith)
          if (ret && typeof ret.then === 'function') {
            ret.then(() => done(), done)
          } else if (ret instanceof Error) {
            done(ret)
          } else {
            done()
          }
        }
      } catch (err) {
        done(err)
      }
    }

    next()
  })
}
```

### File: `lib/index.js`

1. `const Ware = require('ware')` is replaced with `const run = require('./run')`.
2. The body of `Metalsmith.prototype.run` collapses from the `new Ware` /
   `bind` / manual-Promise wrapper:

   ```js
   const ware = new Ware(plugins)
   const run = ware.run.bind(ware)

   const result = new Promise((resolve, reject) => {
     run(files, this, (err, files) => {
       if (err) reject(err)
       else resolve(files)
     })
   })
   ```

   down to a single call:

   ```js
   const result = run(plugins, files, this)
   ```

   The surrounding Metalsmith 2.x callback-compat blocks are unchanged.

### File: `package.json`

- `ware` removed from `dependencies`.
- `lib/run.js` added to the published `files` array.

## New Tests (All Passing)

Five tests were added to the `#run` block in `test/index.js` to cover the error
and async paths that `ware` previously handled:

- promise-returning plugins are awaited,
- a synchronously thrown plugin error is propagated,
- a returned `Error` is treated as a plugin error,
- a rejected promise is propagated as a plugin error, and
- plugins after an error do not run (stack short-circuits).

The pre-existing callback and synchronous plugin tests continue to pass
unchanged, confirming the contract is preserved.

## Current Status

- `ware` is no longer a direct dependency; the `ware -> wrap-fn -> co` chain is
  gone from Metalsmith's own tree. (A nested copy remains under the
  `@metalsmith/drafts` devDependency, which pulls an old Metalsmith — that is
  expected and outside this change.)
- The full suite passes except for the watch/chokidar tests tracked separately
  in #412, which fail identically on `main` and are untouched by this change.
- `lib/run.js` is at 100% statement and function coverage.
- `npm run lint:check` and `npm run test:types` (`tsc`) are both clean.

## Files Changed

- `lib/run.js` (new) — internal middleware runner
- `lib/index.js` — use `./run`, simplify `Metalsmith.prototype.run`
- `package.json` — drop `ware`, publish `lib/run.js`
- `test/index.js` — add error/async path tests for the runner
