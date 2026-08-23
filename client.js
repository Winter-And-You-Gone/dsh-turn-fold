// dsh-turn-fold: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。只负责折叠。
//
// 行为：
//   1. 段级分组自动折叠：两个 text 之间的所有工具调用和纯 Think 收成一个段级组头，
//      默认折叠（运行中也不例外）。段未闭合（下一个 text 还没出现）时组头动态显示
//      "正在运行 Xxx · 参数摘要 / 正在思考 · 内容"；下一个 text 出现后变为
//      "运行了 N 条命令"（think 不算命令数）。
//   2. 大组头在 agent 回复开始就出现（运行中默认展开，回复在其下逐条加载），
//      组头实时显示本轮耗时/token/tok/s/缓存命中率——直播指标按随机间隔刷新
//      （CONFIG.liveTickMs × 随机数 0.5~1，默认 125~250ms）：耗时秒数走动、tok/s
//      按已输出 token 实时估算；真实 usage 只在请求完成时到达，"消耗token"在两次
//      到达之间按固定动画节奏持续增长（+1/+11 交替：个位每 tick +1、十位每 2 tick
//      +1，tick 间隔随机、节奏不规律），真实值到达时只校正基线（数字只增不减）；
//      数值变化带"滚轮/里程表"式逐位滚动动画（每位数字独立滚动，变化快时用短动画、
//      慢速变化用 350ms 回弹缓动）；组头下方常驻一条水平分隔线（收起/展开都显示）。
//   3. 回合结束后，整回合（所有 Think + 工具调用 + 上下文注入）收成一个大组头并
//      默认收起，只保留最终总结正文；非正常结束的回合带状态标签（已停止 / 已中断）。
//   4. 点击组头可手动展开/折叠；展开带平滑过渡动画（高度展开 + 淡入 + 微位移，280ms），
//      收起带收缩动画（200ms）后卸载内容；尊重 prefers-reduced-motion。
//   5. 界面文案自动适配中英文（navigator.language(s) 含 zh 即中文），
//      组头带 aria-label / aria-expanded，键盘可操作（Enter / Space）。
//
// 实现方式：
//   - 用 priority:-1 覆盖（shadow）内置的 conversation.chat.node 渲染器：
//       key "tool-call"        -> 段级分组 + 自动折叠
//       key "assistant-step"   -> 段级分组（纯 Think）+ 整回合折叠（Think/最终消息）
//       key "context"          -> 整回合折叠（上下文注入）
//   - 通过 ctx.slots.entries() 取到内置组件引用做"委托渲染"（展开时原样转发，
//     工具卡片内容/样式与内置一致）。因为我们的 entry 没声明 children 收不到
//     renderSlot，而内置 ToolCallTree 需要它来分发 tool.call.toolview 子视图，
//     所以这里用 slotsService.entriesOfSlot() 自行实现这个 keyed 分发。
//   - Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})。
// 纯浏览器 bundle：仅在 window 存在时注册。host（Node）进程若误导入本文件
// 应静默跳过，而不是抛 ReferenceError 拖垮整个插件树。
if (typeof window !== "undefined" && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
	id: "dsh-turn-fold",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ---- 可调配置 ----
		var CONFIG = {
			// 组头文案："运行了 N 条命令"；组内有失败命令时追加"——M条执行失败"
			headerPrefix: "运行了",
			headerSuffix: "条命令",
			failureSuffix: "条执行失败",
			// 运行中大组头直播指标的刷新间隔基准（毫秒）：耗时秒数、"消耗token"增长
			// 动画都按此频率刷新。"消耗token"在真实 usage 之间按固定节奏增长——偏移
			// 按 +1/+11 交替循环推进（个位每 tick +1、十位每 2 tick +1），营造
			// "一直在消耗"的观感；真实 usage 到达时只校正基线、偏移不回退。
			// 调小更"活跃"（渲染更频繁），调大更省资源。
			liveTickMs: 250,
			// 刷新间隔抖动比例：实际间隔 = liveTickMs × 随机数（liveTickJitter ~ 1），
			// 让数字跳动节奏不规律（时快时慢），更像真实的生成速率而不是节拍器。
			liveTickJitter: 0.5
		};

		// ---- 多语言支持 ----
		// 根据浏览器语言自动选择界面语言：任一语言以 zh 开头即简体中文，否则英语；
		// 无 navigator（如部分测试/SSR 环境）时回退英语。
		var LOCALE = "en";
		if (typeof navigator !== "undefined" && navigator) {
			var langList = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]);
			for (var li = 0; li < langList.length; li++) {
				if (langList[li] && String(langList[li]).indexOf("zh") !== -1) { LOCALE = "zh"; break; }
			}
		}
		var TEXTS = {
			zh: {
				headerPrefix: "运行了",
				headerSuffix: "条命令",
				failurePrefix: " —— ",
				failureSingle: "执行失败",
				failureSuffix: "条执行失败",
				statusCompleted: "已完成",
				statusStopped: "已停止",
				statusInterrupted: "已中断",
				ariaGroup: "展开本组",
				ariaGroupExpanded: "折叠本组",
				ariaTurn: "展开回合",
				ariaTurnExpanded: "折叠回合",
				// 段级折叠运行中标题：当前正在执行的工具 / 思考内容（间隔由 CSS margin 控制）
				runningTool: "正在运行",
				runningThink: "正在思考",
				// 纯 think 段（无工具调用）闭合后的标题
				thinkOnly: "思考",
				// 段闭合详细标题：按工具类型分组
				segmentCommand: "运行了",
				segmentCommandSuffix: "条命令",
				segmentRead: "读取了",
				segmentReadSuffix: "份文件",
				segmentEdit: "编辑了",
				segmentEditSuffix: "份文件",
				segmentSearch: "搜索了",
				segmentSearchSuffix: "次",
				segmentOthers: "执行了",
				segmentOthersSuffix: "项操作"
			},
			en: {
				headerPrefix: "Ran",
				headerSuffix: "commands",
				failurePrefix: " — ",
				failureSingle: "failed",
				failureSuffix: " failed",
				statusCompleted: "Completed",
				statusStopped: "Stopped",
				statusInterrupted: "Interrupted",
				ariaGroup: "Expand group",
				ariaGroupExpanded: "Collapse group",
				ariaTurn: "Expand turn",
				ariaTurnExpanded: "Collapse turn",
				runningTool: "Running ",
				runningThink: "Thinking ",
				thinkOnly: "Think",
				segmentCommand: "Ran ",
				segmentCommandSuffix: " commands",
				segmentRead: "Read ",
				segmentReadSuffix: " files",
				segmentEdit: "Edited ",
				segmentEditSuffix: " files",
				segmentSearch: "Searched ",
				segmentSearchSuffix: " times",
				segmentOthers: "Executed ",
				segmentOthersSuffix: " operations"
			}
		};
		/** 取当前语言下的文案；缺失键回退英文，再缺失返回键名本身。 */
		function _T(key) {
			var dict = TEXTS[LOCALE] || TEXTS.en;
			return dict[key] !== undefined ? dict[key] : key;
		}

		// ---- React ----
		var react = require("react");
		var useMemo = react.useMemo;
		var useSyncExternalStore = react.useSyncExternalStore;

		// ---- 官方 UI 原语（可选依赖） ----
		// 组头优先用官方 DisclosureRow 渲染（24px 行高、16px 前导、14px 官方 chevron、
		// 14px/24px 标题），与 Think / 工具卡片的折叠行逐像素一致。
		// @deepseek-ai/dsh-client-ui-primitives 是平台 seed 模块，插件工厂可直接 require；
		// 若某版本缺失则回退到自带兜底样式，保证插件仍可用。
		var DisclosureRow = null;
		var IconChevronDownOutline14 = null;
		var IconChevronRightOutline14 = null;
		var IconThinkOutline14 = null;
		var IconSearchOutline16 = null;
		var IconEditOutline16 = null;
		var IconBrowseOutline16 = null;
		var IconCodeOutline16 = null;
		var IconApiOutline14 = null;
		var IconSparkle16 = null;
		try {
			var uiPrimitives = require("@deepseek-ai/dsh-client-ui-primitives");
			DisclosureRow = uiPrimitives.DisclosureRow;
			IconChevronDownOutline14 = uiPrimitives.IconChevronDownOutline14;
			IconChevronRightOutline14 = uiPrimitives.IconChevronRightOutline14;
			IconThinkOutline14 = uiPrimitives.IconThinkOutline14;
			IconSearchOutline16 = uiPrimitives.IconSearchOutline16;
			IconEditOutline16 = uiPrimitives.IconEditOutline16;
			IconBrowseOutline16 = uiPrimitives.IconBrowseOutline16;
			IconCodeOutline16 = uiPrimitives.IconCodeOutline16;
			IconApiOutline14 = uiPrimitives.IconApiOutline14;
			IconSparkle16 = uiPrimitives.IconSparkle16;
		} catch (e) {
			/* 平台模块缺失：走自带兜底样式 */
		}

		// ---- 注入样式 ----
		var CSS_ID = "dsh-turn-fold/style";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turn-fold";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				/* 组容器：不加 margin，行间距完全交给官方 column 的 16px 节奏 */
				".ccg-group-root{display:flex;flex-direction:column}",
				/* 展开时组头与内容之间留 8px（折叠时组头独立成行，间距即官方 16px） */
				".ccg-group-root[data-ccg-open] .ccg-header{margin-bottom:8px}",
				/* 大组头组头下方常驻 1px 分隔线（收起/展开都显示，参考图：组头文字
				   下方的水平细线）。段级组头保持原 8px 间距；大组头由分隔线自带
				   上下留白（上 4px / 下 8px）。 */
				".ccg-group-root[data-ccg-turn][data-ccg-open] .ccg-header{margin-bottom:0}",
				".ccg-turn-divider{height:1px;flex:none;background:var(--dsw-alias-line-secondary,#d1d5db);margin:4px 0 8px}",
				/* 折叠内容容器：grid 轨道 0fr→1fr 过渡（无需测量——1fr 轨道自动等于
				   内容完整高度，内容多少就展开多少；曲线/时长为本插件自有，与
				   常见的 grid 0fr 方案参数不同）。折叠态 opacity 0 淡入。 */
				".ccg-fold-clip{display:grid;grid-template-rows:0fr;min-width:0;max-width:100%;opacity:0;transition:grid-template-rows .28s cubic-bezier(.22,1,.36,1),opacity .2s ease-out}",
				".ccg-fold-clip.ccg-fold-clip-open{grid-template-rows:1fr;opacity:1}",
				/* 折叠内容：flex column + 16px gap——段内命令（工具卡片 / Think 行）之间的
				   间距与官方聊天流 column 节奏一致 */
				".ccg-fold-body{display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;overflow:hidden}",
				".ccg-fold-clip.ccg-fold-clip-open .ccg-fold-body{overflow:visible}",
				"@media (prefers-reduced-motion: reduce){.ccg-fold-clip{transition:none!important}}",
				/* 大组头展开时，非第一个段的成员节点不经过 FoldClip 高度动画，
				   用淡入+微位移入场动画避免"瞬间出现"（.22s ease-out） */
				"@keyframes ccg-member-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}",
				".ccg-member-in{animation:ccg-member-in .22s ease-out both}",
				/* 官方 DisclosureRow 组头微调：标题 400、可省略号（大组头指标文案可能较长）、chevron 用 label-secondary */
				".ccg-header-title{font-weight:400;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				/* 组内有执行失败命令时标题标红（与官方错误色 token 一致） */
				".ccg-header-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}",
				".ccg-header-chevron{color:var(--dsw-alias-label-secondary,#9ca3af)}",
				/* 兜底组头（官方 DisclosureRow 不可用时）：24px 行高 + 14px chevron + 14px/24px 文案 */
				".ccg-header-fallback{display:flex;align-items:center;gap:6px;height:24px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:14px;line-height:24px;white-space:nowrap}",
				".ccg-header-fallback .ccg-chevron{flex:none;font-size:14px;width:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#6b7280);transition:transform .12s ease}",
				".ccg-header-fallback[data-open] .ccg-chevron{transform:rotate(90deg)}",
				".ccg-header-fallback .ccg-title{font-weight:400;overflow:hidden;text-overflow:ellipsis}",
				/* 被折叠的成员（段级 + 整回合折叠，tool-call 与 assistant-step 通用）：
				   整个 flowItem 必须 display:none，否则空 flowItem 仍会占据 flex 布局
				   并吃掉 column 的 16px gap。注：每个 flowItem 里永远包着一个
				   <div data-slot style="display:contents">，所以 :empty 永远匹配不上，
				   必须用 :has() 按隐藏标记定位。 */
				"[data-chat-flow-kind]:has([data-ccg-hidden]){display:none}",
				"[data-chat-flow-kind]:empty{display:none}",
				/* 最终总结消息：回合结束后隐藏其内部 Think 行（官方 ReasoningRow 根节点带
				   data-variant="think"），只显示正文 —— 符合"只显示最终结果"的语义 */
				"[data-ccg-turn-folded] [data-variant=\"think\"]{display:none}",
				/* 滚轮数字（大组头直播指标）：每位数 1ch 宽视窗，竖排 0-9 用 transform
				   滚动，呈现里程表/滚轮式变化。文字部分保持原样内联。 */
				".ccg-roll-cell{display:inline-block;width:1ch;height:1em;overflow:hidden;vertical-align:-0.15em;text-align:center}",
				".ccg-roll-strip{display:flex;flex-direction:column}",
				".ccg-roll-strip .ccg-roll-d{flex:none;width:1ch;height:1em;line-height:1em;text-align:center}",
				".ccg-roll-text{display:inline}",
				".ccg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				/* think 运行中摘要（段组头标题）：前缀 + 最新一行，横向自动滚动跟随末尾
				   （官方 ReasoningRow 同款 data-follow-end） */
				".ccg-think-title{display:inline-flex;align-items:center;min-width:0;max-width:100%}",
				".ccg-think-prefix{flex:none}",
				/* 图标与 · 前后统一 4px 间隔：前缀 图标 名称 · 摘要 */
				".ccg-think-icon{flex:none;display:inline-flex;align-items:center;margin:0 4px}",
				/* 名称不设显式颜色：继承组头标题色（label-secondary），与"运行了 N 条命令"
				   纯文本标题视觉一致（此前设 label-primary 白色导致观感字号不同） */
				".ccg-think-name{flex:none;font-weight:400}",
				".ccg-think-sep{flex:none;color:var(--dsw-alias-label-tertiary,#9ca3af);margin:0 4px}",
				".ccg-think-summary{display:inline-block;min-width:0;max-width:100%;vertical-align:bottom;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				".ccg-think-summary[data-follow-end]{text-overflow:clip}",
				/* 运行中段组头标题：整行统一 shimmer 高光（官方 TurnStatus "Deep diving..."
				   同款）——渐变挂在父容器上，整行一个渐变背景 + background-clip:text +
				   背景位移动画，光泽扫过整个标题。
				   颜色方案：基线用 Codex 同款深灰 rgb(104,104,104) + 纯白高光
				   （对比更明显，动效可见且观感仍是灰色系）；高光区域加宽（35%~65%）。
				   图标 span 单独恢复颜色（background-clip:text 会把 currentColor 变透明）。 */
				".ccg-think-title-live{color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--dsw-alias-label-caption,#6b7280) 0%,var(--dsw-alias-label-caption,#6b7280) 35%,#ffffff 50%,var(--dsw-alias-label-caption,#6b7280) 65%,var(--dsw-alias-label-caption,#6b7280) 100%);background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;animation:3.8s linear infinite ccg-turn-status-shimmer}",
				".ccg-think-title-live .ccg-think-icon{color:var(--dsw-alias-label-caption,#6b7280);-webkit-text-fill-color:var(--dsw-alias-label-caption,#6b7280)}",
				/* 高光流动 1.8s（47.4% 从右扫到左）→ 停顿 2s（100% 停在终态），循环 */
				"@keyframes ccg-turn-status-shimmer{0%{background-position:100% 0}47.4%{background-position:0 0}100%{background-position:0 0}}",
				"@media (prefers-reduced-motion:reduce){.ccg-think-title-live{background-position:0 0;background-size:100% 100%;animation:none}}",
				/* 含 think+text 节点拆分渲染：段外 text 正文的官方 think 行隐藏
				   （段外只显示 text 正文，段内展开时官方渲染含完整 think 行） */
				".ccg-text-only [data-variant=\"think\"]{display:none}",
				/* 段外 text 正文：顶部 16px 与段组头行拉开（官方 MarkdownText 的 p 首尾 margin 为 0）；
				   底部不额外加 padding——text 到下一个段组头 flowItem 之间由官方 column 的
				   16px gap 承担，避免 16px + 16px 叠加成 32px 造成间距过大 */
				".ccg-text-only{padding:16px 0 0}"
			].join("\n");
			document.head.appendChild(tag);
		}

		// ---- 手动展开/折叠状态（模块级，跨组件共享；按 sessionId+leaderKey 记忆） ----
		var overrides = new Map();
		var overrideListeners = new Set();
		function groupKeyOf(sessionId, leaderKey) { return sessionId + "::" + leaderKey; }
		function subscribeOverrides(fn) { overrideListeners.add(fn); return function () { overrideListeners.delete(fn); }; }
		function notifyOverrides() {
			var fns = [];
			overrideListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function setGroupOpen(sessionId, leaderKey, open) {
			var k = groupKeyOf(sessionId, leaderKey);
			var current = overrides.get(k);
			if (current === open) return;
			if (open === undefined) overrides.delete(k); else overrides.set(k, open);
			notifyOverrides();
		}
		/** 读取该组的手动选择；null = 未手动干预（跟随自动规则）。 */
		function readOverride(sessionId, leaderKey) {
			var v = overrides.get(groupKeyOf(sessionId, leaderKey));
			return v === undefined ? null : v;
		}
		/** React 钩子：订阅该组的手动选择变化。 */
		function useGroupOverride(sessionId, leaderKey) {
			return useSyncExternalStore(subscribeOverrides, function () { return readOverride(sessionId, leaderKey); });
		}

		// ---- 整回合折叠状态（模块级；按 sessionId+turn 记忆） ----
		// 回合进行中：大组头在回复开始就出现，默认展开；回合结束后整回合收成一个
		// 大组头，默认折叠；点击大组头展开/收起。手动选择永久记忆（三态：null=未干预）。
		var turnOverrides = new Map();
		var turnOverrideListeners = new Set();
		function turnKeyOf(sessionId, turn) { return sessionId + "::turn:" + turn; }
		function subscribeTurnOverrides(fn) { turnOverrideListeners.add(fn); return function () { turnOverrideListeners.delete(fn); }; }
		function notifyTurnOverrides() {
			var fns = [];
			turnOverrideListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function setTurnOpen(sessionId, turn, open) {
			var k = turnKeyOf(sessionId, turn);
			var current = turnOverrides.get(k);
			if (current === open) return;
			if (open === undefined) turnOverrides.delete(k); else turnOverrides.set(k, open);
			notifyTurnOverrides();
		}
		/** 回合折叠手动选择：null = 未手动干预（跟随自动规则：运行中展开、结束后折叠）。 */
		function useTurnOverride(sessionId, turn) {
			return useSyncExternalStore(subscribeTurnOverrides, function () {
				if (turn === undefined) return null;
				var v = turnOverrides.get(turnKeyOf(sessionId, turn));
				return v === undefined ? null : v;
			});
		}

		// ---- 实时直播时钟（回合运行中，大组头指标按随机间隔刷新） ----
		// 运行中回合的 turnTimings 只有 startTime，没有 endTime：耗时秒数需要时钟
		// 驱动，"消耗token"的持续增长动画同样依赖这个时钟（每 tick 前进 1）。
		// 间隔 = liveTickMs × 随机数（liveTickJitter ~ 1），数字跳动节奏不规律。
		// 共享一个模块级定时器（递归 setTimeout）：有组件订阅才启动，全部退订即停止。
		var tickListeners = new Set();
		var tickVersion = 0;
		var tickTimer = null;
		var liveTickState = { index: 0 };
		function scheduleTick() {
			var delay = CONFIG.liveTickMs * (CONFIG.liveTickJitter + (1 - CONFIG.liveTickJitter) * Math.random());
			tickTimer = setTimeout(function () {
				liveTickState.index++;
				tickVersion++;
				var fns = [];
				tickListeners.forEach(function (fn) { fns.push(fn); });
				for (var i = 0; i < fns.length; i++) fns[i]();
				scheduleTick();
			}, delay);
		}
		function subscribeTicks(fn) {
			tickListeners.add(fn);
			if (tickTimer === null) scheduleTick();
			return function () {
				tickListeners.delete(fn);
				if (tickListeners.size === 0 && tickTimer !== null) {
					clearTimeout(tickTimer);
					tickTimer = null;
				}
			};
		}
		function subscribeNothing() { return function () {}; }
		function getTickVersion() { return tickVersion; }
		/** 运行中：每次直播 tick（间隔随机）返回新版本号驱动重渲染，返回实时 Date.now()；结束后订阅空源、不再刷新。 */
		function useLiveNow(active) {
			useSyncExternalStore(active ? subscribeTicks : subscribeNothing, getTickVersion);
			return active ? Date.now() : undefined;
		}

		// ---- 委托渲染：取内置组件引用 ----
		// slotsService 在 apply 时捕获；entries() 返回缓存的数组引用，渲染期读取廉价且稳定。
		var slotsService = null;
		function builtinComponent(kind) {
			if (!slotsService) return undefined;
			var entries = slotsService.entries("conversation.chat.node");
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				if (e.options && e.options.key === kind && (e.options.priority || 0) === 0) return e.component;
			}
			return undefined;
		}

		// ---- 会话快照辅助 ----
		function hasReasoning(node) {
			if (!node || node.kind !== "assistant-step") return false;
			var blocks = node.data && node.data.blocks;
			return Array.isArray(blocks) && blocks.some(function (b) { return !!b && b.kind === "reasoning"; });
		}
		/** 是否含实际 text 块（非空文本）——"下一个 text 出现"的判定依据，也是段边界。 */
		function hasText(node) {
			if (!node || node.kind !== "assistant-step" || !node.data || !Array.isArray(node.data.blocks)) return false;
			var blocks = node.data.blocks;
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (b && b.kind === "text" && typeof b.text === "string" && b.text.trim() !== "") return true;
			}
			return false;
		}
		/** think 节点：有 reasoning 块即算（含 think+text 同一节点的消息——DSH 把 think 和
		 *  text 放在同一 assistant-step 的 blocks 里；think 部分收进段组头，text 部分在
		 *  段外单独渲染保持可见）。 */
		function isThinkNode(node) {
			return hasReasoning(node);
		}
		/** 段成员：tool-call 或含 reasoning 的 assistant-step（两个 text 之间的内容都入段）。 */
		function isSegmentMember(node) {
			if (!node) return false;
			if (node.kind === "tool-call") return true;
			return node.kind === "assistant-step" && isThinkNode(node);
		}
		/** 拼接节点的 reasoning 块文本（段组头运行中显示 think 内容用）。 */
		function reasoningText(node) {
			if (!node || node.kind !== "assistant-step" || !node.data || !Array.isArray(node.data.blocks)) return "";
			var parts = [];
			var blocks = node.data.blocks;
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (b && b.kind === "reasoning" && typeof b.text === "string" && b.text.trim() !== "") parts.push(b.text);
			}
			return parts.join("\n");
		}
		/** 工具调用信息：名称 / 原始参数 JSON / 官方 diff 数据 / 是否仍在运行。
		 *  官方 diff 视图（dsh-client-ui-tool 的 narrowDiffs）从 call.diffs 读取
		 *  [{path, oldText, newText}]——与官方展开详情完全一致的数据源。 */
		function toolCallInfo(node) {
			var root = node && node.data && node.data.root;
			if (!root) return null;
			if ("kind" in root) {
				// 已结算：root.kind === "tool-result"，call 字段携带 name/argsRaw/diffs（兼容旧数据直接放 root 上）
				var call = root.call || root;
				return { name: call.name, argsRaw: call.argsRaw, diffs: call.diffs, running: false };
			}
			// 运行中（in-flight）：root 就是调用本身
			return { name: root.name, argsRaw: root.argsRaw, diffs: root.diffs, running: true };
		}
		/** 参数摘要：取 argsRaw 中最长的字符串值（-m 的正文 / 路径等最有信息量的内容），截断。 */
		function summarizeArgs(argsRaw, maxLen) {
			if (!argsRaw) return "";
			var limit = typeof maxLen === "number" ? maxLen : 60;
			var best = "";
			try {
				var obj = JSON.parse(argsRaw);
				(function walk(v) {
					if (typeof v === "string") {
						if (v.length > best.length) best = v;
					} else if (Array.isArray(v)) {
						for (var i = 0; i < v.length; i++) walk(v[i]);
					} else if (v && typeof v === "object") {
						for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) walk(v[k]); }
					}
				})(obj);
			} catch (e) {
				best = String(argsRaw);
			}
			best = best.replace(/\s+/g, " ").trim();
			if (best.length > limit) best = best.slice(0, limit) + "…";
			return best;
		}
		function isRunningRoot(root) {
			return !!root && !("kind" in root);
		}
		/**
		 * 计算本节点所属的"段级分组"：
		 *   - 段 = 两个 text 之间的所有内容（tool-call + 含 reasoning 的 assistant-step
		 *     混排成一段；think 不打断段，text 是段边界）。含 think+text 的同一节点是
		 *     段的"收尾成员"：think 部分入段，text 部分使段闭合（text 正文在段外单独
		 *     渲染保持始终可见）。
		 *   - leader = 段内第一个节点（只有 leader 渲染段组头）。
		 *   - 段级折叠始终默认收起（autoCollapsed 恒 true）；运行中（textAfter=false）
		 *     段组头动态显示"正在运行 Xxx · 描述 / 正在思考 · 内容"，出现下一个 text
		 *     后显示"运行了 N 条命令"（think 不算命令数）。
		 */
		function computeGroup(order, nodes, ourNode) {
			if (!order || !nodes || !ourNode) return null;
			var ourIdx = -1;
			for (var i = 0; i < order.length; i++) {
				if (order[i] === ourNode.key) { ourIdx = i; break; }
			}
			if (ourIdx === -1) return null;
			var start = ourIdx, end = ourIdx;
			// 向前：不包含含 text 的节点（含 text 的节点属于它前面的段或独立为边界）
			while (start - 1 >= 0) {
				var prev = nodes.get(order[start - 1]);
				if (!isSegmentMember(prev) || hasText(prev)) break;
				start--;
			}
			// 向后：段尾含 text 时停止扩展（text 出现即段闭合）
			while (end + 1 < order.length) {
				var tail = nodes.get(order[end]);
				if (hasText(tail)) break;
				var next = nodes.get(order[end + 1]);
				if (!isSegmentMember(next)) break;
				end++;
			}
			var keys = [];
			for (var k = start; k <= end; k++) keys.push(order[k]);
			var toolCount = 0;
			var failures = 0;
			var anyRunning = false;
			var segHasText = false;
			for (var m = 0; m < keys.length; m++) {
				var n = nodes.get(keys[m]);
				if (!n) continue;
				if (hasText(n)) segHasText = true;
				if (n.kind !== "tool-call") continue;
				toolCount++;
				if (n.data && isRunningRoot(n.data.root)) { anyRunning = true; continue; }
				// 已结算的命令以 isError=true 标记执行失败（含中断）。
				var root = n.data && n.data.root;
				if (root && "kind" in root && root.kind === "tool-result" && root.isError === true) failures++;
			}
			// 段闭合：段尾节点自身含 text，或段尾之后已出现含 text 的节点。
			var textAfter = segHasText;
			if (!textAfter) {
				for (var j = end + 1; j < order.length; j++) {
					if (hasText(nodes.get(order[j]))) { textAfter = true; break; }
				}
			}
			return {
				start: start,
				end: end,
				keys: keys,
				leaderKey: keys[0],
				isLeader: ourIdx === start,
				count: keys.length,
				toolCount: toolCount,
				failures: failures,
				anyRunning: anyRunning,
				textAfter: textAfter,
				// 运行中段组头标题取段内最后一个节点（当前正在执行的工具 / 思考内容）
				lastActiveKey: keys[keys.length - 1],
				// 段级折叠始终默认收起（含 think+text 节点的 text 正文在段外单独渲染）
				autoCollapsed: true
			};
		}
		/** 取节点所属回合号；非回合/步骤定位（如 session 级）返回 undefined。 */
		function turnNumber(node) {
			if (!node || !node.location) return undefined;
			var loc = node.location;
			return (loc.kind === "turn" || loc.kind === "step") ? loc.turn.turn : undefined;
		}
		/**
		 * 计算"整回合折叠"信息：把本回合所有 Think + 工具调用 + 上下文注入收成一个大组头。
		 * 运行中的回合同样成立（大组头在回复开始就出现、默认展开），只保留最终总结消息
		 * （+官方 turn-tail 脚注）可见发生在回合结束后（默认收起）。
		 *   - closed：回合是否已结束（turnEnds 里有记录，turn/end 事件驱动）。
		 *   - toolCount：回合内工具调用总数（大组头文案"运行了 N 条命令"的 N）。
		 *   - finalAssistantKey：回合结束后回合内最后一条 assistant-step（最终总结，绝不
		 *     折叠）；运行中的回合为 null——当前流式消息只是"最后一条中间节点"，同样可以
		 *     作为大组头锚点，保证大组头从回复第一条内容起就出现。
		 *   - headerKey：回合内第一条"中间节点"（tool-call / context / 非最终 assistant-step），由它渲染大组头。
		 */
		function computeTurnFold(order, nodes, locations, turnEnds, ourNode, timeline) {
			if (!order || !nodes || !locations || !turnEnds || !ourNode) return null;
			var turn = turnNumber(ourNode);
			if (turn === undefined) return null;
			var closed = turnEnds.has(turn);
			var keys = locations.getTurn(turn) || [];
			var ourKey = null;
			for (var i = 0; i < keys.length; i++) {
				if (keys[i] === ourNode.key) { ourKey = keys[i]; break; }
			}
			var finalAssistantKey = null;
			var toolCount = 0;
			for (var j = 0; j < keys.length; j++) {
				var n = nodes.get(keys[j]);
				if (!n) continue;
				if (n.kind === "assistant-step") finalAssistantKey = keys[j];
				else if (n.kind === "tool-call") toolCount++;
			}
			// 运行中的回合没有"最终总结"：最后一条 assistant-step 只是当前流式消息，
			// 它同样可以作为大组头锚点（回复开始即出现大组头），不豁免于组头候选。
			if (!closed) finalAssistantKey = null;
			// 折叠作用域 = (最后一个 user 节点, 当前 agent 回合]：
			// DSH 会把上下文注入（source 非 user 的 user/message 事件，如批准
			// 策略 / 权限 / skills 提醒）排到用户首条消息之前（anchorSeq 更小）。
			// 整回合折叠只能折叠"用户消息之后"的内容——锚定在最后一个 user 节点
			// 之前（含）的节点（如审批策略变更通知）不属于本回合的输出区间，
			// 绝不参与折叠、也绝不作组头候选，否则大组头会"跨过"用户消息去折叠
			// 其上方的内容，破坏"折叠 = 收起用户消息与 agent 回复之间内容"的语义。
			var lastUserSeq = -1;
			for (var u = 0; u < keys.length; u++) {
				var un = nodes.get(keys[u]);
				if (un && un.kind === "user" && typeof un.anchorSeq === "number" && un.anchorSeq > lastUserSeq) lastUserSeq = un.anchorSeq;
			}
			var ourAnchor = typeof ourNode.anchorSeq === "number" ? ourNode.anchorSeq : undefined;
			// 当前节点是否位于折叠作用域之外（锚定在最后一个 user 节点之前/之上）。
			var outsideScope = ourKey !== null && ourAnchor !== undefined && lastUserSeq >= 0 && ourAnchor <= lastUserSeq;
			var headerKey = null;
			for (var m = 0; m < keys.length; m++) {
				var key = keys[m];
				if (key === finalAssistantKey) continue;
				var node = nodes.get(key);
				if (!node || !(node.kind === "tool-call" || node.kind === "assistant-step" || node.kind === "context")) continue;
				// 组头必须锚定在用户消息之后（anchorSeq > lastUserSeq）；
				// assistant-step / tool-call 在 settle 后必然位于用户消息之后。
				if (lastUserSeq >= 0 && typeof node.anchorSeq === "number" && node.anchorSeq <= lastUserSeq) continue;
				headerKey = key;
				break;
			}
			// ---- 回合结束状态检测（completed / stopped / interrupted）----
			// 权威数据源：快照的 s.chat.timeline.turns 里，turn.end 是完整的
			// turn/end 事件对象，其 data.reason.kind 由 agent-loop 写入：
			//   completed（正常） / aborted（用户停止） / error（出错） /
			//   max-tokens / blocked。turnEnds Map 只存 seq 拿不到 reason，
			// 因此以 timeline 为准，其余信号作兜底。取不到任何信号时按
			// 正常完成处理，绝不误报。
			var turnStatus = "completed";
			var reasonKind = null;
			if (timeline && timeline.turns && typeof timeline.turns.get === "function") {
				var tlTurn = timeline.turns.get(turn);
				if (tlTurn && tlTurn.end && tlTurn.end.data && tlTurn.end.data.reason) {
					reasonKind = tlTurn.end.data.reason.kind;
				}
			}
			if (reasonKind === "aborted") turnStatus = "stopped";
			else if (reasonKind === "error" || reasonKind === "max-tokens") turnStatus = "interrupted";
			// blocked：输入被拒绝，按正常完成处理（不误报）。
			if (turnStatus === "completed" && turnEnds && typeof turnEnds.get === "function") {
				var endInfo = turnEnds.get(turn);
				if (endInfo) {
					var reason = endInfo.reason || endInfo.stopReason || "";
					if (reason === "stopped" || reason === "cancelled") turnStatus = "stopped";
					else if (reason === "interrupted" || reason === "error" || reason === "maxTokens" || reason === "length") turnStatus = "interrupted";
				}
			}
			if (turnStatus === "completed" && finalAssistantKey) {
				var finalNode = nodes.get(finalAssistantKey);
				if (finalNode && finalNode.data) {
					var stopReason = finalNode.data.stopReason || finalNode.data.finishReason || finalNode.data.reason;
					if (stopReason === "length" || stopReason === "max_tokens" || stopReason === "content_filter") turnStatus = "interrupted";
					else if (stopReason === "stopped" || stopReason === "cancelled") turnStatus = "stopped";
				}
			}
			return {
				turn: turn,
				closed: closed,
				toolCount: toolCount,
				headerKey: headerKey,
				finalAssistantKey: finalAssistantKey,
				ourKey: ourKey,
				outsideScope: outsideScope,
				turnStatus: turnStatus,
				// 只有能同时定位到"自己的 key"和"作用域内的组头"时才允许折叠。
				// 运行中：finalAssistantKey 为 null（当前流式消息也是组头候选），
				// 只要 headerKey 存在即可折叠。回合结束后额外要求 finalAssistantKey
				// 存在，避免 turn/end 与最终消息索引的瞬时竞态导致最终消息被误隐藏。
				foldable: ourKey !== null && headerKey !== null && (closed ? finalAssistantKey !== null : true),
				isTurnHeader: ourKey !== null && ourKey === headerKey,
				isFinalAssistant: ourKey !== null && finalAssistantKey !== null && ourKey === finalAssistantKey
			};
		}

		// ---- 回合性能指标（大组头文案） ----
		/** 汇总本回合的耗时 / 消耗 token / tok/s / 缓存命中率。
		 *  @param {number|undefined} liveNow - 运行中回合传 Date.now() 用于实时耗时计算；
		 *    回合结束后传 undefined，耗时从 turnTimings 的 endTime 精确计算。 */
		function computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow) {
			if (turn === undefined || !nodes || !locations || !turnTimings) return null;
			var keys = locations.getTurn(turn) || [];
			var durationMs;
			var timing = turnTimings.get(turn);
			if (timing && typeof timing.startTime === "number") {
				// 运行中：endTime 缺失时用 liveNow 补足（实时耗时）
				var endTime = typeof timing.endTime === "number" ? timing.endTime : liveNow;
				if (typeof endTime === "number") {
					durationMs = Math.max(0, endTime - timing.startTime);
				}
			}
			var input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
			var tokensPerSecond;
			for (var i = 0; i < keys.length; i++) {
				var n = nodes.get(keys[i]);
				if (!n) continue;
				if (n.kind === "assistant-step" && n.data && n.data.usage) {
					var u = n.data.usage;
					if (typeof u.inputTokens === "number" && isFinite(u.inputTokens)) input += u.inputTokens;
					if (typeof u.outputTokens === "number" && isFinite(u.outputTokens)) output += u.outputTokens;
					if (typeof u.cacheReadTokens === "number" && isFinite(u.cacheReadTokens)) cacheRead += u.cacheReadTokens;
					if (typeof u.cacheWriteTokens === "number" && isFinite(u.cacheWriteTokens)) cacheWrite += u.cacheWriteTokens;
				} else if (n.kind === "turn-tail" && n.data && typeof n.data.tokensPerSecond === "number") {
					tokensPerSecond = n.data.tokensPerSecond;
				}
			}
			var billedInput = input + cacheRead + cacheWrite;
			var hasUsage = billedInput > 0 || output > 0;
			// 运行中（liveNow 存在）且官方 turn-tail 未给出 tok/s 时：
			// 按"已输出 token / 已耗时"实时估算（耗时 >=1s 且已有输出才显示，避免
			// 开场瞬间的巨大瞬时速率；回合结束后由 turn-tail 的权威值覆盖）。
			if (tokensPerSecond === undefined && typeof liveNow === "number" && durationMs !== undefined && durationMs >= 1000 && output > 0) {
				tokensPerSecond = output / (durationMs / 1000);
			}
			if (durationMs === undefined && !hasUsage && tokensPerSecond === undefined) return null;
			return {
				durationMs: durationMs,
				// 消耗 = 计费输入（uncached + cacheRead + cacheWrite）+ 输出
				tokens: hasUsage ? (billedInput + output) : undefined,
				// 输出 token 累计（tok/s 实时估算用）
				outputTokens: hasUsage ? output : undefined,
				tokensPerSecond: tokensPerSecond,
				cacheHitPercent: hasUsage && billedInput > 0 ? Math.round(cacheRead / billedInput * 100) : undefined
			};
		}

		// ---- 运行中"消耗token"的持续增长动画 ----
		// 真实 usage（assistant/chunk 的 usage 块）只在每个请求完成时到达，两次到达
		// 之间（思考/工具执行期间）数字会停住不动。为营造"一直在消耗"的观感，在真实
		// 基线之上叠加一个纯展示用的动画偏移：偏移按实际 tick 次数推进，**+1/+11 交替**
		// 循环（个位每 tick +1、十位每 2 tick +1、更高位随进位自然走动），永不回退；
		// tick 间隔 = liveTickMs × 随机数（liveTickJitter ~ 1），数字跳动节奏不规律。
		// 真实 usage 到达时只把基线校正为真实值（偏移继续累计，数字只增不减）。
		// 缓存按 sessionId+turn 记忆（跨会话不串）、跨渲染共享。
		// （outputTokens / tps / now 参数保留仅为兼容旧调用与测试签名，动画不再使用。）
		var liveTokenCache = new Map();
		function projectLiveTokens(key, realTokens, outputTokens, now, tps) {
			if (key === undefined || typeof realTokens !== "number") return realTokens;
			var c = liveTokenCache.get(key);
			if (!c) {
				liveTokenCache.set(key, { lastTokens: realTokens, animBaseTick: liveTickState.index });
				return realTokens;
			}
			if (realTokens !== c.lastTokens) c.lastTokens = realTokens;
			// 真实基线 + 动画偏移（+1/+11 交替：个位每 tick +1、十位每 2 tick +1；
			// tick 间隔随机，节奏不规律）
			var tickCount = liveTickState.index - c.animBaseTick;
			var animOffset = (tickCount % 10) + Math.floor(tickCount / 2) * 10;
			return Math.floor(c.lastTokens) + animOffset;
		}
		/** 大组头展示指标：运行中把"消耗token"按动画节奏持续增长（真实 usage 到达时校正基线）。 */
		function turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow) {
			if (!metrics || closed || typeof metrics.tokens !== "number" || typeof liveNow !== "number" || turn === undefined) return metrics;
			var projected = projectLiveTokens(sessionId + "::" + turn, metrics.tokens, metrics.outputTokens, liveNow, metrics.tokensPerSecond);
			if (projected === metrics.tokens) return metrics;
			return {
				durationMs: metrics.durationMs,
				tokens: projected,
				outputTokens: metrics.outputTokens,
				tokensPerSecond: metrics.tokensPerSecond,
				cacheHitPercent: metrics.cacheHitPercent
			};
		}
		/** 耗时格式化：中英文各自的单位写法；>=1 小时 → "x时x分x秒" / "xh xm xs"。 */
		function formatTurnDuration(ms) {
			var total = Math.floor(ms / 1000);
			if (total >= 3600) {
				var h = Math.floor(total / 3600);
				var m = Math.floor((total % 3600) / 60);
				var s = total % 60;
				if (LOCALE === "zh") return h + "时" + m + "分" + s + "秒";
				return h + "h " + m + "m " + s + "s";
			}
			if (total >= 60) {
				var mm = Math.floor(total / 60);
				var ss = total % 60;
				if (LOCALE === "zh") return mm + "分" + ss + "秒";
				return mm + "m " + ss + "s";
			}
			if (LOCALE === "zh") return total + "秒";
			return total + "s";
		}
		/** tok/s：>=10 取整，<10 保留一位小数（与官方一致）。 */
		function formatTokPerSec(tps) {
			var v = Math.max(0, tps);
			return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
		}
		/** 大组头文案："耗时…，消耗…token，…tok/s，缓存命中…%"；无数据返回空串。 */
		function turnHeaderLabel(metrics) {
			if (!metrics) return "";
			var parts = [];
			if (metrics.durationMs !== undefined) {
				if (LOCALE === "zh") parts.push("耗时" + formatTurnDuration(metrics.durationMs));
				else parts.push(formatTurnDuration(metrics.durationMs));
			}
			if (metrics.tokens !== undefined) {
				if (LOCALE === "zh") parts.push("消耗" + metrics.tokens + "token");
				else parts.push(metrics.tokens + " tokens");
			}
			if (metrics.tokensPerSecond !== undefined) {
				if (LOCALE === "zh") parts.push(formatTokPerSec(metrics.tokensPerSecond) + "tok/s");
				else parts.push(formatTokPerSec(metrics.tokensPerSecond) + " tok/s");
			}
			if (metrics.cacheHitPercent !== undefined) {
				if (LOCALE === "zh") parts.push("缓存命中" + metrics.cacheHitPercent + "%");
				else parts.push("cache hit " + metrics.cacheHitPercent + "%");
			}
			return parts.join(LOCALE === "zh" ? "，" : ", ");
		}

		// ---- 回合状态标签 ----
		/** 已结束的回合在大组头前置状态文本（如"已完成 | 耗时…"、"已停止 | 耗时…"）。 */
		function turnLabelWithStatus(baseLabel, turnStatus) {
			var key = "status" + (turnStatus || "completed").charAt(0).toUpperCase() + (turnStatus || "completed").slice(1);
			var text = _T(key);
			return text ? (text + " | " + baseLabel) : baseLabel;
		}

		// ---- 自行实现的 tool.call.toolview 分发（替代内置 renderSlot） ----
		// 内置 ToolCallTree 调用 renderSlot("tool.call.toolview", owner, {entryKey, fallback})；
		// 我们用 slotsService.entriesOfSlot() 找到该工具名的子视图组件，用"我们自己的
		// 标准 kit + owner"渲染。子视图注册只有 locale（conversation），无 inject/store/children，
		// 因此这套组合与内置渲染器给出的 props 等价。
		function renderToolview(kit, owner, entryKey, fallback) {
			var entries = slotsService ? slotsService.entriesOfSlot("tool.call.toolview") : null;
			var entry = null;
			if (entries) {
				for (var i = 0; i < entries.length; i++) {
					if (entries[i].options && entries[i].options.key === entryKey) { entry = entries[i]; break; }
				}
			}
			if (!entry) return fallback;
			var Comp = entry.component;
			var props = {};
			if (kit.useSession) props.useSession = kit.useSession;
			if (kit.sessionId !== undefined) props.sessionId = kit.sessionId;
			if (kit.useSessions) props.useSessions = kit.useSessions;
			if (kit.useProjection) props.useProjection = kit.useProjection;
			if (kit.useWorkspaces) props.useWorkspaces = kit.useWorkspaces;
			if (kit.t) props.t = kit.t;
			if (kit.useHostDescription) props.useHostDescription = kit.useHostDescription;
			for (var k in owner) if (Object.prototype.hasOwnProperty.call(owner, k)) props[k] = owner[k];
			return react.createElement(Comp, props);
		}

		// 给内置 ToolCallTree 补齐 renderSlot（我们的 entry 无 children，拿不到原装 renderSlot）
		function renderBuiltinToolCall(props) {
			var Builtin = builtinComponent("tool-call");
			if (!Builtin) return null;
			var kit = {
				useSession: props.useSession,
				sessionId: props.sessionId,
				useSessions: props.useSessions,
				useProjection: props.useProjection,
				useWorkspaces: props.useWorkspaces,
				t: props.t,
				useHostDescription: props.useHostDescription
			};
			var customRenderSlot = function (key, owner, options) {
				if (key !== "tool.call.toolview") return options && options.fallback ? options.fallback : null;
				return renderToolview(kit, owner, options.entryKey, options.fallback);
			};
			return react.createElement(Builtin, Object.assign({}, props, { renderSlot: customRenderSlot }));
		}

		// 内置 AssistantNodeView 无需 renderSlot（只用 useTurnData 等注入 props），原样转发即可。
		function renderBuiltinAssistant(props) {
			var Builtin = builtinComponent("assistant-step");
			if (!Builtin) return null;
			return react.createElement(Builtin, props);
		}

		// 内置 ContextMessageNodeView 同样无 renderSlot，原样转发即可。
		function renderBuiltinContext(props) {
			var Builtin = builtinComponent("context");
			if (!Builtin) return null;
			return react.createElement(Builtin, props);
		}

		// ---- 折叠隐藏标记 ----
		// 被折叠的成员节点渲染此标记，CSS 用 :has() 把整个 flowItem 设为 display:none，
		// 避免空 flowItem 吃掉 flex gap。
		function hiddenMarker() {
			return react.createElement("span", { "data-ccg-hidden": "true", style: { display: "none" } });
		}

		// ---- 折叠内容过渡动画包装器 ----
		// 折叠时内容不挂载（保持 DOM 干净）；展开时挂载内容（grid 0fr 折叠态），
		// 双 rAF 确保折叠态被样式计算（过渡的起始帧），再加 open class 播放
		// grid 轨道 0fr→1fr 过渡（280ms + 淡入）——1fr 轨道自动等于内容完整
		// 高度，无需 JS 测量，内容无论何时渲染/增长都完整展开；
		// 收起时移除 open class（1fr→0fr 过渡），支持 CSS 过渡的环境延迟卸载
		// （动画播完再卸载），否则（jsdom/reduced-motion）立即卸载。
		// rAF 兜底：jsdom/非浏览器环境没有 window.requestAnimationFrame 时用 setTimeout。
		var raf = (typeof window !== "undefined" && window.requestAnimationFrame)
			? window.requestAnimationFrame.bind(window)
			: function (fn) { return setTimeout(fn, 16); };
		var caf = (typeof window !== "undefined" && window.cancelAnimationFrame)
			? window.cancelAnimationFrame.bind(window)
			: function (id) { clearTimeout(id); };
		function FoldClip(props) {
			var open = props.open;
			var live = props.live === true;
			// 注意：官方 DisclosureRow 只在展开时渲染 children，所以本组件
			// 首次挂载时 open 往往已是 true。初始状态必须固定为"折叠态"
			// （不挂载、无 open class、prev=false），否则展开动画分支永不执行。
			var mountedState = react.useState(false);
			var mounted = mountedState[0];
			var setMounted = mountedState[1];
			var expandedState = react.useState(false);
			var expanded = expandedState[0];
			var setExpanded = expandedState[1];
			var elRef = react.useRef(null);
			var prevOpenRef = react.useRef(false);
			var rafRef = react.useRef(null);
			var timerRef = react.useRef(null);
			// 用 useLayoutEffect（DOM 提交后同步执行）：展开分支的 setExpanded(false)
			// 折叠起始态在 paint 前提交 DOM，双 rAF 展开时过渡起始帧必然存在——
			// useEffect（异步）在渲染合并/帧时序下可能让浏览器从未渲染过 0fr 起始帧，
			// 导致 grid 过渡不播放、出现"瞬间展开"。
			react.useLayoutEffect(function () {
				var prev = prevOpenRef.current;
				prevOpenRef.current = open;
				// 直播模式（回合运行中）：内容常驻、直接展开（轨道 1fr 自适应流式增长）。
				if (live && open) {
					setMounted(true);
					setExpanded(true);
					return undefined;
				}
				if (open && !prev) {
					// 展开：挂载内容（grid 0fr 折叠态，opacity 0）→ 双 rAF 确保
					// 折叠态被样式计算 → 加 open class 播放 0fr→1fr 轨道过渡。
					setMounted(true);
					setExpanded(false);
					if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
					if (rafRef.current !== null) { caf(rafRef.current); rafRef.current = null; }
					rafRef.current = raf(function () {
						rafRef.current = raf(function () {
							rafRef.current = null;
							setExpanded(true);
						});
					});
					return function () {
						if (rafRef.current !== null) { caf(rafRef.current); rafRef.current = null; }
					};
				}
				if (!open) {
					// 收起：移除 open class（1fr→0fr 过渡）。若环境实际支持 CSS
					// 过渡（getComputedStyle 的 transitionDuration 非 0）且未开启
					// reduced-motion，动画播完再卸载；否则立即卸载。
					var el = elRef.current;
					setExpanded(false);
					if (rafRef.current !== null) { caf(rafRef.current); rafRef.current = null; }
					if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
					if (el && mounted) {
						var reduced = false;
						try { reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
						var dur = "0s";
						try { dur = typeof window !== "undefined" && window.getComputedStyle ? window.getComputedStyle(el).transitionDuration : "0s"; } catch (e) {}
						var hasTransition = !reduced && typeof dur === "string" && dur.length > 0 && dur.split(",")[0].trim() !== "0s";
						if (hasTransition) {
							// 等过渡结束再卸载（收起动画期间内容保留在 DOM）
							timerRef.current = setTimeout(function () { timerRef.current = null; setMounted(false); }, 340);
						} else {
							setMounted(false);
						}
					} else {
						setMounted(false);
					}
					return function () {
						if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
					};
				}
				// 初始即展开（open 从未变过）：直接展开。
				setExpanded(true);
			}, [open]);
			if (!mounted) return null;
			return react.createElement(
				"div",
				{
					ref: elRef,
					className: "ccg-fold-clip" + (expanded ? " ccg-fold-clip-open" : "")
				},
				react.createElement(
					"div",
					{ className: "ccg-fold-body" },
					props.children
				)
			);
		}

		// ---- 滚轮数字（大组头直播指标的逐位滚动动画） ----
		// 每个数位是一个 1ch 宽、1em 高的视窗（overflow:hidden），内部竖排 0-9
		// （flex column，每格恰好 1em）；数值变化时用 Web Animations API 从旧数位
		// 滚到新数位（回弹缓动），呈现"滚轮/里程表"效果——耗时秒数每秒变化一次，
		// token 个位每个刷新周期 +1（十位每 2 个周期 +1）、tok/s/缓存命中随流式数据
		// 到达而变化。动画时长按变化频率自适应：距上次变化不足 2 个基准周期说明
		// 数字在快速滚动（如 token 个位），用短于最小间隔的动画保证每拍完整走完、
		// 不抖动；慢速变化（如耗时秒数）保持 350ms 回弹滚动。首次挂载从 0 滚到
		// 当前值（计数感）；prefers-reduced-motion 或环境无 WAAPI（如 jsdom）时
		// 直接定位、无动画。
		function RollDigit(props) {
			var digit = props.digit;
			var stripRef = react.useRef(null);
			var animRef = react.useRef(null);
			var prevRef = react.useRef(0);
			var lastChangeRef = react.useRef(0);
			react.useEffect(function () {
				var el = stripRef.current;
				if (!el) return undefined;
				var prev = prevRef.current;
				prevRef.current = digit;
				var nowMs = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();
				var sinceLast = lastChangeRef.current ? nowMs - lastChangeRef.current : 1e9;
				lastChangeRef.current = nowMs;
				var target = "translateY(" + (-digit * 10) + "%)";
				var reduced = false;
				try { reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
				if (reduced || prev === digit || typeof el.animate !== "function") {
					el.style.transform = target;
					return undefined;
				}
				if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
				// 快速连续变化（<2 个基准周期）用短动画：时长取最小间隔（liveTickMs×jitter）
				// 的 0.8 倍，保证节奏最快时每拍也能完整走完、不抖动
				var dur = sinceLast < CONFIG.liveTickMs * 2 ? Math.max(40, Math.round(CONFIG.liveTickMs * CONFIG.liveTickJitter * 0.8)) : 350;
				var anim = el.animate(
					[
						{ transform: "translateY(" + (-prev * 10) + "%)" },
						{ transform: target }
					],
					{ duration: dur, easing: "cubic-bezier(.34,1.56,.64,1)" }
				);
				animRef.current = anim;
				anim.onfinish = function () { animRef.current = null; };
				return function () {
					if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
				};
			}, [digit]);
			var kids = [];
			for (var d = 0; d < 10; d++) {
				kids.push(react.createElement("span", { key: d, className: "ccg-roll-d" }, String(d)));
			}
			return react.createElement(
				"div",
				{ className: "ccg-roll-cell", "data-digit": String(digit) },
				react.createElement(
					"div",
					{
						ref: stripRef,
						className: "ccg-roll-strip",
						style: { transform: "translateY(" + (-digit * 10) + "%)" }
					},
					kids
				)
			);
		}

		// ---- 直播指标文案：数字部分渲染成逐位滚轮，其余文字原样 ----
		// 文本段与数字段分别计数做稳定 key：某段指标（如缓存命中）中途出现时，
		// 只让新数字挂载滚动，已显示的数值不重滚。
		function AnimatedLabel(props) {
			var label = props.label;
			var kids = [];
			var re = /(\d+(?:\.\d+)?)/g;
			var last = 0;
			var m;
			var textIdx = 0;
			var numIdx = 0;
			while ((m = re.exec(label)) !== null) {
				if (m.index > last) {
					kids.push(react.createElement("span", { key: "t" + textIdx++, className: "ccg-roll-text" }, label.slice(last, m.index)));
				}
				var digits = [];
				for (var i = 0; i < m[1].length; i++) {
					var ch = m[1].charAt(i);
					if (ch >= "0" && ch <= "9") {
						digits.push(react.createElement(RollDigit, { key: "d" + i, digit: Number(ch) }));
					} else {
						digits.push(react.createElement("span", { key: "d" + i, className: "ccg-roll-text" }, ch));
					}
				}
				kids.push(react.createElement("span", { key: "n" + numIdx++, className: "ccg-roll-num", "aria-hidden": "true" }, digits));
				last = re.lastIndex;
			}
			if (last < label.length) {
				kids.push(react.createElement("span", { key: "t" + textIdx++, className: "ccg-roll-text" }, label.slice(last)));
			}
			// 滚动窗口（0-9 数字条）只是视觉装饰：数字段 aria-hidden；
			// 完整最终文案放在 sr-only 文本里，读屏/断言拿到的是最终值。
			return react.createElement(
				"span",
				{ className: "ccg-roll-label" },
				react.createElement("span", { className: "ccg-sr-only" }, label),
				kids
			);
		}

		// ---- 组头组件 ----
		// 优先用官方 DisclosureRow（24px 行高、16px 前导、14px 官方 chevron、14px/24px 标题），
		// 与 Think / 工具卡片的折叠行样式一致；平台原语缺失时回退到自带兜底行。
		// 无障碍：两种路径都带 aria-label / aria-expanded，键盘可操作。
		// live：运行中的大组头——标题里的数字用滚轮动画逐位滚动；回合结束后纯文本。
		function GroupHeader(props) {
			var count = props.count;
			var open = props.open;
			var onToggle = props.onToggle;
			// label 可选：大组头传指标文案；缺省用"运行了 N 条命令"（多语言）。
			var label = props.label || (_T("headerPrefix") + " " + count + " " + _T("headerSuffix"));
			// danger：组内有执行失败的命令时标题标红。
			var danger = props.danger === true;
			// isTurn：大组头（整回合折叠）用回合语义的无障碍标签。
			var isTurn = props.isTurn === true;
			// live：运行中的大组头数值实时变化，用滚轮动画渲染（DisclosureRow 的
			// title 直接作为 children 渲染，传 React 元素即可）。
			var live = props.live === true;
			var titleContent = live ? react.createElement(AnimatedLabel, { label: label }) : label;
			var titleClass = "ccg-header-title" + (danger ? " ccg-header-danger" : "");
			var ariaLabel = isTurn
				? (open ? _T("ariaTurnExpanded") : _T("ariaTurn"))
				: (open ? _T("ariaGroupExpanded") : _T("ariaGroup"));
			// DisclosureRow 只在 open 时渲染 children（open && children），且
			// keepContentWhenOpen 只作用于 collapsedContent。因此 FoldClip 不能
			// 放在 children 里（收起瞬间会被卸载，收起动画无法播放）——由调用方
			// 渲染在 GroupHeader 之后，挂载生命周期完全由 FoldClip 自己控制。
			if (DisclosureRow && IconChevronDownOutline14 && IconChevronRightOutline14) {
				return react.createElement(
					DisclosureRow,
					{
						rowClassName: "ccg-header",
						leadingClassName: "ccg-header-leading",
						titleClassName: titleClass,
						chevronClassName: "ccg-header-chevron",
						// 收起：官方右向 chevron（14px）；展开：DisclosureRow 内建的下向 chevron（14px）
						icon: react.createElement(IconChevronRightOutline14, { size: 14 }),
						title: titleContent,
						open: open,
						expandable: true,
						expandOnRowClick: true,
						previewChevron: false,
						onToggle: onToggle,
						"aria-label": ariaLabel
					}
				);
			}
			return react.createElement(
				"div",
				{
					className: "ccg-header ccg-header-fallback",
					role: "button",
					tabIndex: 0,
					"aria-expanded": !!open,
					"aria-label": ariaLabel,
					"data-open": open ? "true" : undefined,
					onClick: onToggle,
					onKeyDown: function (e) {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
					}
				},
				react.createElement("span", { className: "ccg-chevron" }, "›"),
				react.createElement("span", { className: "ccg-title" + (danger ? " ccg-header-danger" : "") }, titleContent)
			);
		}

		// ---- 段级分组渲染（现有行为）：单条原样 / 非 leader 隐藏 / leader 渲染组头 ----
				/** 取 think 文本最后一行（运行中摘要跟随最新内容，官方 ReasoningRow 同款）。 */
		function latestLine(text) {
			var visible = String(text).trimEnd();
			var newline = visible.lastIndexOf("\n");
			return newline === -1 ? visible : visible.slice(newline + 1);
		}
		/** 取 think 文本第一行（段闭合后摘要用）。 */
		function firstLine(text) {
			var t = String(text);
			var newline = t.indexOf("\n");
			return newline === -1 ? t : t.slice(0, newline);
		}
		// ---- 段闭合后的详细标题：按工具类型分组统计 ----
		// 分类与官方 TOOL_VARIANTS 一致（bash→命令、read→读取、search→搜索、
		// write/edit→编辑），run_code 归命令、str-replace-editor 归编辑。
		var TOOL_KINDS = {
			pwsh: "command", bash: "command", shell: "command", cmd: "command", terminal: "command", git: "command", run_code: "command",
			read: "read", view: "read", cat: "read", web_fetch: "read", cordis_package_inspect: "read", cordis_runtime_inspect: "read",
			grep: "search", search: "search", find: "search", glob: "search", web_search: "search",
			edit: "edit", write: "edit", patch: "edit", create: "edit", "str-replace-editor": "edit"
		};
		/** 解析 argsRaw 一次（提取路径与行数共用，避免重复 JSON.parse）。 */
		function parseArgsRaw(argsRaw) {
			if (!argsRaw) return null;
			try { return JSON.parse(argsRaw); } catch (e) { return null; }
		}
		/** 从已解析的 args 提取文件路径（path / file_path / url / file / target；args 数组兜底取含路径分隔符的串）。 */
		function extractFilePathFromParsed(raw) {
			if (!raw || typeof raw !== "object") return null;
			var keys = ["file_path", "path", "file", "target", "url"];
			for (var i = 0; i < keys.length; i++) {
				var v = raw[keys[i]];
				if (typeof v === "string" && v !== "") return v;
			}
			if (Array.isArray(raw.args)) {
				for (var j = raw.args.length - 1; j >= 0; j--) {
					var a = raw.args[j];
					if (typeof a === "string" && (a.indexOf("/") !== -1 || a.indexOf("\\") !== -1)) return a;
				}
			}
			return null;
		}
		/** 从已解析的 args 提取编辑行数变更：insertions/deletions 显式字段，否则 old/new
		 *  内容块行数（兼容全部命名变体）。 */
		function extractLineChangesFromParsed(raw) {
			if (!raw || typeof raw !== "object") return null;
			var added = 0, removed = 0;
			// 显式字段
			if (typeof raw.insertions === "number") added = raw.insertions;
			else if (typeof raw.added === "number") added = raw.added;
			else if (typeof raw["+"] === "number") added = raw["+"];
			if (typeof raw.deletions === "number") removed = raw.deletions;
			else if (typeof raw.removed === "number") removed = raw.removed;
			else if (typeof raw["-"] === "number") removed = raw["-"];
			// 从 old/new 内容块行数统计（edit 类工具常用，兼容全部命名变体：
			//  camelCase oldStr/newStr、snake_case old_str/new_str、
			//  DSH edit 工具全拼 old_string/new_string）
			if (added === 0 && removed === 0) {
				var newContent = null, oldContent = null;
				if (typeof raw.newStr === "string") newContent = raw.newStr;
				else if (typeof raw.new_str === "string") newContent = raw.new_str;
				else if (typeof raw.new_string === "string") newContent = raw.new_string;
				if (typeof raw.oldStr === "string") oldContent = raw.oldStr;
				else if (typeof raw.old_str === "string") oldContent = raw.old_str;
				else if (typeof raw.old_string === "string") oldContent = raw.old_string;
				if (newContent !== null) {
					// 块级统计（与官方 edit 的 diff 视图一致：old_string 整块删除、
					// new_string 整块新增，统计块的行数而非行级差异）
					added = newContent.split("\n").length;
					removed = oldContent !== null ? oldContent.split("\n").length : 0;
				}
			}
			if (added === 0 && removed === 0) return null;
			return { added: added, removed: removed };
		}
		/** 路径最后一段（文件名 / URL 尾）。 */
		function pathBasename(path) {
			if (!path) return null;
			var sep = path.indexOf("\\") !== -1 ? "\\" : "/";
			var parts = path.split(sep);
			var last = parts[parts.length - 1];
			return last || null;
		}
		/** 统计段内工具调用：按分类分组，read/edit 类附带去重后的文件名单及行数变更。 */
		function classifySegmentTools(group, nodes) {
			var stats = { command: [], read: [], search: [], edit: [], others: [] };
			for (var i = 0; i < group.keys.length; i++) {
				var n = nodes.get(group.keys[i]);
				if (!n || n.kind !== "tool-call") continue;
				var info = toolCallInfo(n);
				var name = info ? String(info.name) : "";
				var kind = TOOL_KINDS[name.toLowerCase()] || "others";
				// 性能：官方 diffs 存在时（路径 + oldText/newText 行数）完全不解析 argsRaw；
				// 否则解析一次 argsRaw 同时提取路径与行数（避免多次 JSON.parse）
				var filePath = null, lineChanges = null;
				if (info && Array.isArray(info.diffs) && info.diffs.length > 0) {
					var first = info.diffs[0];
					if (first && typeof first.path === "string") filePath = first.path;
					var ta = 0, tr = 0;
					for (var di = 0; di < info.diffs.length; di++) {
						var h = info.diffs[di];
						if (!h) continue;
						if (typeof h.newText === "string") ta += h.newText.split("\n").length;
						if (typeof h.oldText === "string") tr += h.oldText.split("\n").length;
					}
					if (ta > 0 || tr > 0) lineChanges = { added: ta, removed: tr };
				} else if (info) {
					var parsed = parseArgsRaw(info.argsRaw);
					filePath = extractFilePathFromParsed(parsed);
					lineChanges = extractLineChangesFromParsed(parsed);
				}
				stats[kind].push({ name: name, filePath: filePath, fileName: pathBasename(filePath), lineChanges: lineChanges });
			}
			return stats;
		}
		/** 组内 read/edit 类的描述：同一文件用文件名，多个文件用数量+单位。edit 类额外附加行数变更。 */
		function filePartLabel(stats, kind, prefix, suffix) {
			var items = stats[kind];
			if (!items || items.length === 0) return "";
			var files = [];
			for (var i = 0; i < items.length; i++) {
				if (items[i].fileName) {
					var fp = items[i].fileName;
					if (files.indexOf(fp) === -1) files.push(fp);
				}
			}
			var label;
			if (files.length === 1) label = prefix + files[0];
			else label = prefix + (files.length > 0 ? files.length : items.length) + suffix;
			// edit 类：单文件时汇总所有编辑的行数变更（方括号包裹，如 [ +12 -3 ]）
			if (kind === "edit" && files.length === 1) {
				var totalAdded = 0, totalRemoved = 0;
				for (var j = 0; j < items.length; j++) {
					var lc = items[j].lineChanges;
					if (lc) { totalAdded += lc.added; totalRemoved += lc.removed; }
				}
				if (totalAdded > 0 || totalRemoved > 0) {
					var parts = [];
					if (totalAdded > 0) parts.push("+" + totalAdded);
					if (totalRemoved > 0) parts.push("-" + totalRemoved);
					label += " [ " + parts.join(" ") + " ]";
				}
			}
			return label;
		}
		/** 组内 command 类的描述：单次用工具名，多次用次数+单位。 */
		function commandPartLabel(stats) {
			var items = stats.command;
			if (!items || items.length === 0) return "";
			if (items.length === 1) return _T("segmentCommand") + (items[0].name || "");
			return _T("segmentCommand") + items.length + _T("segmentCommandSuffix");
		}
		// 段闭合标题缓存：段闭合后（textAfter=true）标题不再随流式变化，按
		// leaderKey+keys+工具轻量指纹记忆只计算一次，避免每次渲染重复解析 argsRaw。
		// 指纹 = 每个 tool 的 name + isError + argsRaw 长度（不解析内容，O(1)）——
		// 段闭合后这些字段稳定；不同内容但同 keys 的段（如测试场景）长度不同也能区分。
		var segmentLabelCache = new Map();
		function segmentCacheKey(group, nodes) {
			var parts = [group.leaderKey, group.keys.join(",")];
			for (var i = 0; i < group.keys.length; i++) {
				var n = nodes.get(group.keys[i]);
				if (!n || n.kind !== "tool-call") continue;
				var root = n.data && n.data.root;
				var name = "", isErr = "0", rawLen = 0;
				if (root && "kind" in root) {
					var call = root.call || root;
					name = call.name || "";
					if (root.isError === true) isErr = "1";
					if (typeof call.argsRaw === "string") rawLen = call.argsRaw.length;
				} else if (root) {
					name = root.name || "";
					if (typeof root.argsRaw === "string") rawLen = root.argsRaw.length;
				}
				parts.push(name + ":" + isErr + ":" + rawLen);
			}
			return parts.join("|");
		}
		/** 段组头标题：运行中（textAfter=false）取最后一个节点显示当前执行内容，闭合后按
		 *  工具类型分组显示详细标题（命令最后）。 */
		function segmentLabel(group, nodes) {
			if (group.textAfter && group.toolCount > 0) {
				// 段闭合：按工具类型分组统计（think 不算），结果缓存
				var cacheKey = segmentCacheKey(group, nodes);
				var cached = segmentLabelCache.get(cacheKey);
				if (cached !== undefined) return cached;
				var stats = classifySegmentTools(group, nodes);
				var parts = [];
				var readLabel = filePartLabel(stats, "read", _T("segmentRead"), _T("segmentReadSuffix"));
				if (readLabel) parts.push(readLabel);
				var editLabel = filePartLabel(stats, "edit", _T("segmentEdit"), _T("segmentEditSuffix"));
				if (editLabel) parts.push(editLabel);
				if (stats.search.length > 0) parts.push(_T("segmentSearch") + stats.search.length + _T("segmentSearchSuffix"));
				if (stats.others.length > 0) parts.push(_T("segmentOthers") + stats.others.length + _T("segmentOthersSuffix"));
				var commandLabel = commandPartLabel(stats);
				if (commandLabel) parts.push(commandLabel);
				var label = parts.join(LOCALE === "zh" ? " " : " ");
				// 失败追加：仅单条工具调用失败显示"执行失败"（无条数）；
				// 多条工具调用时 1 条失败也显示"1条执行失败"
				if (group.failures > 0) {
					if (group.failures === 1 && group.toolCount === 1) label += _T("failurePrefix") + _T("failureSingle");
					else label += _T("failurePrefix") + group.failures + _T("failureSuffix");
				}
				segmentLabelCache.set(cacheKey, label);
				return label;
			}
			if (group.textAfter && group.toolCount === 0) {
				// 纯 think 段闭合后显示"思考"（"运行了 0 条命令"不好看）
				return _T("thinkOnly");
			}
			// 运行中（段未闭合）：显示段内最后一个节点（当前正在执行的工具 / 思考内容）
			var last = group.lastActiveKey ? nodes.get(group.lastActiveKey) : null;
			if (last && last.kind === "tool-call") {
				var info = toolCallInfo(last);
				if (info && info.name) {
					var desc = summarizeArgs(info.argsRaw);
					return _T("runningTool") + info.name + (desc ? " · " + desc : "");
				}
			}
			if (last && last.kind === "assistant-step") {
				var text = reasoningText(last);
				if (text) {
					// 运行中摘要取最新一行（与官方 ReasoningRow 一致：流式跟随最新内容）
					return _T("runningThink") + latestLine(text);
				}
			}
			// 兜底：退回"运行了 N 条命令"
			var fallback = _T("headerPrefix") + " " + group.toolCount + " " + _T("headerSuffix");
			if (group.failures > 0) {
				if (group.failures === 1 && group.toolCount === 1) fallback += _T("failurePrefix") + _T("failureSingle");
				else fallback += _T("failurePrefix") + group.failures + _T("failureSuffix");
			}
			return fallback;
		}
		/** think 摘要行：运行中横向自动滚动跟随末尾（官方 ReasoningRow 的 data-follow-end 行为）。
		 *  滚动位置用 rAF 节流（每帧至多一次 layout 读写）——think 流式 chunk 高频更新时，
		 *  若每次渲染都同步读 scrollWidth / 写 scrollLeft 会造成 layout thrashing、阻塞主线程
		 *  （表现：标题卡住不动、几秒后一次性刷出全部内容）。官方 ReasoningRow 同样用
		 *  useThrottledVisualUpdate 节流。 */
		function ThinkSummary(props) {
			var text = props.text;
			var running = props.running === true;
			var ref = react.useRef(null);
			var rafRef = react.useRef(null);
			var line = running ? latestLine(text) : firstLine(text);
			react.useEffect(function () {
				var el = ref.current;
				if (!el) return;
				if (rafRef.current !== null) return; // 本帧已排队，合并多次渲染
				rafRef.current = raf(function () {
					rafRef.current = null;
					if (running) el.scrollLeft = el.scrollWidth - el.clientWidth;
					else el.scrollLeft = 0;
				});
				return function () {
					if (rafRef.current !== null) { caf(rafRef.current); rafRef.current = null; }
				};
			});
			return react.createElement(
				"span",
				{ ref: ref, className: "ccg-think-summary" + (running ? " ccg-think-summary-live" : ""), "data-follow-end": running || undefined },
				line
			);
		}
		/** 工具图标：复用官方 GenericToolCard 的 VARIANT_ICONS 映射（dsh-client-ui-tool），
		 *  与官方工具行逐像素一致：bash/pwsh → IconApiOutline14、read → IconBrowseOutline16、
		 *  search → IconSearchOutline16、write/edit → IconEditOutline16、code → IconCodeOutline16、
		 *  兜底 others → IconSparkle16。图标统一包 flex:none 容器防滚动摘要挤压。 */
		function toolIconFor(name, size) {
			var n = String(name || "").toLowerCase();
			var s = typeof size === "number" ? size : 14;
			var Icon = null;
			if (n.indexOf("pwsh") !== -1 || n.indexOf("bash") !== -1 || n.indexOf("shell") !== -1 || n.indexOf("cmd") !== -1 || n.indexOf("terminal") !== -1 || n.indexOf("git") !== -1) {
				Icon = IconApiOutline14;
			} else if (n.indexOf("read") !== -1 || n.indexOf("view") !== -1 || n.indexOf("cat") !== -1 || n.indexOf("web_fetch") !== -1) {
				Icon = IconBrowseOutline16;
			} else if (n.indexOf("grep") !== -1 || n.indexOf("search") !== -1 || n.indexOf("find") !== -1 || n.indexOf("glob") !== -1 || n.indexOf("web_search") !== -1) {
				Icon = IconSearchOutline16;
			} else if (n.indexOf("edit") !== -1 || n.indexOf("write") !== -1 || n.indexOf("patch") !== -1 || n.indexOf("create") !== -1) {
				Icon = IconEditOutline16;
			} else if (n.indexOf("run_code") !== -1 || n.indexOf("code") !== -1) {
				Icon = IconCodeOutline16;
			} else {
				Icon = IconSparkle16;
			}
			if (!Icon) return null;
			return react.createElement("span", { className: "ccg-think-icon" }, react.createElement(Icon, { size: s }));
		}
		/** 段组头标题元素：think / 工具运行中用"前缀 + 官方图标 + 名称 + 摘要"（官方行风格），
		 *  其余情况为纯文本。 */
		function segmentTitle(group, nodes) {
			if (!group.textAfter) {
				var last = group.lastActiveKey ? nodes.get(group.lastActiveKey) : null;
				if (last && last.kind === "assistant-step") {
					var text = reasoningText(last);
					if (text) {
						return react.createElement(
							"span",
							{ className: "ccg-think-title ccg-think-title-live" },
							react.createElement("span", { className: "ccg-think-prefix" }, _T("runningThink")),
							IconThinkOutline14 ? react.createElement("span", { className: "ccg-think-icon" }, react.createElement(IconThinkOutline14, { size: 14 })) : null,
							react.createElement("span", { className: "ccg-think-name" }, "Think"),
							react.createElement("span", { className: "ccg-think-sep" }, " · "),
							react.createElement(ThinkSummary, { text: text, running: true })
						);
					}
				}
				if (last && last.kind === "tool-call") {
					var info = toolCallInfo(last);
					if (info && info.name) {
						var desc = summarizeArgs(info.argsRaw);
						return react.createElement(
							"span",
							{ className: "ccg-think-title ccg-think-title-live" },
							react.createElement("span", { className: "ccg-think-prefix" }, _T("runningTool")),
							toolIconFor(info.name, 14),
							react.createElement("span", { className: "ccg-think-name" }, info.name),
							desc ? react.createElement("span", { className: "ccg-think-sep" }, " · ") : null,
							desc ? react.createElement("span", { className: "ccg-think-summary" }, desc) : null
						);
					}
				}
			}
			return segmentLabel(group, nodes);
		}
		/** 段级分组渲染：只有 leader 渲染（成员渲染 hiddenMarker，内容由 leader 统一渲染，
		 *  保证 DOM 顺序：段组头行 → 段内内容（工具卡片 / think 完整内容）→ text 正文）。
		 *  段内所有含 text 的节点的 text 正文统一在段组头下方渲染（始终显示、不折叠、
		 *  唯一一份——官方渲染 + CSS 隐藏 think 行）。
		 *  finalKey：回合最终总结节点（由 turn 级单独渲染，段内跳过避免重复）。 */
		function renderSegment(props, group, open, sessionId, nodes, finalKey) {
			if (!group.isLeader) return hiddenMarker();
			var inner = [];
			var textBodies = [];
			for (var i = 0; i < group.keys.length; i++) {
				var n = nodes.get(group.keys[i]);
				if (!n || n.key === finalKey) continue;
				if (n.kind === "tool-call") {
					inner.push(react.createElement("div", { key: "c" + n.key }, renderBuiltinToolCall(Object.assign({}, props, { node: n }))));
				} else if (n.kind === "assistant-step" && hasText(n)) {
					// 含 think+text：构造仅含 reasoning 块的节点，官方渲染只出 Think 行
					// （官方 ReasoningRow：收起显示"Think · 摘要"，点击展开完整内容）；
					// text 正文进段外（官方渲染 + CSS 隐藏 think 行）
					var thinkOnlyNode = Object.assign({}, n, {
						data: Object.assign({}, n.data, {
							blocks: (n.data.blocks || []).filter(function (b) { return !b || b.kind !== "text"; })
						})
					});
					inner.push(react.createElement("div", { key: "t" + n.key }, renderBuiltinAssistant(Object.assign({}, props, { node: thinkOnlyNode }))));
					textBodies.push(react.createElement(
						"div",
						{ key: "x" + n.key, className: "ccg-text-only" },
						renderBuiltinAssistant(Object.assign({}, props, { node: n }))
					));
				} else if (n.kind === "assistant-step" && hasReasoning(n)) {
					// 纯 think：官方渲染（官方 Think 行）
					inner.push(react.createElement("div", { key: "r" + n.key }, renderBuiltinAssistant(Object.assign({}, props, { node: n }))));
				}
			}
			var toggle = function () {
				setGroupOpen(sessionId, group.leaderKey, !open);
			};
			var title = segmentTitle(group, nodes);
			var danger = group.failures > 0;
			// 顺序：段组头行 → 段内内容（think 完整内容 / 工具卡片，折叠时不可见）
			// → 段内 text 正文（始终显示）——think 在 text 上方，符合"先思考后正文"的阅读顺序
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(group.toolCount), "data-ccg-open": open ? "true" : undefined },
				react.createElement(
					GroupHeader,
					{ count: group.toolCount, open: open, onToggle: toggle, label: title, danger: danger, isTurn: false }
				),
				react.createElement(FoldClip, { open: open }, inner),
				textBodies
			);
		}

		// ---- 工具调用节点：段级分组 + 整回合折叠 ----
		function GroupedToolCallView(props) {
			var node = props.node;
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			// 订阅会话快照：order/nodes 变化时重渲染；locations/turnEnds 提供"回合是否结束"信号。
			var order = useSession(function (s) { return s.chat.order; });
			var nodes = useSession(function (s) { return s.chat.nodes; });
			var locations = useSession(function (s) { return s.chat.locations; });
			var turnEnds = useSession(function (s) { return s.turnEnds; });
			var turnTimings = useSession(function (s) { return s.turnTimings; });
			var timeline = useSession(function (s) { return s.chat.timeline; });
			var group = useMemo(function () { return computeGroup(order, nodes, node); }, [order, nodes, node]);
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var leaderKey = group ? group.leaderKey : "";
			var manual = useGroupOverride(sessionId, leaderKey);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			// 运行中：大组头默认展开（回复逐条加载、指标实时刷新）；回合结束后默认收起。
			// 只有大组头节点需要实时秒表（成员不渲染组头）。
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);

			// 兜底：找不到自己的节点时，原样委托内置渲染（补齐 renderSlot），绝不白屏。
			if (!group) return renderBuiltinToolCall(props);

			// 有效展开状态 = 手动选择优先；否则跟随自动规则。
			var open = manual === null ? !group.autoCollapsed : manual;

			// 整回合折叠成一个大组头（段级组头不再各自显示）：回合进行中同样成立——
			// 大组头在 agent 回复开始就出现（默认展开），组头实时显示耗时/token 指标。
			// 折叠作用域之外（用户消息上方）的节点不参与整回合折叠。
			// 判定只看"是否存在可折叠的中间节点"（foldable），不要求本回合必须有
			// 工具调用：仅上下文注入/思考的纯问答回合同样收成一个大组头。
			if (fold && fold.foldable && !fold.outsideScope) {
				var turnOpen = turnOverride === null ? !closed : turnOverride;
				var finalKey = fold.finalAssistantKey;
				if (!fold.isTurnHeader) {
					// 成员：大组头展开时显示自己的段级内容（非 leader 由段 leader 统一渲染）；收起时隐藏。
					return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderSegment(props, group, open, sessionId, nodes, finalKey)) : hiddenMarker();
				}
				// 组头节点：渲染大组头（文案 = 本回合性能指标 + 状态标签，无数据则退回
				// "运行了 N 条命令"）；组头下方常驻分隔线（收起/展开都显示），其下接自己的段级内容。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnOpen);
				};
				var baseLabel = turnHeaderLabel(displayMetrics) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
				var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(
						GroupHeader,
						{ label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed }
					),
					react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
					react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderSegment(props, group, open, sessionId, nodes, finalKey))
				);
			}

			// 未整回合折叠：段级分组逻辑。
			return renderSegment(props, group, open, sessionId, nodes, fold ? fold.finalAssistantKey : undefined);
		}

		// ---- 助手节点（Think / 最终消息）：整回合折叠支持 ----
		// 回合进行中：大组头在回复开始就出现，默认展开，内容原样流式加载；
		// 回合结束后，除最终总结消息外的所有 assistant-step（即 Think 行）都收进大组头。
		function GroupedAssistantView(props) {
			var node = props.node;
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			var order = useSession(function (s) { return s.chat.order; });
			var nodes = useSession(function (s) { return s.chat.nodes; });
			var locations = useSession(function (s) { return s.chat.locations; });
			var turnEnds = useSession(function (s) { return s.turnEnds; });
			var turnTimings = useSession(function (s) { return s.turnTimings; });
			var timeline = useSession(function (s) { return s.chat.timeline; });
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);
			// 纯 think 节点也参与段级分组（段 = 两个 text 之间的 tool-call + think）。
			var segGroup = useMemo(function () { return computeGroup(order, nodes, node); }, [order, nodes, node]);
			var segManual = useGroupOverride(sessionId, segGroup ? segGroup.leaderKey : "");
			var segOpen = segManual === null ? !(segGroup && segGroup.autoCollapsed) : segManual;

			// 无法安全定位组头（回合内无任何中间节点）/ 节点在折叠作用域之外（用户消息上方）：
			// 原样委托内置渲染。不要求本回合必须有工具调用——仅上下文注入/思考的回合同样折叠。
			if (!fold || !fold.foldable || fold.outsideScope) {
				return renderBuiltinAssistant(props);
			}
			var turnOpen = turnOverride === null ? !closed : turnOverride;
			if (fold.isFinalAssistant) {
				// 最终总结消息保持可见；回合结束后隐藏其内部的 Think 行（"只显示最终结果"）。
				// 运行中（isFinalAssistant 恒为 false）不会走到这里，流式 Think 保持内置行为。
				return react.createElement(
					"div",
					{ "data-ccg-turn-folded": "true", style: { display: "contents" } },
					renderBuiltinAssistant(props)
				);
			}
			// think 节点（含 think+text 同一节点）：纯 think 段（段内无工具调用）不套段组头，
			// 直接官方渲染（官方 Think 行 + text 正文，与官方一致）；工具段（段内有工具）
			// 收进段级折叠，think 用官方 Think 行、text 正文由 renderSegment 统一在段外渲染。
			if (isThinkNode(node) && segGroup) {
				if (segGroup.toolCount === 0) {
					// 纯 think 段：不套段组头，直接官方渲染（无重复、无双层折叠）
					if (fold.isTurnHeader) {
						// think 是回合第一条中间节点：大组头下方直接接官方 think 行。
						var toggleTurn3 = function () {
							setTurnOpen(sessionId, fold.turn, !turnOpen);
						};
						var baseLabel3 = turnHeaderLabel(displayMetrics) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
						var turnLabel3 = closed ? turnLabelWithStatus(baseLabel3, fold.turnStatus) : baseLabel3;
						return react.createElement(
							"div",
							{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
							react.createElement(GroupHeader, { label: turnLabel3, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn3, isTurn: true, live: !closed }),
							react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
							react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinAssistant(props))
						);
					}
					return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinAssistant(props)) : hiddenMarker();
				}
				if (fold.isTurnHeader) {
					// think 是回合第一条中间节点：同时是 turn 组头和段 leader——大组头下方接段级折叠行。
					var toggleTurn2 = function () {
						setTurnOpen(sessionId, fold.turn, !turnOpen);
					};
					var baseLabel2 = turnHeaderLabel(displayMetrics) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
					var turnLabel2 = closed ? turnLabelWithStatus(baseLabel2, fold.turnStatus) : baseLabel2;
					return react.createElement(
						"div",
						{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
						react.createElement(GroupHeader, { label: turnLabel2, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn2, isTurn: true, live: !closed }),
						react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
						react.createElement(FoldClip, { open: turnOpen, live: !closed },
							renderSegment(props, segGroup, segOpen, sessionId, nodes, fold.finalAssistantKey)
						)
					);
				}
				if (!turnOpen) return hiddenMarker();
				return renderSegment(props, segGroup, segOpen, sessionId, nodes, fold.finalAssistantKey);
			}
			if (!fold.isTurnHeader) {
				// 中间 Think 节点（含 text 的普通消息）：大组头展开时显示；收起时隐藏。
				return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinAssistant(props)) : hiddenMarker();
			}
			// 组头节点：渲染大组头（文案 = 本回合性能指标 + 状态标签）；组头下方常驻
			// 分隔线（收起/展开都显示），其下接自己的内容（Think 行）。
			var toggleTurn = function () {
				setTurnOpen(sessionId, fold.turn, !turnOpen);
			};
			var baseLabel = turnHeaderLabel(displayMetrics) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
			var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
				react.createElement(
					GroupHeader,
					{ label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed }
				),
				react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
				react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinAssistant(props))
			);
		}

		// ---- 上下文注入节点（context）：整回合折叠时收进大组头 ----
		// 若上下文注入恰好是回合第一条"中间节点"，则由它渲染大组头。
		function GroupedContextView(props) {
			var node = props.node;
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			var order = useSession(function (s) { return s.chat.order; });
			var nodes = useSession(function (s) { return s.chat.nodes; });
			var locations = useSession(function (s) { return s.chat.locations; });
			var turnEnds = useSession(function (s) { return s.turnEnds; });
			var turnTimings = useSession(function (s) { return s.turnTimings; });
			var timeline = useSession(function (s) { return s.chat.timeline; });
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);

			// 无法安全定位组头（回合内无任何中间节点）/ 折叠作用域之外（用户消息上方）的
			// 上下文行不参与折叠，始终原样渲染。不要求本回合必须有工具调用——仅上下文
			// 注入/思考的回合同样折叠。
			if (!fold || !fold.foldable || fold.outsideScope) {
				return renderBuiltinContext(props);
			}
			var turnOpen = turnOverride === null ? !closed : turnOverride;
			if (fold.isTurnHeader) {
				// 组头节点：渲染大组头（文案 = 本回合性能指标 + 状态标签）；组头下方常驻
				// 分隔线（收起/展开都显示），其下接自己的内容（上下文注入行）。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnOpen);
				};
				var baseLabel = turnHeaderLabel(displayMetrics) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
				var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(
						GroupHeader,
						{ label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed }
					),
					react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
					react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinContext(props))
				);
			}
			return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinContext(props)) : hiddenMarker();
		}

		// ---- Cordis 插件入口 ----
		// 关键：委托渲染内置组件时，内置组件（ToolCallTree 等）依赖由"条目自身
		// inject 声明"提供的 hook（如 useHostDescription，来自 connection 服务的
		// hostDescription 可观察源）。我们的条目必须声明同样的 inject，否则手动
		// createElement 内置组件会因缺少这些 hook 而崩溃，SlotErrorBoundary 会把
		// 我们的条目"abdicate"（踢出槽位），折叠随即永久失效。
		exports.inject = ["slots", "connection"];
		exports.apply = function (ctx) {
			ctx.inject(["slots", "connection"], function (scope) {
				slotsService = scope.slots;
				var connection = scope.connection;
				// 与内置 tool-call 条目一致的 inject：把 connection.hostDescription
				// 以 useHostDescription 形式注入组件 props，委托渲染时原样透传。
				var hostDescriptionInject = function () {
					return { hooks: { hostDescription: connection.hostDescription } };
				};
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "tool-call",
						priority: -1,
						locale: "conversation",
						inject: hostDescriptionInject
					}, GroupedToolCallView);
				});
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "assistant-step",
						priority: -1,
						locale: "conversation",
						inject: hostDescriptionInject
					}, GroupedAssistantView);
				});
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "context",
						priority: -1,
						locale: "conversation",
						inject: hostDescriptionInject
					}, GroupedContextView);
				});
			});
		};

		return module.exports;
	}
});
}
