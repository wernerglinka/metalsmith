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
 *   short-circuits the remaining stack.
 *
 * Like `ware`, the same `(files, metalsmith)` pair flows through every plugin;
 * plugin return values are not threaded into the next plugin. Generator-function
 * plugins (an undocumented `ware` feature) are intentionally not supported.
 *
 * @param {import('./index').Plugin[]} fns
 * @param {import('./index').Files} files
 * @param {import('./index')} metalsmith
 * @return {Promise<import('./index').Files>}
 */
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

module.exports = run
