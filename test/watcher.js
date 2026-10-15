const { writeFile, rename, readFile, access } = require('fs/promises')
const { Stats } = require('fs')
const assert = require('assert')
const path = require('path')
const { rm } = require('../lib/helpers')
const Metalsmith = require('..')
const fixture = path.resolve.bind(path, __dirname, 'fixtures')

const initialFiles = ['change', 'dir/file', 'remove'].map(path.normalize)

const defaultWatchOpts = {
  alwaysStat: false,
  awaitWriteFinish: false,
  cwd: fixture('watch'),
  ignoreInitial: true,
  ignored: [],
  paths: [fixture('watch/src')]
}

describe('watcher', function () {
  let activeMs = null

  this.timeout(10000)
  this.beforeEach(() => {
    activeMs = null
  })
  this.afterEach(async function () {
    // ensure the watcher is closed before restoring fixtures,
    // even if the test failed before reaching ms.watch(false)
    if (activeMs) {
      try {
        const watchState = activeMs.watch()
        if (watchState && watchState !== false) {
          await activeMs.watch(false)
        }
      } catch (_e) {
        // ignore close errors
      }
      activeMs = null
    }
    // restore src files without deleting the directory (clean: false).
    // deleting and recreating the directory causes FSEvents to lose track
    // of watchers, leading to missed events in subsequent tests.
    const srcDir = fixture('watch/src')
    await Metalsmith(fixture('watch')).source('contents').destination('src').clean(false).build()
    // remove any extra files created by tests
    const { readdir } = require('fs/promises')
    const expected = ['change', 'dir', 'dir/file', 'remove']
    const actual = (await readdir(srcDir)).flatMap((f) =>
      f === 'dir'
        ? [
            'dir',
            ...require('fs')
              .readdirSync(path.join(srcDir, 'dir'))
              .map((n) => `dir/${n}`)
          ]
        : [f]
    )
    for (const f of actual) {
      if (!expected.includes(f)) await rm(path.join(srcDir, f))
    }
  })

  it('should set proper default options according to metalsmith config', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.watch(true)

    assert.deepStrictEqual(ms.watch(), defaultWatchOpts)
  })

  it("should take into account metalsmith.ignore'd paths", function () {
    const ms = Metalsmith(fixture('watch'))
    ms.ignore('ignored')
    ms.watch(true)

    assert.deepStrictEqual(ms.watch(), { ...defaultWatchOpts, ignored: ['ignored'] })
  })

  it('should expand glob patterns to base directories for chokidar 4 compatibility', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.watch(['src/**/*', 'lib/layouts/**/*.njk'])

    const opts = ms.watch()
    assert.deepStrictEqual(opts.paths, ['src', 'lib/layouts'])
  })

  it('should move negation patterns to the ignored option', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.watch(['src/**/*', '!node_modules', '!.git'])

    const opts = ms.watch()
    assert.deepStrictEqual(opts.paths, ['src'])
    assert.deepStrictEqual(opts.ignored, ['node_modules', '.git'])
  })

  it('should deduplicate paths that are subdirectories of other watched paths', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.watch(['src', 'src/sub', 'lib'])

    const opts = ms.watch()
    assert.deepStrictEqual(opts.paths, ['src', 'lib'])
  })

  it('should handle a single string path', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.watch('src/**/*')

    const opts = ms.watch()
    assert.deepStrictEqual(opts.paths, ['src'])
  })

  it('should allow overwriting certain chokidar options', function () {
    const ms = Metalsmith(fixture('watch'))
    ms.ignore('ignored')
    ms.watch({
      useFsEvents: true,
      awaitWriteFinish: {
        stabilityTreshold: 500
      },
      usePolling: false,
      ignored: []
    })

    assert.deepStrictEqual(ms.watch(), {
      ...defaultWatchOpts,
      useFsEvents: true,
      awaitWriteFinish: {
        stabilityTreshold: 500
      },
      usePolling: false,
      ignored: ['ignored']
    })
  })

  /**
   * Start watching, run `trigger` after the initial build and resolve once a rebuild satisfies `check`
   * (which throws otherwise). Rebuilds are not counted on: chokidar may deliver a batch of events in
   * several waves, and FSEvents may replay a stale event from the fixture restore during watcher startup.
   */
  function expectRebuild(ms, trigger, check) {
    activeMs = ms
    let builds = 0
    return new Promise((resolve, reject) => {
      ms.watch(true).build((err, files) => {
        if (err) return reject(err)
        builds += 1
        if (builds === 1) {
          Promise.resolve().then(trigger).catch(reject)
          return
        }
        try {
          check(files)
        } catch (err) {
          if (builds > 10) reject(err)
          return
        }
        ms.watch(false).then(resolve, reject)
      })
    })
  }

  it('should detect added files', function () {
    const addFile = () => writeFile(path.join(fixture('watch/src'), 'added'), '')
    return expectRebuild(Metalsmith(fixture('watch')), addFile, (files) => {
      assert.deepStrictEqual(Object.keys(files), [...initialFiles, 'added'])
    })
  })

  it('should detect removed files', function () {
    const remove = () => rm(path.join(fixture('watch/src'), 'remove'))
    return expectRebuild(Metalsmith(fixture('watch')), remove, (files) => {
      assert.deepStrictEqual(Object.keys(files), initialFiles.slice(0, 2))
    })
  })

  it('should detect changed files', function () {
    const change = () => writeFile(path.join(fixture('watch/src'), 'change'), 'body')
    return expectRebuild(Metalsmith(fixture('watch')), change, (files) => {
      assert.strictEqual(files['change'].contents.toString(), 'body')
    })
  })

  it('should give plugins a fresh deep clone of the cached files on every rebuild', async function () {
    const touch = () => writeFile(path.join(fixture('watch/src'), 'change'), 'body')
    const original = await readFile(fixture('watch/contents/dir/file'))
    const key = path.normalize('dir/file')
    const ms = Metalsmith(fixture('watch'))
    // a plugin that mutates what it receives: with a proper clone this never reaches the cache,
    // so every rebuild appends exactly one '+' to the original instead of accumulating
    ms.use((files) => {
      files[key].contents = Buffer.concat([files[key].contents, Buffer.from('+')])
    })
    return expectRebuild(ms, touch, (files) => {
      assert.strictEqual(files[key].contents.toString(), original.toString() + '+')
      assert(Buffer.isBuffer(files[key].contents))
      assert(files[key].stats instanceof Stats)
      assert.strictEqual(files[key].stats.isFile(), true)
    })
  })

  it('should detect moved files', function () {
    const move = () => rename(path.join(fixture('watch/src'), 'change'), path.join(fixture('watch/src'), 'renamed'))
    return expectRebuild(Metalsmith(fixture('watch')), move, (files) => {
      assert.deepStrictEqual(Object.keys(files), initialFiles.slice(1).concat(['renamed']))
    })
  })

  it('should keep statik files out of the pipeline and in sync with the disk while watching', async function () {
    const src = fixture('watch/src')
    const build = fixture('watch/build')
    const ms = Metalsmith(fixture('watch')).statik(['dir'])
    activeMs = ms
    const exists = (p) =>
      access(p).then(
        () => true,
        () => false
      )
    let builds = 0
    await new Promise((resolve, reject) => {
      ms.watch(true).build(async (err, files) => {
        if (err) return reject(err)
        builds += 1
        try {
          // statik files are never part of the files object
          assert.deepStrictEqual(
            Object.keys(files),
            initialFiles.filter((f) => !f.startsWith('dir'))
          )
          if (builds === 1) {
            // copied by build(), not by the pipeline
            assert.strictEqual(await exists(path.join(build, 'dir/file')), true)
            await writeFile(path.join(src, 'dir/new'), 'new')
          } else if (await exists(path.join(build, 'dir/new'))) {
            // a file added under a statik dir is copied on the next build
            assert.strictEqual((await readFile(path.join(build, 'dir/new'))).toString(), 'new')
            if (await exists(path.join(src, 'dir/file'))) {
              await rm(path.join(src, 'dir/file'))
            } else if (!(await exists(path.join(build, 'dir/file')))) {
              // a removed statik file is no longer copied, and the build did not fail on it
              ms.watch(false).then(resolve, reject)
            }
          }
          if (builds > 10) throw new Error('Strict equality failure after 10 rounds')
        } catch (e) {
          if (!e.message.startsWith('Strict equality failure') && !(e instanceof assert.AssertionError))
            return reject(e)
          if (e.message.startsWith('Strict equality failure') || builds > 10) reject(e)
        }
      })
    })
  })

  it('should graciously batch file ops', function () {
    const batch = () =>
      Promise.all([
        rename(path.join(fixture('watch/src'), 'change'), path.join(fixture('watch/src'), 'renamed')),
        writeFile(path.join(fixture('watch/src'), 'added'), 'body'),
        rm(path.join(fixture('watch/src'), 'remove'))
      ])
    return expectRebuild(Metalsmith(fixture('watch')), batch, (files) => {
      // sorting because the order of execution of the batch is not guaranteed
      assert.deepStrictEqual(Object.keys(files).sort(), initialFiles.slice(1, 2).concat(['added', 'renamed']).sort())
    })
  })

  it('should pass synchronous errors to the watch callback', async function () {
    const ms = Metalsmith(fixture('watch'))
    const throwsError = () => {
      throw new Error('failure')
    }

    return new Promise((resolve, reject) => {
      ms.watch(true)
        .use(throwsError)
        .build((err) => {
          try {
            assert(err instanceof Error)
            ms.watch(false).then(resolve)
          } catch (err) {
            reject(err)
          }
        })
    })
  })

  it('should pass asynchronous errors to the watch callback', async function () {
    const ms = Metalsmith(fixture('watch'))
    const throwsError = (files, ms, done) => {
      done(new Error('failure'))
    }

    return new Promise((resolve, reject) => {
      ms.watch(true)
        .use(throwsError)
        .build((err) => {
          try {
            assert(err instanceof Error)
            ms.watch(false).then(resolve)
          } catch (err) {
            reject(err)
          }
        })
    })
  })
})
