'use strict'
/**
 * 临时分析脚本（开发用）：加载 dsh web UI，分析布局框架与滚动容器结构。
 * 只读加载 + DOM 查询，不做任何交互，用完即删。
 * 用法：node_modules\.bin\electron.cmd scripts/analyze-dsh-layout.js <url>
 */
const { app, BrowserWindow } = require('electron')

const url = process.argv[2]
if (!url) {
  console.error('用法：analyze-dsh-layout.js <url>')
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
  // 等 SPA 完整渲染（会话列表/聊天区）
  await new Promise((resolve) => setTimeout(resolve, 8000))
  try {
    const result = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root')
      const all = root ? [root, ...root.querySelectorAll('div')] : []
      const frame = all.find((el) => {
        const s = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return s.display === 'grid' && s.gridTemplateColumns.split(/\\s+/).length >= 2
          && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8
      })
      const out = { inner: [innerWidth, innerHeight], frame: null, columns: [], scrollables: [], centerTree: [] }
      let centerCol = null
      if (frame) {
        const fr = frame.getBoundingClientRect()
        out.frame = { id: frame.id, cls: String(frame.className).slice(0, 100), rect: [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)], cols: getComputedStyle(frame).gridTemplateColumns }
        out.columns = Array.from(frame.children).map((child, i) => {
          const cr = child.getBoundingClientRect()
          const entry = {
            i,
            id: child.id,
            cls: String(child.className).slice(0, 90),
            slot: child.getAttribute('data-slot'),
            role: child.getAttribute('role'),
            rect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)],
          }
          // 会话区 = grid 第 2 个轨道列（sidebar 右侧、宽度最大的内容列）
          if (i === 1 && cr.width > 300 && cr.left > 50) centerCol = child
          return entry
        })
      }
      // centerCol 子树（两层）与其中的滚动容器
      const describe = (el, depth) => {
        const cr = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return {
          depth,
          tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 70),
          role: el.getAttribute('role'),
          overflowY: s.overflowY,
          scroll: el.scrollHeight > el.clientHeight + 2 ? 'yes' : 'no',
          rect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)],
        }
      }
      if (centerCol) {
        const walk = (el, depth) => {
          if (depth > 6) return
          if (out.centerTree.length > 100) return
          out.centerTree.push(describe(el, depth))
          if (depth < 6) {
            for (const child of el.children) walk(child, depth + 1)
          }
        }
        walk(centerCol, 0)
      }
      const seen = new Set()
      for (const el of all) {
        const s = getComputedStyle(el)
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.getBoundingClientRect().height > 50) {
          const sig = el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 40)
          if (seen.has(sig)) continue
          seen.add(sig)
          out.scrollables.push({
            tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 80),
            role: el.getAttribute('role'),
            scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
            rectTop: Math.round(el.getBoundingClientRect().top),
            rectHeight: Math.round(el.getBoundingClientRect().height),
          })
        }
      }
      return out
    })()`)
    // 第二轮：注入实验（async IIFE 需要在 executeJavaScript 的字符串里自建）
    const experiment = await win.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById('root')
      const all = root ? [root, ...root.querySelectorAll('div')] : []
      const frame = all.find((el) => {
        const s = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return s.display === 'grid' && s.gridTemplateColumns.split(/\\s+/).length >= 2
          && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8
      })
      if (!frame) return { error: 'no frame' }
      const centerCol = frame.children[1]
      if (!centerCol) return { error: 'no centerCol' }
      const describe = (el) => {
        const cr = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return { cls: String(el.className).slice(0, 70), overflowY: s.overflowY, rect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)] }
      }
      const findScrollTarget = () => {
        const candidates = []
        const scan = (el) => {
          const s = getComputedStyle(el)
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.getBoundingClientRect().height > 100) candidates.push(el)
          for (const child of el.children) scan(child)
        }
        scan(centerCol)
        candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)
        return candidates[0] || null
      }
      const findMessageBody = () => {
        // 消息列表滚动体：overflow auto/scroll、贴窗口底部、top>40（在 header 之下），
        // 且不包含 textarea（据此排除含 composer 的 scrollBody 与 composer 内滚动体）
        const candidates = []
        const scan = (el) => {
          const s = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          const containsComposer = el.querySelector('textarea, [contenteditable="true"]')
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && !containsComposer
            && r.bottom >= innerHeight - 2 && r.top > 40) {
            candidates.push(el)
          }
          for (const child of el.children) scan(child)
        }
        scan(centerCol)
        candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)
        return candidates[0] || null
      }
      // 消息区容器：scrollBody 直接子元素中不含 textarea 的那个（空会话时无子元素）
      const findMessageSeat = (scrollBody) => {
        if (!scrollBody) return null
        for (const child of scrollBody.children) {
          if (!child.querySelector('textarea, [contenteditable="true"]')) return child
        }
        return null
      }
      const rectOf = (el) => {
        const r = el.getBoundingClientRect()
        return [Math.round(r.top), Math.round(r.height), Math.round(r.bottom)]
      }
      const scrollTarget = findScrollTarget()
      const messageSeat = findMessageSeat(scrollTarget)
      const textarea = centerCol.querySelector('textarea, [contenteditable="true"]')
      const composerProbe = textarea ? textarea.closest('div') : null
      const pathOf = (el) => {
        const parts = []
        let cur = el
        while (cur && cur !== centerCol.parentElement) {
          parts.unshift(cur.tagName + (cur.className ? '.' + String(cur.className).slice(0, 30) : ''))
          cur = cur.parentElement
        }
        return parts.join(' > ')
      }
      const out = {
        target: scrollTarget ? describe(scrollTarget) : null,
        messageSeat: messageSeat ? { cls: describe(messageSeat).cls, rect: rectOf(messageSeat), display: getComputedStyle(messageSeat).display, children: messageSeat.children.length, path: pathOf(messageSeat) } : null,
        composerHadProbe: !!composerProbe,
      }
      // 造假消息：撑出消息滚动体（DOM 注入，刷新即回滚），再测 padding 效果
      const filler = document.createElement('div')
      filler.style.height = '2000px'
      filler.textContent = 'dshdesktop-smoke-filler'
      if (messageSeat) messageSeat.appendChild(filler)
      await new Promise((r) => setTimeout(r, 250))
      // 有消息后重新定位消息滚动体
      const msgBody = findMessageBody()
      out.msgBody = msgBody ? { cls: describe(msgBody).cls, rect: rectOf(msgBody), overflow: getComputedStyle(msgBody).overflowY, path: pathOf(msgBody) } : null
      if (msgBody) {
        out.msgBodyBefore = rectOf(msgBody)
        out.composerBefore = composerProbe ? rectOf(composerProbe) : null
        msgBody.style.paddingBottom = '200px'
        await new Promise((r) => setTimeout(r, 250))
        out.msgBodyAfterPaddingBottom = rectOf(msgBody)
        out.composerAfterPaddingBottom = composerProbe ? rectOf(composerProbe) : null
        msgBody.style.paddingBottom = ''
        msgBody.style.paddingRight = '300px'
        await new Promise((r) => setTimeout(r, 250))
        out.msgBodyAfterPaddingRight = rectOf(msgBody)
        out.composerAfterPaddingRight = composerProbe ? rectOf(composerProbe) : null
        msgBody.style.paddingRight = ''
      }
      if (filler.parentElement) filler.remove()
      return out
    })()`)
    result.experiment = experiment
    console.log(JSON.stringify(result, null, 2))
    // 第三轮：测 DSH 会话区 header 高度（顶部条带与滚动体起点）
    const headerProbe = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root')
      const all = root ? [root, ...root.querySelectorAll('div')] : []
      const frame = all.find((el) => {
        const s = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return s.display === 'grid' && s.gridTemplateColumns.split(/\\s+/).length >= 2
          && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8
      })
      if (!frame) return { error: 'no frame' }
      const centerCol = frame.children[1]
      if (!centerCol) return { error: 'no centerCol' }
      const strips = []
      const scan = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width > 200 && r.height > 25 && r.height < 160 && r.top < 20 && r.top > -1) {
          strips.push({ cls: String(el.className).slice(0, 60), top: Math.round(r.top), height: Math.round(r.height) })
        }
        for (const child of el.children) scan(child)
      }
      scan(centerCol)
      const findScroll = (el) => {
        const s = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && r.height > 100 && r.top > 40) return el
        for (const child of el.children) {
          const found = findScroll(child)
          if (found) return found
        }
        return null
      }
      const scroller = findScroll(centerCol)
      return { strips: strips.slice(0, 12), scrollerTop: scroller ? Math.round(scroller.getBoundingClientRect().top) : null }
    })()`)
    console.log('HEADER_PROBE ' + JSON.stringify(headerProbe))
  } catch (err) {
    console.error('分析失败：', err.message)
  }
  app.quit()
})
