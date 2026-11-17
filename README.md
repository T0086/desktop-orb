# desktop-orb

> 作者：空游

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

### 贴边与悬停

球拖到屏幕边缘（10px 内）会"贴住"，只露 26px。之后：

- 光标落在球身上 → 滑出来；移开约 0.26s → 缩回去
- 拖到边上松手时**不立刻缩**：光标还在球上就先让它待着，移开才收

这里有两个坑，都是踩过的：

1. **窗口尺寸有四种状态**（球 76、面板 380×460、气泡 240×136、缩边的 76）。所有尺寸变化都必须从 `ballPos`（球的归位坐标）推导，不能从"当前窗口矩形"反推 —— 反推会把上一步的误差当成事实继承下去。曾经因此把开着面板的球"收起"，380 宽的窗口只剩 26px 在屏上，球画在窗口右下角，直接滑出屏幕，再也点不到。
2. **悬停判定必须轮询光标，不能用 `mouseenter`**。窗口是在光标底下自己滑走的，光标没跨过边界，浏览器不会补发 enter，于是"贴边后第一次悬停"必然唤不出。`reconcileHover()` 每 120ms 看一眼光标位置，幂等，不依赖事件。

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
