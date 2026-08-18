'use strict'
/**
 * DSH 内容页的内部观测器：读取页面最终计算出的主题色和侧栏宽度，
 * 通过单向 IPC 上报给主进程。不会向 DSH 页面暴露任何 Electron API。
 */
const { ipcRenderer } = require('electron')

let frame = null
let sidebar = null
let resizeObserver = null
let probe = null
let dragRow = null
let scheduled = false
let lastPayload = ''
let dialogHost = null
let dialogRoot = null
let activeDialogState = null
let dialogPreviousFocus = null
let dialogActionPending = false

const DIALOG_MODES = new Set(['loading', 'progress', 'info', 'confirm', 'error'])

function ensureDialogUi() {
  if (dialogRoot || !document.body) return

  dialogHost = document.createElement('div')
  dialogHost.id = 'dsh-desktop-dialog-host'
  Object.assign(dialogHost.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'none',
    webkitAppRegion: 'no-drag',
  })
  dialogRoot = dialogHost.attachShadow({ mode: 'closed' })
  dialogRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        color: var(--dsw-alias-label-primary, #171717);
        font-family: var(--dsw-font-family, "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif);
      }
      * { box-sizing: border-box; }
      .backdrop {
        position: fixed;
        inset: 0;
        display: grid;
        padding: 24px;
        place-items: center;
        background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.36));
        backdrop-filter: blur(var(--dsw-mask-blur, 4px));
        -webkit-backdrop-filter: blur(var(--dsw-mask-blur, 4px));
        -webkit-app-region: no-drag;
      }
      .dialog {
        position: relative;
        width: min(420px, calc(100vw - 48px));
        max-height: calc(100vh - 48px);
        padding: 24px;
        overflow: auto;
        color: var(--dsw-alias-label-primary, #171717);
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
        border-radius: 24px;
        box-shadow: var(--dsw-shadow-lv3, 0 20px 48px rgba(0, 0, 0, 0.20));
        outline: none;
        transform-origin: center;
        animation: enter 150ms ease-out;
      }
      .head {
        display: flex;
        min-height: 28px;
        align-items: flex-start;
        gap: 12px;
      }
      .indicator {
        position: relative;
        width: 24px;
        height: 24px;
        flex: 0 0 auto;
        color: var(--dsw-alias-label-secondary, #626873);
        border-radius: 50%;
      }
      .indicator[data-mode='loading'],
      .indicator[data-mode='progress'] {
        border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #4d6bfe) 18%, transparent);
        border-top-color: var(--dsw-alias-button-primary-fill, #4d6bfe);
        animation: spin 0.75s linear infinite;
      }
      .indicator[data-mode='info']::before,
      .indicator[data-mode='error']::before,
      .indicator[data-mode='confirm']::before {
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        font-size: 14px;
        font-weight: 700;
        border: 1px solid currentColor;
        border-radius: 50%;
      }
      .indicator[data-mode='info']::before { content: 'i'; }
      .indicator[data-mode='confirm']::before { content: '?'; }
      .indicator[data-mode='error'] {
        color: var(--dsw-alias-label-error, #d64545);
      }
      .indicator[data-mode='error']::before { content: '!'; }
      h2 {
        flex: 1;
        margin: 0;
        font-size: 18px;
        font-weight: 650;
        line-height: 26px;
      }
      .close {
        width: 28px;
        height: 28px;
        margin: -3px -4px 0 0;
        padding: 0;
        color: var(--dsw-alias-label-secondary, #626873);
        background: transparent;
        border: 0;
        border-radius: 8px;
        font-size: 20px;
        line-height: 28px;
        cursor: pointer;
      }
      .close:hover {
        color: var(--dsw-alias-label-primary, #171717);
        background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.06));
      }
      .message {
        margin: 14px 0 0 36px;
        color: var(--dsw-alias-label-secondary, #626873);
        font-size: 14px;
        line-height: 22px;
        white-space: pre-wrap;
      }
      .detail {
        max-height: 144px;
        margin: 14px 0 0 36px;
        padding: 10px 12px;
        overflow: auto;
        color: var(--dsw-alias-label-tertiary, #777d87);
        background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.035));
        border-radius: 10px;
        font: 12px/18px Consolas, "Cascadia Mono", monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .actions {
        display: flex;
        min-height: 36px;
        margin-top: 22px;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        min-width: 80px;
        height: 36px;
        padding: 0 16px;
        color: var(--dsw-alias-label-primary, #171717);
        background: var(--dsw-alias-button-secondary-fill, rgba(0, 0, 0, 0.055));
        border: 1px solid var(--dsw-alias-border-l1, transparent);
        border-radius: 10px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: var(--dsw-alias-button-secondary-fill-hover, rgba(0, 0, 0, 0.09));
      }
      button[data-kind='primary'] {
        color: var(--dsw-alias-button-primary-label, #ffffff);
        background: var(--dsw-alias-button-primary-fill, #4d6bfe);
        border-color: transparent;
      }
      button[data-kind='primary']:hover:not(:disabled) {
        background: var(--dsw-alias-button-primary-fill-hover, #405de5);
      }
      button[data-kind='danger'] {
        color: var(--dsw-alias-label-error, #d64545);
      }
      button:disabled { opacity: 0.55; cursor: default; }
      button:focus-visible, .dialog:focus-visible {
        outline: 2px solid var(--dsw-alias-border-focus, #4d6bfe);
        outline-offset: 2px;
      }
      [hidden] { display: none !important; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes enter {
        from { opacity: 0; transform: scale(0.98) translateY(4px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dialog { animation: none; }
        .indicator[data-mode='loading'],
        .indicator[data-mode='progress'] { animation-duration: 1.5s; }
      }
    </style>
    <div class="backdrop">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" tabindex="-1">
        <div class="head">
          <span class="indicator" aria-hidden="true"></span>
          <h2 id="dialog-title"></h2>
          <button class="close" type="button" aria-label="Close" hidden>×</button>
        </div>
        <p id="dialog-message" class="message"></p>
        <pre class="detail" hidden></pre>
        <div class="actions"></div>
      </section>
    </div>
  `
  document.body.appendChild(dialogHost)

  dialogRoot.querySelector('.close').addEventListener('click', () => sendDialogAction(activeDialogState?.cancelAction))
  dialogRoot.querySelector('.backdrop').addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget && activeDialogState?.cancelable) {
      sendDialogAction(activeDialogState.cancelAction)
    }
  })
}

function isValidDialogState(state) {
  return state &&
    typeof state === 'object' &&
    typeof state.id === 'string' &&
    DIALOG_MODES.has(state.mode) &&
    typeof state.title === 'string' &&
    typeof state.message === 'string'
}

function renderDialog(state) {
  if (state?.mode === 'close') {
    if (!activeDialogState || !state.id || state.id === activeDialogState.id) closeDialog()
    return
  }
  if (!isValidDialogState(state)) return
  ensureDialogUi()

  if (!activeDialogState) dialogPreviousFocus = document.activeElement
  activeDialogState = {
    ...state,
    cancelable: Boolean(state.cancelable),
    buttons: Array.isArray(state.buttons) ? state.buttons : [],
  }
  dialogActionPending = false

  const dialog = dialogRoot.querySelector('.dialog')
  const indicator = dialogRoot.querySelector('.indicator')
  const title = dialogRoot.querySelector('h2')
  const message = dialogRoot.querySelector('.message')
  const detail = dialogRoot.querySelector('.detail')
  const close = dialogRoot.querySelector('.close')
  const actions = dialogRoot.querySelector('.actions')

  indicator.dataset.mode = state.mode
  title.textContent = state.title
  message.textContent = state.message
  detail.textContent = typeof state.detail === 'string' ? state.detail : ''
  detail.hidden = !detail.textContent
  close.hidden = !activeDialogState.cancelable
  actions.replaceChildren()

  for (const item of activeDialogState.buttons) {
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') continue
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = item.id
    button.dataset.kind = ['primary', 'danger'].includes(item.kind) ? item.kind : 'secondary'
    button.textContent = item.label
    button.disabled = Boolean(item.disabled)
    button.addEventListener('click', () => sendDialogAction(item.id))
    actions.append(button)
  }

  actions.hidden = actions.childElementCount === 0
  dialogHost.style.display = 'block'
  requestAnimationFrame(() => {
    const defaultButton = typeof state.defaultAction === 'string'
      ? actions.querySelector(`[data-action="${CSS.escape(state.defaultAction)}"]`)
      : null
    ;(defaultButton ?? actions.querySelector('button:not(:disabled)') ?? dialog).focus()
  })
}

function sendDialogAction(action) {
  if (!activeDialogState || dialogActionPending || typeof action !== 'string') return
  dialogActionPending = true
  for (const button of dialogRoot.querySelectorAll('button')) button.disabled = true
  ipcRenderer.send('dsh:dialog-action', {
    id: activeDialogState.id,
    action,
  })
}

function closeDialog() {
  if (!dialogHost || !activeDialogState) return
  dialogHost.style.display = 'none'
  activeDialogState = null
  dialogActionPending = false
  if (dialogPreviousFocus instanceof HTMLElement && dialogPreviousFocus.isConnected) dialogPreviousFocus.focus()
  dialogPreviousFocus = null
}

function handleDialogKeydown(event) {
  if (!activeDialogState || dialogHost?.style.display === 'none') return

  if (event.key === 'Escape' && activeDialogState.cancelable) {
    event.preventDefault()
    event.stopImmediatePropagation()
    sendDialogAction(activeDialogState.cancelAction)
    return
  }

  if (event.key === 'Enter' && typeof activeDialogState.defaultAction === 'string') {
    event.preventDefault()
    event.stopImmediatePropagation()
    sendDialogAction(activeDialogState.defaultAction)
    return
  }

  if (event.key !== 'Tab') return
  const focusable = [...dialogRoot.querySelectorAll('button:not(:disabled), [tabindex="-1"]')]
    .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none')
  if (focusable.length === 0) return
  const current = dialogRoot.activeElement
  let index = focusable.indexOf(current)
  index = event.shiftKey
    ? (index <= 0 ? focusable.length - 1 : index - 1)
    : (index >= focusable.length - 1 ? 0 : index + 1)
  event.preventDefault()
  event.stopImmediatePropagation()
  focusable[index].focus()
}

ipcRenderer.on('dsh:dialog-state', (_event, state) => renderDialog(state))
window.addEventListener('keydown', handleDialogKeydown, true)

function ensureDragStyle() {
  if (document.getElementById('dsh-desktop-window-drag-style')) return
  const style = document.createElement('style')
  style.id = 'dsh-desktop-window-drag-style'
  style.textContent = `
    [data-dsh-desktop-drag-region] {
      -webkit-app-region: drag !important;
    }
    [data-dsh-desktop-drag-region] * {
      -webkit-app-region: no-drag !important;
    }
  `
  document.head.appendChild(style)
}

function findLogoRow() {
  if (!sidebar?.isConnected) return null

  // DSH 的 slot 渲染器会在侧栏列与 SidebarRoot 之间插入 display: contents 包装层。
  // 通过稳定的 data-slot 语义定位，避免把覆盖整栏的 SidebarRoot 误设为拖动区。
  const slot = sidebar.querySelector(':scope > [data-slot="sidebar"]')
  const sidebarRoot = slot?.firstElementChild
  const candidate = sidebarRoot?.firstElementChild
  if (!(candidate instanceof HTMLElement)) return null

  const sidebarRect = sidebar.getBoundingClientRect()
  const candidateRect = candidate.getBoundingClientRect()
  const topOffset = candidateRect.top - sidebarRect.top
  const insideSidebar = candidateRect.left >= sidebarRect.left - 1
    && candidateRect.right <= sidebarRect.right + 1
  const isTopRow = topOffset >= -1 && topOffset <= 24
  const hasSafeSize = candidateRect.width > 0
    && candidateRect.height > 0
    && candidateRect.height <= 80
  return insideSidebar && isTopRow && hasSafeSize ? candidate : null
}

function updateDragRegion() {
  const next = findLogoRow()
  if (next === dragRow && next?.hasAttribute('data-dsh-desktop-drag-region')) return
  if (dragRow) dragRow.removeAttribute('data-dsh-desktop-drag-region')
  dragRow = next
  if (dragRow) dragRow.setAttribute('data-dsh-desktop-drag-region', '')
}

function colorFromToken(token, property, fallback) {
  if (!probe) {
    probe = document.createElement('span')
    Object.assign(probe.style, {
      position: 'fixed',
      width: '0',
      height: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
    })
    document.body.appendChild(probe)
  }
  probe.style.removeProperty('color')
  probe.style.removeProperty('background-color')
  probe.style.setProperty(property, `var(${token})`)
  const value = getComputedStyle(probe).getPropertyValue(property).trim()
  return value || fallback
}

function findFrame() {
  const root = document.getElementById('root')
  if (!root) return null
  const candidates = [root, ...root.querySelectorAll('div')]
  return candidates.find((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display === 'grid'
      && style.gridTemplateColumns.split(/\s+/).length >= 2
      && rect.width >= window.innerWidth * 0.8
      && rect.height >= window.innerHeight * 0.8
  }) ?? null
}

function observeLayout(nextFrame) {
  const nextSidebar = nextFrame?.firstElementChild ?? null
  if (nextFrame === frame && nextSidebar === sidebar) return
  frame = nextFrame
  sidebar = nextSidebar
  if (resizeObserver) resizeObserver.disconnect()
  resizeObserver = new ResizeObserver(scheduleReport)
  if (frame) resizeObserver.observe(frame)
  if (sidebar) resizeObserver.observe(sidebar)
  updateDragRegion()
}

function report() {
  scheduled = false
  if (!document.body) return
  if (!frame || !frame.isConnected || !sidebar || !sidebar.isConnected) observeLayout(findFrame())
  updateDragRegion()

  const bodyStyle = getComputedStyle(document.body)
  const baseFallback = bodyStyle.backgroundColor || 'rgb(255, 255, 255)'
  const payload = {
    baseColor: colorFromToken('--dsw-alias-bg-base', 'background-color', baseFallback),
    sidebarColor: colorFromToken('--dsw-specific-sidebar-fill', 'background-color', baseFallback),
    borderColor: colorFromToken('--dsw-alias-border-l1', 'background-color', 'rgba(0, 0, 0, 0.06)'),
    symbolColor: colorFromToken('--dsw-alias-label-primary', 'color', bodyStyle.color || 'rgb(15, 17, 21)'),
    sidebarWidth: sidebar ? sidebar.getBoundingClientRect().width : 0,
  }
  const serialized = JSON.stringify(payload)
  if (serialized === lastPayload) return
  lastPayload = serialized
  ipcRenderer.send('dsh:chrome-state', payload)
}

function scheduleReport() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(report)
}

function start() {
  ensureDragStyle()
  ensureDialogUi()
  observeLayout(findFrame())
  const mutationObserver = new MutationObserver((mutations) => {
    // colorFromToken 会更新隐藏探针的 style；忽略这类内部变更，避免观察器自激。
    if (mutations.every((mutation) => mutation.target === probe)) return
    if (!frame || !frame.isConnected || !sidebar || !sidebar.isConnected) observeLayout(findFrame())
    scheduleReport()
  })
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-sidebar-collapsed'],
  })
  window.addEventListener('resize', scheduleReport)
  scheduleReport()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
