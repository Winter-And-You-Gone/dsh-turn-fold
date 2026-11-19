# 回合指标、工作原理与注意事项（工程附录）

> 本文是 [README](../README.md) 的工程细节附录：指标口径、视觉计数、实现原理与已知问题。

## 回合栏指标口径

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


## 工作原理（为什么不用改源码）

- DSH 会话 UI 是 Cordis 插件 + Slot 插槽系统拼出来的；聊天流每个块经
  `conversation.chat.node`（keyed slot）按节点类型分发渲染器，**复用同 key 即替换该
  渲染器（lowest renders）**。
- 本插件用 `priority: -1` 覆盖官方 `turn-process` 渲染器——这是**现代宿主上**插件替换的
  唯一官方渲染器。不 shadow `tool-call` / `assistant-step` / `context` / `user`，不扫描
  官方 slot entries 做委托渲染，不复制官方 inject hooks（官方组件始终由官方条目
  自己渲染）。**例外**：`engines.dsh` 区间之外的旧宿主（0.1.1~0.1.6）上，插件会走
  Legacy 兼容层注册自有渲染器——那一段在本区间内不可达，详见「Legacy 兼容层」。
- **折叠语义全部来自官方 owner state**：官方 `ChatNodeSeat` 为每个节点构建
  `turnProcess = { spec, foldable, hasContent, open, setOpen }` 并自己负责成员的隐藏
  （`data-turn-process-hidden`）与展开。插件回合栏只在点击时调用
  `turnProcess.setOpen(!open)`；`canCollapse` 的判定与官方渲染器一致
  （`foldable && hasContent`，且回合 aborted/error/open 时不可折叠——官方
  `turnProcessAlwaysOpen` 语义）。
- **运行中状态条**：官方 `turn-process` 节点在 `turn/start` 即投影，但官方渲染器在
  回合未结束时返回 null——插件渲染器在此阶段显示 Running Turn Bar（0 秒起、真实
  指标、无折叠行为）。回合结束后同一渲染器切换为完整回合栏，视觉与位置连续。
- **已知问题：运行栏造成的跟随释放（根因未定，插件不打补丁）**：官方那一行在运行中是
  **0px**，插件这里约 **37px**（24px 行 + 1px 分隔线 + 4/8 边距），而且位于回合顶端＝阅读锚点
  **之上**。**观察到的链路**：回合边界的布局变化 → 官方开 500ms 的读者采样窗口
  （`use-chat-viewport` 把 scroll 事件判为 `movedByReader`，其间 `use-chat-reading` 的
  `onResize` 不跟随）→ 下一回合的增长正落在这个窗口里 → 窗口结束用 `nearBottom`（25px）
  重判意图 → 跟随被释放，正在运行的步骤栏就可能停在输入框（滚动容器内的 sticky 座位）
  覆盖带里。**真机证据**：关掉插件这个现象就消失——所以插件自己那 37px 的行高变化
  （0 → ≈37px，位置在回合顶端）**是贡献者之一**；但**根因尚未查清**（官方跟随策略与插件
  布局变化之间的交互没有被完整归因）。**按用户定的规则，插件不加任何补偿/补丁**（不写官方
  滚动位置、不读官方跟随状态、不做 DOM 观察），并由守卫测试把"零滚动写入"钉死
  （`.scrollTop` 写入 0 处、无 `scrollIntoView`/`scrollTo`/`overflow-anchor`、无
  `data-chat-following-tail` / `data-conversation-scroll`、无 ResizeObserver /
  MutationObserver / IntersectionObserver，见 `tests/unit.compat.test.mjs`），以免临时
  workaround 又悄悄长回来。**目前最可疑的线索（不是修复方案）**：插件自己在回合边界的
  **布局变化**——每个新的 `(count, topFace)` 变体都会**追加**一个 220~390 KB 的 `<style>`
  （实测：3 张 ≈218~235 KB、5 张 ≈378 KB，10 个变体 ≈3 MB），且只写一次、**永不重写**；
  此外逐组规则表（`style-step-cards` / `style-step-files`）在内容变化时整表重写。
  （2026-10-13 起 `iconStyle = native` 不再生成这些资产与皮肤表，见上文体积门控；
  但 poker 模式下的体量不变，这条线索照旧成立。）
- **指标读取面（只读官方数据，不重算折叠成员）**：`node.location.turn`
  （`TurnLocation`：start/end/status/reason/steps）+ turn data store（`get('turn-tail')`
  官方聚合 `tokenUsage`、`get('turn-process')` 官方 spec）+ 每 step 的
  `data.get('assistant-step')`（usage / `finalNode.timing`）。快照经 `useChat`
  （SessionStandardProps 合并成员）订阅以驱动重渲染；step data store 与节点可见性
  无关，隐藏纯工具步骤的 usage 不漏计。
- **Step 皮（纯 CSS）**：官方 `ChatGroupSeat` / `ProcessGroupHeader` 原样渲染步骤分组
  与标题；插件 CSS 隐藏 `data-step-process-icon` 的官方图标内容、用 `::before` +
  CSS mask 渲染扑克卡，花色由 `data-process-activity` 值经 `ACTIVITY_SUIT` 映射生成
  （JS 映射 → CSS 规则同源生成）。总闸：`applyIconStyle()` 切换皮肤与牌数桥两张样式表的
  `disabled`（**不写任何 `document.body` 属性**，官方 DOM 一个字节不动）。
  **不用 MutationObserver、不往官方 header 挂 React 根、不自己维护 Step 展开状态。**
- **注册冲突自动让位**：注册前探测同 key 的 `priority: -1` 是否已被占用
  （`ctx.slots.entries`），被占则自动让位到第一个不冲突的值（官方 `0` 恒预留）并
  `console.warn`。
- **注册异常软降级（绝不带崩 DSH）**：slots 注入回调若让异常外泄，延迟执行路径会
  打断官方 UI 激活、web 整页无法启动。因此 slot 注册统一走一个注册管道：inject 声明
  等待与回调内 register 各自兜异常，单个条目注册失败仅跳过该条目，`console.warn`
  留排查线索并弹一次中性措辞的降级 Toast；宿主半边的 skill 注册同样双层防护。
- **设置完全独立**：插件不读、更不写官方 `transcriptView` 字段（源码级架构守卫测试
  锁死）。插件设置存 `localStorage['dsh-turn-fold:settings']`（只有两项：字段显隐、
  统一图标风格——旧的 `foldIcon` / `stepSkin` 双字段在读取层一次性迁移后即删除），
  图标包仍走 `localStorage['dsh-turn-fold:icons']`。
- **多语言跟随**：文案读取 `document.documentElement.lang`（DSH 切换界面语言时由
  `dsh-client-locale` 设置），随 DSH 语言实时切换，浏览器语言仅作回退。

## 注意事项

- 兼容性目标：**DSH 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.2-rc.1 /
  0.2.2-rc.2 / 0.2.2-rc.3 的
  `conversation.chat.node` + `turn-process` owner state 契约**（前三个 LIVE-HOST VERIFIED，
  0.2.1-rc.2 为 CONTRACT-VERIFIED + LOAD/APPLY VERIFIED，0.2.1-rc.3 为 CONTRACT-VERIFIED，
  0.2.2-rc.1 为 CONTRACT-VERIFIED + LOAD/APPLY VERIFIED（Turn Bar 接管待真实模型会话验收），
  0.2.2-rc.2 / 0.2.2-rc.3 为 CONTRACT-VERIFIED（rc.2 叠加式新增 + `context` 词表项已消化，
  rc.3 仅版本号 bump），
  见上文能力矩阵）。
  0.1.7-rc.1 起官方才提供完整契约面（`TurnProcessOwnerProps`、
  `useTurnData` reactive hook、`ChatNodeStore.turnDataSource`——已核对 rc.1 源码）；
  **更早版本不再声明兼容**——
  "安装后自然休眠"不计入兼容，兼容 = 插件核心功能真正工作。DSH 升级若改变上述
  契约，本插件可能需要随版本小改（属插件维护，非改源码）。
- **宿主要求已声明**：`package.json` 的 `engines.dsh` = `>=0.1.7-rc.1`（**仅下限、无上限**；
  2026-10-25 前曾是闭区间、锁到已核验版本——那个时代每个宿主升级都要抬上限并发版，否则
  0.2.1+ 宿主预检会把 bundle 整包跳过，用户升级桌面端后插件"静默消失"）。
  插件市场（dshmarket）仍读 npm `latest` manifest 的这个字段显示宿主要求，并在**更新**前
  拦下确定不满足的版本（现在只有低于 0.1.7-rc.1 的宿主会被拦）。
  **DSH 0.2.1 起宿主自己也会执行该字段**（`app-boot` 的 plugin-compatibility 预检）：
  仅下限的区间对任何未来版本都满足 → bundle 永远通过预检被加载；未验证版本上的不兼容由
  **崩溃隔离**兜底（四层机制见上文 2026-10-25 政策注记）：探测不过 → 零注册（FAIL OPEN）；
  渲染崩溃 → 官方 SlotErrorBoundary 单条目占位；激活失败 → app-boot 逐条目隔离，宿主照常
  启动。契约核对在每次 DSH 升级后照常进行（版本矩阵 = 已验证基线证据表），但**不再作为
  加载门控**——适配节奏从"必须发版"降为"最好核实"。
- **集成依赖清单**（DSH 升级时对照排查；已按 0.1.7-rc.2 `787b746b80` ↔ 0.2.0-rc.2
  `c1b47e41fc` ↔ 0.2.1-rc.2 `d1b9c04067` ↔ 0.2.1-rc.3 `1f81c047fc` ↔ 0.2.2-rc.1 `66491b05e3`
  ↔ 0.2.2-rc.2 `ddac96760b` ↔ 0.2.2-rc.3 `38a6a5c965`
  逐契约 diff 审计：Public/stable 契约在七个 release 间保持不变；0.2.1 只新增 `interrupted`
  停止语义、group-tree 分组位置与 `engines.dsh` 强制检查，rc.3 仅抬版本号与 `engines.dsh` 上限，
  0.2.2 只新增 `conversation.chat.text-interaction` / `conversation.chat.user.before` slot、
  package-asset 路由与 `foldedReplies` 设置，并移除 `ChatNodeOwnerProps.fileMentions` /
  `compactAnswer` / `data-turn-process-answer`（插件均未使用），
  0.2.2-rc.2 再叠加 `conversation.chat.markdown.fence` slot / `consumeOlder` /
  `conversation.hero.frame` 包裹层 / composer 粘贴路由 / `sessionHeader` 菜单，并把
  ProcessActivity 词表扩了 `context`（全-Context 组；插件花色映射已补 context→spade），
  0.2.2-rc.3 仅各 package.json 版本号 bump，
  均已被插件消化或属于宿主行为）：
  - **Cordis activation**：`exports.inject = ["slots"]` + `ctx.inject(["slots"], …)`
    （客户端 slots 服务与 keyed slot 注册语义，官方 `boot-client` 未变）；
  - **Public/stable**：`conversation.chat.node` keyed slot（`turn-process` key +
    owner state `TurnProcessOwnerProps`）；`TurnLocation`（start/end/status/steps）、
    step data store（`assistant-step` usage/timing）、turn data store
    （`turn-tail` / `turn-process`）——均来自官方 `dsh-client-ui-chat` /
    `dsh-client-ui-conversation` 契约；
  - **Soft visual dependency**：`data-step-process-icon` / `data-step-process-chevron`
    / `data-process-activity` + 其 `aria-expanded="true"`（仅 Step 皮：第一个是卡牌渲染位、
    第二个是 Poker 皮要隐掉的官方箭头、后两者决定展开态是否呈扇形；失效 = 皮消失或退化为
    收起态，官方图标与折叠原样保留）；
  - **Soft visual dependency（运行态，双契约）**：官方 `TextShimmer` 渲染的
    shimmer 属性（`ChatGroupSeat` 标题在 `!data.closed` 时携带）。属性名随官方
    版本演进，两个都是官方真实历史契约（源码证据）：
    - DSH 0.1.7（release commit `787b746b807df83776957875683b8853c862ca2c`，
      `TextShimmer.tsx`：`data-text-shimmer={active || undefined}`）→
      `data-text-shimmer="true"`；
    - DSH 0.2.0+（master，`TextShimmer.tsx`：`data-shimmer={active || undefined}`）→
      `data-shimmer="true"`。
    插件同时兼容两者，任一存在 → Running Step Poker 动画（`:has()` 命中即把卡牌
    mask 换成**五牌面轮换 SVG**——♠ ♥ ♦ ♣ + DeepSeek 五张地位相同的
    牌面、每 0.8s 一次轮换、4s 完整循环、动态蒙版挖空下层牌；**收起态正立，展开态
    （同一按钮 `aria-expanded="true"`）才把整套动画绕图标中心旋转 35.5°**）；
    两者都不存在 → completed 双态静态回落（收起五张牌堆 / 展开扇形）。**仅用于运行中 Step 的
    扑克轮换动画识别**；官方回合结束属性消失 → 动画规则不再命中 → 自动回落，
    交接零 JS。无论视觉钩子是否失效，都不影响 Step Fold / Tool / Think /
    Turn Fold 与页面稳定性；
  - **Soft style injection（非理想软兼容点，已如实记录）**：插件向 `document.head`
    注入最小 `<style>`：基础样式 + Step 皮 + 牌数桥逐组规则 + 逐组牌面资产（每个
    `(count, topFace)` 变体一个元素，只写一次）+ 步骤文件清单逐组规则（独立元素，
    与皮肤总闸解耦）+ Legacy Step 表（旧宿主兼容层）。截至当前 DSH master（21638c5631）
    官方没有给 plain-JS client plugin 提供样式注册 API（全宿主唯一 `createElement('style')`
    在 web 自身代码里），而 Step 皮必须作用在官方 Header 的官方 DOM 上、无法收敛进
    插件 React 子树——故保留此软兼容点。注入失败的最坏退化 = 无 Turn 栏样式与无
    Step 皮，官方折叠行为不受影响（每个注入点各自兜异常，见 `unit.compat.test.mjs`
    的「样式注入失败不得带崩插件激活」）；宿主未来提供样式注册面时迁移。
    `iconStyle = native` 时皮肤表与逐组牌面资产**根本不生成**（只保留空元素占位与
    `disabled` 总闸），切回 poker 惰性补齐。
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
