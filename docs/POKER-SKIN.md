# Step 扑克牌皮与图标细节（工程附录）

> 本文是 [README](../README.md) 的工程细节附录：Step 换装、运行态轮换、牌面分配与图标数据源。

## Step 扑克牌皮

官方步骤分组栏（含官方标题语义「正在读取…」「已读取 3 个文件」「正在思考…」、官方
shimmer、官方分页与搜索显隐）原样工作，插件只换装：

- **牌身透明**的扑克卡（CSS mask，当前色描边 + 花色点，壁纸可透出）替换官方活动图标，
  牌尺寸与 Turn 栏扑克图标**同一设计语言**：图案画布 24×24、16 视箱 mask 按 24px 渲染
  （1.5px/单位）→ 牌外缘 ≈9.62×13.05px、描边 1.05px；**两侧都把这张 24px 画布放进官方
  16×16 的 leading 盒子里居中溢出**（Turn 栏的 `.ccg-poker-icon` 就是 16×16，与官方
  `.leading` 同尺寸）⇒ 墨迹左缩进 1.3px、与文字间隙 6(gap)+1.3 = 7.3px，两条栏**在默认内容
  字号下**逐像素同款。**边界（如实记录）**：官方 `.leading` 是
  `calc(16px + var(--dsh-content-font-delta, 0px))`，内容字号被放大时它会跟着变宽；插件的
  `.ccg-poker-icon` 与栏文字都是定值（16px / 14px），不随字号放大，此时两侧不再逐像素相等
  （曾用 24px 盒子：墨迹居中后左右各空 5.3px，Turn 栏字距比 Step 栏宽 4px、牌也右移 4px）；
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
  （展开态才平面旋转 35.5°），既不消耗 bag 也不产出覆盖规则；分配只在组第一次渲染（CSS 规则生成）时发生，之后重渲染 / 开合 /
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
  取舍——最多 3 个；预算**按内容区宽度自适应**（`stepFilesBudgetPx()` =
  `clamp(内容宽 − 300px, 150px, 380px)`，那 300px 是给标签/图标/齿轮留的位置）。内容宽是
  **实测**出来的：取官方内容列里一行的 `clientWidth`（`[data-chat-group-key]` 组根，有会话
  锚点时按会话限定，宽度 0 的隐藏/未布局行跳过）——官方 `--dsh-chat-content-width` 声明在
  会话内容元素上（不是 `:root`，自定义属性也不会向上继承），而且它的计算值是 `var()/clamp()`
  文本、`parseFloat` 读不出数值，所以不作数值源；一次也量不到才回落到视口估算
  （`window.innerWidth − 312`，下限 320，最后 680）；窗口 resize 与组条目列表变化时重量一次。
  名字再按**等效 ASCII 字符**折算（ASCII 记 1、中文/全角记 2.4 ≈ 1em/6px）⇒ 宽窗口约 63 字符
  （吃满 380px），窄窗口夹在 `STEP_FILES_MIN_PX`（150px ≈ 25 个等效 ASCII 字符；旧版的固定
  回落常量 `STEP_FILES_BUDGET`（32 字符 ≈ 192px）已删除）。放不下的名字整条折成 ` +N`，
  ` +N` 自己也要挤进预算；
  **只有第一个名字例外**：为了"至少留一个名字，否则这段就没信息了"，它无条件显示，所以它自身
  可能超过预算，这时若宽于 `max-width` 就会被省略号截断——这是**已知边界**。写进 CSS 的
  `max-width` 与数据层用的是**同一个像素值**（早期用固定 44ch 兜底：口径不同，而且在宽窗口下
  白白浪费一半空间——实测 680px 的行里旧规则只用掉 130~167px、右侧空着 231~468px）；正常
  （名字都放得下）不触发 CSS 截断，也不会出现早先那种 `ChatGroup…` 残片；
  `glob/grep/find/ls` 这类目录型工具的 `path` 是搜索根、不当文件名
  （`file_path` 恒采信）；目录（以分隔符结尾）与 `url` 不算文件；运行中与已完成都显示
  （运行中随官方工具数据变化累积，`turnDataSource(turn,'tool-call')` 只作刷新触发器），
  条目消失/会话卸载即撤下规则。独立样式表 `style-step-files`，**不随 iconStyle 启停**
  （信息不是皮肤，native 模式同样显示）；旧宿主（0.1.2~0.1.6 legacy 面）不产出；**已知边界
  （如实记录）**：只读组的**顶层**成员节点——PTC 子调用（`ToolCallBlock.subCalls`）里才出现的
  文件不进清单；
- 花色按官方 `data-process-activity` 值映射（`ACTIVITY_SUIT` 单一数据源生成 CSS）：
  thinking/questions → ♥，read/readImage/search/webSearch/webFetch → ♠，
  edit/write → ♦，commands/code → ♣，subagents/plan/tools → 🐋鲸鱼（DeepSeek Logo）；
  未登记活动回退 ♥（该映射现在主要作为 reduced-motion 的运行态回落）；
- **运行态牌面轮换 · 展开时平面旋转 35.5°**（**不是**回合栏运行中那套竖直对角线轴翻牌——
  两者刻意不同）：运行中的 Step（官方标题带 shimmer。Soft running-state
  dependencies——DSH 0.1.7 输出 `data-text-shimmer`、DSH 0.2.0+ 输出 `data-shimmer`，
  两者都是官方真实历史契约，插件同时兼容）保持**五牌面轮换**本体
  （♠ ♥ ♦ ♣ + DeepSeek 鲸鱼五张地位相同的牌面，无正/背面）。**倾斜只在「运行中 + 展开」**：
  收起态是**正立**轮换（不加旋转包装），展开态才把整套可见动画（卡牌、花色、以及它们
  引用的 mask）**绕图标中心整体旋转 35.5°**。自运行 SVG（SMIL）作为卡牌的 CSS mask，
  牌线颜色仍由 `currentColor` 跟随主题：
  - **状态事实** = 官方组头按钮的 `aria-expanded="true"`（官方 `ChatGroupSeat` 恒渲染
    `aria-expanded={open}`，插件 Legacy Header 也主动渲染同一钩子；与 completed 展开扇形
    同一个官方事实）。运行中收起 → 正立；运行中展开 → 倾斜。插件零 JS 判定，纯 CSS cascade；
  - **两份资产**：展开态用生成块（带旋转包装）的 data URI；收起态用**运行时从生成块摘掉
    最外层 `<g class="tf-step-flat-rotation" …>` 包装**派生的正立 SVG。两者动画本体逐字节
    相同（守卫断言「只差最外层包装」），不存在第二套关键帧。代价：两份 data URI 各自一条
    SMIL 时间线，开合切换会从相位 0 重新开始（切换本身是用户操作，可接受）；
  - **设计源** = 参考实现 `docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html`：动画本体取自
    **第三行**（`── 第三行：五牌面轮换动画 ──`）的 `const ANIM_SVG`，再加上 `svg3dRotated()`
    那一步（在 `</defs>` 之后插入 `<g class="anim-root-rotation" transform="rotate(angle 8 8)">`，
    参考稿注释原文：「在不改动动画关键帧的前提下，把整套可见动画绕 16×16 画布中心旋转。
    defs 保持原坐标；外层 transform 会让卡牌、花色以及引用的 mask 一起旋转。」）；而 **35.5°
    这个目标角与设计标签本身来自第五行**——`── 第五行：两个"点击切换型"动画 ──` 的点击切换
    变体（「牌面轮换 · 平面旋转 35.5°」/ `const target = toward35 ? 35.5 : 0`；第三行自己的
    预览按 `ANIM_ANGLES = [0, 30, 45, 60, 90]` 渲染，不带 35.5 字面量）；
  - **旋转角** = `icons/default.json → pokerSpin.restAngle`（≈35.5377° = `atan(w/h)`，
    与回合栏轴角同一数据源）；生成脚本断言它四舍五入到 1 位小数 == 参考稿第五行那条变体的
    字面量 **35.5**，设计值与数据源任一边漂移即生成失败；
  - **生成** = `npm run sync:step-anim` 写入 `client.js` 的
    `>>> step-running-poker-svg` 标记块。脚本断言的是**接线与结构**：参考稿第三行的动画本体与
    平面旋转接线仍在（`const ANIM_SVG` / `svg3dRotated` / `anim-root-rotation` /
    `rotate(' + angle + ' 8 8)`）、第五行的 35.5 字面量仍在，旋转组真的包住全部相位、产物不含
    第四/五行轴旋转时代的禁用标识，并把产物计数**打到 stdout**。**5 组相位 / 72 个
    animateTransform / 15 个 animate / `0.8s`×82 / `4s`×5 这些计数不变量由
    `tests/unit.css.test.mjs` 的「平面旋转契约」断言**（即「只加旋转、不动关键帧」）——
    脚本不是这些数字的 pre-commit 守卫；
  - **结构** = 五牌面轮换（每 0.8s 一组：两张完整平面牌对角轻微错开再合拢，唯一的 rotate 是
    ±3.1° 二维平面小角度；中途 `discrete` 在中点换层；四个动态 luminance 蒙版把下层牌与
    上层牌重叠处的线条挖空；五组相位连成 4s 完整循环：
    diamond → club → spade → heart → deepseek →（回到 diamond））；
    **展开态外面套一层** `<g class="tf-step-flat-rotation" transform="rotate(35.5377 8 8)">`，
    收起态由同一份本体摘掉这层包装得到；
  - **边界（如实记录）**：本 SVG 是构建期烘焙进 `client.js` 的，运行时 localStorage
    图标包覆盖不改写它（覆盖只作用于回合栏翻牌与运行时生成的 completed 双态牌面）——
    与改动前的实现同性质；
  - 运行态与牌数无关（本组只有一个工具也照轮换）；回合结束 shimmer 消失 → 自动回落
    completed 双态（按本组工具数的 3/5 张收起牌堆 / 展开扇形），全程纯 CSS cascade、
    零 JS 运行态。系统「减少动态效果」开启时运行态直接显示静态花色牌（倾斜也一并关闭）；
  - 旋转角只由 SVG 的 `transform` 属性决定：**CSS 不得再写 transform 覆盖它**
    （CSS transform 会压掉同名属性，回合栏踩过这个坑；收起/展开两份资产同理）。步骤侧旋转组类名
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


## 扑克模式细节（iconStyle = poker）

- **native 模式几何**：Turn 前导 chevron 逐值对齐官方
  `IconChevronDownOutlineRegular`（viewBox 16、stroke 1、size 14），收起向下、展开
  `rotate(180deg)` 向上；Step 侧停用两张皮肤样式表，官方 `ProcessGroupHeader` 的 DOM 不动。

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
- **数据源**：`icons/default.json`（花色路径、卡牌几何、扇形/牌堆变换表、`pokerSpin` 语义旋钮
  `restAngle` / `strokeW` / `frames` / `flipMs`），改完 `npm run sync:icons` 注入、
  `npm run icons:check` 校验。**关键帧不存数据源**：`scaleX = cos(2πk/frames)` 是公式
  （`frames: 72` = 5°/步，与历史字面量表逐字节相同，有守卫锁死）；数据源里不放"没人读的值"
  ——旧 `scaleKeys`/`scaleKeyTimes`（73 个值、运行时零读取）与 `pokerAnimSVG`（54 KB 快照、
  零消费者）已删除，client.js 因此瘦了 ~59 KB；
- **步骤栏运行中轮换（展开态平面旋转 35.5°，收起态正立）**是**构建期**产物（`npm run sync:step-anim` 由参考稿
  第三行动画本体 + 第五行的 35.5° 设计标签生成、旋转角取上面的数据源 `pokerSpin.restAngle`，
  见「Step 运行态」一节；收起态正立版由运行时摘掉旋转包装派生）：脚本**只读 `pokerSpin.restAngle`**（外加参考稿 HTML）——改
  `pokerPips` / `pokerSpinDeepseek` **不需要**重跑它；改了 `restAngle` 忘了重跑，运行中旋转角
  仍是旧值（`npm test` 的生成块守卫会先失败）。
- **图标包（`localStorage['dsh-turn-fold:icons']`）的覆盖面**（不对称是设计，不是 bug）。
  ⚠️ `iconConfig` 只在**模块初始化时读一次**（没有 storage 监听），所以**表内每一行的覆盖
  都要刷新页面才生效**——不只是 Step 组头皮那一行：

  | 覆盖 | 不覆盖 |
  | --- | --- |
  | 回合栏运行中翻牌 + 完成态牌堆/扇形牌面 | **Step 运行中五牌面轮换**（构建期 `npm run sync:step-anim` 从设计稿烘焙进 client.js，改图标包无效） |
  | 设置弹窗的牌面预览 | 官方 chevron 风格（`iconStyle = native`，不属于数据源） |
  | **Step 组头皮**（卡牌尺寸/蒙版/花色映射：插件激活时 `buildStepSkinCss` 读**实时** `iconConfig` 生成） | — |
  | 几何/时序旋钮（`restAngle`/`strokeW`/`frames`/`flipMs`/`pokerPips`/牌堆扇形表） | — |

  改回来：`localStorage.removeItem('dsh-turn-fold:icons')`（同样刷新后生效）。
  包**缺字段不再炸**：`pokerPips` 缺哪个花色就逐花色回退内置默认（缺字段的包此前会在
  渲染期抛错，而 Turn 栏没有错误边界）；但**缺 `pokerSpinDeepseek` 是有效语义**
  （= 无鲸鱼牌面，退化为四花色池），不会被默认值补回来。
- **`iconStyle = native` 的体积门控**：皮肤 CSS（实测约 522 KB）与逐组牌面资产
  （最多 10 个变体、合计约 2.9 MB）只在 poker 模式生成——native 用户不为它们付解析与
  常驻内存；切回 poker 由 `applyIconStyle()` 惰性补齐（幂等，来回切换不会重复注入）。

