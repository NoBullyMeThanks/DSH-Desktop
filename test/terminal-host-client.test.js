'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { TerminalHostClient } = require('../terminal-host-client.js')

const HOST_PATH = path.join(__dirname, '..', 'pty-host.js')
const MODULE_DIR = path.join(os.homedir(), '.dsh-desktop', 'pty-host', 'node_modules')
const hostAvailable = () => fs.existsSync(path.join(MODULE_DIR, 'node-pty'))

/** 给 Promise 加超时，超时抛错。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`等待${label}超时（${ms}ms）`)), ms)
    }),
  ])
}

test('真实宿主：spawn → 回显 → kill → shutdown 全链路', { skip: hostAvailable() ? false : 'node-pty 未安装，跳过（先跑 scripts/smoke-pty-host.js 的安装步骤）' }, async () => {
  const client = new TerminalHostClient({ hostPath: HOST_PATH, moduleDir: MODULE_DIR })
  await client.start()
  try {
    const spawnRes = await client.request('spawn', { sessionId: 'client-test-1', shell: 'powershell.exe', cols: 80, rows: 24 })
    assert.equal(spawnRes.ok, true)

    let echoed = ''
    client.onData = ({ sessionId, data }) => {
      if (sessionId === 'client-test-1') echoed += data
    }
    const echoedPromise = withTimeout(new Promise((resolve) => {
      const check = () => {
        if (echoed.includes('ClientEchoOk')) resolve()
        else setTimeout(check, 50)
      }
      check()
    }), 20_000, '输出回显')
    await client.write('client-test-1', "Write-Output 'ClientEchoOk'\r")
    await echoedPromise
    assert.ok(echoed.includes('ClientEchoOk'), '应收到命令输出回显')

    await client.killSession('client-test-1')
    const result = await client.shutdown(5_000)
    assert.equal(result.exitCode, 0)
  } finally {
    if (client.alive) client.killTree()
  }
})

test('假宿主：非法协议帧被容忍且请求仍能配对', async () => {
  const fakeHost = String.raw`process.stdout.write('not-json\n');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const j=JSON.parse(l);process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n')})`
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', fakeHost] })
  await client.start()
  try {
    const res = await client.request('ping')
    assert.equal(res.ok, true)
  } finally {
    await client.shutdown(3_000)
  }
})

test('假宿主：无响应时请求按超时失败', async () => {
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', 'setInterval(()=>{},1000)'] })
  await client.start()
  try {
    await assert.rejects(() => client.request('ping', {}, 300), /超时/)
  } finally {
    client.killTree()
  }
})

test('假宿主：宿主退出后触发 onClosed 且请求报错', async () => {
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', 'process.exit(3)'] })
  await client.start()
  const closed = withTimeout(new Promise((resolve) => {
    client.onClosed = (code) => resolve(code)
  }), 5_000, 'onClosed')
  assert.equal(await closed, 3)
  await assert.rejects(() => client.request('ping', {}, 500), /未运行|已退出/)
})

test('假宿主：data/exit 事件按 sessionId 分发并解码 base64', async () => {
  const fakeHost = String.raw`const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const j=JSON.parse(l);if(j.type==='spawn'){process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n');process.stdout.write(JSON.stringify({type:'data',sessionId:j.sessionId,data:Buffer.from('你好世界','utf8').toString('base64')})+'\n');process.stdout.write(JSON.stringify({type:'exit',sessionId:j.sessionId,code:0})+'\n')}else{process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n')}})`
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', fakeHost] })
  await client.start()
  try {
    const events = []
    client.onData = (e) => events.push(['data', e])
    client.onExit = (e) => events.push(['exit', e])
    const spawnRes = await client.request('spawn', { sessionId: 'evt-1' })
    assert.equal(spawnRes.ok, true)
    await withTimeout(new Promise((resolve) => {
      const check = () => {
        if (events.length >= 2) resolve()
        else setTimeout(check, 20)
      }
      check()
    }), 5_000, '事件')
    assert.deepEqual(events[0], ['data', { sessionId: 'evt-1', data: '你好世界' }])
    assert.deepEqual(events[1], ['exit', { sessionId: 'evt-1', code: 0 }])
  } finally {
    await client.shutdown(3_000)
  }
})
