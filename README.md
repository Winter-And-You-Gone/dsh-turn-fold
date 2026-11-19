# dsh-turn-fold

> **简体中文**（默认） | [English](README.en.md)

> DeepSeek Harness（DSH）原生折叠 + 扑克牌视觉 + 回合性能指标。

本插件在 DSH 官方折叠引擎之上做**纯 UI 增强**，**不修改任何 `@deepseek-ai/dsh-*` 源码**。

## 功能

- **增强回合栏**：扑克牌前导图标、耗时、首字（TTFT）、token、tok/s、缓存命中率、
  右对齐轮次「第x轮」、非正常结束状态词（已停止 / 运行失败 / 已中断）。
  折叠状态**完全来自官方** `turnProcess`（`open / setOpen / foldable / hasContent`），
  点击只调用 `turnProcess.setOpen()`，成员显隐由官方 seat 完成。
- **运行中状态条**：回合开始（`turn/start` 投影）即出现，耗时从 0 秒实时走动，
  token / tok/s / 缓存命中随真实数据更新；只作状态展示，不维护折叠状态。
- **Step 扑克牌皮**：官方步骤分组栏原样工作，插件通过官方 DOM 钩子
  （`data-step-process-icon` / `data-process-activity`）做纯 CSS 换装。花色按活动语义映射：
  ♥ 思考/提问 · ♠ 读取/搜索 · ♦ 编辑/写入 · ♣ 命令/代码 · 🐋 编排/计划/子代理。
  钩子失效时皮肤消失，官方图标与折叠原样保留。
- **真实指标**：统计全部来自官方数据（`TurnLocation`、step `usage`、`finalNode.timing`、
  turn-tail 的 `tokenUsage`）。运行中的 token 另有一个 **presentation-only 视觉计数**，
  只影响显示：不参与 tok/s / 缓存 / TTFT / durable projection，也不持久化。
- **插件设置**：回合栏字段显隐 + **统一折叠栏图标模式** `iconStyle`（动态扑克牌 / 官方图标，
  一个设置同时管 Turn 与 Step），持久化到 `localStorage['dsh-turn-fold:settings']`。
  与官方 `transcriptView` 完全解耦，Compact / Standard / Detailed / Verbose 四档照常工作。

## 职责边界

| 归属 | 内容 |
| --- | --- |
| **DSH owns** | grouping · membership · disclosure（何时折叠/是否展开）· paging · search reveal · history state · Step 分组栏与其标题（正在读取…/已读取… 等官方语义） |
| **dsh-turn-fold owns** | 增强回合栏 · 运行中回合状态条 · 扑克牌视觉 · 指标呈现 · 动画 · 插件设置 |

## 回合栏形态

```
运行中（turn/start → turn/end）：
  [翻牌动画] 耗时0秒 · 首字— · — token · — tok/s · 缓存—   ← 0 秒起字段槽位完整
  ────────────────────────────────────────
  [官方过程内容逐条加载…（官方 liveProcess 语义，始终展开）]

  [翻牌动画] 耗时13秒 · 首字0.8s · 3,214 token · 247tok/s · 缓存—
  ────────────────────────────────────────                 ← 真实值到达只替换 —

回合结束（默认收起，点击展开）：
  [牌堆/扇形] 耗时22分34秒 · 首字4.9s · 370,202 token · 2.4tok/s · 缓存93.99%   第13轮
  ────────────────────────────────────────
  [最终总结正文（官方渲染）]

失败/中止：
  [牌堆] 运行失败 · 48秒 · 首字— · 7,812 token · 28tok/s · 缓存—   第13轮
```

- **字段槽位始终存在**：启用的字段从 0 秒起占位（无数据显示 `—`），真实数据到达只替换
  `—`；关闭的字段整段消失。统计值绝不伪造，没有估算、无数据 = `—`。读屏文本（sr-only）
  始终是官方真实值。
- **指标来源**：耗时取 `TurnLocation.start/end`；首字与 tok/s **durable 优先**（插件自己的
  `turnFoldMetrics` projection，重载/历史会话后仍在），其次客户端 `finalNode.timing` 与
  step 聚合；tok/s 是 **decode-speed**（与官方 StatsPills 同一定义）。
  完整口径、视觉计数节奏与降级路径见 [docs/INTERNALS.md](docs/INTERNALS.md)。
- **无障碍**：`aria-expanded` / `aria-label`，Enter / Space 可操作；不可折叠的回合
  （Verbose、中止/失败）呈现为静态栏。
- **官方四档全兼容**：Compact / Standard / Detailed / Verbose 下均正常渲染。

## Step 扑克牌皮

- **牌身透明**的扑克卡（CSS mask，当前色描边 + 花色点，壁纸可透出）替换官方活动图标；
  与 Turn 栏扑克图标共用同一套 24×24 画布与几何。
- **completed 双态**：收起 = 花色牌堆、展开 = 扇形；张数按本组工具调用数（≤3 → 3 张，
  ≥4 → 5 张），开合有 morph 过渡与真 knockout 遮挡。
- **运行态**：五牌面轮换（♠ ♥ ♦ ♣ + DeepSeek 鲸鱼）；**收起态正立，展开态平面旋转 35.5°**
  （由官方 `aria-expanded` 驱动，纯 CSS）。这与回合栏运行中的竖直对角线轴翻牌刻意不同。
- **步骤文件清单**：组头尾部显示本步骤碰过的文件（basename 去重、最多 3 个、超出折成 ` +N`），
  只读官方数据、走 CSS `::after`，不写官方 DOM。

换装细节、牌面分配、图标数据源与已知边界见 [docs/POKER-SKIN.md](docs/POKER-SKIN.md)。

## 安装

### 方式一（推荐）：从 npm 安装

本插件已发布到 npm registry：[@winteries/dsh-turn-fold](https://www.npmjs.com/package/@winteries/dsh-turn-fold)

```sh
# 官方命令（推荐）
dsh plugin --profile web add @winteries/dsh-turn-fold

# 或从 GitHub 源码安装
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` 会将包加入 profile 的 pnpm 依赖并自动追加到组合包层（`dsh.profile.bundles`），
无需手动改任何文件。验证：

```sh
dsh --profile web --dump-config    # 确认输出中能看到 "@winteries/dsh-turn-fold" 层
```

然后**完全退出 DSH 进程并重启**。

### 方式二：手工 `install.ps1`

```powershell
# 把插件目录放到你已有的插件目录，然后：
.\install.ps1 -PluginSource "<你的插件目录>"
# 例如：.\install.ps1 -PluginSource "C:\dsh-plugins\dsh-turn-fold"
# 不传参数时默认用脚本自身所在目录作为插件源
```

脚本会建立 Junction、在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行 `- insert:` 注册，
并用 `require.resolve` 校验。然后**完全退出 DSH 进程并重启**。

## 卸载

```sh
# 官方方式：同时移除依赖和插件层
dsh plugin --profile web remove @winteries/dsh-turn-fold
```

手工方式（曾用 `install.ps1` 安装时）：删除
`~/.dsh/profiles/node_modules/@winteries/dsh-turn-fold` Junction，并删掉
`cordis.patch.yml` 里对应的 `insert` 块。

## 设置

回合栏右侧 ⚙ 齿轮打开设置：

- **回合栏字段**：耗时 / 首字 / Token / tok/s / 缓存命中，逐项显隐。
- **折叠栏图标**：一个统一选择器同时决定 Turn 前导图标与 Step 皮。
  - **动态扑克牌（poker，默认）**：Turn 完成态 = 牌堆/扇形、运行态 = 翻牌动画；
    Step completed = 牌堆/扇形、running = 五牌面轮换 · 展开时平面旋转 35.5°。
  - **官方图标（native）**：Turn 保留增强栏全部内容，只把前导图标换回官方风格 chevron；
    Step 完全恢复官方 `ProcessGroupHeader` 自己的图标与交互。
- **迁移**：旧设置里的 `foldIcon` / `stepSkin` 在读取层一次性迁移为 `iconStyle`，
  下次保存只写新字段。
- 切换无需刷新页面（`applyIconStyle()` 同步两张皮肤样式表的 `disabled` 总闸）。

## 兼容性

`engines.dsh` = `>=0.1.7-rc.1`（**仅下限、无上限**）。DSH 0.2.1 起宿主会执行该字段；
仅下限意味着未来版本都能通过预检，未验证版本上的不兼容由崩溃隔离兜底（探测失败零注册、
渲染崩溃由官方 SlotErrorBoundary 单条占位、激活失败由 app-boot 逐条隔离）。

| DSH 版本 | 证据等级 |
| --- | --- |
| 0.1.7-rc.1 · 0.1.7-rc.2 · 0.2.0-rc.2 | **LIVE-HOST VERIFIED** |
| 0.2.1-rc.2 · 0.2.2-rc.1 | **CONTRACT-VERIFIED + LOAD/APPLY VERIFIED** |
| 0.2.1-rc.3 · 0.2.2-rc.2 · 0.2.2-rc.3 | **CONTRACT-VERIFIED** |

能力探测、Legacy 兼容层、逐版本矩阵与验收记录见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 自定义图标

插件随包注册了 agent skill `dsh-turn-fold-customize-icons`。对 AI 助手说
“帮我把扑克牌图标改成××样式”，助手会加载完整流程：

- 数据源：`icons/default.json`（唯一数据源）
- 改完同步：`npm run sync:icons` → `npm run icons:check`
- 快速预览：写 `localStorage['dsh-turn-fold:icons']` 免改代码覆盖
- 避坑指南：SVG 渲染坑与图标包覆盖面（不是所有元素都吃图标包）

skill 正文在 `assets/dsh-turn-fold-customize-icons.md`，随 npm 包发布。

## 测试

```sh
npm install        # 首次：安装 jsdom / react / react-dom（devDependencies）
npm test           # node --test 运行 tests/ 下的全部测试
npm run check      # 语法检查 client.js / index.js
```

测试套件直接加载真实 `client.js`（经 `__ModuleLoader__` 注入 + `__test` 导出，无复制粘贴漂移）。
测试文件索引、CI 与发版流程见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 已知问题

运行中的回合栏比官方那一行高约 37px，位于回合顶端（阅读锚点之上），观察到它会参与
“跟随释放”的链路；**根因尚未查清**。按用户定的规则，插件不加任何补偿/补丁
（不写滚动位置、不读官方跟随状态、不做 DOM 观察），并由守卫测试把“零滚动写入”钉死。
现象、证据与最可疑的线索见 [docs/INTERNALS.md](docs/INTERNALS.md)。

## 许可

[MIT](LICENSE)
