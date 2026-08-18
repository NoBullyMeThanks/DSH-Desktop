'use strict'
/**
 * 运行时管理：把 `@deepseek-ai/dsh` 装进 `~/.dsh-desktop/runtime`，
 * 提供「安装 / 查最新 / 更新 / 回退 / 运行时完整性 / Node 可用性检查」能力。
 *
 * 只依赖 Node 内置模块，不依赖 Electron，可用纯 Node 单独单测。
 *
 * 关键约定：桌面程序只认 npm registry（官方发布源），与本地的 git clone
 * 无关——「跟随最新版」就是向 npm 服务器查版本、下载包。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

/** 桌面程序自己的运行时/数据根目录。 */
const BASE_DIR = path.join(os.homedir(), '.dsh-desktop')
/** @deepseek-ai/dsh 的安装目录（npm 的 cwd）。 */
const RUNTIME_DIR = path.join(BASE_DIR, 'runtime')
/** 记录已装版本与历史（用于回退）的元数据文件。 */
const VERSION_FILE = path.join(BASE_DIR, 'version.json')
/** npm 上的官方发布包。 */
const PKG_NAME = '@deepseek-ai/dsh'
/** npm 命令名：Windows 下由 run() 用 cmd.exe /c 解析 PATHEXT，这里统一用 `npm`。 */
function npmCommand() {
  return 'npm'
}

/**
 * 跑一条命令，返回 `{ ok, code, out, err, error }`。
 * 用 spawn 管道拼接而非 exec，避免 npm install 输出超过默认 maxBuffer。
 * Windows 下用 cmd.exe /c 执行（npm 是 .cmd 脚本，不能直接 CreateProcess），
 * 避免 shell:true 的 DEP0190 弃用告警；本模块所有参数均无空格/特殊字符，
 * 故 join 成命令行字符串是安全的。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/d', '/s', '/c', [cmd, ...args].join(' ')], {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } else {
        child = spawn(cmd, args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    } catch (e) {
      return resolve({ ok: false, error: e })
    }
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', (e) => resolve({ ok: false, error: e }))
    child.on('close', (code) => resolve({ ok: code === 0, code, out, err }))
  })
}

/** 把一个 run 结果转成可读的错误信息。 */
function errMsg(res) {
  if (res.error) return res.error.message ?? String(res.error)
  if (res.err && res.err.trim()) return res.err.trim().slice(-2000)
  return `命令退出码 ${res.code}`
}

/** 确保运行时目录与最小 package.json 存在（npm install 的 cwd）。 */
function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const pkgJson = path.join(RUNTIME_DIR, 'package.json')
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({
      private: true,
      type: 'module',
      description: 'DSH Desktop 管理的运行时，请勿手动修改',
    }, null, 2) + '\n')
  }
}

/** 当前已安装的 @deepseek-ai/dsh 版本，未安装返回 null。 */
function installedVersion(runtimeDir = RUNTIME_DIR) {
  try {
    const p = path.join(runtimeDir, 'node_modules', ...PKG_NAME.split('/'), 'package.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** 当前安装的 dsh 入口 bin 路径。 */
function binPath(runtimeDir = RUNTIME_DIR) {
  return path.join(runtimeDir, 'node_modules', ...PKG_NAME.split('/'), 'lib', 'bin.js')
}

/**
 * 检查运行时是否完整可用。仅有 package.json 不足以证明安装成功，
 * 入口文件缺失时必须重新安装，避免启动重试一直命中同一个损坏目录。
 */
function runtimeStatus(runtimeDir = RUNTIME_DIR) {
  const version = installedVersion(runtimeDir)
  let hasBin = false
  try { hasBin = fs.statSync(binPath(runtimeDir)).isFile() } catch { hasBin = false }
  return {
    version,
    usable: Boolean(parseVersion(version) && hasBin),
    hasBin,
  }
}

/** 读取版本元数据（installed + history），文件缺失/损坏时返回空结构。 */
function readVersionFile() {
  try {
    const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
    return { installed: typeof j.installed === 'string' ? j.installed : null, history: Array.isArray(j.history) ? j.history : [] }
  } catch {
    return { installed: null, history: [] }
  }
}

function writeVersionFile(data) {
  fs.mkdirSync(BASE_DIR, { recursive: true })
  fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2) + '\n')
}

/**
 * 安装指定版本（缺省 latest）。成功后更新版本元数据，
 * 把「被替换掉的旧版本」压入 history 用于回退，history 最多保留 3 个。
 */
async function installVersion(version, options = {}) {
  ensureRuntimeDir()
  const target = version || 'latest'
  if (target !== 'latest' && !parseVersion(target)) return { ok: false, err: `无效的 DSH 版本：${target}` }
  const spec = `${PKG_NAME}@${target}`
  const args = ['install', spec]
  if (options.force === true) args.push('--force')
  const res = await run(npmCommand(), args, { cwd: RUNTIME_DIR })
  if (!res.ok) return { ok: false, err: errMsg(res) }
  const status = runtimeStatus()
  if (!status.usable) {
    return { ok: false, err: `npm 安装完成，但 DSH 运行时完整性校验失败：${binPath()}` }
  }
  const newVer = status.version
  if (newVer) {
    const vf = readVersionFile()
    if (vf.installed && vf.installed !== newVer && !vf.history.includes(vf.installed)) {
      vf.history.unshift(vf.installed)
    }
    vf.history = vf.history.slice(0, 3)
    vf.installed = newVer
    writeVersionFile(vf)
  }
  return { ok: true, version: newVer }
}

/**
 * 确保运行时可用：完整安装直接复用；入口缺失时修复当前精确版本；
 * 无法识别已装版本时安装 latest。options 仅用于纯 Node 测试注入临时目录与安装器。
 */
async function ensureRuntime(options = {}) {
  const runtimeDir = options.runtimeDir ?? RUNTIME_DIR
  const installer = options.installer ?? installVersion
  const status = runtimeStatus(runtimeDir)
  if (status.usable) return { ok: true, version: status.version, repaired: false }
  const target = parseVersion(status.version) ? status.version : 'latest'
  const result = await installer(target, { force: target !== 'latest' })
  return { ...result, repaired: target !== 'latest' }
}

/** 向 npm registry 查 @deepseek-ai/dsh 的最新版本；失败（离线等）返回 null。 */
async function latestVersion() {
  const res = await run(npmCommand(), ['view', PKG_NAME, 'version'], {})
  if (!res.ok) return null
  const first = res.out.trim().split(/\s+/)[0]
  return parseVersion(first) ? first : null
}

/** 回退目标：最近一次被替换掉的版本（history 第一个）。 */
function rollbackTarget() {
  const target = readVersionFile().history[0]
  return parseVersion(target) ? target : null
}

/** 解析完整的 SemVer（构建元数据不参与比较），无法解析返回 null。 */
function parseVersion(v) {
  if (typeof v !== 'string') return null
  const identifier = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*'
  const m = v.trim().match(new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${identifier}))?(?:\\+${identifier})?$`))
  if (!m) return null
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre: m[4] ? m[4].split('.') : [],
  }
}

/**
 * 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 能区分 prerelease（`0.1.0-rc.7` < `0.1.0-rc.8` < `0.1.0`），
 * 这是「跟随预览版最新」的关键——rc 版本号也能正确判定新旧。
 */
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1 // 正式版 > 任何 prerelease
  if (pb.pre.length === 0) return -1
  const n = Math.min(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return parseInt(x, 10) > parseInt(y, 10) ? 1 : -1
    if (xNum) return -1 // 数字段 < 字母段
    if (yNum) return 1
    return x > y ? 1 : -1
  }
  if (pa.pre.length === pb.pre.length) return 0
  return pa.pre.length > pb.pre.length ? 1 : -1
}

/** 读取系统 node 版本字符串（去 v 前缀）；取不到返回 null。 */
function nodeVersion() {
  try {
    const r = spawnSync('node', ['--version'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout) return r.stdout.trim().replace(/^v/, '')
  } catch {}
  return null
}

/** 只判断系统是否提供了可执行的 Node，不对版本设置硬门槛。 */
function nodeIsAvailable(version) {
  return typeof version === 'string' && version.trim().length > 0
}

module.exports = {
  BASE_DIR,
  RUNTIME_DIR,
  VERSION_FILE,
  npmCommand,
  run,
  ensureRuntime,
  installVersion,
  installedVersion,
  latestVersion,
  rollbackTarget,
  binPath,
  runtimeStatus,
  compareVersions,
  parseVersion,
  nodeVersion,
  nodeIsAvailable,
}
