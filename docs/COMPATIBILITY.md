# 兼容性架构（工程附录）

> 本文是 [README](../README.md) 的工程细节附录：宿主能力探测、Legacy 兼容层、逐版本能力矩阵与真机验收记录。日常安装与使用只看 README 即可。

## 兼容性架构（Compatibility Architecture）

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
| 0.2.1-rc.2 | modern | 新形状 | modern | reactive | official（宿主开始用 `engines.dsh` 拦截不兼容 bundle；`interrupted` 与 aborted 同为停止语义） |
| 0.2.1-rc.3 | modern | 新形状 | modern | reactive | official（`ui-chat` 客户端契约与 0.2.1-rc.2 逐字一致；仅 `engines.dsh` 上限抬到 rc.3） |
| 0.2.2-rc.1 | modern | 新形状 | modern | reactive | official（客户端契约面与 0.2.1 同形；0.2.2 只叠加 `conversation.chat.text-interaction` / `chat.user.before` slot、package-asset 路由与 `foldedReplies` 设置（默认保留全部回复），并移除插件未用的 `fileMentions` / `compactAnswer` / `data-turn-process-answer`） |
| 0.2.2-rc.2 | modern | 新形状 | modern | reactive | official（仍为叠加式：新增 `conversation.chat.markdown.fence` slot / `consumeOlder` 分页消费 / `conversation.hero.frame` 包裹层 / composer 粘贴路由 / `sessionHeader` 菜单；ProcessActivity 词表新增 `context`（全-Context 组，running 永不取该值）——插件花色映射已补 context→spade；Step DOM 钩子 / 会话锚点 / owner state / TextShimmer 逐字未变） |
| 0.2.2-rc.3 | modern | 新形状 | modern | reactive | official（ui-chat / ui-conversation / boot 源码零变更，仅各 package.json 版本号 bump；契约面与 0.2.2-rc.2 完全同形） |

### Live-host acceptance：已真机验收的版本（2026-10-06，RELEASE GATE PASSED）

对**当时 `engines.dsh` 声明的三个版本**做真机验收：官方 npm 发布包 + 隔离 `DSH_HOME`/profile +
官方 `dsh plugin --profile web add <path>` 装载（profile `dsh.profile.bundles` + link），
真实 provider、真实模型会话（含工具调用的 Turn 与纯问答 Turn 各一条），并用插桩副本读取插件内部
状态（同一份 `client.js` + 只读 console/`__test` 桥，不改变插件行为）。

| 版本 | 宿主启动 | 插件装载 | capability 最终值 | Turn Bar 接管 | running/completed | Step Bar + Poker | 折叠切换 | 纯问答 | reload/历史 | React 警告 | 未捕获异常 | ownership loss | 证据等级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.7-rc.1 | ✅ npm 发布包 | ✅ | modern / modern / reactive | ✅（running 实时指标 + completed 默认收起） | ✅ | ✅（Step Bar + 图标锚点，折叠正交） | ✅（展开 12→1 隐藏，再收起复原） | ✅（静态栏 + 真实指标） | ✅（重载后 3 根栏重建、零重复注册） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |
| 0.1.7-rc.2 | ✅ npm 发布包 | ✅ | modern / modern / reactive（sessionScope=official） | ✅ | ✅ | ✅（3 个 Step Bar） | ✅（16→3→16 隐藏成员） | ✅ | ✅（2 根栏重建） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |
| 0.2.0-rc.2 | ✅ npm 发布包 | ✅ | modern / modern / reactive | ✅ | ✅ | ✅（4 个 Step Bar + Poker 图标） | ✅（10→0→10 隐藏成员） | ✅ | ✅（3 根栏重建） | 0 | 0 | 0 | **LIVE-HOST VERIFIED** |

> **2026-10-17：`engines.dsh` 上限抬到 0.2.1-rc.2。** 0.2.1 的结论来自 release commit
> `d1b9c04067` 的逐契约源码核对 + 版本矩阵/契约测试（`npm test` 全绿），并在本机用
> **源码构建的 0.2.1-rc.2 宿主 + 隔离 `DSH_HOME`/profile** 实测：插件 client bundle 被编入
> 启动图，页面里 4 个插件样式元素全部注入（base 7.6KB / skin 535KB，均 enabled）——
> 即 **LOAD + APPLY VERIFIED**。Turn Bar 接管需要真实模型会话，本轮未观测，因此 0.2.1 行
> 仍不记 LIVE-HOST VERIFIED（证据等级：LOAD+APPLY VERIFIED / TURN TAKEOVER PENDING）。
> 0.2.1 与 0.2.0 的插件集成面差异：`turnProcessAlwaysOpen` 增加 `interrupted`（插件已同步为
> "已停止 + 不可折叠"）；官方分组改由 group-tree 位置驱动（插件只读 group snapshot 与 DOM
> 钩子，不参与分组）；宿主开始执行 `engines.dsh` 拦截（区间不覆盖运行时 → bundle 被跳过）。

> **2026-10-25：`engines.dsh` 上限抬到 0.2.1-rc.3。** 依据 `git diff
> dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.3 -- packages/client/ui-chat/src/client` 为空
> （仅 `ui-chat/package.json` 版本号变化），插件消费的 Public/stable 契约与 rc.2 逐字一致；
> 版本矩阵与源码契约测试加入 rc.3 基线（commit `1f81c047fc`），`npm test` 全绿。
> 证据等级：CONTRACT-VERIFIED；LOAD/APPLY 待重启桌面端后复核。

> **2026-10-25（同日第二项）：`engines.dsh` 改为仅下限（无上限）。** 闭环区间时代（每个新
> 宿主 prerelease 都要抬上限并发版，否则 0.2.1+ 宿主预检整包跳过、插件"静默消失"）到此为止。
> 依据是"插件崩溃绝不影响宿主"已有四层兜底：① 宿主 `app-boot` 逐条目激活隔离（插件激活失败
> 只是一条 `did not activate` 警告，宿主照常启动）；② 宿主 `ui-renderer` 的 SlotErrorBoundary
> 逐条目渲染隔离（插件 renderer 崩溃只在原位渲染 `data-slot-error` 占位符，兄弟条目与会话树
> 存活）；③ 插件注册事务 FAIL OPEN（预检失败整体不装，官方 priority-0 renderer 保持 owner）；
> ④ 插件全部宿主通知回调（`ctx.on("slots/changed")` / `slots.onEntryError` / `slots.subscribe`）
> 经 `guardedHostListener` 统一 try/catch 包装，抛错不逃逸进宿主 dispatch。未验证宿主版本的
> 最坏行为 = 插件零注册（FAIL OPEN）或单个 slot 占位符；控制台 `[dsh-turn-fold]` 的
> probing/resolved 信息行与降级警告是诊断线索。此后 DSH 升级不再需要抬上限发版才能加载；
> 契约核对照常进行（本矩阵 = 已验证基线的证据表），只是不再作为加载门控。

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

### 历史验收记录：首轮真机矩阵（2026-10-05，0.1.1 ~ 0.2.0-rc.2）

> 本节是**那一轮**的原始记录（行内结论按当时状态保留）。其中 0.1.7-rc.1 / 0.1.7-rc.2 /
> 0.2.0-rc.2 三行**已被 2026-10-06 的「Live-host acceptance：已真机验收的版本」取代**——三者现在
> 都是 LIVE-HOST VERIFIED，含 0.2.0-rc.2 的 Turn Bar 接管（下表那句 INCONCLUSIVE 只描述
> 那一轮的观测中断）。0.1.1 ~ 0.1.6 仍**不在当前 `engines.dsh` 声明范围内**，各自有独立阻塞项
> （详见下文）。

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

因此本轮（2026-10-05）**没有放开 `engines.dsh`**：0.1.1 的 live 结论是失败，0.1.2/0.1.5 连官方
runtime 都起不来，0.1.6+ 未真机验证。当时区间保持 `>=0.1.7-rc.1 <=0.2.0-rc.2`
（2026-10-17 上限已按 0.2.1-rc.2 契约核对结果抬到 `<=0.2.1-rc.2`；
2026-10-25 再按 0.2.1-rc.3 的客户端契约核对结果抬到 `<=0.2.1-rc.3`）。

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

当前 `engines.dsh = ">=0.1.7-rc.1"`——**仅下限、无上限**（2026-10-25 起，政策见上文注记）。
已验证基线：0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 三个版本**已 LIVE-HOST VERIFIED**
（见上文「Live-host acceptance：已真机验收的版本」）；
0.2.1-rc.2 已按 release commit `d1b9c04067` 逐契约核对并纳入版本矩阵，证据等级为
**CONTRACT-VERIFIED + LOAD/APPLY VERIFIED**（Turn Bar 接管待真实会话验收）。
0.2.1-rc.3 按 release commit `1f81c047fc` 核对：`ui-chat` 客户端契约与 rc.2 逐字一致，
证据等级 **CONTRACT-VERIFIED**（LOAD/APPLY 待重启桌面端复核）。
0.2.2-rc.1 按 release commit `66491b05e3` 核对：客户端契约面（slots / owner state / Step DOM 钩子 /
TextShimmer）与 0.2.1 逐字同形，证据等级 **CONTRACT-VERIFIED + LOAD/APPLY VERIFIED**
（源码构建 0.2.2-rc.1 宿主 + 隔离 profile 实跑：插件 bundle 编入 boot 图、注入四张样式表、
`turn=modern` 注册成功、零异常；Turn Bar 视觉接管仍待真实模型会话）。
0.2.2-rc.2 按 release commit `ddac96760b` 核对：仍为叠加式（`conversation.chat.markdown.fence`
slot、`consumeOlder` 分页消费、`conversation.hero.frame` 包裹层与 composer 粘贴路由、
`sessionHeader` 菜单），唯一词表级变化是 ProcessActivity 新增 `context`（全-Context 组）——
插件花色映射已补 context→spade，证据等级 **CONTRACT-VERIFIED**（LOAD/APPLY 待重启桌面端复核）。
0.2.2-rc.3 按 release commit `38a6a5c965` 核对：ui-chat / ui-conversation / boot 源码零变更
（仅版本号 bump），契约面与 rc.2 完全同形，证据等级 **CONTRACT-VERIFIED**。
**上限不设**：未验证的未来宿主版本由运行时探测降级兜底——注册期三态探测 + 安装事务
FAIL OPEN + 宿主 app-boot 逐条目激活隔离 + 官方 SlotErrorBoundary 逐条目渲染隔离 +
宿主通知回调统一 try/catch 包装；最坏行为 = 插件零注册或单个 slot 占位符，不影响宿主本身。
**下限不放开**：0.1.1-rc.2 的 Full Legacy Node Backend（Turn + Step 双语义）与 0.1.2 ~ 0.1.6 的
Official Turn + Legacy Step 都必须等真实旧宿主矩阵通过后才会放开 `engines.dsh`——0.1.1 的真机
结论是**失败**（3 键 backend 安装后自行 teardown，折叠未生效），0.1.2 / 0.1.5 连官方 npm
runtime 都起不来（`hmr.registerConfig` 阻塞），0.1.6 仍走 hybrid（同一 blocker）；这三档目前
只有 source-audited / contract-harness verified。

