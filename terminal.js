(() => {
  'use strict'
  /**
   * 终端面板页面逻辑（M3：xterm.js 渲染）。
   * xterm 6 的 UMD 构建把导出展开到全局（Terminal/FitAddon/ClipboardAddon），
   * 由 terminal.html 在 terminal.js 之前以经典 <script> 引入。
   * 面板页是本地页面，仅通过 window.__terminalBridge 与主进程通信。
   *
   * 注意：'use strict' 必须放在函数体内——沙箱渲染进程经自定义 scheme 加载
   * 经典脚本时，顶层指令会被当作表达式求值（实测报 "use strict" is not a
   * function），因此本文件整体包在 IIFE 里。
   */
  const bridge = window.__terminalBridge
  const { Terminal } = window
  // UMD 形态差异：xterm 核心把导出展开到全局（window.Terminal 直接是类），
  // 而 addon 的 UMD 把整个导出对象挂到全局名下（window.FitAddon.FitAddon 才是类）。
  const FitAddonCtor = (typeof window.FitAddon === 'function' ? window.FitAddon : window.FitAddon && window.FitAddon.FitAddon) || null
  const ClipboardAddonCtor = (typeof window.ClipboardAddon === 'function' ? window.ClipboardAddon : window.ClipboardAddon && window.ClipboardAddon.ClipboardAddon) || null

  const dot = document.getElementById('dot')
  const titleEl = document.getElementById('title')
  const statusEl = document.getElementById('status')
  const reopenBtn = document.getElementById('reopenBtn')
  const dockBottomBtn = document.getElementById('dockBottomBtn')
  const dockRightBtn = document.getElementById('dockRightBtn')
  const closeBtn = document.getElementById('closeBtn')
  const container = document.getElementById('terminal')

  let sessionId = null

  // ── 文案（主进程按 locale 下发，缺省回退中文） ──────────────────────────────
  const DEFAULT_STRINGS = {
    title: '终端',
    connecting: '正在连接…',
    installing: '正在安装终端服务…',
    startingSession: '正在启动会话…',
    connected: '已连接（{shell}）',
    exited: '进程已退出',
    reopen: '重新打开',
    hostFailed: '终端服务不可用',
    close: '收起面板',
    dockBottom: '停靠到底部',
    dockRight: '停靠到右侧',
  }
  let STR = { ...DEFAULT_STRINGS }

  // ── xterm 主题（深浅两套，与面板/应用配色同源） ─────────────────────────────
  const THEMES = {
    light: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#1f2328',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(77, 107, 254, 0.30)',
      // xterm 6 滚动条滑块颜色按 theme 字段注入样式，缺省是黑色（实测白主题下呈黑色横条）：
      // 统一改为当前主题的半透明滑块色
      scrollbarSliderBackground: 'rgba(0, 0, 0, 0.25)',
      scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.45)',
      black: '#1f2328',
      red: '#c42b1c',
      green: '#2fae5f',
      yellow: '#b58900',
      blue: '#4d6bfe',
      magenta: '#b5651d',
      cyan: '#0083a5',
      white: '#eef0f2',
      brightBlack: '#626873',
      brightRed: '#c42b1c',
      brightGreen: '#2fae5f',
      brightYellow: '#b58900',
      brightBlue: '#4d6bfe',
      brightMagenta: '#b5651d',
      brightCyan: '#0083a5',
      brightWhite: '#ffffff',
    },
    dark: {
      background: '#151517',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
      cursorAccent: '#151517',
      selectionBackground: 'rgba(77, 107, 254, 0.40)',
      scrollbarSliderBackground: 'rgba(255, 255, 255, 0.25)',
      scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.45)',
      black: '#1e1e21',
      red: '#f14c4c',
      green: '#3ecf6f',
      yellow: '#d7a84b',
      blue: '#6d8bff',
      magenta: '#c586c0',
      cyan: '#42a5c9',
      white: '#e6e6e6',
      brightBlack: '#9ba1aa',
      brightRed: '#f14c4c',
      brightGreen: '#3ecf6f',
      brightYellow: '#d7a84b',
      brightBlue: '#6d8bff',
      brightMagenta: '#c586c0',
      brightCyan: '#42a5c9',
      brightWhite: '#ffffff',
    },
  }

  // ── 终端实例 ────────────────────────────────────────────────────────────────
  let term = null
  let fitAddon = null
  // 最近一次收到/默认的深色状态：spawned 可能先于 appearance 到达，
  // xterm 创建必须用当前状态初始化主题，避免先白后黑（用户实测反馈）。
  let currentDark = false

  function initTerminal() {
    if (term) return
    if (typeof Terminal !== 'function' || !FitAddonCtor) {
      setStatus(STR.hostFailed, 'error')
      return
    }
    term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: true,
      theme: THEMES[currentDark ? 'dark' : 'light'],
    })
    fitAddon = new FitAddonCtor()
    term.loadAddon(fitAddon)
    if (ClipboardAddonCtor) term.loadAddon(new ClipboardAddonCtor())

    term.open(container)
    term.onData((data) => {
      if (sessionId) bridge.sendInput(sessionId, data)
    })

    scheduleFit()
  }

  /** fit 后按 xterm 实际列数/行数上报（比估算可靠）。 */
  function reportSize() {
    if (!term || !fitAddon) return
    try {
      fitAddon.fit()
    } catch {}
    if (sessionId) bridge.resize(sessionId, term.cols, term.rows)
  }

  let fitTimer = null
  function scheduleFit() {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(reportSize, 100)
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleFit).observe(container)
  }
  window.addEventListener('resize', scheduleFit)

  // ── 状态与文案 ──────────────────────────────────────────────────────────────

  function setStatus(text, mode) {
    statusEl.textContent = text
    dot.dataset.mode = mode || 'idle'
  }

  function setInputEnabled(enabled) {
    if (term) term.options.disableStdin = !enabled
  }

  function setExited(exited) {
    document.body.dataset.exited = exited ? 'true' : 'false'
  }

  function applyStrings(strings) {
    if (strings && typeof strings === 'object') {
      STR = { ...DEFAULT_STRINGS, ...strings }
    }
    titleEl.textContent = STR.title
    reopenBtn.textContent = STR.reopen
    closeBtn.title = STR.close
    dockBottomBtn.title = STR.dockBottom
    dockRightBtn.title = STR.dockRight
  }

  // ── 主进程事件 ──────────────────────────────────────────────────────────────

  bridge.on('terminal:appearance', ({ dark, strings }) => {
    currentDark = dark === true
    document.body.dataset.theme = currentDark ? 'dark' : 'light'
    // 容器背景与 xterm 主题背景同色：fit 取整余量/切换瞬间的裁切区不可见
    document.documentElement.style.setProperty('--term-bg', THEMES[currentDark ? 'dark' : 'light'].background)
    if (term) term.options.theme = THEMES[currentDark ? 'dark' : 'light']
    if (strings) applyStrings(strings)
  })
  bridge.on('terminal:host-state', ({ state, message }) => {
    if (state === 'installing') {
      setStatus(STR.installing, 'busy')
    } else if (state === 'down') {
      setStatus(message || STR.hostFailed, 'error')
      setInputEnabled(false)
      setExited(true)
    } else if (state === 'ready' && !sessionId) {
      setStatus(STR.startingSession, 'busy')
    }
  })
  bridge.on('terminal:spawned', ({ sessionId: id, shell }) => {
    sessionId = id
    initTerminal()
    if (!term) return
    setExited(false)
    term.reset()
    setStatus(STR.connected.replace('{shell}', shell), 'ready')
    setInputEnabled(true)
    reportSize()
    term.focus()
  })
  bridge.on('terminal:data', ({ sessionId: id, data }) => {
    if (id !== sessionId || !term) return
    term.write(data)
  })
  bridge.on('terminal:exit', ({ sessionId: id, code }) => {
    if (id !== sessionId) return
    sessionId = null
    const codeText = code === null || code === undefined ? '-' : code
    setStatus(`${STR.exited}（code ${codeText}）`, 'error')
    setInputEnabled(false)
    setExited(true)
  })
  bridge.on('terminal:error', ({ message }) => {
    setStatus(message || STR.hostFailed, 'error')
    setInputEnabled(false)
    setExited(true)
  })
  bridge.on('terminal:focus', () => {
    if (term) {
      scheduleFit()
      term.focus()
    }
  })
  bridge.on('terminal:dock-state', ({ mode }) => {
    const right = mode === 'right'
    dockBottomBtn.classList.toggle('active', !right)
    dockRightBtn.classList.toggle('active', right)
    // 停靠切换后尺寸立即适配（ResizeObserver 有 100ms 防抖，不足以消除切换瞬间的裁切闪现）
    if (term) reportSize()
  })

  // ── 本地交互 ────────────────────────────────────────────────────────────────

  reopenBtn.addEventListener('click', () => bridge.spawn())
  dockBottomBtn.addEventListener('click', () => bridge.setDock('bottom'))
  dockRightBtn.addEventListener('click', () => bridge.setDock('right'))
  closeBtn.addEventListener('click', () => bridge.togglePanel())

  // 集成冒烟用：从 xterm 缓冲区取纯文本（与渲染器无关，canvas 渲染下也可用）
  window.__getTermText = () => {
    if (!term) return ''
    let text = ''
    for (let i = 0; i < term.buffer.active.length; i++) {
      const line = term.buffer.active.getLine(i)
      if (line) text += line.translateToString(true) + '\n'
    }
    return text
  }

  setStatus(STR.connecting, 'busy')
  bridge.ready()
  window.__readySent = true // 供集成冒烟确认发送侧已执行
})()
