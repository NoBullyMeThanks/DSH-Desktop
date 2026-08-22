'use strict'
/**
 * pty-host 的协议客户端（纯 Node，不依赖 Electron，可单独单测）。
 *
 * 职责：拉起 pty-host 子进程（系统 Node 执行）、JSON Lines 帧编解码、
 * 请求/响应配对（带超时）、data/exit 事件分发、关闭与整树清理。
 *
 * 数据帧的 data 一律 base64（与 pty-host.js 的协议约定一致）；对外暴露的
 * write/onData 接口收发的是普通 utf8 字符串，编解码收敛在本模块内部。
 */
const readline = require('node:readline')
const { spawn, spawnSync } = require('node:child_process')

/** 默认单次请求超时。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** 默认等待宿主退出的时长（shutdown 后）。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000
/** 宿主进程 close 前等待的最长时间，超时后整树强杀。 */
const HOST_CLOSE_TIMEOUT_MS = 5_000

class TerminalHostClient {
  /**
   * @param {object} options
   * @param {string} options.hostPath pty-host.js 的绝对路径
   * @param {string} options.moduleDir node-pty 所在 node_modules 目录
   * @param {string} [options.executable='node'] 执行宿主用的可执行文件（测试可注入）
   * @param {string[]} [options.hostArgs] 覆盖默认 argv（测试可注入假宿主脚本）
   * @param {object} [options.env] 宿主环境变量，默认继承 process.env
   * @param {Function} [options.log] 日志回调（stderr 与协议异常）
   */
  constructor(options = {}) {
    this.hostPath = options.hostPath
    this.moduleDir = options.moduleDir
    this.executable = options.executable ?? 'node'
    this.hostArgs = options.hostArgs
    this.env = options.env
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.onData = null // ({ sessionId, data }) => void，data 为 utf8 文本
    this.onExit = null // ({ sessionId, code }) => void
    this.onClosed = null // (exitCode) => void，宿主进程退出
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.stderrBuffer = ''
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  get pid() {
    return this.child ? this.child.pid : null
  }

  /** 最近一段宿主 stderr（错误提示用）。 */
  get lastStderr() {
    return this.stderrBuffer.slice(-2000)
  }

  /** 拉起宿主进程并接好流。返回的 Promise 在进程成功拉起后 resolve。 */
  start() {
    return new Promise((resolve, reject) => {
      const args = this.hostArgs ?? [this.hostPath, '--module-dir', this.moduleDir]
      let child
      try {
        child = spawn(this.executable, args, {
          env: this.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        reject(err)
        return
      }
      this.child = child
      this.nextId = 1
      this.pending.clear()
      this.stderrBuffer = ''

      child.once('error', (err) => reject(err))
      child.once('spawn', () => resolve())
      child.on('close', (code) => this.handleHostClose(code))

      child.stderr.on('data', (d) => {
        const text = String(d)
        this.stderrBuffer += text
        this.log(text)
      })

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => this.handleLine(line))
    })
  }

  handleHostClose(code) {
    const error = new Error(`终端宿主进程已退出（code ${code}）`)
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    if (this.onClosed) this.onClosed(code)
  }

  handleLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.log(`终端宿主输出非法协议帧：${String(line).slice(0, 120)}`)
      return
    }
    if (frame && Number.isInteger(frame.id)) {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      this.pending.delete(frame.id)
      clearTimeout(entry.timer)
      entry.resolve(frame)
      return
    }
    if (!frame || typeof frame.type !== 'string') return
    if (frame.type === 'data' && this.onData && typeof frame.sessionId === 'string') {
      this.onData({ sessionId: frame.sessionId, data: decodeData(frame.data) })
    } else if (frame.type === 'exit' && this.onExit && typeof frame.sessionId === 'string') {
      this.onExit({ sessionId: frame.sessionId, code: frame.code })
    }
  }

  /** 发送一条请求并等待响应；失败或超时抛 Error。 */
  request(type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.alive) return Promise.reject(new Error('终端宿主进程未运行'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`终端请求 ${type} 超时（${timeoutMs}ms）`))
        }, timeoutMs),
      }
      this.pending.set(id, entry)
      try {
        this.child.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n')
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(err)
      }
    })
  }

  /** 向会话写入文本（utf8，内部转 base64）。 */
  async write(sessionId, text, timeoutMs) {
    const res = await this.request('write', { sessionId, data: encodeData(String(text)) }, timeoutMs)
    if (!res.ok) throw new Error(res.error || '写入失败')
    return res
  }

  /** 调整会话终端尺寸。 */
  async resize(sessionId, cols, rows, timeoutMs) {
    const res = await this.request('resize', { sessionId, cols, rows }, timeoutMs)
    if (!res.ok) throw new Error(res.error || '调整尺寸失败')
    return res
  }

  /** 强制结束一个会话（宿主负责整树清理）。 */
  async killSession(sessionId, timeoutMs) {
    const res = await this.request('kill', { sessionId }, timeoutMs)
    if (!res.ok) throw new Error(res.error || '结束会话失败')
    return res
  }

  /**
   * 优雅关闭：发 shutdown 并等待宿主自行退出；超时则整树强杀兜底。
   * 返回宿主最终退出码（强杀路径可能返回 null）。
   */
  async shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    if (!this.alive) {
      const code = this.child ? this.child.exitCode : null
      return { ok: true, exitCode: code }
    }
    try {
      await this.request('shutdown', {}, 3_000)
    } catch {
      // 宿主可能已自行退出，走下面的 close 等待即可
    }
    const exitCode = await this.waitClose(timeoutMs)
    if (exitCode === null && this.alive) {
      this.log('终端宿主未在期限内退出，整树强杀')
      this.killTree()
      const forced = await this.waitClose(HOST_CLOSE_TIMEOUT_MS)
      return { ok: true, exitCode: forced }
    }
    return { ok: true, exitCode }
  }

  /** 等待宿主进程 close；超时返回 null。 */
  waitClose(timeoutMs) {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.resolve(this.child ? this.child.exitCode : null)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      this.child.once('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  /** 整树强杀宿主（Windows 用 taskkill /T /F，与 stopDsh 同模式）。 */
  killTree() {
    if (!this.child) return
    const pid = this.child.pid
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch (err) {
        this.log(`taskkill ${pid} 失败：${err.message}`)
      }
    } else {
      try { this.child.kill('SIGTERM') } catch {}
    }
  }

  /** 立即断开（不等待、不清理子进程树；退出路径应优先用 shutdown）。 */
  destroy() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('终端宿主已销毁'))
    }
    this.pending.clear()
    this.child = null
  }
}

function encodeData(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

function decodeData(base64) {
  try {
    return Buffer.from(String(base64), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

module.exports = { TerminalHostClient }
