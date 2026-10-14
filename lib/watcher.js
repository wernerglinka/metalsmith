/* c8 ignore start */
const chokidar = require('chokidar')
// to be replaced in distant future by native structuredClone when dropping Node <17 support
const cloneDeepWith = require('lodash.clonedeepwith')
const crypto = require('crypto')
const { relative } = require('path')
const { rm } = require('./helpers')

function sourceRelPath(p, ms) {
  return relative(ms.source(), ms.path(p))
}
function isInSource(p) {
  return !p.startsWith('..')
}

function computeHashMap(files) {
  return Object.entries(files).reduce((hashes, [path, file]) => {
    hashes[path] = crypto.createHash('md5').update(file.contents).digest('hex')
    return hashes
  }, {})
}

/**
 * @type {Object<string, string>} HashMap
 */

/**
 * Return the keys of `map1` that are different from `map2`
 * @param {HashMap} map1
 * @param {HashMap} map2
 * @returns {Array}
 */
function diffHashMap(map1, map2) {
  return Object.keys(map1).filter((path) => map1[path] !== map2[path])
}

module.exports = function watchable(files, metalsmith) {
  const clean = metalsmith.clean()
  const meta = metalsmith.metadata()
  const fileCache = files
  let lastHashmap

  function rerun() {
    const originalFiles = cloneDeepWith(fileCache, (value) => {
      if (Buffer.isBuffer(value)) return Buffer.from(value)
    })
    return metalsmith.metadata(meta).run(originalFiles, metalsmith.plugins)
  }

  function transformFilesObj(evt, p, metalsmith) {
    // we only care about in-source files & dirs to update the fileCache
    // other files are eventually added or processed by plugins
    let filesTransform = Promise.resolve()
    const relPath = sourceRelPath(p, metalsmith)

    if (isInSource(relPath)) {
      switch (evt) {
        case 'unlinkDir':
          metalsmith.match(relPath, Object.keys(fileCache)).forEach((r) => delete fileCache[r])
          break
        case 'unlink':
          delete fileCache[relPath]
          break
        case 'add':
        case 'change':
          filesTransform = metalsmith.readFile(metalsmith.path(p)).then((file) => {
            fileCache[relPath] = file
          })
          break
      }
    }

    return filesTransform
  }

  function watcherFn({ paths, ...options }, onRebuild) {
    const watcher = chokidar.watch(paths || metalsmith.source(), options)

    // chokidar 4's ready event can fire before native FSEvents watchers are fully active.
    // a short stabilization delay ensures file operations are reliably detected.
    const watcherReady = new Promise((resolve) => watcher.on('ready', () => setTimeout(resolve, 100)))
    watcherReady.then(() => {
      watcherFn.close = function () {
        return watcher.unwatch(paths).close()
      }
    })

    const eventqueue = []
    let inTheMiddleOfABuild = false
    let run

    function scheduleRun() {
      clearTimeout(run)
      run = setTimeout(processQueue, 0)
    }

    function finishRun() {
      inTheMiddleOfABuild = false
      // events that arrived while building are processed in a follow-up run
      if (eventqueue.length) scheduleRun()
    }

    function processQueue() {
      // never run 2 builds concurrently: chokidar emits unlink events ~100ms after add events on Linux & Windows,
      // and concurrent builds race each other cleaning & writing the destination (EPERM/ENOENT, missed rebuilds)
      if (inTheMiddleOfABuild) return
      inTheMiddleOfABuild = true
      const batch = eventqueue.splice(0, eventqueue.length)

      Promise.all(batch.map(([evt, p]) => transformFilesObj(evt, p, metalsmith)))
        .then(() => rerun())
        .then(
          (files) => {
            if (clean) {
              onRebuild(null, files)
              return
            }

            const newHashMap = computeHashMap(files)
            const changedOrRemoved = diffHashMap(lastHashmap, newHashMap)
            const addedFiles = diffHashMap(newHashMap, lastHashmap).filter((p) => !changedOrRemoved.includes(p))
            const removedFiles = changedOrRemoved.filter((f) => !files[f])
            const changedFiles = changedOrRemoved.filter((f) => !!files[f])
            const output = [...addedFiles, ...changedFiles].reduce((all, current) => {
              all[current] = files[current]
              return all
            }, {})
            lastHashmap = newHashMap

            return Promise.all(removedFiles.map((f) => rm(f))).then(() => onRebuild(null, output), onRebuild)
          },
          (err) => onRebuild(err)
        )
        .finally(finishRun)
    }

    watcher.on('all', (evt, p) => {
      // the metalsmith Files object does not output empty dirs,
      // wait for the file add/change events instead
      if (evt === 'addDir') return

      eventqueue.push([evt, p])
      scheduleRun()
    })
    return new Promise((resolve, reject) => {
      rerun()
        .then((files) => {
          if (!clean) lastHashmap = computeHashMap(files)
          watcherReady.then(() => {
            onRebuild(null, files)
            resolve(function closeWatcher() {
              return watcher.unwatch(paths).close()
            })
          }, reject)
        })
        .catch((err) => {
          watcherReady.then(() => reject(err), reject)
        })
    })
  }

  return watcherFn
}
/* c8 ignore end */
