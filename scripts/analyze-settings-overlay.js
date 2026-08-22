'use strict'
/**
 * 临时分析脚本：打开 DSH 设置面板并 Dump 浮层 DOM 结构。
 * 分析窗口是独立客户端，点开/关闭设置只影响分析窗口自身，不影响其他窗口。
 * 用法：node_modules\.bin\electron.cmd scripts/analyze-settings-overlay.js <url>
 */
const { app, BrowserWindow } = require('electron')

const url = process.argv[2]
if (!url) {
  console.error('用法：analyze-settings-overlay.js <url>')
  app.exit(2)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  await win.loadURL(url)
  await new Promise((resolve) => setTimeout(resolve, 8000))

  // 1) 找设置入口并点开：匹配 aria-label/title/text 含 设置/settings
  const clickResult = await win.webContents.executeJavaScript(`(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const hit = candidates.find((el) => {
      const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
        .filter(Boolean).join(' ').toLowerCase()
      return text.includes('设置') || text.includes('settings') || text.includes('setting')
    })
    if (!hit) return { ok: false, reason: '未找到设置入口' }
    hit.click()
    return { ok: true, tag: hit.tagName, label: (hit.getAttribute('aria-label') || hit.title || hit.textContent || '').slice(0, 40) }
  })()`)
  console.log('CLICK ' + JSON.stringify(clickResult))
  await new Promise((resolve) => setTimeout(resolve, 2500))

  // 2) Dump：overlay 容器内容、body 顶层 fixed 层、采样命中
  const dump = await win.webContents.executeJavaScript(`(() => {
    const root = document.getElementById('root')
    const all = root ? [root, ...root.querySelectorAll('div')] : []
    const frame = all.find((el) => {
      const s = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return s.display === 'grid' && s.gridTemplateColumns.split(/\\s+/).length >= 2
        && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8
    })
    const out = { frame: !!frame }
    // frame 子列
    if (frame) {
      out.columns = Array.from(frame.children).map((child, i) => ({
        i,
        cls: String(child.className).slice(0, 60),
        children: child.children.length,
        rect: [Math.round(child.getBoundingClientRect().left), Math.round(child.getBoundingClientRect().top), Math.round(child.getBoundingClientRect().width), Math.round(child.getBoundingClientRect().height)],
      }))
    }
    // body 顶层 fixed 层
    out.bodyTopFixed = Array.from(document.body.children)
      .filter((el) => getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().width > 100)
      .map((el) => ({ cls: String(el.className).slice(0, 60), id: el.id, rect: [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)] }))
    // 9 点采样命中
    out.samples = []
    for (const [xr, yr] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.5, 0.05], [0.05, 0.5], [0.95, 0.5], [0.5, 0.95], [0.05, 0.95], [0.95, 0.95]]) {
      const el = document.elementFromPoint(innerWidth * xr, innerHeight * yr)
      out.samples.push({
        pt: [xr, yr],
        inFrame: el ? Boolean(frame && frame.contains(el)) : null,
        overlayHost: el ? Boolean(frame && Array.from(frame.children).some((c) => String(c.className).toLowerCase().includes('overlay') && c.contains(el))) : null,
        cls: el ? String(el.className || el.tagName).slice(0, 50) : 'null',
      })
    }
    return out
  })()`)
  console.log('DUMP ' + JSON.stringify(dump, null, 2))

  // 3) 复现 pageHasOverlay 新判定：命中元素祖先链上有覆盖 60%+ 视口的 fixed/absolute 层 → 浮层
  const detectOpen = await win.webContents.executeJavaScript(`(() => {
    const isOverlayElement = (el) => {
      let cur = el
      let depth = 0
      while (cur && cur !== document.body && depth < 12) {
        const style = getComputedStyle(cur)
        if (style.position === 'fixed' || style.position === 'absolute') {
          const r = cur.getBoundingClientRect()
          if (r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.6) return true
        }
        cur = cur.parentElement
        depth++
      }
      return false
    }
    let hits = 0
    for (const [xr, yr] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.5, 0.05], [0.05, 0.5], [0.95, 0.5], [0.5, 0.95], [0.05, 0.95], [0.95, 0.95]]) {
      const el = document.elementFromPoint(innerWidth * xr, innerHeight * yr)
      if (!el || el === document.documentElement || el === document.body) continue
      if (isOverlayElement(el)) hits += 1
    }
    return { hits, overlay: hits >= 4 }
  })()`)
  console.log('DETECT_OPEN ' + JSON.stringify(detectOpen))

  // 4) 关闭设置（Esc）后再判定：应为 false
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const detectClosed = await win.webContents.executeJavaScript(`(() => {
    const isOverlayElement = (el) => {
      let cur = el
      let depth = 0
      while (cur && cur !== document.body && depth < 12) {
        const style = getComputedStyle(cur)
        if (style.position === 'fixed' || style.position === 'absolute') {
          const r = cur.getBoundingClientRect()
          if (r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.6) return true
        }
        cur = cur.parentElement
        depth++
      }
      return false
    }
    let hits = 0
    for (const [xr, yr] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.5, 0.05], [0.05, 0.5], [0.95, 0.5], [0.5, 0.95], [0.05, 0.95], [0.95, 0.95]]) {
      const el = document.elementFromPoint(innerWidth * xr, innerHeight * yr)
      if (!el || el === document.documentElement || el === document.body) continue
      if (isOverlayElement(el)) hits += 1
    }
    return { hits, overlay: hits >= 4 }
  })()`)
  console.log('DETECT_CLOSED ' + JSON.stringify(detectClosed))
  app.quit()
})
