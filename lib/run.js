'use strict'

/**
 * Run a `files` object through a stack of middleware `fns`, in series.
 *
 * This is Metalsmith's internal middleware runner. It replaces the
 * `segmentio/ware` dependency (and its `wrap-fn`/`co` chain), keeping only the
 * behavior Metalsmith actually relies on:
 *
 * - **callback** plugins `(files, metalsmith, done)` are detected by arity
 *   (`fn.length > 2`) and receive a `done` callback;
 * - **synchronous** plugins `(files, metalsmith)` may simply mutate `files`;
 * - **promise** plugins `(files, metalsmith)` may return a thenable, which is
 *   awaited;
 * - a returned `Error`, a thrown error, or a `done(err)` call rejects and
 *   short-circuits the remaining stack. A throw or promise rejection always
 *   signals failure, so a falsy reason (`throw null`, `Promise.reject()`) is
 *   coerced to an `Error` rather than read as success.
 *
 * Like `ware`, the same `(files, metalsmith)` pair flows through every plugin;
 * plugin return values are not threaded into the next plugin. Generator-function
 * plugins (an undocumented `ware` feature) are intentionally not supported.
 *
 * Two deliberate deviations from `ware`:
 *
 * - **`this` binding.** `ware` invoked plugins with `this` bound to the internal
 *   `Ware` instance. Here `this` is the `metalsmith` instance instead. No plugin
 *   should have depended on the old value, which was an internal object plugins
 *   could not usefully reach; binding to `metalsmith` matches the explicit second
 *   argument and is the more useful default.
 * - **Generator plugins removed**, as noted above.
 *
 * @param {import('./index').Plugin[]} fns
 * @param {import('./index').Files} files
 * @param {import('./index')} metalsmith
 * @return {Promise<import('./index').Files>}
 */
/**
 * Coerce a thrown value or promise-rejection reason into a truthy error. A
 * throw or rejection always signals failure, but a falsy reason (`throw null`,
 * `Promise.reject()`) would pass `next`'s `if (err)` check and be misread as
 * success. Truthy non-Error reasons (strings, objects) are preserved as-is to
 * match `ware`'s pass-through behavior; only falsy reasons are wrapped. The
 * `done(falsy)` callback convention (falsy means success) is intentionally not
 * routed through here.
 *
 * @param {*} reason
 * @return {*}
 */
function asError(reason) {
  if (reason) return reason
  return new Error(`Plugin signalled failure with a falsy value: ${reason}`)
}

function run(fns, files, metalsmith) {
  return new Promise((resolve, reject) => {
    let i = 0

    function next(err) {
      if (err) return reject(err)

      const fn = fns[i++]
      if (!fn) return resolve(files)

      // Guard against a plugin calling its `done` more than once. The
      // monotonic `i` already prevents a re-run when the stack is purely
      // synchronous; this guard is what covers async interleaving, where a
      // plugin calls `done` a second time while a later plugin's promise is
      // still pending and the second call would otherwise advance the stack
      // out of order. Replicates ware's `once`-wrapped callback.
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
            ret.then(() => done(), (reason) => done(asError(reason)))
          } else if (ret instanceof Error) {
            done(ret)
          } else {
            done()
          }
        }
      } catch (err) {
        done(asError(err))
      }
    }

    next()
  })
}

module.exports = run
