# desktop-orb

一个 DSH 插件：桌面悬浮球。显示用量/费用，点开能进 DSH 会话聊天，偶尔念一句诗。

它和 `beacon` 不是一回事：beacon 是独立的 PowerShell 常驻条（课程/硬件/天气），这个是**随 DSH 启动的 Electron 小窗**。

| | desktop-orb | beacon |
|---|---|---|
| 技术 | Electron + DSH 插件 | PowerShell + WPF |
| 能对话 | 是（进 DSH 会话） | 否 |
| 显示 | 用量/费用、状态、诗词 | 时间/硬件/课程/天气 |

## 结构

```
index.js             插件入口：起 helper 进程、注册工具
helper/main.js       Electron 主进程：窗口、位置、IPC
helper/index.html    球体界面
helper/renderer.js   渲染逻辑
helper/poem.*        点开时念的那首诗
helper/preload.js    沙箱桥
```

## 窗口行为

- 无边框、透明、`alwaysOnTop('screen-saver')`、不入任务栏
- **`focusable: false`**：永不抢焦点。打游戏时鼠标滑过或点到它，前台游戏不会被打断
- 可拖动，位置存 `helper/config.json`
- 诗词窗口是另一个独立小窗，同样不可激活

## 安装

```powershell
plugin_manager install_bundle "D:\DeepSeek\workspace\desktop-orb"
```

装进 profile 后随 DSH 启动；`cordis.patch.yml` 里那行 `persona` 是它的性格设定。

## 已知边界

- 依附 DSH 进程：DSH 不开，球就没有
- 用的是订阅账号的用量，数字来自 DSH 自己的计量，不是磁盘上的账本
- `helper/config.json` 是运行时位置状态，不入库

## 许可

MIT
