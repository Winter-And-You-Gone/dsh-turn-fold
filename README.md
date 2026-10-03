# dsh-turn-fold

> **简体中文**（默认） | [English](README.en.md)

> DeepSeek Harness（DSH）原生折叠 + 扑克牌视觉 + 回合性能指标。

**DSH 原生负责全部折叠语义**（分组、成员归属、展开/收起状态、分页、搜索显隐、历史状态），
本插件在官方折叠引擎之上做**纯 UI 增强**：

1. **增强回合栏（Enhanced Turn Process Bar）**：替换官方 `turn-process` 渲染器，
   提供比官方更丰富的回合栏——扑克牌前导图标、耗时、首字（TTFT）、token、tok/s、
   缓存命中率、右对齐轮次「第x轮」、非正常结束状态词（已停止 / 运行失败 / 已中断）。
   折叠状态**完全来自官方**（`turnProcess.open / setOpen / foldable / hasContent`），
   点击回合栏只调用 `turnProcess.setOpen()`，成员的隐藏/显示由官方 seat 完成；
2. **运行中状态条（Running Turn Bar）**：回合开始（`turn/start` 投影）即出现——
   官方渲染器此时什么都不渲染，插件补上这根状态条：耗时从 0 秒起步实时走动，
   token / tok/s / 缓存命中率随真实数据到达而更新。它只是**状态表面**：不维护任何
   折叠状态、不隐藏任何成员；回合结束后平滑交接为完整的收起态回合栏；
3. **Step 扑克牌皮（Poker Step Skin）**：官方步骤分组栏（`ChatGroupSeat` /
   `ProcessGroupHeader`）原样保留，插件通过官方 DOM 钩子
   （`data-step-process-icon` / `data-process-activity`）做一层**纯 CSS** 的扑克牌换装，
   花色按官方活动类型语义映射（♥ 思考/提问 · ♠ 读取/搜索 · ♦ 编辑/写入 · ♣ 命令/代码 ·
   🐋鲸鱼 编排/计划/子代理）。软依赖：钩子失效时皮消失、官方图标与折叠原样保留；
4. **真实指标承诺**：全部数值来自官方真实数据（`TurnLocation.start/end`、step 的
   `usage` 与 `finalNode.timing`、turn-tail 的官方聚合 `tokenUsage`）。**没有伪造增长**——
   旧版的 +1/+11 动画偏移已删除：真实数据变化时数字才滚动，真实数据不变时数字不变；
5. **插件设置**：回合栏字段显隐（耗时/首字/Token/tok/s/缓存命中）、前导图标风格
   （扑克牌 / 官方图标）、Step 皮（扑克 / 官方图标），持久化到
   `localStorage['dsh-turn-fold:settings']`。**与官方 transcriptView 完全解耦**——
   官方 Compact / Standard / Detailed / Verbose 四档照常工作，插件只增强其 UI。

**不修改任何 `@deepseek-ai/dsh-*` 源码。**

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

- **字段槽位始终存在**：设置里启用的字段从 0 秒起就占位（无真实数据显示 `—`），
  真实数据到达只替换 `—`、完成瞬间不新增字段段；关闭的字段整段消失（连 `—` 也不显示）。
  全部数值均为官方真实数据，**绝不伪造**（没有估算 token、假增长；无数据 = `—`）。
- **指标来源（全部官方真实数据）**：
  - 耗时：`TurnLocation.start.time → end.time`（运行中用实时时钟补足）；
  - 首字（TTFT）：**durable 优先**——插件自己的官方 projection `turnFoldMetrics`
    （见下方「durable Turn 指标」）给出该回合稳定步的首字延迟
    （`firstTokenTime - stepStartTime`，与官方统计同款语义）；
    其次客户端 `finalNode.timing`（只在本次页面 live 流过时才有）；运行中官方
    timing 未就绪时给 provisional 可见首字延迟（`data.time - stepStartTime`，
    页面内观察过就记住，settle 后 exact 缺失时继续显示、不退回 `—`）；
  - Token / 缓存命中：回合结束后优先 turn-tail 的官方聚合 `tokenUsage`
    （`deriveTurnTokenUsage` 折叠全部计费 attempt，含被重试请求；缓存分母 = prompt 侧
    总量），运行中/缺失时按 step usage 累加（官方 step data store 与节点可见性无关，
    隐藏纯工具步骤同样计入）；
  - tok/s：**decode-speed**（与官方 StatsPills 同一定义）——
    `Σ outputTokens ÷ Σ(completedTime − firstTokenTime)`，只统计首字/完成时间/outputTokens
    三项齐备的 step；TTFT、tool 执行、step 间等待、整个回合墙钟时长都不进分母。
    decode 证据同样 **durable 优先**（projection）、客户端 step 聚合兜底。
- **durable Turn 指标（`turnFoldMetrics` projection，为什么需要）**：官方客户端的
  `finalNode.timing.firstTokenTime` 只在收到 `assistant/live-chunk`（客户端瞬态事件、
  **不落盘**）时记录（`ui-chat/.../assistant.ts:146,154`），`settleMessage()` 与历史重建用的
  `fallbackState()` 都不从落盘的 `assistant/message.stream` 恢复它 —— 于是**刷新页面或打开
  历史会话后首字与 tok/s 同时消失**（显示 `首字—` / `— tok/s`），而官方底部 sessionStats
  仍有这两个值（它用 `assistantStreamFirstTokenTime(event.data.stream)` 做 durable 折叠）。
  插件因此在宿主半边注册自己的 projection（官方公开扩展面
  `ctx.sessionProjections.register`，unit 归插件所有、只读、返回同一引用不产生多余广播），
  用与官方 sessionStats **逐条相同**的事件语义折叠出 per-turn 指标，由 host 经 projection
  wire 推给客户端，前端用 `useProjection('turnFoldMetrics')` 读取 —— LIVE / SETTLED /
  RELOAD / HISTORY 四条路径数据来源一致。旧宿主没有该服务时整个注册跳过，前端自动回落到
  客户端 step 数据（退化 = 重载后这两个字段为 `—`，不伪造）。每回合只存 3 个数字，
  上限 2000 回合（超出后最旧回合降级为 `—`）。
- **滚轮数字动画**：运行中数值变化时逐位滚动（里程表效果，回弹缓动）；完整文案有
  sr-only 副本（读屏无障碍）；系统「减少动态效果」时自动退化为静态数字。
- **回合栏下常驻分隔线**（`--dsw-alias-line-secondary` token 链式回退，随主题适配）。
- **无障碍**：`aria-expanded` / `aria-label`，键盘可操作（Enter / Space）；不可折叠的
  回合（如 Verbose 官方语义、中止/失败回合）呈现为静态栏。
- **四个官方 transcript 档位全兼容**：Compact / Standard / Detailed / Verbose 下回合栏
  都正常渲染；`foldable=false`（如 Verbose）与分页加载中（`turn/start` 未在窗口内，
  官方本就不渲染控制条）时优雅降级。

## Step 扑克牌皮

官方步骤分组栏（含官方标题语义「正在读取…」「已读取 3 个文件」「正在思考…」、官方
shimmer、官方分页与搜索显隐）原样工作，插件只换装：

- **牌身透明**的扑克卡（CSS mask，当前色描边 + 花色点，壁纸可透出）替换官方活动图标，
  牌尺寸与 Turn 栏扑克图标**同一设计语言**：伪元素 24×24（= Turn 容器）、16 视箱 mask
  按 24px 渲染（1.5px/单位），牌外缘 ≈9.62×13.05px、描边 1.05px，两侧逐像素一致；
- **completed 双态图标**（Fold-state aware）：收起 = 花色牌堆（closed = 牌收好未翻看），
  展开 = 扇形（open = 牌已翻看）——与运行态牌面同序同构，几何直接复用 Turn 栏的
  stack3/stack5 · fan3/fan5 变换表（`icons/default.json` 数据源）；**牌身份连续**：
  同一 card id 在 stack 与 fan 里是同一张牌、层级不变——stack3 的顶牌 card3 在 fan3
  里是最右那张（与 fan5 同构：居中那张不旋转、两侧对称、id 越大越靠右），展开时
  它从左上顶牌位置一路向右、始终压在最上层；**张数按本 Process
  Group 的工具调用数决定**：官方 `summary.counts[].count` 求和 ≤3 → 3 张、≥4 → 5 张
  （旧宿主 / 数据取不到 → 5 张安全回落，绝不猜 3 张）；
  **开合有 morph 过渡**：预采样 stack↔fan 插值帧（cubic-bezier(.22,1,.36,1) 采样、
  400ms、16 帧采样 = 17 关键帧、每帧静态 SVG）经 CSS keyframes 逐帧换 mask-image——
  animation 每次状态变化都从头重放（同 URL mask 图像的 SMIL 时间线在 Chromium 全页共享、
  重应用不 restart，帧序列绕开该限制），帧内 occluder 逐帧同步 knockout；
  **easing 只作用于"几何进度"、开合互为镜像**：帧时间进度 u=0→1 先过同一 easing
  得到几何进度（展开 `progress = E(u)`、收起 `progress = 1 - E(u)`），几何 helper 只做
  线性插值——两个方向因此都是"起手最快、后段减速、柔和停住"（实测前 100ms 走掉 ≈74%、
  后 100ms ≈0.25%），与 Turn 栏 `transition: transform .45s cubic-bezier(.22,1,.36,1)`
  同一手感。**不是时间反转** `E(1-u)`：那会让收起起手速度为 0、收尾最陡（前 100ms 仅 ≈0.25%、
  后 100ms ≈74%），观感"前慢后急"，与展开相反；**重叠区用真
  knockout 遮挡**：每张下层牌一个内嵌 luminance mask，z 更高层牌以实心黑牌面
  （fill=black occluder）把覆盖区从下层整体挖掉——牌身保持透明（壁纸/图片背景透出），
  下层 stroke 与 pip 绝不穿透上层牌（occluder 必须直接内联图形——Chromium 不渲染
  `<mask>` 内容里的 `<use>` 引用）；**官方 chevron 在 Poker skin 下恒隐**
  （normal/hover/focus/active 一致显示 Poker，hover 变色与 focus ring 等官方交互不受影响）；
- **牌数从哪来**（纯只读视觉桥，零分组重算）：数据源 = 官方现成 API——session 作用域
  条目都能拿到的标准 kit `useConversation`（官方 `SessionStandardProps`，ui-conversation
  经 `ctx.uiSession.provide` 下发）→ `ConversationSnapshot.views.grouped('chat')` →
  `groupSource(key)` → `GroupSnapshot.data.summary.counts`（与官方
  `ChatViewInjected.keyedHooks.chatGroup` 是同一个源）；出口 = 官方组根上的稳定 DOM 事实
  `data-chat-group-key`，插件只在自己的样式表里按它生成覆盖规则。官方分组算法、成员判定、
  open/closed、折叠交互、隐藏与搜索展开全部不重算、不接管；不写官方 DOM、不加官方属性。
  官方未提供这些 API 的旧宿主上不产出任何规则 → 行为回落为 5 张；
- 花色按官方 `data-process-activity` 值映射（`ACTIVITY_SUIT` 单一数据源生成 CSS）：
  thinking/questions → ♥，read/readImage/search/webSearch/webFetch → ♠，
  edit/write → ♦，commands/code → ♣，subagents/plan/tools → 🐋鲸鱼（DeepSeek Logo）；
  未登记活动回退 ♥（该映射现在主要作为 reduced-motion 的运行态回落）；
- **运行态牌面轮换**：运行中的 Step（官方标题带 shimmer。Soft running-state
  dependencies——DSH 0.1.7 输出 `data-text-shimmer`、DSH 0.2.0+ 输出 `data-shimmer`，
  两者都是官方真实历史契约，插件同时兼容）改为**五牌面轮换**（♠ ♥ ♦ ♣ + DeepSeek
  鲸鱼，五张地位相同的牌面，没有正/背面）——自运行 SVG（SMIL，移植自参考实现
  `docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html` 第三行「牌面轮换 · 正向」，
  见 `scripts/sync-step-anim.mjs`）作为卡牌的 CSS mask，牌线颜色仍由 `currentColor`
  跟随主题。每 0.8s 一组：两张完整平面牌对角轻微错开再合拢（唯一的 rotate 是 ±3.1°
  二维平面小角度），中途 discrete 在中点切换上下层，四个动态蒙版把下层牌与上层牌
  重叠处的线条挖空（透明卡面仍透壁纸、不透下层牌）；五组相位连成 4s 完整循环：
  diamond → club → spade → heart → deepseek →（回到 diamond）。运行态与牌数无关——
  本组只有一个工具也仍是五牌面轮换；回合结束 shimmer 消失 → 自动回落 completed 双态
  （按本组工具数的 3/5 张收起牌堆 / 展开扇形），全程纯 CSS cascade、零 JS 运行态。
  系统「减少动态效果」开启时运行态直接显示静态花色牌；
- **软依赖**：全部选择器挂在官方 DOM 钩子上，总闸 = 皮肤 `<style>` 元素的
  `disabled` 属性（插件不写任何 `document.body` 全局状态）——DSH 改掉钩子时
  **最坏退化 = 皮消失、官方图标原样显示**，官方折叠行为不受任何影响。
  运行态识别依赖官方 shimmer 属性（两个版本任一存在即触发 Running Step Poker
  动画；两者都不存在 → 静态 Poker fallback；即使视觉钩子失效，也不影响
  Step Fold / Tool / Think / Turn Fold 与页面稳定性）。

## 安装

### 方式一（推荐）：从 npm 安装

本插件已发布到 npm registry：[@winteries/dsh-turn-fold](https://www.npmjs.com/package/@winteries/dsh-turn-fold)

```sh
# 官方命令（推荐）
dsh plugin --profile web add @winteries/dsh-turn-fold

# 或从 GitHub 源码安装
dsh plugin --profile web add github:Winter-And-You-Gone/dsh-turn-fold
```

`dsh plugin` 会将包加入 profile 的 pnpm 依赖并自动追加到组合包层（`dsh.profile.bundles`），无需手动改任何文件。验证方式：

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

脚本会：
1. 在 `~/.dsh/profiles/node_modules/@winteries/dsh-turn-fold` 建 **Junction** 指向插件目录；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行 `- insert:` 注册；
3. 校验 `require.resolve` 可解析。

然后**完全退出 DSH 进程并重启**。

## 卸载

```sh
# 官方方式：同时移除依赖和插件层
dsh plugin --profile web remove @winteries/dsh-turn-fold
```

手工方式（曾用 `install.ps1` 安装时）：

```powershell
Remove-Item "$env:DSH_HOME\profiles\node_modules\@winteries\dsh-turn-fold" -Force   # 删 Junction
# 手动删掉 cordis.patch.yml 里对应的 insert 块
```

## 测试

```sh
npm install        # 首次：安装 jsdom / react / react-dom（devDependencies）
npm test           # node --test 运行 tests/ 下的全部测试
npm run check      # 语法检查 client.js / index.js
```

测试套件（`tests/`）直接加载真实 `client.js`（经 `__ModuleLoader__` 注入 + `__test`
导出，无复制粘贴漂移），分层如下：

| 文件 | 覆盖 |
| --- | --- |
| `unit.logic.test.mjs` | 指标纯函数：`turnClockOf` / `computeTurnMetrics` / `readStepUsage`（官方 TurnLocation / step usage / turn-tail 聚合三来源）、格式化、字段显隐与 localStorage 持久化；同一输入两次计算结果逐字段相等（无伪造增长） |
| `unit.turn-renderer.test.mjs` | Turn 渲染器：`open=false → 点击 → setOpen(true)`、`open=true → 点击 → setOpen(false)`；`foldable=false`/aborted/error → 静态栏无 setOpen 通道；Running Bar 0 秒出现、非交互、不触碰 Fold 状态；回合结束平滑交接；`turnProcess` 缺失降级 |
| `unit.poker.test.mjs` | 活动→花色映射（官方 ProcessActivity 词表全覆盖）、牌堆/扇形/翻牌 SVG 生成、组件渲染、reduced-motion 与无 WAAPI 静态降级 |
| `unit.css.test.mjs` | Step 皮总闸（`body[data-tf-step-skin]`）与官方 DOM 钩子规则；**架构守卫：旧 Fold Engine 的 `:has()` 隐藏规则必须消失** |
| `unit.gear.test.mjs` | 设置弹窗：字段 checkbox 双向绑定、设置持久化、图标风格 / Step 皮选择器（hooks 顺序守卫） |
| `unit.compat.test.mjs` | **注册审计：仅 shadow `turn-process` 一个 key**、`exports.inject=['slots']`、priority 冲突让位、注册异常软降级；**架构守卫：旧引擎标识符 / 官方 renderer 代理层 / transcriptView 写入扫描为零**；官方四档 transcript 模式渲染兼容 |
| `regression.test.mjs` | 历史回归：直播时钟空转定时器、**禁止假 token 增长（真实数据不变 → 数字不变）**、齿轮 stopPropagation、降级要求（图标包/设置损坏回退默认） |

> 在 Windows 沙箱等无法 spawn 子进程的环境下需要 `--test-isolation=none`（已在
> `npm test` 中内置）；普通 Linux/macOS CI 同样可用该参数（Node ≥ 22.9）。

## 折叠图标（扑克牌）

回合栏前导图标默认为**动态扑克牌**（回合栏右侧 ⚙ 齿轮 → 弹窗里的「回合栏图标」
选择器可切回官方 chevron）：

- **完成态**：收起为牌堆（本回合工具+子代理 ≤3 用 3 张、>3 用 5 张），展开变扇形；
  **牌身份连续**：绘制顺序恒为身份序 1…N（开合一致），stack 的顶牌就是 fan 最右那张，
  同一张牌在开合全程保持自己的层级——不会出现"展开后中间那张变成顶牌"的身份交换；
- **牌面池**：♠ ♥ ♦ ♣ + DeepSeek 鲸鱼 Logo **五选一**，每回合按回合号随机记忆（重渲染不变）；
- **运行态**：对角线轴翻牌（四花色循环、Logo 背面），SVG 原生动画，SMIL 不随重渲染重启；
- **遮挡**：luminance mask 按上层牌变换动态挖空下层覆盖区，牌身透明（壁纸/透明背景下正确）；
- **数据源**：`icons/default.json`（花色路径、卡牌几何、扇形/牌堆变换表、动画模板），
  改完 `npm run sync:icons` 注入、`npm run icons:check` 校验。

## 自定义图标（Agent Skill）

想改回合栏图标的用户不用手动操作——本插件随包注册了一个 **agent skill**
`dsh-turn-fold-customize-icons`（host 半边 `index.js` 通过 `ctx.skills` 注册，
DSH 0.1.2+ 装配了 `@deepseek-ai/dsh-skill` 时自动生效）。对 AI 助手说"帮我把
扑克牌图标改成××样式"，助手会自动加载该 skill，得到完整自定义流程：

- **数据源**：`icons/default.json`（唯一数据源，含花色路径、牌堆/扇形几何、动画）
- **改完同步**：`npm run sync:icons` 注入 client.js → `npm run icons:check` 校验
- **快速预览**：写 `localStorage['dsh-turn-fold:icons']` 可免改代码覆盖
- **避坑指南**：该环境特有的 SVG 渲染坑（fill var 属性不生效、defs fill 覆盖不掉、
  clip-rule 无效、transform-origin 不可靠等）

skill 正文在 `assets/dsh-turn-fold-customize-icons.md`，随 npm 包 `files` 一起发布。

## CI 与发布

GitHub Actions 会在每次 PR / push 到 `main` 时自动运行语法检查、`npm test` 全套测试和
`npm pack --dry-run` 打包预检；推送 `v*` tag 时自动发布到 npm（OIDC Trusted Publishing，
无需长期 token）并创建 GitHub Release。**一次性配置**（把 npm 包绑定到本仓库的 release workflow）：

```sh
npx npm@^11.15.0 trust github @winteries/dsh-turn-fold \
  --repo Winter-And-You-Gone/dsh-turn-fold \
  --file release.yml \
  --allow-publish
```

也可以改为在 npmjs.com 网站账户设置里配置 Trusted Publishing。

**之后每次发版只需两步**：

```sh
npm version patch    # 或 minor / major：bump 版本并自动打 v* tag
git push --follow-tags
```

> 提示：`npm version` 要求工作区干净，先把待发布的改动提交；tag 名必须与
> `package.json` 的 `version` 一致（workflow 会校验，不一致即失败）。

## 工作原理（为什么不用改源码）

- DSH 会话 UI 是 Cordis 插件 + Slot 插槽系统拼出来的；聊天流每个块经
  `conversation.chat.node`（keyed slot）按节点类型分发渲染器，**复用同 key 即替换该
  渲染器（lowest renders）**。
- 本插件用 `priority: -1` 覆盖官方 `turn-process` 渲染器——这是插件替换的**唯一**
  官方渲染器。不 shadow `tool-call` / `assistant-step` / `context` / `user`，不扫描
  官方 slot entries 做委托渲染，不复制官方 inject hooks（官方组件始终由官方条目
  自己渲染）。
- **折叠语义全部来自官方 owner state**：官方 `ChatNodeSeat` 为每个节点构建
  `turnProcess = { spec, foldable, hasContent, open, setOpen }` 并自己负责成员的隐藏
  （`data-turn-process-hidden`）与展开。插件回合栏只在点击时调用
  `turnProcess.setOpen(!open)`；`canCollapse` 的判定与官方渲染器一致
  （`foldable && hasContent`，且回合 aborted/error/open 时不可折叠——官方
  `turnProcessAlwaysOpen` 语义）。
- **运行中状态条**：官方 `turn-process` 节点在 `turn/start` 即投影，但官方渲染器在
  回合未结束时返回 null——插件渲染器在此阶段显示 Running Turn Bar（0 秒起、真实
  指标、无折叠行为）。回合结束后同一渲染器切换为完整回合栏，视觉与位置连续。
- **指标读取面（只读官方数据，不重算折叠成员）**：`node.location.turn`
  （`TurnLocation`：start/end/status/reason/steps）+ turn data store（`get('turn-tail')`
  官方聚合 `tokenUsage`、`get('turn-process')` 官方 spec）+ 每 step 的
  `data.get('assistant-step')`（usage / `finalNode.timing`）。快照经 `useChat`
  （SessionStandardProps 合并成员）订阅以驱动重渲染；step data store 与节点可见性
  无关，隐藏纯工具步骤的 usage 不漏计。
- **Step 皮（纯 CSS）**：官方 `ChatGroupSeat` / `ProcessGroupHeader` 原样渲染步骤分组
  与标题；插件 CSS 隐藏 `data-step-process-icon` 的官方图标内容、用 `::before` +
  CSS mask 渲染扑克卡，花色由 `data-process-activity` 值经 `ACTIVITY_SUIT` 映射生成
  （JS 映射 → CSS 规则同源生成）。总闸：`<body data-tf-step-skin="poker">`。
  **不用 MutationObserver、不往官方 header 挂 React 根、不自己维护 Step 展开状态。**
- **注册冲突自动让位**：注册前探测同 key 的 `priority: -1` 是否已被占用
  （`ctx.slots.entries`），被占则自动让位到第一个不冲突的值（官方 `0` 恒预留）并
  `console.warn`。
- **注册异常软降级（绝不带崩 DSH）**：slots 注入回调若让异常外泄，延迟执行路径会
  打断官方 UI 激活、web 整页无法启动。因此 slot 注册统一走一个注册管道：inject 声明
  等待与回调内 register 各自兜异常，单个条目注册失败仅跳过该条目，`console.warn`
  留排查线索并弹一次中性措辞的降级 Toast；宿主半边的 skill 注册同样双层防护。
- **设置完全独立**：插件不读、更不写官方 `transcriptView` 字段（源码级架构守卫测试
  锁死）。插件设置存 `localStorage['dsh-turn-fold:settings']`（字段显隐、图标风格、
  Step 皮），图标包仍走 `localStorage['dsh-turn-fold:icons']`。
- **多语言跟随**：文案读取 `document.documentElement.lang`（DSH 切换界面语言时由
  `dsh-client-locale` 设置），随 DSH 语言实时切换，浏览器语言仅作回退。

## 注意事项

- 兼容性目标：**DSH 0.1.7-rc.1 / rc.2 的 `conversation.chat.node` + `turn-process`
  owner state 契约**。0.1.7-rc.1 起官方才提供完整契约面（`TurnProcessOwnerProps`、
  `useTurnData` reactive hook、`ChatNodeStore.turnDataSource`——已核对 rc.1 源码），
  且 rc.1 为真机验证版本、rc.2 经逐包契约 diff 复核；**更早版本不再声明兼容**——
  "安装后自然休眠"不计入兼容，兼容 = 插件核心功能真正工作。DSH 升级若改变上述
  契约，本插件可能需要随版本小改（属插件维护，非改源码）。
- **宿主要求已声明**：`package.json` 的 `engines.dsh` = `>=0.1.7-rc.1 <=0.2.0-rc.2`
  —— 插件市场（dshmarket）读 npm `latest` manifest 的这个字段，在插件卡片上显示
  宿主要求，并在**更新**前拦下确定不满足的版本（DSH 本体不读该字段，不影响加载）。
  区间是**闭区间**、锁到已核验的宿主版本：每次 DSH 升级后重新核对契约，再抬上限
  并随新版本发布。
- **集成依赖清单**（DSH 升级时对照排查；已按 0.1.7-rc.2 `787b746b80` ↔ 0.2.0-rc.2
  `c1b47e41fc` 逐契约 diff 审计：Public/stable 契约在两个 release 间逐字节不变）：
  - **Cordis activation**：`exports.inject = ["slots"]` + `ctx.inject(["slots"], …)`
    （客户端 slots 服务与 keyed slot 注册语义，官方 `boot-client` 未变）；
  - **Public/stable**：`conversation.chat.node` keyed slot（`turn-process` key +
    owner state `TurnProcessOwnerProps`）；`TurnLocation`（start/end/status/steps）、
    step data store（`assistant-step` usage/timing）、turn data store
    （`turn-tail` / `turn-process`）——均来自官方 `dsh-client-ui-chat` /
    `dsh-client-ui-conversation` 契约；
  - **Soft visual dependency**：`data-step-process-icon` / `data-process-activity`
    （仅 Step 皮；失效 = 皮消失，官方图标与折叠原样保留）；
  - **Soft visual dependency（运行态，双契约）**：官方 `TextShimmer` 渲染的
    shimmer 属性（`ChatGroupSeat` 标题在 `!data.closed` 时携带）。属性名随官方
    版本演进，两个都是官方真实历史契约（源码证据）：
    - DSH 0.1.7（release commit `787b746b807df83776957875683b8853c862ca2c`，
      `TextShimmer.tsx`：`data-text-shimmer={active || undefined}`）→
      `data-text-shimmer="true"`；
    - DSH 0.2.0+（master，`TextShimmer.tsx`：`data-shimmer={active || undefined}`）→
      `data-shimmer="true"`。
    插件同时兼容两者，任一存在 → Running Step Poker 动画（`:has()` 命中即把卡牌
    mask 换成五牌面轮换 SVG——♠ ♥ ♦ ♣ + DeepSeek 五张牌面、每 0.8s 一次轮换、
    4s 完整循环，动态蒙版挖空下层牌）；
    两者都不存在 → 静态 Poker fallback（该 Step activity 对应花色）。**仅用于运行中 Step 的
    扑克翻牌动画识别**；官方回合结束属性消失 → 动画规则不再命中 → 自动回落，
    交接零 JS。无论视觉钩子是否失效，都不影响 Step Fold / Tool / Think /
    Turn Fold 与页面稳定性；
  - **Soft style injection（非理想软兼容点，已如实记录）**：插件向 `document.head`
    注入两个最小 `<style>`（基础样式 + Step 皮）。截至当前 DSH master（21638c5631）
    官方没有给 plain-JS client plugin 提供样式注册 API（全宿主唯一 `createElement('style')`
    在 web 自身代码里），而 Step 皮必须作用在官方 Header 的官方 DOM 上、无法收敛进
    插件 React 子树——故保留此软兼容点。注入失败的最坏退化 = 无 Turn 栏样式与无
    Step 皮，官方折叠行为不受影响；宿主未来提供样式注册面时迁移。
- 相比上一代（≤0.5.x）的行为变化：
  - 步骤分组/标题完全交还官方——插件自研的「运行了N条命令 / 读取了… / 思考了N次」
    段标题、段内文件链接复制、[ +N -M ] 行数统计、标题缓存已删除（官方标题语义为准）；
  - 「待折叠/已折叠 N 步」字段删除（折叠成员归属由官方决定，插件不再自行统计步数）；
  - **假 token 增长删除**——运行中两次 usage 之间数字保持真实值不动（不再 +1/+11）；
  - **零宿主包运行时依赖**——chevron / 通知全部自有实现，不 require 任何
    `@deepseek-ai/*` client 包（官方 practices：不要运行时 require Harness Client
    package）；设置面板由打开它的 Turn 栏自身 React 树渲染，无 body portal / 独立
    root；指标订阅走官方最小切片（`useTurnData('turn-tail')` +
    `turnDataSource(turn, 'assistant-step')`），不再订阅整份快照；
  - 「Turn-Fold」transcript 模式与 shadow 官方设置行删除——官方四档照常工作，
    插件设置改为纯 UI 增强（见职责边界）；
  - 0 秒占位条从「user 消息正下方」改为挂在官方 `turn-process` 节点上：回合开始
    （turn/start 投影）即出现；发送消息到 turn/start 之间的窗口（通常亚秒级）由官方
    "Deep diving..." 状态行呈现；
  - 运行中首字（TTFT）先给 **provisional 可见首字延迟**（官方 `data.time` −
    step/start，无渲染时刻近似、无估算），settle 后被 **exact** 覆盖；exact 的稳定来源是
    插件的 durable projection（reload / 历史会话后仍在），客户端 timing 与页面内观察缓存
    依次兜底——详见「指标来源」。
