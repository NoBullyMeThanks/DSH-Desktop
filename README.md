# DSH Desktop

DSH Desktop 是一个面向 Windows 的 DeepSeek Harness（DSH）桌面启动器。它把 DSH 原本需要通过命令行启动的本地 Web 服务包装成可直接双击运行的桌面应用，并默认跟随 DeepSeek 官方 npm 包的最新版本。

> 本项目不重新实现 DSH，也不修改其 Web UI。桌面窗口加载的是本机 DSH 服务提供的官方界面。

## 项目背景

DeepSeek Harness 官方主要提供命令行入口：

```powershell
npx @deepseek-ai/dsh web
```

该命令会在本机启动 HTTP 服务，用户还需要自行管理终端进程、访问地址和运行时版本。DSH Desktop 将这些步骤自动化：

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
- 支持手动检查更新，以及在用户确认后回退到上一历史版本。
- DSH 异常退出时提供重试、日志和退出操作。
- 窗口主题、语言和原生窗口按钮跟随 DSH 设置。
- 关闭主窗口后驻留托盘，只有选择“退出”才结束后台服务。

## 技术实现

| 技术 | 用途 |
|---|---|
| Electron 43 | Windows 桌面窗口、托盘、IPC 和应用生命周期 |
| Node.js / CommonJS | 启动 DSH 子进程、管理文件和运行时 |
| `@deepseek-ai/dsh` | 提供本地服务与官方 Web UI |
| npm | 首次安装、更新和回退 DSH 运行时 |
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
- `npm test`：执行全部自动化测试。
- `npm start`：以开发模式运行 `electron .`。

首次启动会把 DSH 下载到 `~/.dsh-desktop/runtime/`，可能需要几十秒到几分钟。后续启动会直接复用完整的本地运行时；网络不可用时仍可使用已安装版本。

### 构建 Windows 安装包

```powershell
npm ci
npm test
npm run build
```

构建结果位于 `dist/`：

- `DSH Desktop Setup x.x.x.exe`：向导式安装包，支持桌面和开始菜单快捷方式。
- `DSH Desktop x.x.x.exe`：无需安装的便携版。

当前安装包不内置 Node.js 和 npm，因此安装或运行便携版的电脑仍需确保 `node` 与 `npm` 可以从系统 PATH 访问。

## 运行时与更新

- 首次运行时安装 `@deepseek-ai/dsh@latest`。
- 默认每次桌面应用启动最多自动检查一次更新，用户可以通过托盘关闭。
- 手动检查更新不受每次启动一次的限制。
- 更新只读取 npm registry，与本地克隆的 DSH 源码无关。
- 更新和回退期间会禁用冲突操作，避免并发写入运行时。
- 回退前必须由用户在应用内弹框中明确确认。
- 运行时入口损坏时，会尝试强制修复当前精确版本。

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.dsh-desktop/runtime/` | DSH Desktop 管理的 DSH npm 运行时 |
| `~/.dsh-desktop/version.json` | 当前版本和最近的历史版本 |
| `~/.dsh-desktop/preferences.json` | 启动更新检查等桌面端偏好 |
| `~/.dsh-desktop/dsh.log` | 桌面启动器和 DSH 子进程日志 |
| `~/.dsh/` | DSH 自身的凭据、设置和会话数据 |

DSH Desktop 与命令行版 DSH 默认共享 `~/.dsh/`。API Key 可以在 DSH Web UI 的 Settings → Models 中配置，也可以通过 DSH 支持的环境变量提供。

## 项目结构

```text
main.js                    Electron 主进程、窗口、IPC、DSH 生命周期与更新流程
content-preload.js         DSH 页面外观观测与 Shadow DOM 模态框
startup.html               本地启动窗口页面
startup-preload.js         启动窗口状态渲染与操作上报
runtime-manager.js         DSH 安装、完整性校验、更新、回退和版本比较
runtime-operation-lock.js  更新与回退的互斥控制
update-preferences.js      自动更新偏好迁移与规范化
settings-reader.js         DSH 主题和语言设置读取与监听
tray.js                    系统托盘及菜单
i18n.js                    中英文桌面端文案
test/                      Node.js 自动化测试
assets/                    应用、安装包和托盘图标
```

## 常见问题

### 首次启动为什么比较慢？

首次运行需要从 npm 下载 DSH 及其依赖。下载完成后会复用本地运行时。

### 会不会发生端口冲突？

应用使用 `--port 0`，由系统分配空闲端口，不固定占用 3080 等常见端口。

### 关闭窗口后为什么进程仍然存在？

关闭主窗口默认是隐藏到系统托盘。请在托盘菜单中选择“退出”以停止 DSH 服务并结束应用。

### 应该使用 `npm install` 还是 `npm ci`？

克隆仓库后使用 `npm ci`。只有在主动增加或更新项目依赖、并准备同步修改 `package-lock.json` 时才使用 `npm install`。

## License

MIT
