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
  [翻牌动画] 耗时0秒 · 第13轮                              ← 0 秒即出现，纯状态条
  ────────────────────────────────────────
  [官方过程内容逐条加载…（官方 liveProcess 语义，始终展开）]

  [翻牌动画] 耗时13秒 · 首字0.8s · 3,214 token · 247tok/s   ← 真实数据到达即更新
  ────────────────────────────────────────

回合结束（默认收起，点击展开）：
  [牌堆/扇形] 耗时22分34秒 · 首字4.9s · 370,202 token · 2.4tok/s · 缓存93.99%   第13轮
  ────────────────────────────────────────
  [最终总结正文（官方渲染）]

失败/中止：
  [牌堆] 运行失败 · 48秒 · 7,812 token · 28tok/s           第13轮
  [牌堆] 已停止 · 21秒 · 3,201 token                        第13轮
```

- **指标来源（全部官方真实数据）**：
  - 耗时：`TurnLocation.start.time → end.time`（运行中用实时时钟补足）；
  - 首字（TTFT）：第一个请求 settle 后读官方 `finalNode.timing`
    （`firstTokenTime - stepStartTime`，与官方统计同款语义）；
  - Token / 缓存命中：回合结束后优先 turn-tail 的官方聚合 `tokenUsage`
    （`deriveTurnTokenUsage` 折叠全部计费 attempt，含被重试请求；缓存分母 = prompt 侧
    总量），运行中/缺失时按 step usage 累加（官方 step data store 与节点可见性无关，
    隐藏纯工具步骤同样计入）；
  - tok/s：真实输出 token / 真实耗时（耗时 ≥1s 才显示，避免开场瞬时速率）。
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

- **牌身透明**的扑克卡（CSS mask，当前色描边 + 花色点，壁纸可透出）替换官方活动图标；
- 花色按官方 `data-process-activity` 值映射（`ACTIVITY_SUIT` 单一数据源生成 CSS）：
  thinking/questions → ♥，read/readImage/search/webSearch/webFetch → ♠，
  edit/write → ♦，commands/code → ♣，subagents/plan/tools → 🐋鲸鱼（DeepSeek Logo）；
  未登记活动回退 ♥；
- **运行态动态翻牌**：运行中的 Step（官方标题带 shimmer，即
  `data-text-shimmer="true"`）改为**循环翻牌**——♠→♥→♦→♣→🐋 每 0.8s 在牌侧面
  （scaleX=0）瞬间换花色、4s 一轮；回合结束自动定格为该 Step activity 的静态花色
  （edit → ♦、thinking → ♥……），全程纯 CSS、零 JS 状态。系统「减少动态效果」
  开启时运行中直接显示静态牌；
- **软依赖**：全部选择器挂在官方 DOM 钩子上，总闸 = 皮肤 `<style>` 元素的
  `disabled` 属性（插件不写任何 `document.body` 全局状态）——DSH 改掉钩子时
  **最坏退化 = 皮消失、官方图标原样显示**，官方折叠行为不受任何影响。
  运行态识别额外依赖官方 `data-text-shimmer`（见集成依赖清单），失效时运行中
  Step 自动退化为静态 Poker。

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
- **宿主要求已声明**：`package.json` 的 `engines.dsh` = `>=0.1.7-rc.1 <=0.1.7-rc.2`
  —— 插件市场（dshmarket）读 npm `latest` manifest 的这个字段，在插件卡片上显示
  宿主要求，并在**更新**前拦下确定不满足的版本（DSH 本体不读该字段，不影响加载）。
  区间是**闭区间**、锁到已核验的宿主版本：每次 DSH 升级后重新核对契约，再抬上限
  并随新版本发布。
- **集成依赖清单**（DSH 升级时对照排查）：
  - **Public/stable**：`conversation.chat.node` keyed slot（`turn-process` key +
    owner state `TurnProcessOwnerProps`）；`TurnLocation`（start/end/status/steps）、
    step data store（`assistant-step` usage/timing）、turn data store
    （`turn-tail` / `turn-process`）——均来自官方 `dsh-client-ui-chat` /
    `dsh-client-ui-conversation` 契约；
  - **Soft visual dependency**：`data-step-process-icon` / `data-process-activity`
    （仅 Step 皮；失效 = 皮消失，官方图标与折叠原样保留）；
  - **Soft visual dependency（运行态）**：官方 `TextShimmer` 渲染的
    `data-text-shimmer="true"`（`ChatGroupSeat` 标题在 `!data.closed` 时携带）。
    **仅用于运行中 Step 的扑克翻牌动画识别**——运行态 = `:has([data-text-shimmer="true"])`
    时叠加纯 CSS 翻牌（♠→♥→♦→♣→🐋 每 0.8s 侧面换牌，4s 一轮）；官方回合结束属性
    消失 → 动画规则不再命中 → 自动回落该 Step activity 对应的静态花色牌，交接零 JS。
    钩子失效的最坏退化 = 运行中 Step 显示静态 Poker，不影响 Fold 行为；
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
  - 运行中首字（TTFT）仅在第一个请求 settle 后显示官方 timing 值（渲染时刻近似已删除）。
