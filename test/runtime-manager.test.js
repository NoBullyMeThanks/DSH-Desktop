'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const runtime = require('../runtime-manager.js')

function createRuntime(t, version = '1.2.3', withBin = true) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-runtime-'))
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }))
  if (withBin) fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  return runtimeDir
}

test('compareVersions 遵循 SemVer 预发布优先级', () => {
  assert.equal(runtime.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(runtime.compareVersions('1.0.0-rc.7', '1.0.0-rc.8'), -1)
  assert.equal(runtime.compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(runtime.compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(runtime.compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(runtime.parseVersion('1.2.3garbage'), null)
})

test('Node 可用性不设置版本门槛', () => {
  assert.equal(runtime.nodeIsAvailable('0.0.1'), true)
  assert.equal(runtime.nodeIsAvailable('23.0.0'), true)
  assert.equal(runtime.nodeIsAvailable(''), false)
  assert.equal(runtime.nodeIsAvailable(null), false)
})

test('完整运行时直接复用', async (t) => {
  const runtimeDir = createRuntime(t)
  let installs = 0
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async () => { installs += 1; return { ok: true, version: 'unexpected' } },
  })
  assert.deepEqual(result, { ok: true, version: '1.2.3', repaired: false })
  assert.equal(installs, 0)
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
})

test('入口缺失时重装当前精确版本', async (t) => {
  const runtimeDir = createRuntime(t, '1.2.3', false)
  let target = null
  let installOptions = null
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async (version, options) => { target = version; installOptions = options; return { ok: true, version } },
  })
  assert.equal(target, '1.2.3')
  assert.deepEqual(installOptions, { force: true })
  assert.equal(result.repaired, true)
})

test('无法识别版本时安装 latest', async (t) => {
  const runtimeDir = createRuntime(t, 'not-semver', false)
  let target = null
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async (version, options) => {
      target = version
      assert.deepEqual(options, { force: false })
      return { ok: true, version: '2.0.0' }
    },
  })
  assert.equal(target, 'latest')
  assert.equal(result.repaired, false)
})
