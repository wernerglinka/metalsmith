/* c8 ignore start */
const chokidar = require('chokidar')
// to be replaced in distant future by native structuredClone when dropping Node <17 support
const cloneDeepWith = require('lodash.clonedeepwith')
const crypto = require('crypto')
const { relative, sep } = require('path')
const { rm } = require('./helpers')
const { stat } = require('fs/promises')
const Mode = require('stat-mode')

function sourceRelPath(p, ms) {
  return relative(ms.source(), ms.path(p))
}
function isInSource(p) {
  return !p.startsWith('..')
}

function noop() {}

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

module.exports = function watchable(files, metalsmith, statikPatterns = []) {
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

  function isStatik(relPath) {
    return statikPatterns.length > 0 && metalsmith.match(statikPatterns, [relPath.replace(/\\/g, '/')]).length > 0
  }

  /**
   * statik files never enter the files object: Metalsmith#build copies them from disk on every build.
   * Keep the statik map in sync instead, so a removed file is not copied (ENOENT) and a new one is.
   */
  function transformStatik(evt, relPath, abs) {
    // keys use the platform path style, exactly as Metalsmith#read stores them
    const statik = metalsmith.statik()
    switch (evt) {
      case 'unlink':
        delete statik[relPath]
        return Promise.resolve()
      case 'unlinkDir':
        Object.keys(statik)
          .filter((k) => k.startsWith(relPath + sep))
          .forEach((k) => delete statik[k])
        return Promise.resolve()
      case 'add':
      case 'change':
        if (statik[relPath]) return Promise.resolve()
        return stat(abs).then((stats) => {
          statik[relPath] = Object.create(
            {},
            {
              mode: { value: Mode(stats).toOctal(), configurable: false, enumerable: true },
              stats: { value: Object.freeze(stats), configurable: false, enumerable: true },
              contents: { value: Buffer.from(relPath), configurable: false, enumerable: true }
            }
          )
        })
      default:
        return Promise.resolve()
    }
  }

  function transformFilesObj(evt, p, metalsmith) {
    // we only care about in-source files & dirs to update the fileCache
    // other files are eventually added or processed by plugins
    let filesTransform = Promise.resolve()
    const relPath = sourceRelPath(p, metalsmith)

    if (isInSource(relPath) && isStatik(relPath)) return transformStatik(evt, relPath, metalsmith.path(p))

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
          filesTransform = metalsmith.readFile(metalsmith.path(p)).then(
            (file) => {
              fileCache[relPath] = file
            },
            (err) => {
              // modified and then removed/renamed within the same batch window: treat as an unlink
              if (err.message.includes('ENOENT')) {
                delete fileCache[relPath]
                return
              }
              throw err
            }
          )
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
    const eventqueue = []
    // starts true: the initial build is in progress and its callback must fire before any rebuild's
    let inTheMiddleOfABuild = true
    let closed = false
    let currentBuild = Promise.resolve()
    let run

    function close() {
      closed = true
      clearTimeout(run)
      eventqueue.splice(0, eventqueue.length)
      // resolve only once no (re)build is in flight anymore, so the consumer can safely build again
      return Promise.all([watcher.unwatch(paths).close(), currentBuild]).then(() => {})
    }

    watcherReady.then(() => {
      watcherFn.close = close
    })

    function scheduleRun() {
      clearTimeout(run)
      run = setTimeout(processQueue, 0)
    }

    function finishRun() {
      inTheMiddleOfABuild = false
      // events that arrived while building are processed in a follow-up run
      if (!closed && eventqueue.length) scheduleRun()
    }

    function processQueue() {
      // never run 2 builds concurrently: chokidar emits unlink events ~100ms after add events on Linux & Windows,
      // and concurrent builds race each other cleaning & writing the destination (EPERM/ENOENT, missed rebuilds)
      if (closed || inTheMiddleOfABuild || !eventqueue.length) return
      inTheMiddleOfABuild = true
      const batch = eventqueue.splice(0, eventqueue.length)

      const build = Promise.all(batch.map(([evt, p]) => transformFilesObj(evt, p, metalsmith)))
        .then(() => rerun())
        .then(
          (files) => {
            // onRebuild is Metalsmith#build's callback: it returns the clean + write chain, which is awaited
            // so the next rebuild cannot clean the destination while this one is still writing to it
            if (clean) return onRebuild(null, files)

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
      // tracked for close(); a rejection here is the consumer's callback throwing, which stays theirs
      currentBuild = build.then(noop, noop)
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
            currentBuild = Promise.resolve(onRebuild(null, files)).then(noop, noop)
            resolve(close)
            // events that arrived during startup (e.g. replayed by FSEvents) are processed once the
            // initial build has been written
            currentBuild.then(finishRun)
          }, reject)
        })
        .catch((err) => {
          watcherReady.then(() => {
            reject(err)
            finishRun()
          }, reject)
        })
    })
  }

  return watcherFn
}
/* c8 ignore end */
