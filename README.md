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
4. **真实指标承诺**：**所有统计计算完全使用官方真实数据**（`TurnLocation.start/end`、step 的
   `usage` 与 `finalNode.timing`、turn-tail 的官方聚合 `tokenUsage`）。运行中的 token 字段
   额外提供 **presentation-only 的视觉计数**，用来填补官方 usage 离散上报之间的静止间隙：
   该值不参与 tok/s、缓存命中、TTFT、durable projection，也不被持久化；真实 usage 更新时
   立即校准（界面直接跳到新真实值再继续缓慢增长），Turn 完成后最终值始终等于官方真实
   token（settle 即归零）；
5. **插件设置**：回合栏字段显隐（耗时/首字/Token/tok/s/缓存命中）+ **统一折叠栏图标模式**
   `iconStyle`（动态扑克牌 / 官方图标，一个设置同时管 Turn 与 Step），持久化到
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
  统计数值全部来自官方真实数据，**绝不伪造**（没有估算、无数据 = `—`）。运行中显示的
  token 数字是 presentation-only 的展示值：有官方数据时 = 真实值 + 受限视觉偏移，官方
  usage 还没首次上报时 = 独立的视觉计数（详见下「真实数据层 / 展示层」）；
  读屏文本（sr-only）**始终**是官方真实值（真实值未到就是 `— token`）。
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
- **真实数据层 / 展示层（运行中 token）**：
  - `canonicalTokens`（真实数据层）= `computeTurnMetrics` 的 `tokens`（官方 usage / turn-tail 聚合），
    是唯一权威值，参与 tok/s、缓存命中、TTFT 与 durable projection；官方 usage 未到时它
    **保持 `undefined`**，绝不由展示值回写；
  - `displayTokens`（展示层），只用于运行中 UI，全部状态存在组件本地 ref
    （不写 localStorage / 不写 projection / 不写任何 node data），不参与任何统计：
    - **有 canonical**：`displayTokens = canonicalTokens + 视觉偏移`；
    - **无 canonical（官方 usage 尚未首次上报）**：当 **running 的 assistant-step 已经出现
      可见 reasoning/text**（官方 `blockIsVisible` 语义：tool-call / 空白文本不算）时，
      token 槽启动 **presentation-only 视觉计数**——第 1 帧就是 `1`，之后按同一节奏增长，
      独立封顶 **500**；该数值不是统计值，首次真实 usage 到达后**立即校准**到官方 token；
      读屏文本在真实值到达前仍显示 `— token`；
    - **提示**：刚发消息、模型还没有产出任何可见内容时不启动（不会自己从 0 开始跳）；
  - **只在模型真的在流式生成可见 assistant 输出时增长**：工具执行、等待结果/审批/子代理、
    等待期间该 step 已 settle（或尚无可见 block），数字**冻结**不动，也不会退回 `— token`
    （避免 `137 → — → 数字` 的跳变）；
  - 节奏固定且确定性：**每 200ms 一个 UI tick**，步长序列 `+1, +1, +10` 循环（无随机 jitter）；
  - canonical 偏移上限 `min(500, max(20, canonicalTokens × 5%))`（例：1,000 → +50；
    10,000 → +500；100,000 → +500），到顶即停，等下一次真实 usage；
  - **官方 usage 更新 → 立即校准**：bootstrap/偏移全部清零，界面下一帧直接等于新真实值
    （绝不从旧展示值慢慢滚过去），再从新基线继续缓慢增长。**校准不改变订阅状态**：
    若该 assistant-step 仍在流式输出可见内容（running + 可见 block），ticker 保持订阅、
    下一 tick 继续从新基线增长；若此刻已进入工具执行/等待阶段（没有 running 的可见
    step），则只显示真实值并退订（工具阶段本来就停止增长）。**Turn settle → 全部归零**，
    历史会话 / 刷新页面只显示官方真实值（无 canonical 则回到 `— token`）；
  - **性能**：视觉 ticker 只在**真正有动画**（运行中 + 已有可见输出 + Token 字段开启 +
    未开启减少动态效果）时订阅——历史回合、已结束回合、工具执行/等待阶段一律不订阅；
    没有任何活动订阅者时 module 级 interval **彻底停止**（100 个历史 Turn = 0 订阅者 + 0 定时器）；
  - 系统「减少动态效果」开启时**立即**归位（丢弃已滚出的视觉偏移：有 canonical → 直接显示
    canonical，无 canonical → 回到 `— token`）并退订 ticker；
    会话中途切换该设置会实时生效（媒体查询 change 事件驱动重渲染）；正常模式下视觉数字滚动、
    sr-only 文本保持 canonical（读屏永远拿到真实值）。
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
  官方未提供这些 API 的旧宿主上不产出任何规则 → 行为回落为 5 张（固定牌面）；
- **桥的 leader 生命周期**（per-session，本轮修复）：宿主里每个回合都会挂一个桥实例，
  但每个 session 只允许一个真正订阅——mounted registry 里首个挂载的实例立即成为 leader，
  leader 卸载时**从同一 session 仍挂载的实例里立即晋升一个**（纯 React mount/unmount
  registry；没有任何 DOM 查询或轮询，也不依赖"下次新组件 mount"）。接棒期间该 session 的
  规则**不清空、不闪回 fallback**；只有该 session 最后一个桥卸载才撤下它的规则块。
  session 完全卸载时只清它的展示层分配（topFaces / bag），**全局共享的变体资产与已注入的
  样式元素保留复用**（池 5 面 × 2 档位，天然有界）；同一 session 重新打开时重新随机；
- **规则按会话作用域隔离**（本轮修复）：最终 CSS selector 是
  `[data-conversation-session="<sessionId>"] [data-step-process][data-chat-group-key="<groupKey>"] `
  —— 官方 `GroupKey` 是"one Session 内的 identity"（跨会话会重复），官方 UI 又允许两棵会话树
  并存（主会话 + 子代理右侧栏会话），只按 groupKey 匹配会让同名组串样式。作用域锚点用的是
  **官方既有 DOM 契约**：ui-conversation 的 `ConversationContent` 在会话内容根上渲染
  `data-conversation-session={sessionId}`（官方自己的 `stop-shortcut` 就是
  `closest('[data-conversation-session]')` 解析会话），该元素包含该会话的全部 chat 节点。
  插件只消费这个属性，不写官方 DOM、不加属性；多个会话的规则块可同时输出（各自只作用于
  自己的会话树），无 sessionId 的旧宿主则回落为不带作用域的选择器且只在唯一时输出；
- **每组牌面从哪来**（completed 组不再"牌数决定顶牌"）：旧行为是固定序
  `♦ ♣ ♠ ♥ 🐋` 取前 N 张 → 3 张永远 ♠、5 张永远 🐋。现在每个 **session 一个 top-face
  shuffle bag**（五牌面池；与 Turn 顶层 Poker 共用 `shufflePokerFaces` 纯函数、bag 状态
  完全独立）：一批内五种顶牌各出现一次、重洗后首张不与上一批末张相同；每组的整套排列 =
  `completedFacesArrangement(count, topFace)`（cardN 必为该组分配到的顶牌，其余由 top face
  播种的确定性洗牌给出，组内不重复；5 张恰好用满牌面池，池只有四花色时把重复牌面放在
  最下层 card1）。身份 = `sessionId + 官方 groupKey`，**只有已完成（官方
  `ProcessGroupData.closed === true`）的组参与分配**——running 组走运行态轮换动画
  （平面旋转 35.5°），既不消耗 bag 也不产出覆盖规则；分配只在组第一次渲染（CSS 规则生成）时发生，之后重渲染 / 开合 /
  快照更新都命中缓存（随机不藏在 CSS builder 里）；不持久化，F5 / 插件重载后重新随机。
  为控制样式体积，逐组牌面资产按 `(count, topFace)` 懒生成、永久缓存、每个变体一个
  `<style>` 元素（只写一次）：逐组规则只有 ~0.5KB（引用变量），整页资产上限 = 池大小 ×
  2 个牌数档位；
- **步骤文件清单**（组头尾部"本步骤碰过哪些文件"，纯 CSS 文本）：数据同样只读官方 API——
  `GroupSnapshot.members`（本组每个成员节点的 key）→ 官方 `ChatNodeStore.get(key)` 读工具
  节点（`ToolChatData.root` = `name` + `argsRaw`）→ `JSON.parse(argsRaw)` 抽
  `file_path/filePath/file/target/path`；出口是官方组头按钮
  `button[data-process-activity]::after{content:"…"}`——**不写官方 DOM、不加官方属性、
  不做 DOM 观察**（架构红线见 `tests/unit.compat.test.mjs` 的禁用标识符与
  `tests/unit.step-cards.test.mjs` 的桥守卫）。显示规则：basename 再去重，然后按**整名预算**
  取舍——最多 3 个、总长不超过 `STEP_FILES_BUDGET`（32 字符），放不下的名字整条折成 ` +N`
  （**绝不显示半个文件名**；CSS 的 `max-width` + ellipsis 只作超长兜底，正常不触发）；
  `glob/grep/find/ls` 这类目录型工具的 `path` 是搜索根、不当文件名
  （`file_path` 恒采信）；目录（以分隔符结尾）与 `url` 不算文件；运行中与已完成都显示
  （运行中随官方工具数据变化累积，`turnDataSource(turn,'tool-call')` 只作刷新触发器），
  条目消失/会话卸载即撤下规则。独立样式表 `style-step-files`，**不随 iconStyle 启停**
  （信息不是皮肤，native 模式同样显示）；旧宿主（0.1.2~0.1.6 legacy 面）不产出；
- 花色按官方 `data-process-activity` 值映射（`ACTIVITY_SUIT` 单一数据源生成 CSS）：
  thinking/questions → ♥，read/readImage/search/webSearch/webFetch → ♠，
  edit/write → ♦，commands/code → ♣，subagents/plan/tools → 🐋鲸鱼（DeepSeek Logo）；
  未登记活动回退 ♥（该映射现在主要作为 reduced-motion 的运行态回落）；
- **运行态牌面轮换 · 平面旋转 35.5°**（**不是**回合栏运行中那套竖直对角线轴翻牌——
  两者刻意不同）：运行中的 Step（官方标题带 shimmer。Soft running-state
  dependencies——DSH 0.1.7 输出 `data-text-shimmer`、DSH 0.2.0+ 输出 `data-shimmer`，
  两者都是官方真实历史契约，插件同时兼容）保持**五牌面轮换**本体
  （♠ ♥ ♦ ♣ + DeepSeek 鲸鱼五张地位相同的牌面，无正/背面），再把整套可见动画
  （卡牌、花色、以及它们引用的 mask）**绕图标中心整体旋转 35.5°**。自运行 SVG（SMIL）
  作为卡牌的 CSS mask，牌线颜色仍由 `currentColor` 跟随主题：
  - **设计源** = 参考实现 `docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html`
    **第三行的「平面旋转」变体**：五牌面轮换本体（`const ANIM_SVG`）+ `svg3dRotated()` 那一步
    （在 `</defs>` 之后插入 `<g class="anim-root-rotation" transform="rotate(angle 8 8)">`，
    参考稿注释原文：「在不改动动画关键帧的前提下，把整套可见动画绕 16×16 画布中心旋转。
    defs 保持原坐标；外层 transform 会让卡牌、花色以及引用的 mask 一起旋转。」）；
  - **旋转角** = `icons/default.json → pokerSpin.restAngle`（≈35.5377° = `atan(w/h)`，
    与回合栏轴角同一数据源）；生成脚本断言它四舍五入到 1 位小数 == 参考稿那条变体的
    字面量 **35.5**（「牌面轮换 · 平面旋转 35.5°」/ `const target = toward35 ? 35.5 : 0`），
    设计值与数据源任一边漂移即生成失败；
  - **生成** = `npm run sync:step-anim` 写入 `client.js` 的
    `>>> step-running-poker-svg` 标记块。脚本逐项断言：参考稿第三行「平面旋转」变体接线仍在
    （`svg3dRotated` / `anim-root-rotation` / `rotate(' + angle + ' 8 8)` / 35.5 字面量），
    转换后仍带 **5 组相位 / 72 个 animateTransform / 15 个 animate / `0.8s`×82 / `4s`×5**
    （即「只加旋转、不动关键帧」），且旋转组真的包住全部相位；
  - **结构** = 五牌面轮换（每 0.8s 一组：两张完整平面牌对角轻微错开再合拢，唯一的 rotate 是
    ±3.1° 二维平面小角度；中途 `discrete` 在中点换层；四个动态 luminance 蒙版把下层牌与
    上层牌重叠处的线条挖空；五组相位连成 4s 完整循环：
    diamond → club → spade → heart → deepseek →（回到 diamond））
    **外面套一层** `<g class="tf-step-flat-rotation" transform="rotate(35.5377 8 8)">`；
  - **边界（如实记录）**：本 SVG 是构建期烘焙进 `client.js` 的，运行时 localStorage
    图标包覆盖不改写它（覆盖只作用于回合栏翻牌与运行时生成的 completed 双态牌面）——
    与改动前的实现同性质；
  - 运行态与牌数无关（本组只有一个工具也照轮换）；回合结束 shimmer 消失 → 自动回落
    completed 双态（按本组工具数的 3/5 张收起牌堆 / 展开扇形），全程纯 CSS cascade、
    零 JS 运行态。系统「减少动态效果」开启时运行态直接显示静态花色牌；
  - 旋转角只由 SVG 的 `transform` 属性决定：**CSS 不得再写 transform 覆盖它**
    （CSS transform 会压掉同名属性，回合栏踩过这个坑）。步骤侧旋转组类名
    `tf-step-flat-rotation` 与回合栏 `ccg-axis-rest-rotation` 刻意分开，守卫见
    `tests/unit.css.test.mjs` 的「平面旋转契约」；
- **软依赖**：全部选择器挂在官方 DOM 钩子上，总闸 = 皮肤 `<style>` 元素的
  `disabled` 属性（插件不写任何 `document.body` 全局状态）——DSH 改掉钩子时
  **最坏退化 = 皮消失、官方图标原样显示**，官方折叠行为不受任何影响。
  运行态识别依赖官方 shimmer 属性（两个版本任一存在即触发 Running Step Poker
  动画；两者都不存在 → 静态 Poker fallback；即使视觉钩子失效，也不影响
  Step Fold / Tool / Think / Turn Fold 与页面稳定性）。
  逐组牌面规则额外消费官方会话锚点 `data-conversation-session`（0.1.7-rc.2+；
  **官方自己的 `stop-shortcut` 就是用 `closest('[data-conversation-session]')` 解析会话**，
  属官方既有契约）：该属性缺失的宿主（0.1.7-rc.1）由 CSS 回退分支
  `[data-conversation-content]:not([data-conversation-session])` 兜住；0.1.7-rc.1 没有
  官方会话锚点、CSS 无法区分两棵会话树，多会话并存时插件**自动撤下 session-specific
  的 completed 牌面覆盖**（回落基础 Step Poker 通用视觉），绝不让 Session A/B 串样式
  （详见下方「会话作用域四态」）；插件不写官方 DOM、不加任何官方属性。

## Compatibility Architecture

现代化宿主的唯一 Fold owner 是 **DSH 自己**（官方 turn-process owner state + 官方
Process Group disclosure）；插件只做 UI（Turn 栏 / Poker / 指标 / token 动画 / 设置）。
插件按**能力**选择 feature-level adapter，而不是比较版本号字符串：

```
                    宿 主 能 力 探 测（capability-first）
                                 │
        ┌────────────────────────┴────────────────────────┐
   Modern Adapter                                  Legacy Adapter
   （官方契约齐全）                                 （官方契约缺失且被显式证明时才启用）
        └────────────────────────┬────────────────────────┘
                                 │
                     Shared UI（Turn 栏 / Poker / 指标 / token 动画 / 设置）
```

### 三态语义：UNKNOWN ≠ LEGACY

每个 feature 的 capability 都是三态（sessionScope 为四态），语义严格定义：

- **`modern` / `reactive` / `official`** = 已确认官方拥有该能力；
- **`legacy` / `fallback` / `tree-only` / `none`** = 已确认官方**没有**该能力（只能由
  显式证据定论：注册期官方 slot 表、或渲染期真实会话快照证明契约缺失）；
- **`unknown`** = 当前阶段尚无法判断。

**UNKNOWN 不是 LEGACY。** 一个 feature 只有在宿主被显式证明缺少官方契约之后才允许
进入 Legacy 模式；注册期探不到的一律 `unknown`，等渲染期 runtime probe 定论，
**绝不因 unknown 启动任何 Legacy 引擎**。运行时 capability 状态一经定论不再翻转
（modern ↔ legacy 需要显式重新初始化）。

### PROBE != COMMIT（探针读取与定论提交分离）

- **React render body 只读取探针值**：`StepCardRuleWriter` 读 `views.grouped` 契约
  三态、`EnhancedTurnProcessView` 读 `ChatNodeStore` 形状——都不修改全局状态；
- **capability resolution 只发生在 committed effect**：render/并发渲染被 abort 也不
  会改变全局兼容状态（未 flush effect 时 `hostCapabilityState` 保持不变，测试锁死）；
- **Legacy activation 只绑定 `unknown → legacy` 的那次 committed 迁移**：
  `resolveHostFeature` 返回 `true`（真迁移）才允许激活一次 legacy backend；
  StrictMode effect replay / 重复渲染一律不再激活、不再记账、不再刷诊断
  （StrictMode 下 `legacyStepEngineActivations === 1`，测试锁死）；
- **注册期（Cordis registration phase）不是 React render**：`adoptRegistrationCapabilities`
  对 turnFold 的同步定论不受此约束。

各 feature 的合法定论值**按 feature 独立定义**（`HOST_FEATURE_VALUES`）：
`turnFold`/`stepFold` ∈ {modern, legacy}；`metrics` ∈ {reactive, fallback}；
`sessionScope` ∈ {official, tree-only, none}。跨域赋值（如 `metrics = "tree-only"`）
一律拒绝且不写入状态（逐项测试锁死）。

注册期唯一可探面是官方 `conversation.chat.node` slot 表（有无 `turn-process` 条目）
→ 只有 `turnFold` 在注册期定论；`stepFold` / `metrics` / `sessionScope` 注册期一律
`unknown`，渲染期定论：

- **Step（stepFold）**：会话快照就绪后探测 `views.grouped` 契约（committed effect
  里 resolve）——快照未就绪（`undefined`）保持 unknown（"宿主 API 存在但数据未初始化"
  与"宿主没有 grouped view contract"是两回事）；快照就绪且 `views.grouped` 不是函数 →
  显式 `legacy`；契约在（函数存在）→ `modern`（此时 grouped 读端可能因"无活动 Group
  Definition"返回 undefined——那是"暂无数据"，不是"没有能力"）。
- **Metrics（metrics）**：渲染期探测官方 `ChatNodeStore.turnDataSource` 是否存在
  （`useChat` 具名形状探针，Hook 全部无条件调用，capability 只决定数据源选择，
  resolve 在 committed effect）：存在 → `reactive`；不存在 → `fallback`（逐 step
  直读）；未就绪 → `unknown`。**Turn fold 能力 ≠ metrics 能力**：0.1.2~0.1.6 有
  turn-process（官方 owner state）但没有 turnDataSource——它们是
  `turnFold=modern + metrics=fallback`，而不是 "metrics = modern" 也不是
  "metrics = legacy fold engine"。metrics fallback 绝不触发 Legacy Fold Engine。
  一个 hybrid 宿主的最终形态可以是
  `{ turnFold: modern, stepFold: legacy, metrics: fallback }` —— 这正是 0.1.2~0.1.6。
- **会话作用域（sessionScope）**：`official`（官方 `data-conversation-session` 锚点，
  0.1.7-rc.2+）| `tree-only`（只有 `data-conversation-content`，0.1.6-alpha.2 /
  0.1.7-rc.1）| `none`（两个锚点都没有，≤0.1.5）| `unknown`（尚未判定）。
  **sessionScope 的唯一事实源是统一 capability controller**（`hostCapabilityState`），
  CSS 子系统不持有第二份结论：state 仍为 unknown 时做**一次性官方 DOM 契约读取**
  （不是轮询：无观察器/定时器/逐帧回调）——看到 session 锚点 → resolve `official`；
  "有 content 无 session"（rc.2+ 上两属性同一次 commit 渲染）→ resolve `tree-only`；
  会话 DOM 尚未渲染 / document 不可用 → 保持 `unknown`。`none` 只能来自显式的宿主
  能力证据（审计 fixtures / 未来 legacy probe），**绝不因"当前 querySelector 没找到"
  推导**。

**Legacy 入口已按 feature 拆分**：`activateLegacyTurnEngine()` 只在
`turnFold === "legacy"` 时调用（注册期 slot 表证明）；`activateLegacyStepEngine()`
只在 `stepFold === "legacy"` 时调用（渲染期快照证明 Process Group 契约缺失）。
两者各自有激活计数（`getLegacyEngineActivations()` → `{ turn, step }`），Modern
宿主必须恒为 0（测试矩阵逐版本锁死）。

**0.1.1 的历史事实（修正）**：`dsh-v0.1.1-rc.2` 无 `turn-process`
slot 条目、无 `useChat`、无 `useConversation`、无 `turnDataSource`；但它的
session-scope 标准 kit **提供** `sessionId` + `useSession` + `useProjection`
（`SessionStandardProps`），`useChat` 是 0.1.2 的 ui-chat 才合并进来的。此前
README/注释里"0.1.1 连 sessionId / useSession 都没有"的说法是**错的**，已按
tag 源码纠正。因此 0.1.1 上：
- **数据面可达**：Legacy 面用 `useSession(s => s.chat)` 拿官方 `ChatSnapshot`
  （与 0.1.2+ 的 `useChat(selector)` 同形：order / nodes / locations / timeline /
  legacy），Step 分组算法与 Turn index **零改动复用**；
- **Step 缺失证据两条独立存在**：kit 里没有 `useConversation`，或快照没有
  `views.grouped` —— 但**绝不**做"turn legacy ⇒ step legacy"的版本相关性推断：
  两条证据链各自探、结论各自 commit（`resolveLegacyStepCapability({ nativeStepGroups })`：
  `false` = 显式缺失证据；`undefined` = 未就绪保持 unknown；返回 true 的那次
  unknown → legacy 迁移才激活一次 legacy backend）。

**Legacy adapter 在官方等价契约存在时永不运行**：判据全部是能力探针，版本号只出现在
测试 fixtures、README 与 `engines.dsh` 里。

### 0.1.1 Legacy Turn 兼容层（Full Legacy Node Backend）

0.1.1 没有 `turn-process` / `TurnProcessOwnerProps` → 官方不拥有 Turn Fold →
**插件在 0.1.1 上拥有 Turn 折叠语义**（PLUGIN OWNS TURN FOLD ONLY ON LEGACY HOSTS）。
实现方式是**一个物理 backend、两套语义**：

| 宿主 | 物理 shadow 键（恰好这些，一个宿主同一时刻只有一个 backend） | Turn 层 | Step 层 |
| --- | --- | --- | --- |
| 0.1.1（turn legacy） | `assistant-step` + `tool-call` + `context`（3 键，full-legacy 模式） | 插件 Turn index + Turn Bar + 可见性 | **logical attach**（同一 backend 上启用，绝不第二次注册） |
| 0.1.2 ~ 0.1.6（turn modern / step legacy） | `assistant-step` + `tool-call`（2 键，step-only 模式，本轮语义一字未变） | 官方 owner（插件零参与） | 插件 Step 分组 + 折叠 |
| 0.1.7+（turn/step 全 modern） | 无 | 官方 | 官方 |

**Turn membership（纯算法 + memo）**：`legacyBuildTurnIndex(snapshot)` 是纯函数（唯一
事实源，`WeakMap` 按 snapshot 身份 memo，一帧只算一次），语义取自旧 main@356db80 的
A 类算法：
- 作用域 = (最后一个 user 锚点 anchorSeq, turn] —— 用 `locations.getTurn(turn)` 取**该
  Turn 的全部节点**（含官方隐藏节点）；`context` 排在 user 之前（审批策略注入）时属于
  作用域外，**永不隐藏、也不作 header 锚点**；
- `finalAssistantKey` = 关闭（`legacy.turnEnds` 有该 turn）后的**最后一个**
  assistant-step —— 最终答案永不在折叠集合内；
- `headerKey` = 作用域内第一个 member（`tool-call` / `assistant-step` / `context`），
  没有中间成员时 fallback 到 `finalAssistantKey`；`hideKeys` 为空 → `canCollapse=false`；
- `reason` 取自 `timeline.turns.get(turn).end.data.reason.kind`：`aborted` / `error`
  → `alwaysOpen`（永不折叠）；`max-tokens` / `blocked` 按正常完成处理；`running`
  （turnEnds 无该 turn）→ 恒展开、Turn Bar 是状态面（无 `aria-expanded`、点击不写状态）；
- **FAIL OPEN**：finalization 竞态（closed 但还没有 assistant-step）、形状异常（无
  turn / 无 user 锚点）→ 不隐藏任何东西，绝不 `return null`。

**Turn 可见性**：与 Step 完全同构的**插件自有 wrapper**（`hidden="until-found"` +
`onbeforematch` 自动展开，旧内核回退普通 hidden），官方内容经 priority-0 builtin
**委托渲染**（原 props、原 node，内容零复制）；`turn-tail` / `user` / `steering` /
`turn-process` **永不 shadow、永不隐藏**（物理键集合与成员集合双方锁死）。

**Turn open store 与 Step open store 正交**：`legacyTurnOpenBySession`
（sessionKey+turn）/ `legacyStepOpenBySession`（sessionKey+leaderKey）互相独立，Turn
折叠/展开**绝不改写** Step 的展开态（反之亦然）；会话状态由统一 session cleanup 在
两个 registry 都空时一次性清理。

**Bootstrap（无轮询）**：注册期 `turnFold=legacy` → `activateLegacyTurnEngine()` 启动
**事件驱动** readiness：官方 builtin 可能尚未注册完成，则挂 `ctx.on("slots/changed")`
等待（同步首查 + 事件补查），三个 builtin 全部可捕获时做**一次**原子安装；稳定冲突
（任一 cell 已被第三方负 priority 占用）→ 停止 bootstrap、当前生命周期不重抢（FAIL
OPEN：官方 owner 原样显示，只是不折叠）。安装事务期间 bootstrap 判定被屏蔽（事务自己
会同步 emit `slots/changed`，否则会把本插件刚注册的 `-1` 条目误判成第三方占位而永久
自伤为 blocked）。

**Ownership / degraded 复用既有安全机制**：atomic install（builtin 预捕获 → ownership
preflight → 逐个注册 → winner 身份验证 → monitor → COMMIT → 任一失败整体回滚）、
runtime monitor（`slots/changed` PRIMARY + `onEntryError` 同步 backstop + `subscribe`
次级）、运行期 ownership 丢失 → 整体 teardown + `degraded="ownership-lost"`、**不自动
重抢**——Step 与 Turn 共用同一套代码与同一份不变量（`getLegacyNodeBackendState()` 诊断
mode / keys / ownershipVerified / monitorInstalled / degraded / stepAttached /
bootstrapWaiting / turnBackendBlocked）。

**能力独立**：`stepFold`（kit 无 `useConversation` 且快照无 `views.grouped`）与
`metrics=fallback`（快照 `nodes.turnDataSource` 缺失）在**各自的 committed effect**
里独立定论，**绝不从 `turnFold` 推导**；0.1.1 上三者的最终值是
`{ turnFold: legacy, stepFold: legacy, metrics: fallback }`。

### Turn owner contract evolution（owner 形状归一化）

官方 `TurnProcessOwnerProps` 有两代形状（逐 tag 审计），插件用
`normalizeTurnProcessOwner(turnProcess, alwaysOpen)`（纯函数、唯一的形状适配点）
归一化，**视图从不感知契约代际**：

- **旧 modern owner 契约（0.1.2-rc.1 ~ 0.1.6-alpha.2）**：
  `{ spec, foldable, open, setOpen }` —— 没有 hasContent 字段。官方 0.1.2 的
  TurnProcessNodeView 语义：`foldable` 即足以决定可折叠，`open = turnProcess.open`、
  点击 `setOpen(!open)`。
- **新 modern owner 契约（0.1.7-rc.1+）**：增加 `readonly hasContent: boolean`，
  可折叠 = `foldable && hasContent`。

归一化规则用 `Object.prototype.hasOwnProperty.call(turnProcess, "hasContent")` 区分：

- **字段不存在（旧契约）**：`canCollapse = foldable && !alwaysOpen`；
- **字段存在且 false（新契约）**：`canCollapse = false`（静态栏、不调 setOpen）；
- **字段存在且 true**：`canCollapse = foldable && !alwaysOpen`（0.1.7+ 零回归）。

**MISSING hasContent ≠ hasContent=false，更 ≠ LEGACY TURN**——缺字段是契约代际
差异，不是缺官方 owner；`turnFold` 对 0.1.2~0.1.6 仍然判 `modern`（官方已拥有
foldable/open/setOpen，插件只消费官方 owner state）。能力矩阵里对应的是 raw 探针
`turnOwnerHasContent`（owner 契约形状能力，绝不参与 turnFold 计算、绝不触发
Legacy Turn Engine）。`foldable=false`（Verbose）与 `alwaysOpen`（aborted/error/
running）语义两代契约一致、零回归；所有切换仍只调用 `turnProcess.setOpen()`，
插件不自持 open 状态、不重算 membership、不做 DOM 隐藏。

### 能力矩阵（官方 release tag 逐版本源码审计）

来源见 `tests/version-fixtures/host-matrix.mjs`（每个探针字段独立审计、绝不互相推导）：

| DSH 版本 | Turn backend | Owner 契约 | Step backend | Metrics backend | 会话作用域 |
| --- | --- | --- | --- | --- |
| 0.1.1-rc.2 | **legacy：插件拥有 Turn Fold**（Full Legacy Node Backend：assistant-step + tool-call + context；无 turn-process、无 useChat/useConversation；有 sessionId/useSession） | —（无 owner 契约） | legacy：同一 backend 上 logical attach（无官方 Process Group） | fallback（无 turnDataSource） | none（无任何锚点） |
| 0.1.2-rc.1 | **modern**（official owner state） | 旧形状（无 hasContent） | **legacy：插件 Legacy Step Adapter**（官方无分组契约） | **fallback**（无 turnDataSource，指标走逐 step 直读） | none（但插件 Legacy Header 自带 session scope） |
| 0.1.5-rc.3 | modern | 旧形状（无 hasContent） | legacy：插件 Legacy Step Adapter | fallback | none（插件自有 scope） |
| 0.1.6-alpha.2 | modern | 旧形状（无 hasContent） | legacy：插件 Legacy Step Adapter | fallback | tree-only（首次出现 `data-conversation-content`；插件 Legacy 面用自有 scope） |
| 0.1.7-rc.1 | modern | 新形状（hasContent 起） | modern | **reactive**（turnDataSource 首次出现） | tree-only（有 content、无 session 锚点） |
| 0.1.7-rc.2 | modern | 新形状 | modern | reactive | official（`data-conversation-session`，commit b7ac0ade10） |
| 0.2.0-rc.2 | modern | 新形状 | modern | reactive | official |

### Live-host acceptance：当前支持区间（2026-10-06，RELEASE GATE PASSED）

对**当前 `engines.dsh` 声明的三个版本**做真机验收：官方 npm 发布包 + 隔离 `DSH_HOME`/profile +
官方 `dsh plugin --profile web add <path>` 装载（profile `dsh.profile.bundles` + link），
真实 provider、真实模型会话（含工具调用的 Turn 与纯问答 Turn 各一条），并用插桩副本读取插件内部
状态（同一份 `client.js` + 只读 console/`__test` 桥，不改变插件行为）。

| 版本 | 宿主启动 | 插件装载 | capability 最终值 | Turn Bar 接管 | running/completed | Step Bar + Poker | 折叠切换 | 纯问答 | reload/历史 | React 警告 | 未捕获异常 | ownership loss | 证据等级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.7-rc.1 | ✅ npm 发布包 | ✅ | modern / modern / reactive | ✅（running 实时指标 + completed 默认收起） | ✅ | ✅（Step Bar + 图标锚点，折叠正交） | ✅（展开 12→1 隐藏，再收起复原） | ✅（静态栏 + 真实指标） | ✅（重载后 3 根栏重建、零重复注册） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |
| 0.1.7-rc.2 | ✅ npm 发布包 | ✅ | modern / modern / reactive（sessionScope=official） | ✅ | ✅ | ✅（3 个 Step Bar） | ✅（16→3→16 隐藏成员） | ✅ | ✅（2 根栏重建） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |
| 0.2.0-rc.2 | ✅ npm 发布包 | ✅ | modern / modern / reactive | ✅ | ✅ | ✅（4 个 Step Bar + Poker 图标） | ✅（10→0→10 隐藏成员） | ✅ | ✅（3 根栏重建） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |

**验收期间发现并修复的真机缺陷（bundle 装载时序竞态）**：本插件以 bundle 方式装载时只注入
`slots`，cordis 会在服务就绪时立即 apply——可能**早于**官方 conversation 层声明
`conversation.chat.node`。此时注册期探测把「没有 turn-process 条目」误判成 legacy →
在现代宿主上装出 3 键 legacy backend 且**永不注册 Turn 渲染器**（表现为官方 Turn Bar 保留、
Step 层退化）。用户自有 profile 经 patch-insert 层装载（apply 最后）恰好绕开该竞态。
修复（commit `abc375c`）：`hostCapabilitiesOf` 的 turnFold 映射三态化
（undefined=unknown，绝不猜 legacy）；注册期探测新增官方只读检查面 `slots.snapshot(root)`
判定槽位是否已声明；unknown 时经 `ctx.on("slots/changed")` **事件驱动**等待，在同一同步突变批
（声明 + 官方 inject 回调注册条目）落地后的**一个微任务**里复判——有 turn-process → modern 并
注册 Turn 渲染器；声明且条目非空、无 turn-process → legacy（0.1.1 形态）；零条目 → 继续等。
无轮询、无定时器；无 `snapshot` 检查面的极简宿主保持既有语义。

### 历史验收记录：0.1.1 ~ 0.1.6（2026-10-05，非当前支持区间）

> 以下四个版本**不在当前 `engines.dsh` 声明范围内**，仅作历史记录；它们各自有独立的
> 兼容阻塞项（详见下文），不构成当前支持区间的发布阻塞。

本轮把矩阵从"契约 harness"推进到**真实宿主**：用各 tag 的真实 runtime（官方 tag 源码构建，
或官方 npm 发布包）在隔离 `DSH_HOME` 里启动 Web 宿主、用官方插件机制装入本插件、跑真实
turn 并读插件自身的内部状态。结论（**证据等级逐项标注**）：

| 版本 | 宿主启动 | 插件装载 | 关键实测 | 证据等级 |
| --- | --- | --- | --- | --- |
| 0.1.1-rc.2 | ✅ 官方 tag 源码自建（`git archive` + 该 tag 的 pnpm 11.7.0/lockfile；npm 发布包**无法**启动 web，见下） | ✅（`/plugins/@winteries/dsh-turn-fold/client.js` 被真实加载） | 能力定论实测为 `turn=legacy, step=legacy, metrics=fallback`（真机 console 实证）；3 键 backend 安装成功后**自行 teardown**（`degraded=ownership-lost`），折叠未生效 | **LIVE-HOST VERIFIED（失败）** |
| 0.1.2-rc.1 / 0.1.5-rc.3 | ⛔ npm 发布包 `app-boot` 仍调用 `hmr.registerConfig`，而 npm 的 `cordis-plugin-hmr@1.0.19` 无此 API → `dsh web` 启动即崩（源码自建可绕开，未跑完整矩阵） | — | 官方 tool-call 入口形态与 0.1.1 相同（`children: {tool.call.toolview}` + `inject: hostDescription`）→ 同一条 blocker 适用 | **HOST BOOT BLOCKED（npm）+ 源码审计** |
| 0.1.6-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 | 发布包 `app-boot` 已不再调用该 API（源码核实），未跑完整真机 | — | 0.1.6 仍是 hybrid（Legacy Step → 同一 blocker）；0.1.7+ 是纯现代路径 | **SOURCE-AUDITED ONLY**（本轮未真机） |
| 0.2.0-rc.2 | ✅ 官方 npm 发布包真机启动（隔离 home + 官方 `dsh plugin add` 装载） | ✅ 客户端 bundle 被加载、插件 apply 生效（三个插件样式表在 head） | 本轮未能完成 Turn Bar 接管观测：调试过程中 profile 状态被改动后宿主不再提供插件 client 模块（`/plugins/...` 404），未及在干净 profile 上复跑 → **不作通过结论** | **LIVE-HOST VERIFIED（启动+装载）/ Turn 接管 INCONCLUSIVE** |

**本轮发现的阻塞项（plugin bug，已在真机定位到具体 API 语义）**：

1. **官方 `tool-call` 渲染器不可被 shadow 委托**：官方入口注册时带了
   `children: { 'tool.call.toolview': … }`（子槽声明**按 key 全局唯一**，同一 key 二次声明直接抛错）
   与 `inject: () => ({ hooks: { hostDescription } })`（entry 级注入面）。插件 shadow 既无法
   复制 `children`（会与官方条目撞声明），也无法拿到该子槽的授权绑定
   （`renderSlot` 绑定按 entry 生成，调用未声明 key 抛 `SlotOwnershipError`），于是委托渲染官方
   `ToolCallTree` 时官方组件拿不到 `useHostDescription` / `renderSlot` → 组件抛错 → 宿主把
   **本插件的** shadow 条目 abdicate → 插件的同步 backstop 按设计整体 teardown
   （真机日志：`slot entry crashed in 'conversation.chat.node': TypeError: useHostDescription is not a function`
   → `[dsh-turn-fold] Legacy Step disabled: runtime shadow ownership was lost; backend torn down`）。
   该形态在 0.1.1 ~ 0.2.0 的官方源码里一致存在 → **Legacy Step / Full Legacy 的"3 键委托"方案在
   真实旧宿主上不成立**，需要重新设计（详见下轮待办）。
2. **npm 发布包 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.3 不能启动 web profile**：官方 `dsh-app-boot`
   在这三代里通过 `hmr.registerConfig` 监听用户 patch 层，而 npm 上 `@deepseek-ai/cordis-plugin-hmr@1.0.19`
   无该 API（tag 内是 `vendor/hmr` 工作区包，未随 npm 发布）→ 现象为
   `TypeError: hmr.registerConfig is not a function`。这属于**宿主自举阻塞**，不是插件问题；
   以真实 tag 源码自建（沿用该 tag 的 lockfile + pnpm 11.7.0）可正常运行。

因此本轮**不放开 `engines.dsh`**：0.1.1 的 live 结论是失败，0.1.2/0.1.5 连官方 runtime 都起不来，
0.1.6+ 未真机验证。当前区间保持 `>=0.1.7-rc.1 <=0.2.0-rc.2`。

### 诊断输出：probing → resolved 两行制

注册期**不下最终结论**（modern + unknown 不是 mixed）：

```
[dsh-turn-fold] host capabilities: turn=modern, step=probing, metrics=probing
```

运行时 resolution 完成后输出一次最终 mode（每个有效变化最多输出一次，不逐 Turn 刷）：

```
[dsh-turn-fold] host mode: modern (turn: modern, step: modern, metrics: reactive)
[dsh-turn-fold] host mode: mixed  (turn: modern, step: legacy,  metrics: fallback)
[dsh-turn-fold] host mode: legacy (turn: legacy, step: legacy,  metrics: fallback)
```

`turn=legacy` 的宿主现代渲染器不注册；最终 mode 行**只在三个 feature 全部定论后**
输出——0.1.1 的 step/metrics 由 Full Legacy renderer 的 committed probe 定论，因此
这行会晚到（注释面完全就绪之后），注册期绝不提前下结论。`getLegacyNodeBackendState()`
可随时查询 backend/ownership/bootstrap 的实时事实。

### 会话作用域四态与 0.1.7-rc.1 安全降级

- **official（0.1.7-rc.2+）**：规则前缀 `[data-conversation-session="<id>"]` + 完整组
  条件，多棵会话树并存（主会话 + 子代理侧栏）时每块只命中自己的树，同名 groupKey
  完全隔离；active session count 对它**没有约束**（第二个 session 刚 mount、还没有
  chunk 时，A 的规则照常输出——official 作用域本身已安全限定）。
- **tree-only（0.1.7-rc.1）**：CSS 层无法区分两棵会话树——单会话时允许输出
  group-specific completed 牌面覆盖；**多会话并存时自动撤下全部 session-specific
  completed 牌面覆盖**（回落基础 Step Poker 的通用 5 张双态与运行态平面旋转轮换）。
  判断依据是**当前已挂载的会话数**（插件自己的 per-session bridge registry
  `stepCardBridgeSessions.size`）——**不是"已生成 CSS chunk 的会话数"**：第二个
  session 一进 registry（哪怕它还没写出任何 chunk）就必须立即撤下，否则 mount 瞬间
  存在 A 的 fallback 规则命中 B 树同名组的错误牌面闪现窗口（已用 registry 级测试与
  harness 五阶段验收锁死）。不做任何 DOM 轮询。"少一点视觉个性"优于"Session A/B
  串样式"；降级只控制规则输出——牌面分配（bag）、`completedFaceSets`、变体样式资产
  全部保留，会话数回落到 1 时立即恢复该会话的规则，无需刷新。**不声称 rc.1 多会话
  可完全隔离。**
- **none（≤0.1.5）**：没有会话内容锚点，无 sessionId 的规则块只在唯一会话时输出。

规则 selector 以"完整 host"为单位逐支生成（0.2.0-rc.2 真机验证）：

```css
[data-conversation-session="A"] [data-step-process][data-chat-group-key="X"]:not(:has([data-shimmer="true"])) … [data-step-process-icon]::before { … },
[data-conversation-content]:not([data-conversation-session]) [data-step-process][data-chat-group-key="X"]:not(:has([data-shimmer="true"])) … [data-step-process-icon]::before { … }
```

两支都是完整 selector：official 支在 rc.2+ 命中，回退支因 `:not()` 恒失败永不命中；
rc.1 上只有回退支命中。插件不写官方 DOM、不加任何官方属性。

### Legacy Step Compatibility Layer（hybrid 宿主：官方 Turn + 插件 Step）

0.1.2-rc.1 ~ 0.1.6-alpha.2 的最终形态：

```
        Official Turn Fold（官方 owner state：foldable / open / setOpen）
                 ↓
        Enhanced Turn UI（插件 Turn 栏 / Poker / 指标 fallback）
                 │
                 └── Legacy Step Adapter（官方没有 Process Group 契约）
                             ↓
                   Plugin-owned LegacyStepHeader（挂官方 Poker skin 钩子）
                             ↓
                   Shared Poker / Native / Settings（同一套视觉资产）
```

**归属边界（硬不变量）**：Turn 的 Fold 引擎是 **DSH 官方**（Legacy 层绝不触碰
turnProcess.open / Turn membership / Turn hide / 不注册 turn-process shadow）；
Step 的 Fold 引擎在 hybrid 宿主上由**插件 Legacy Adapter** 补位——**只因为官方没有
Step 分组契约**（没有 Process Group / ChatGroupSeat / ProcessGroupHeader /
`views.grouped` / `groupSource` / `data-step-process` 组条）。两组状态完全正交：
官方收起整回合时插件什么都不做，再展开时 Legacy Step 保留自己的 open 状态（测试锁死）。

**Modern 宿主（0.1.7+）绝不运行 Legacy 层**：`stepFold` 由渲染期契约探针定论为
`modern` → `activateLegacyStepEngine` 的安装点永不进入 → shadow 注册数 0、
legacy 组计算计数恒 0（测试锁死）。

**数据层（纯函数，无 DOM/无文字匹配/无轮询）**：`legacyBuildStepIndex(snapshot)` 从
官方 `useChat` 快照（具名 `selectLegacyChatSnapshot`，仅 Legacy shadow 消费）单遍切段：
段 = 两个 text 之间的 tool-call + 含 reasoning 的 assistant-step 混排；think 不打断段、
text 是唯一闭合标记；`todo_write` 排除工具不入段；**user / context / 纯 text 节点是边界
而不是成员**（最终答案永远在 Step Fold 之外、user 消息永不可被隐藏）。索引按 snapshot
身份 **WeakMap memo（每次快照发布最多构建一次，节点查询 O(1)——不是每 node O(N)）**。
组身份 = **anchor 节点官方稳定 key**（非数组下标/随机数），open/close、rerender、
分页 remount 期间稳定；回合已结束（`legacy.turnEnds`）强制段闭合（中断/出错不再永久
running）。Legacy 组模型：`{ leaderKey, keys, memberKeys, toolCount, lastToolName,
turn, closed }`。

**视觉层共享**：Legacy Header 是**插件自己渲染的 DOM**（`data-tf-legacy-step` /
`data-tf-legacy-session` 身份标记），它主动渲染与官方组条相同的视觉钩子
（`data-step-process` / `data-chat-group-key` / `data-process-activity` /
`aria-expanded` / `data-step-process-icon`）——Step Poker skin（含 running 平面旋转 35.5° 轮换：
running 时在插件自有按钮上置 `data-shimmer="true"`，皮肤 `:has()` 直接命中）、3/5 张
threshold、per-session shuffle bag、`completedFaceSets` 变体资产、morph/knockout 全部
原样复用（逐组规则经 `buildStepCardRulesCss(..., "legacy")` 的 surface 适配：scope 前缀
换成 `[data-tf-legacy-session="<sessionKey>"]`，单分支、天然精确——**不依赖官方
session DOM 锚点**，0.1.2/0.1.5 的 sessionScope=none 也能做到真正的会话隔离）。
Native 模式：skin 总闸关闭时 Legacy Header 仍是功能载体（自带 chevron + 标题，
折叠语义不变，plugin 基础 CSS 提供布局壳）。**Modern 官方 ProcessGroupHeader 与插件
LegacyStepHeader 是两种不同的 DOM，共用同一套 Poker 资产**——0.1.2 没有官方组条。

**成员可见性（FAIL OPEN）**：running 段成员恒可见（绝不隐藏正在生成的内容）；completed
段默认收起，点击 Header 展开（`legacyStepOpenBySession`：sessionKey+leaderKey 隔离的
插件自有 open store，与 turnProcess.open 无关）。隐藏挂在**插件自有的原地 wrapper** 上
（`hidden="until-found"` + `beforematch` → 自动展开，浏览器搜索命中不外泄；旧内核安全
回退普通 hidden）——原官方内容经 priority-0 builtin **委托渲染**（原 renderer 原样调用、
内容零复制零变形），think+text 成员只折叠 think 部分、text 正文段外恒可见。session 状态
（open store / 共享牌面分配）在该 session 最后一个 Legacy 面卸载后（微任务确认，
与 modern 桥共享同一清理门）才清理。

**Installation safety（原子安装；FAIL OPEN 的准确含义）**：Legacy Step backend 的
安装是**同步事务**——① 在注册 shadow **之前** preflight 捕获两个官方 builtin
renderer（`entries()` 的 priority-0 条目；真机审计确认 0.1.2/0.1.5/0.1.6/0.2.0 的
`StoredEntry` 都直接暴露 `component`；ui-renderer 的 `slots.inject` 在 slot 已声明时
**同步执行回调并同步抛出 setup 失败**——注册成败可同步观测）；② **ownership preflight**：
插件的 shadow 固定以 `priority: -1` 注册，而官方 keyed slot 是 **lower priority wins**
（条目按 priority 升序，每个 cell 的首个 live 条目渲染）——因此只有当该 cell
**不存在任何 `priority < 0` 的既有条目**时才可能成为 winner。preflight 检查的是
**任意负 priority**（不是"是否已有 -1"）：第三方 `-2/-3/-10` 会赢过 `-1`、且 register
不会抛（priority 不同）——只查 -1 会注册出一个永远不渲染的 shadow 并错误 COMMIT 成
半套。任何同 key 负 priority → **整个 backend 让位**（绝不改成 -100/-999 去抢；也不
走"让位到 +1"——+1 赢不过官方 0，只会造成半套）；③ 依次注册两个 shadow；④ **winner
身份验证**：`entriesOfSlot()`（每个 cell 的 winning entry）中 assistant-step 与
tool-call 的 winner 必须**就是本次事务注册的条目**——`key` 命中 + `priority` **恰好
-1** + `component === 本次事务的组件`（宿主把 `options` 规范化为新对象、对象身份不可用，
故用三元组；仅判断"negative winner"不够——第三方 -2 同样满足）；`entriesOfSlot`
缺失/抛错 → 验证失败（目标宿主 0.1.2/0.1.5/0.1.6 均有该 API；不可验证 = 不安装）。
任一步失败（含验证失败）→ **回滚已注册的全部**、registration/builtins 清空；全部通过
才 COMMIT（builtin 引用与 registration 一起落定，`getLegacyStepRegistrationState()`
保证 `installed === true` ⇒ `ownershipVerified === true` ⇒ keys 恰好两个）。
因此：**"无法安全捕获两个 builtin / 无法同时取得两个 shadow cell 的 ownership → 整个
backend 不安装，官方（或第三方）现有 owner 保持不动、内容原样显示，代价只是 Step 不
折叠"**——绝不出现"内容消失 / 半套折叠 / 返回 null"。**BOTH CELLS OWNED BY THIS
PLUGIN, OR ZERO LEGACY SHADOWS REMAIN**——不是"both registered"，而是"both actually
winning"。render 路径只读**安装期捕获的 builtin 引用**，**不再扫描 slots.entries()**
（源码守卫 + 调用计数测试锁死）；安装期降级警告各恰一次且区分类型（builtin 缺失 /
cell 已被占用 / ownership 验证失败回滚），counters 分开记账
（`getLegacyStepInstallStats()`：attempts / successes / preflightFailures /
ownershipConflicts / ownershipVerificationFailures / rollbacks + installs）。

**Runtime ownership liveness（WHILE INSTALLED: BOTH CELLS MUST CONTINUE TO BE
OWNED）**：安装事务只保证 COMMIT 那一刻成立；slot registry 是动态的——第三方插件
可以后加载 `-2` 抢走某个 cell，官方也可能把崩溃的 renderer **abdicate**（从 winner
投影中退休）。因此成功 COMMIT 后安装 **ownership monitor**（`activate` 事务的最后一
步，三通道任一不可用即回滚 FAIL OPEN）：

- **PRIMARY `ctx.on("slots/changed", key)`（同步事件，维护严格不变量）**：官方
  ui-renderer 在 `SlotRegistry` 构造时把 `core.onMutate` 桥成
  `ctx.emit("slots/changed", key)`（0.1.2/0.1.5/0.1.6 同形）——**同步**发射：官方
  invariant 强制"emission must follow the applied mutation"（`register` 先替换
  entries 数组、再 `markDirty` 同步派发监听器），官方 registry 测试也在 `register()`
  之后**立即**断言事件序列（无 await/microtask）。因此**第三方 register/dispose 的
  同一调用栈内**就完成 ownership 重验证与整体 teardown——**不存在一个 microtask 的
  半套窗口**。监听器内 dispose 本插件 entries 是安全的（markDirty 用快照副本迭代、
  `dirty` 是 Set、entries 为原子数组替换、disposer 幂等——官方源码审计）。
- **BACKSTOP `slots.onEntryError(…)`**：renderer crash / abdication 的语义信号
  （同步、在 abdication mutation 之后；PRIMARY 已在同一栈内 teardown 时自然 no-op）。
- **SECONDARY `slots.subscribe("conversation.chat.node", …)`**：microtask-batched
  一致性备份（成本极低，覆盖理论上的 event bridge 异常；**不承担同步 invariant**）。

漂移处置（与 install 时同一套严格判据：`entriesOfSlot` 的 winner 必须 = 本次事务的
renderer、priority 恰好 -1、component 一致）：任一 required cell 丢失 → **整体
teardown**（`teardownLegacyStepEngine("ownership-lost")`：重入 guard → **先注销
三个 monitor** → 再 dispose 两个 shadow → 清 registration/builtins）→ **FAIL OPEN
到宿主当前 winners**（官方或第三方继续正常渲染，第三方新 entry 与官方 builtin 原样
保留），绝不半套运行、绝不 `return null`。register() 返回后**绝不存在**长期或
microtask 级半套状态——同步不变量：

```
WHILE INSTALLED: 两个 required cell 的当前 live winner 都是本插件；
任何破坏它的 registry mutation，都在同一次 mutation 调用栈内
整体拆掉 Legacy backend。
```

**不自动重抢**：运行期 ownership 一旦丢失，本插件当前生命周期内不会重新争抢该 slot
（即使冲突插件随后退出）——backend 保持 fail-open disabled（`stepFold` 能力仍为
`legacy`；`getLegacyStepRegistrationState()` 给出 `degraded/degradedReason`）。
**显式重试语义**：外部显式再次 `activateLegacyStepEngine()` 时——preflight 失败
（冲突仍在）→ degraded 状态**保留**；完整成功重新 COMMIT → **degraded 清零**
（`degraded=false, degradedReason=null`，且 installed/ownershipVerified/
monitorInstalled 全部为 true）。这是稳定共存策略，避免 ownership oscillation 与重复
shadow mount/unmount。ownership-lost 只记
`runtimeOwnershipLosses`/`runtimeTeardowns`（与 preflight/verification 计数分开），
警告恰一次（跨显式重装也不重复刷）；**不动**任何 session presentation state
（open/face/CSS 由统一 session cleanup 收尾）。

**raw entries vs live winners（审计边界）**：`slots.entries()` 是 **raw registration
ledger**——abdicated 条目仍会列出（registration 未撤销、disposer 仍有效）；它只用于
**捕获官方 priority-0 builtin 引用**。`slots.entriesOfSlot()` 是**当前 live winners**
（每个 cell 的首个非 abdicated 条目）——**ownership preflight、post-register 验证、
runtime liveness 全部以它为准**。上一轮的 preflight 曾用 raw entries 检查负 priority：
一个"曾存在但已 abdicate"的第三方 `-2` 会永远错误阻止安装（stale 误阻）；现在 preflight
按 live winner 判定（winner priority >= 0 即可接管），同时"live winner 为负 priority"
仍然整体让位（安全语义不倒退，测试双向锁死）。

**Hook lifecycle（架构约束）**：Legacy member surface 的挂载登记由**无条件 Hook**
`useLegacyStepSurface(sessionKey, active)` 管理——两个 renderer 在每一次 render 里都
先调用它（早于任何 return），non-member ↔ member 的流式转换（assistant-step 的 blocks
从空到 reasoning、工具的排除/恢复）**绝不改变 Hook 顺序**；渲染路径内不再有任何直写
`useEffect`（源码守卫锁死）。surface registry 计数与真实挂载的成员数严格一致
（StrictMode effect replay 后恰好 1，卸载回 0，无重复 mount / 负计数 / zombie session）。

**Unified session cleanup（单一 gate）**：Modern 牌数桥（`stepCardBridgeSessions`）与
Legacy Step 面（`legacyStepSurfaces`）共享**一个** session presentation cleanup gate：
`stepPresentationSessionActive(sessionKey)` = 任一 registry 仍在场即活跃；两条卸载路径
（`unregisterStepCardBridge` 与 `legacyStepSurfaceUnmounted`）都只调用**同一个**
`scheduleStepPresentationSessionCleanup`（唯一的 `stepPresentationPendingCleanup` Set +
微任务复核；mount 路径 delete pending 取消清理，StrictMode/同 commit 重挂载不误清）。
两个 registry 都清空后，**唯一**的 `cleanupStepPresentationSession(sessionKey)` 一次性
清干净：Legacy open store、Legacy 逐组 CSS（含 `__css__` chunk）、per-session
completed 牌面分配/bag——**谁最后退出不影响结果**（此前 legacy 先退、bridge 后退时
modern 清理只清 face/bag，Legacy open state 会残留）。全局共享资产（completedFaceSets /
变体样式元素 / Poker 池 / settings）绝不在这里清。现代 `stepCardRulesBySession` 仍由
bridge 的卸载路径负责（统一 helper 不重复清）。

Legacy **Step** 层的语义最小化：rich title（编辑 diff 文案 / 文件名 / failure 聚合 /
自动跟随 think）与旧 metrics **明确不移植**。Legacy **Turn** 层（0.1.1）移植的是旧
main 的 Turn 折叠**语义**（membership / 边界 / header / final / reason），实现是新写的
纯索引 + 插件自有 DOM，同样**不计算任何指标**（TTFT/TPS/token/cache 全部由共享的
TurnBarView fallback 面负责：Turn 级时钟取 `legacy.turnTimings`/`turnEnds`，TTFT 取
turn-tail 的官方 `ttftMs`，decode 由 assistant-step 证据聚合，取不到的字段显示 "—"）。

当前 `engines.dsh = ">=0.1.7-rc.1 <=0.2.0-rc.2"`（**本轮未放开**）：0.1.1-rc.2 的
Full Legacy Node Backend（Turn + Step 双语义）与 0.1.2 ~ 0.1.6 的 Official Turn +
Legacy Step 都必须等真实旧宿主矩阵通过后才会放开 `engines.dsh`。0.1.1 / 0.1.2 / 0.1.5 /
0.1.6 / 0.1.7-rc.1 均为 source-audited / contract-harness verified（官方 tag 契约 +
真实 DOM/组件形状 + 本机 0.1.1 契约 harness），**not live-host verified**（本机无这些
版本的 runtime）。

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
| `unit.poker.test.mjs` | 活动→花色映射（官方 ProcessActivity 词表全覆盖）、牌堆/扇形/翻牌 SVG 生成、**运行中翻牌轴 = 竖直对角线轴（轴角 = atan(w/h) + 几何/原点校验 + CSS 覆盖回归守卫）**、组件渲染、reduced-motion 与无 WAAPI 静态降级 |
| `unit.step-cards.test.mjs` | Step 牌数桥：官方 `counts` 求和 → 3/5 张、3 张 morph 身份连续、逐组 mask 几何、桥全链路（groupSource 订阅、同域规则撤销/恢复、leader 卸载清空）；**步骤文件清单：路径抽取（结算态/运行中/preparing/截断/目录型工具/转义）、basename 去重 + `+N` 截断、会话作用域双支、运行中也输出、参数变化跟随刷新、无 ChatNodeStore 时降级为空** |
| `unit.css.test.mjs` | Step 皮总闸（`body[data-tf-step-skin]`）与官方 DOM 钩子规则；**平面旋转契约（`tf-step-flat-rotation` 包住全部相位、角 = 数据源 `pokerSpin.restAngle` 且四舍五入 == 参考稿字面量 35.5、五相位/72 animateTransform/15 animate/0.8s×82/4s×5 全部原样、±3.1° 二维小角度、四蒙版挖空、poker 5:7 卡牌）**；**架构守卫：旧 Fold Engine 的 `:has()` 隐藏规则必须消失** |
| `unit.gear.test.mjs` | 设置弹窗：字段 checkbox 双向绑定、设置持久化、图标风格 / Step 皮选择器（hooks 顺序守卫）；**「动态扑克牌」预览的牌面每秒轮换（纯函数位移 + 真实直播时钟驱动 + 关窗退订）** |
| `unit.compat.test.mjs` | **注册审计：仅 shadow `turn-process` 一个 key**、`exports.inject=['slots']`、priority 冲突让位、注册异常软降级；**架构守卫：旧引擎标识符 / 官方 renderer 代理层 / transcriptView 写入扫描为零**；官方四档 transcript 模式渲染兼容 |
| `regression.test.mjs` | 历史回归：直播时钟空转定时器、齿轮 stopPropagation、降级要求（图标包/设置损坏回退默认） |
| `unit.host-compat.test.mjs` | 跨版本能力矩阵（三态语义、UNKNOWN ≠ LEGACY）、注册门控（Modern 宿主 legacy 激活恒 0；legacy 宿主注册期只记 Turn）、selector 完整 host 逐支生成 + jsdom 双树命中、运行时 resolution（未就绪保持 unknown / 契约缺失才 legacy / 已定论不翻转）、metrics 与 Turn fold 解耦（reactive/fallback/unknown）、诊断两行制（probing → resolved） |
| `unit.step-session-scope.test.mjs` | 会话作用域：selector 前缀与转义、裸会话分支回归锁定、same groupKey 双树隔离、tree-only 多会话安全降级（撤下 session-specific 覆盖、恢复无需刷新、completedFaceSets 保留、running 轮换不受影响） |

> 在 Windows 沙箱等无法 spawn 子进程的环境下需要 `--test-isolation=none`（已在
> `npm test` 中内置）；普通 Linux/macOS CI 同样可用该参数（Node ≥ 22.9）。

## 折叠栏图标（统一模式）

设置弹窗里只有一个**统一图标模式**选择器（回合栏右侧 ⚙ 齿轮 →「折叠栏图标」），
一个设置同时决定 Turn 前导图标与 Step 皮，不再提供"Turn=官方 / Step=扑克"这类
不一致组合（旧的双字段 `foldIcon` / `stepSkin` 在读取时自动迁移，见下）：

- **动态扑克牌（poker，默认）**：
  - Turn：完成态 = 牌堆/扇形（本回合工具+子代理 ≤3 用 3 张、>3 用 5 张），运行态 = 翻牌动画；
  - Step：completed = 扑克牌堆/扇形（张数按 Process Group 工具数），running = 五牌面轮换 · 平面旋转 35.5°。
  - 设置预览：4 张静态预览（3 牌折叠 / 3 牌展开 / 5 牌折叠 / 5 牌展开）的牌面**每秒在牌面池
    （♠♥♦♣ + DeepSeek 鲸鱼）里整体轮换一位**，各预览相位错开 → 同一时刻恰好展示 4 种不同
    牌面；第 5 项是运行中翻牌（真实组件）。轮播复用耗时秒表那只全局 1s 直播时钟：弹窗挂载
    才订阅、关闭即退订（不新开第二只定时器，无空转）。
- **官方图标（native）**：
  - Turn：**保留插件增强栏的全部内容**（耗时/首字/token/tok/s/缓存/第 N 轮/齿轮/durable
    指标/官方 Fold 行为——仍然是 `EnhancedTurnProcessView` 渲染，**不**切回官方
    TurnProcessNodeView），只把前导图标换成官方风格的折叠 chevron：几何逐值对齐官方
    `IconChevronDownOutlineRegular`（viewBox 16、stroke 1、size 14），收起向下、展开
    `rotate(180deg)` 向上（官方 CSS 同款 100ms 过渡）；运行中/不可折叠的回合官方本就
    没有折叠 chevron，前导位留空；
  - Step：**完全恢复官方 ProcessGroupHeader 自己的图标**——activity icon、hover/focus
    chevron、open/closed 方向、shimmer、title、disclosure 全部原样（实现 = 停用插件的
    两张皮肤样式表 `disabled=true`，官方 DOM 一个字节不动）。
- **迁移**：旧设置里的 `foldIcon` / `stepSkin` 任一为 `native` → 升级后 `iconStyle=native`
  （老用户不会突然重新出现扑克）；两者都是 poker → poker；新字段存在时优先。
  迁移只发生在读取层；下一次保存只写 `iconStyle`（并保留 localStorage 里的未知字段）。
- 切换**无需刷新页面**：`iconStyle` 的 React 订阅**只有一处**（EnhancedTurnProcessView
  无条件调用一次），随后以普通字符串 prop 下传给 TurnBarView 与前导图标工厂
  `turnPokerIcon(iconStyle, …)`——TurnBarView 的 `canToggle` 会随回合生命周期变化，
  若在它内部订阅就成了条件 Hook（Rules of Hooks 违规），因此源码有静态守卫锁死这一点；
  Step 由 `applyIconStyle()` 同步两张样式表的 `disabled` 总闸。
- 旧字段清理：`foldIcon` / `stepSkin` 只在读取时用于一次性迁移；下一次真实保存
  （改字段显隐或切图标模式）时 `saveSettings()` 会**删除**这两个键并写入 `iconStyle`，
  其余未知字段原样保留（启动阶段不写盘）。

### 扑克模式细节（iconStyle = poker）

- **完成态**：收起为牌堆（本回合工具+子代理 ≤3 用 3 张、>3 用 5 张），展开变扇形；
  **牌身份连续**：绘制顺序恒为身份序 1…N（开合一致），stack 的顶牌就是 fan 最右那张，
  同一张牌在开合全程保持自己的层级——不会出现"展开后中间那张变成顶牌"的身份交换；
- **牌面分配（shuffle bag）**：牌面池 ♠ ♥ ♦ ♣ + DeepSeek 鲸鱼 Logo 五选一（鲸鱼数据缺失时
  自动退化为四花色）。**每个 session 一个独立洗牌袋**：一个完整袋内每种牌面各出现一次、
  顺序随机（Fisher–Yates，不用 `sort(() => Math.random() - .5)`）；重洗后首张不会与上一批
  末张相同（避免跨批出现"…♦ / ♦…"连续重复）；同一 Turn **首次分配后在当前页面生命周期内
  保持稳定**——重渲染、开合、指标/设置变化都不会换牌面。刷新页面或插件重载后重新随机：
  这是纯 presentation state（不写 localStorage / projection / node data），也不声称长期均匀
  或密码学随机，只保证"一个袋内不重复 + 同一 Turn 稳定"的观感；
- **运行态**：对角线轴翻牌（四花色循环、Logo 背面），SVG 原生动画，SMIL 不随重渲染重启；
- **遮挡**：luminance mask 按上层牌变换动态挖空下层覆盖区，牌身透明（壁纸/透明背景下正确）；
- **数据源**：`icons/default.json`（花色路径、卡牌几何、扇形/牌堆变换表、动画模板），
  改完 `npm run sync:icons` 注入、`npm run icons:check` 校验；
- **步骤栏运行中轮换（平面旋转 35.5°）**是**构建期**产物（`npm run sync:step-anim` 由参考稿
  第三行「平面旋转」变体生成、旋转角取上面的数据源 `pokerSpin.restAngle`，见「Step 运行态」
  一节）：数据源改了要重跑它，否则运行中旋转角仍是旧值（`npm test` 的生成块守卫会先失败）。
  运行时 `localStorage['dsh-turn-fold:icons']` 覆盖只作用于回合栏翻牌与 completed 双态牌面。

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
    mask 换成**五牌面轮换 · 平面旋转 35.5° 的 SVG**——♠ ♥ ♦ ♣ + DeepSeek 五张地位相同的
    牌面、每 0.8s 一次轮换、4s 完整循环、动态蒙版挖空下层牌，整套动画绕图标中心整体旋转 35.5°）；
    两者都不存在 → 静态 Poker fallback（该 Step activity 对应花色）。**仅用于运行中 Step 的
    扑克轮换动画识别**；官方回合结束属性消失 → 动画规则不再命中 → 自动回落，
    交接零 JS。无论视觉钩子是否失效，都不影响 Step Fold / Tool / Think /
    Turn Fold 与页面稳定性；
  - **Soft style injection（非理想软兼容点，已如实记录）**：插件向 `document.head`
    注入最小 `<style>`：基础样式 + Step 皮 + 牌数桥逐组规则 + 逐组牌面资产（每个
    `(count, topFace)` 变体一个元素，只写一次）+ 步骤文件清单逐组规则（独立元素，
    与皮肤总闸解耦）。截至当前 DSH master（21638c5631）
    官方没有给 plain-JS client plugin 提供样式注册 API（全宿主唯一 `createElement('style')`
    在 web 自身代码里），而 Step 皮必须作用在官方 Header 的官方 DOM 上、无法收敛进
    插件 React 子树——故保留此软兼容点。注入失败的最坏退化 = 无 Turn 栏样式与无
    Step 皮，官方折叠行为不受影响；宿主未来提供样式注册面时迁移。
- 相比上一代（≤0.5.x）的行为变化：
  - 步骤分组/标题完全交还官方——插件自研的「运行了N条命令 / 读取了… / 思考了N次」
    段标题、段内文件链接复制、[ +N -M ] 行数统计、标题缓存已删除（官方标题语义为准）；
    （唯一回来的相关能力是**只读的步骤文件清单**：组头尾部 `a.ts · b.ts +2` 纯文本，
    由官方节点数据生成、走 CSS `::after`——仍然不可点击、不复制路径、不碰官方 DOM。）
  - 「待折叠/已折叠 N 步」字段删除（折叠成员归属由官方决定，插件不再自行统计步数）；
  - **旧版 +1/+11 假增长删除**——现在运行中的 token 槽是 **presentation-only 视觉计数**
    （canonical 真实值与展示值分层，见上文「真实数据层 / 展示层」）：真实 usage 一到立即校准、
    settle / 历史 / 刷新只显示官方真实值；
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
