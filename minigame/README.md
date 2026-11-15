# 水果 2048 · 抖音原生小游戏工程

由现有 H5 版（上级目录）迁移而来。核心算法层复用，渲染层由 DOM 改为 Canvas。

## 目录结构

```
minigame/
├── game.js                  # 小游戏入口（require 各模块后启动）
├── game.json               # 小游戏配置（竖屏、网络超时）
├── project.config.json     # 项目配置（appid 占位，导入开发者工具后替换）
├── debug.html              # 浏览器本地预览/调试页（不参与小游戏打包）
├── js/
│   ├── platform.js          # 平台桥接：tt / 浏览器降级；登录、广告、云函数占位
│   ├── tile.js              # 方块数据模型（复用自 H5）
│   ├── grid.js              # 棋盘数据模型（复用自 H5）
│   ├── game_manager.js      # 游戏主逻辑（移动/合并/结束/序列化，复用自 H5）
│   ├── storage_manager.js   # 本地存档适配（bestScore / gameState）
│   ├── input_manager.js     # 触摸滑动方向识别（浏览器降级含方向键）
│   └── renderer.js          # Canvas 渲染器：背景、棋盘、贴图、分级底色、结束遮罩
├── images/fruits/           # 11 级水果成品贴图（256×256 透明 PNG）
└── cloud/                   # 云函数目录（P2 阶段填充）
```

## 本地预览（浏览器降级）

直接用浏览器打开 `debug.html`。该页面走 `Platform` 的浏览器降级分支：
存储用 `localStorage`，输入支持触摸与方向键（R 重开），广告/登录按占位返回。

> 注意：浏览器降级只用于核对渲染与玩法，不等同于抖音原生运行时验证；
> 最终需在「抖音开发者工具」导入本目录真机/模拟器预览。

## 等级与贴图映射

| 数值 | 水果 | 底色色系 |
|---|---|---|
| 2 | 蓝莓 | 白 |
| 4 | 青提 | 浅绿 |
| 8 | 橙子 | 绿 |
| 16 | 桃子 | 浅蓝 |
| 32 | 菠萝 | 蓝 |
| 64 | 椰子 | 浅紫 |
| 128 | 哈密瓜 | 紫 |
| 256 | 金果 | 橙红 |
| 512 | 草莓 | 红 |
| 1024 | 火龙果 | 玫红 |
| 2048 | 金色大西瓜 | 深红（最红），瓜体金色 |

映射表集中在 `js/renderer.js` 顶部的 `FRUIT_MAP`。

## 云端战绩与全网榜（骨架已落地，待环境部署）

`cloud/` 下已按抖音云 `callContainer` HTTP 模式写好后端骨架，详见 `cloud/README.md`：

- 路由：`/login`（code 换 openid 建档）、`/report`（上报战绩 + 更新最高分 + 名次）、`/leaderboard`（Top N 榜）、`/myRank`（本人名次）；
- 集合：`leaderboard`（一人一条）、`records`（每局流水）；
- 端侧桥接：`platform.js` 的 `login / reportScore / getLeaderboard / getMyRank`，envID/serviceID 待回填。

## 后续待接阶段

- **P2 部署对齐**：开发者工具新建函数服务，补齐 `shared/db.js` 的 SDK 初始化；建集合与索引；回填 `envID/serviceID`；服务端 token 校验防刷榜。
- **P3 静默登录**：启动调 `login()`，缓存 openid/nickname；默认昵称，不取头像。
- **P4 复活 + 激励视频**：死局钩子 → 看激励视频 → 清掉 2 个最小方块复活；每局限 1 次；`platform.showRewardedAd` 接 `tt.createRewardedVideoAd`。
- **P5 全网榜 + 上架**：榜单 UI、历史战绩页、分享、隐私协议与审核包。

## 动画

渲染器内置 rAF 帧循环，对齐 H5 原版手感：

- 滑动：旧格 → 新格，100ms ease-in-out 插值；
- 新块弹出：200ms easeOutBack 回弹，延迟 100ms；
- 合并回弹：scale 先冲到 1.18 再回落 1，Q 弹手感，延迟 100ms；
- 加分飘字：`+N` 在分数盒上方上浮 600ms 淡出。

## 已知边界

- 4096 及以上：渲染兜底为深色块 + 数字，未配水果贴图。
- 动画为帧插值实现，未做滑动轨迹残影、粒子等高级反馈。
- `project.config.json` 的 `appid` 为占位，需替换为真实小游戏 AppID。
