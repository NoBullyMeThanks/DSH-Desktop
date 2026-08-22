<p align="center">
  <img src="assets/icon.png" alt="DSH-Desktop 项目图标" width="128">
</p>

<h1 align="center">DSH-Desktop</h1>

DSH-Desktop 是一个面向 Windows 的 DeepSeek Harness（DSH）桌面启动器。它把 DSH 原本需要通过命令行启动的本地 Web 服务包装成可直接双击运行的桌面应用，并默认跟随 DeepSeek 官方 npm 包的最新版本。

> 本项目不重新实现 DSH，也不修改其 Web UI。桌面窗口加载的是本机 DSH 服务提供的官方界面。

## 项目背景

DeepSeek Harness 官方主要提供命令行入口：

```powershell
npx @deepseek-ai/dsh web
```

该命令会在本机启动 HTTP 服务，用户还需要自行管理终端进程、访问地址和运行时版本。DSH-Desktop 将这些步骤自动化：

```text
启动桌面应用
  → 检查系统是否可以执行 Node.js
  → 安装或复用独立的 DSH 运行时
  → 使用随机空闲端口启动 DSH Web 服务
  → 在 Electron 原生窗口中加载官方 Web UI
  → 关闭窗口时隐藏到托盘，退出应用时结束 DSH 子进程
```

项目适合希望以普通桌面软件方式使用 DSH，同时又希望保持官方界面和运行时更新能力的 Windows 用户。

## 核心能力

- 双击启动 DSH，无需手动维护终端和本地访问地址。
- DSH 运行时独立安装在用户目录，不与桌面程序源码或安装包绑定。
- 默认在应用启动后检查 npm 官方源，可在托盘中关闭自动检查。
- 支持手动检查更新。
- DSH 异常退出时提供重试、日志和退出操作。
- 应用使用由系统分配空闲端口，不固定占用 3080 等常见端口。
- 窗口主题、语言和自绘窗口按钮跟随 DSH 设置。
- 关闭主窗口后驻留托盘，只有选择“退出”才结束后台服务。
- **内嵌终端面板**：应用内直接打开 PowerShell/cmd 终端（Ctrl+\`、窗口按钮或托盘入口），支持多会话、停靠到底部或右侧、拖动调整尺寸、会话重命名，随深浅色主题自动切换。

## 内嵌终端

终端面板是 VS Code 风格的嵌入面板：DSH 内容区之上叠加一个独立 WebContentsView，运行 xterm.js，由主进程经 node-pty（ConPTY）托管真实 shell 进程。它完全不改动 DSH 自身源码——对 DSH 页面的仅有的交互是运行时观测布局与注入内缩 padding（内存级、刷新即消失）。

- **打开方式**：`Ctrl+\``、窗口控件区「终端」按钮、托盘「打开终端」。
- **停靠**：底部（默认，35% 高度）或右侧（35% 宽度），可拖动边界调整大小，偏好持久化到 `preferences.json`。
- **多会话**：管理区新建/切换/重命名（双击）/真正关闭（垃圾桶图标）；会话退出后保留输出并可一键重新打开。
- **工作目录**：默认跟随 DSH 当前工作区，推断失败回退用户主目录。
- **联动**：DSH 会话区自动为面板让位（内缩 padding）；页面出现设置面板/弹窗时终端自动收起、关闭后恢复；面板浮层跟随深浅色主题。
- **安全**：面板沙箱 + contextIsolation，IPC 全量校验来源，DSH 页面无法触达终端通道。

## 技术实现

| 技术 | 用途 |
|---|---|
| Electron 43 | Windows 桌面窗口、托盘、IPC 和应用生命周期 |
| WebContentsView | 终端面板叠加视图（始终渲染在 DSH 页面之上） |
| xterm.js 6 + addon-fit | 终端面板渲染（vendored 到 `terminal-assets/`） |
| node-pty 1.1.0（ConPTY） | 托管真实 shell 进程（pty-host 子进程，懒安装） |
| Node.js / CommonJS | 启动 DSH 子进程、管理文件和运行时 |
| `@deepseek-ai/dsh` | 提供本地服务与官方 Web UI |
| npm | 首次安装和更新 DSH 运行时 |
| electron-builder | 生成 x64 NSIS 安装包和便携版 |
| `node:test` | 运行时、版本比较、偏好迁移和互斥锁测试 |


## 快速启动

### 环境要求

- Windows 10/11 x64
- Git
- 系统 PATH 中可用的 Node.js 和 npm
- 首次启动时能够访问 npm registry

启动器不硬编码 Node.js 版本门槛，实际兼容性由当前 DSH 的运行结果决定。开发和构建建议使用项目已经验证过的 Node.js 24.x。

可以先确认环境：

```powershell
git --version
node --version
npm --version
```

### 从源码运行

```powershell
git clone <仓库地址>
cd dsh-desktop

npm ci
npm test
npm start
```

各命令用途：

- `npm ci`：严格按照 `package-lock.json` 安装可复现依赖，首次克隆推荐使用。
- `npm test`：执行全部自动化测试（终端纯函数、协议客户端、工作区解析等单元测试）。
- `npm start`：以开发模式运行 `electron .`。

首次启动会把 DSH 下载到 `~/.dsh-desktop/runtime/`，可能需要几十秒到几分钟。后续启动会直接复用完整的本地运行时；网络不可用时仍可使用已安装版本。

打开终端面板的快捷键是 **`Ctrl+\``**（反引号），也可通过窗口控件区「终端」按钮或托盘「打开终端」。

终端面板的集成冒烟（真实 PTY 会话 + 键盘输入链路 + 停靠/拖动/重命名/宿主崩溃恢复）：

```powershell
node_modules\.bin\electron.cmd scripts/electron-terminal-smoke.js
```


## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.dsh-desktop/runtime/` | DSH-Desktop 管理的 DSH npm 运行时 |
| `~/.dsh-desktop/pty-host/` | 终端宿主的 node-pty 安装目录（首次打开终端时懒安装） |
| `~/.dsh-desktop/version.json` | 当前已安装的 DSH 版本 |
| `~/.dsh-desktop/preferences.json` | 启动更新检查、终端停靠等桌面端偏好 |
| `~/.dsh-desktop/dsh.log` | 桌面启动器和 DSH 子进程日志 |
| `~/.dsh/` | DSH 自身的凭据、设置和会话数据 |

DSH-Desktop 与命令行版 DSH 默认共享 `~/.dsh/`。API Key 可以在 DSH Web UI 的 Settings → Models 中配置，也可以通过 DSH 支持的环境变量提供。

## 项目结构

```text
main.js                    Electron 主进程、窗口、IPC、DSH 生命周期与更新流程
content-preload.js         DSH 页面外观观测与 Shadow DOM 模态框
startup.html               本地启动窗口页面
startup-preload.js         启动窗口状态渲染与操作上报
runtime-manager.js         DSH 安装、完整性校验、更新和版本比较
runtime-operation-lock.js  更新与安装的互斥控制
update-preferences.js      自动更新偏好迁移与规范化
settings-reader.js         DSH 主题和语言设置读取与监听
tray.js                    系统托盘及菜单
i18n.js                    中英文桌面端文案
terminal-manager.js        终端面板主进程：视图、宿主生命周期、会话表、IPC
terminal-host-client.js    pty-host 协议客户端（JSON-Lines + 超时/退出事件）
pty-host.js                终端宿主（独立 Node 进程，运行 node-pty）
terminal-utils.js          shell 探测、面板 bounds 计算等纯函数
terminal.html / terminal.js / terminal-preload.js   终端面板页面
terminal-assets/           vendored xterm.js 静态资源
workspace-resolver.js      终端默认工作目录（DSH 工作区推断）
scripts/                   集成冒烟与诊断脚本（electron-terminal-smoke 等）
test/                      Node.js 自动化测试
assets/                    应用、安装包和托盘图标
```

## License

MIT
