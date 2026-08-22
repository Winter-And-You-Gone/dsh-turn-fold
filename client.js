// dsh-turn-fold: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。只负责折叠。
//
// 行为：
//   1. Think 块保持内置默认（收起、点击展开），不做任何改动。
//   2. 工具调用按 Think 段级分组：下一个 Think 出现后自动折叠成段级组头；运行中保持展开。
//   3. 大组头在 agent 回复开始就出现（运行中默认展开，回复在其下逐条加载），
//      组头实时显示本轮耗时/token/tok/s/缓存命中率——耗时每秒刷新、token 随流式
//      usage 事件更新、tok/s 按已输出 token 实时估算；真实 usage 只在请求完成时
//      到达，"消耗token"在两次到达之间按观测速率持续外推增长（新数据到达时校正
//      为真实值）；数值变化带"滚轮/里程表"式逐位滚动动画（每位数字独立滚动，
//      350ms 回弹缓动）；组头下方常驻一条水平分隔线（收起/展开都显示）。
//   4. 回合结束后，整回合（所有 Think + 工具调用 + 上下文注入）收成一个大组头并
//      默认收起，只保留最终总结正文；非正常结束的回合带状态标签（已停止 / 已中断）。
//   5. 点击组头可手动展开/折叠；展开带平滑过渡动画（高度展开 + 淡入 + 微位移，280ms），
//      收起带收缩动画（200ms）后卸载内容；尊重 prefers-reduced-motion。
//   6. 界面文案自动适配中英文（navigator.language(s) 含 zh 即中文），
//      组头带 aria-label / aria-expanded，键盘可操作（Enter / Space）。
//
// 实现方式：
//   - 用 priority:-1 覆盖（shadow）内置的 conversation.chat.node 渲染器：
//       key "tool-call"        -> 段级分组 + 自动折叠
//       key "assistant-step"   -> 整回合折叠（Think/最终消息）
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
			// 运行中大组头"消耗token"数字的外推参数：真实 usage 只在请求完成时到达，
			// 两次到达之间按观测速率持续增长，保持"实时消耗"的观感。
			liveTokenRate: 30,       // 默认增长速率（tok/s；尚无观测数据时使用）
			liveTokenRateMax: 300    // 观测速率上限（tok/s；防单次大跳变导致外推暴涨）
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
				failureSuffix: "条执行失败",
				statusCompleted: "已完成",
				statusStopped: "已停止",
				statusInterrupted: "已中断",
				ariaGroup: "展开本组",
				ariaGroupExpanded: "折叠本组",
				ariaTurn: "展开回合",
				ariaTurnExpanded: "折叠回合"
			},
			en: {
				headerPrefix: "Ran",
				headerSuffix: "commands",
				failureSuffix: "failed",
				statusCompleted: "Completed",
				statusStopped: "Stopped",
				statusInterrupted: "Interrupted",
				ariaGroup: "Expand group",
				ariaGroupExpanded: "Collapse group",
				ariaTurn: "Expand turn",
				ariaTurnExpanded: "Collapse turn"
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
		try {
			var uiPrimitives = require("@deepseek-ai/dsh-client-ui-primitives");
			DisclosureRow = uiPrimitives.DisclosureRow;
			IconChevronDownOutline14 = uiPrimitives.IconChevronDownOutline14;
			IconChevronRightOutline14 = uiPrimitives.IconChevronRightOutline14;
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
				/* 折叠内容容器：height/opacity/transform 全部由 FoldClip 用
				   Web Animations API（element.animate）显式驱动关键帧动画播放，
				   CSS 只负责裁切。不依赖 CSS transition 起始帧 / interpolate-size。 */
				".ccg-fold-clip{overflow:hidden}",
				".ccg-fold-body{min-width:0;min-height:0}",
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
				".ccg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}"
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

		// ---- 实时秒表（回合运行中，大组头"耗时"每秒刷新） ----
		// token 等指标随会话快照自然更新（流式 usage 事件触发重渲染）；只有"耗时"
		// 需要时钟驱动：运行中回合的 turnTimings 只有 startTime，没有 endTime。
		// 共享一个模块级定时器：有组件订阅才启动，全部退订即停止。
		var tickListeners = new Set();
		var tickVersion = 0;
		var tickTimer = null;
		function subscribeTicks(fn) {
			tickListeners.add(fn);
			if (tickTimer === null) {
				tickTimer = setInterval(function () {
					tickVersion++;
					var fns = [];
					tickListeners.forEach(function (fn) { fns.push(fn); });
					for (var i = 0; i < fns.length; i++) fns[i]();
				}, 1000);
			}
			return function () {
				tickListeners.delete(fn);
				if (tickListeners.size === 0 && tickTimer !== null) {
					clearInterval(tickTimer);
					tickTimer = null;
				}
			};
		}
		function subscribeNothing() { return function () {}; }
		function getTickVersion() { return tickVersion; }
		/** 运行中：每秒返回新版本号驱动重渲染，返回实时 Date.now()；结束后订阅空源、不再刷新。 */
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
		function isRunningRoot(root) {
			return !!root && !("kind" in root);
		}
		/**
		 * 计算本 tool-call 节点所属的"组"：
		 *   - 组 = 连续一段 tool-call 节点（被任何其他节点——尤其 Think——打断即新组）。
		 *   - leader = 组内第一个节点（只有 leader 渲染组头）。
		 *   - autoCollapsed = 组尾之后已出现 Think 且组内没有仍在运行的调用。
		 */
		function computeGroup(order, nodes, ourNode) {
			if (!order || !nodes || !ourNode) return null;
			var ourIdx = -1;
			for (var i = 0; i < order.length; i++) {
				if (order[i] === ourNode.key) { ourIdx = i; break; }
			}
			if (ourIdx === -1) return null;
			var start = ourIdx, end = ourIdx;
			while (start - 1 >= 0) {
				var prev = nodes.get(order[start - 1]);
				if (!prev || prev.kind !== "tool-call") break;
				start--;
			}
			while (end + 1 < order.length) {
				var next = nodes.get(order[end + 1]);
				if (!next || next.kind !== "tool-call") break;
				end++;
			}
			var keys = [];
			for (var k = start; k <= end; k++) keys.push(order[k]);
			var anyRunning = false;
			var failures = 0;
			for (var m = 0; m < keys.length; m++) {
				var n = nodes.get(keys[m]);
				if (!n || n.kind !== "tool-call") continue;
				if (n.data && isRunningRoot(n.data.root)) { anyRunning = true; continue; }
				// 已结算的命令以 isError=true 标记执行失败（含中断）。
				var root = n.data && n.data.root;
				if (root && "kind" in root && root.kind === "tool-result" && root.isError === true) failures++;
			}
			var hasLaterThink = false;
			for (var j = end + 1; j < order.length; j++) {
				if (hasReasoning(nodes.get(order[j]))) { hasLaterThink = true; break; }
			}
			return {
				start: start,
				end: end,
				keys: keys,
				leaderKey: keys[0],
				isLeader: ourIdx === start,
				count: keys.length,
				// 组内已结算且执行失败（isError=true，含中断）的命令数。
				failures: failures,
				anyRunning: anyRunning,
				hasLaterThink: hasLaterThink,
				autoCollapsed: hasLaterThink && !anyRunning
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
				// 输出 token 累计：外推增长速率用它估算（输入随请求一次性跳变，不适合当速率）
				outputTokens: hasUsage ? output : undefined,
				tokensPerSecond: tokensPerSecond,
				cacheHitPercent: hasUsage && billedInput > 0 ? Math.round(cacheRead / billedInput * 100) : undefined
			};
		}

		// ---- 运行中"消耗token"的外推增长 ----
		// 真实 usage（assistant/chunk 的 usage 块）只在每个请求完成时到达，两次到达
		// 之间（思考/工具执行期间）数字会停住不动。为保持"实时消耗"的观感，按观测到
		// 的生成速率持续外推增长；新 usage 到达时立即校正为真实值（可能回跳，属预期）。
		// 速率取"输出 token 增量 / 时间间隔"（输入随请求一次性跳变，不适合当速率），
		// 上限见 CONFIG.liveTokenRateMax；尚无观测数据时用实时 tps，再退化为
		// CONFIG.liveTokenRate 默认速率。缓存按 sessionId+turn 记忆（跨会话不串），
		// 跨渲染共享。
		var liveTokenCache = new Map();
		function projectLiveTokens(key, realTokens, outputTokens, now, tps) {
			if (key === undefined || typeof realTokens !== "number" || typeof now !== "number") return realTokens;
			var c = liveTokenCache.get(key);
			if (!c) {
				var initRate = (typeof tps === "number" && tps > 0) ? tps : CONFIG.liveTokenRate;
				liveTokenCache.set(key, {
					lastTokens: realTokens,
					lastOutput: typeof outputTokens === "number" ? outputTokens : 0,
					lastAt: now,
					rate: initRate
				});
				return realTokens;
			}
			if (realTokens !== c.lastTokens) {
				// 新真实数据到达：校正基线，并用输出增量重新估算速率（截断到上限）
				var dtSec = (now - c.lastAt) / 1000;
				if (dtSec > 1 && typeof outputTokens === "number" && outputTokens > c.lastOutput) {
					var rate = (outputTokens - c.lastOutput) / dtSec;
					if (rate > 0) c.rate = Math.min(rate, CONFIG.liveTokenRateMax);
				}
				c.lastTokens = realTokens;
				c.lastOutput = typeof outputTokens === "number" ? outputTokens : c.lastOutput;
				c.lastAt = now;
				return realTokens;
			}
			// 无新数据：按速率外推（每秒随 tick 增长）
			return Math.floor(c.lastTokens + c.rate * ((now - c.lastAt) / 1000));
		}
		/** 大组头展示指标：运行中把"消耗token"按观测速率外推增长（真实 usage 到达时校正）。 */
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
		// 折叠时内容不挂载（保持 DOM 干净）；展开时用手动 rAF 动画（每帧重新测量
		// 内容高度、动画目标实时跟随，easeOutQuint 280ms，高度+淡入+微位移），
		// 结束 height:auto 完全放开；收起用 Web Animations API 播放收缩动画
		// （200ms）后卸载。不依赖 CSS transition 起始帧；prefers-reduced-motion
		// 时跳过动画。
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
			// （不挂载、高度 0、prev=false），否则 open&&!prev 永远为 false，
			// 展开动画分支永不执行，内容直接显示（瞬间展开）。
			var mountedState = react.useState(false);
			var mounted = mountedState[0];
			var setMounted = mountedState[1];
			var heightState = react.useState("0px");
			var height = heightState[0];
			var setHeight = heightState[1];
			// visible：内容是否可见。展开动画期间由 el.style 手动控制 opacity，
			// 结束后置 true（React 接管）；挂载测量阶段保持 false 掩盖内容。
			var visibleState = react.useState(false);
			var visible = visibleState[0];
			var setVisible = visibleState[1];
			var elRef = react.useRef(null);
			var animRef = react.useRef(null);
			var prevOpenRef = react.useRef(false);
			react.useEffect(function () {
				var prev = prevOpenRef.current;
				prevOpenRef.current = open;
				// 直播模式（回合运行中）：内容常驻且高度自适应，不裁切不断增长的流式内容。
				if (live && open) {
					setMounted(true);
					setHeight("auto");
					setVisible(true);
					return undefined;
				}
				if (open && !prev) {
					// 从折叠切到展开。关键：先用 height:auto 完整渲染（opacity:0
					// 掩盖），让浏览器完成全部布局/懒渲染，稳定测量到【真实高度】
					// 后再收起播放动画——之前"先隐藏再测量"时，内容在 height:0
					// 裁切下不会完整渲染，测量值只有前几行，动画永远覆盖不全。
					setMounted(true);
					setHeight("auto");
					setVisible(false);
					// 【调试 v6】展开流程日志
					if (typeof console !== "undefined" && console.log) console.log("[dsh-turn-fold] expand: mount full-render (opacity:0)");
					var rafId = null;
					var timer = setTimeout(function () {
						var el = elRef.current;
						if (!el) return;
						var reduced = false;
						try { reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
						if (reduced) { setVisible(true); return; }
						var measureH = function () {
							var body = el.firstElementChild;
							return Math.max(0, body ? body.offsetHeight : el.scrollHeight);
						};
						// 稳定测量（内容可见状态，连续 2 帧相同或最多 30 帧 ≈500ms）
						var prevH = -1;
						var stableFrames = 0;
						var totalFrames = 0;
						var fullH = 0;
						function measureLoop() {
							var h = measureH();
							totalFrames++;
							if (h === prevH) { stableFrames++; } else { stableFrames = 0; prevH = h; }
							if (h > fullH) fullH = h;
							if (typeof console !== "undefined" && console.log && totalFrames <= 6) {
								console.log("[dsh-turn-fold] measure frame " + totalFrames + ": h=" + h);
							}
							if (stableFrames < 2 && totalFrames < 30) {
								rafId = raf(measureLoop);
								return;
							}
							if (typeof console !== "undefined" && console.log) console.log("[dsh-turn-fold] measured fullH=" + fullH + " after " + totalFrames + " frames (stable " + stableFrames + ")");
							if (fullH <= 0) { setVisible(true); return; }
							// 测量完成：立即收起（opacity:0 掩盖，无闪烁），播放 0→fullH 动画
							el.style.height = "0px";
							el.style.opacity = "0";
							el.style.transform = "translateY(-4px)";
							var start = null;
							var DURATION = 280;
							var frameCount = 0;
							rafId = raf(function frame(t) {
								if (start === null) start = t;
								var p = Math.min(1, (t - start) / DURATION);
								var e = 1 - Math.pow(1 - p, 5); // easeOutQuint
								el.style.height = Math.round(e * fullH) + "px";
								el.style.opacity = String(e);
								el.style.transform = "translateY(" + (-4 * (1 - e)) + "px)";
								frameCount++;
								if (typeof console !== "undefined" && console.log && (frameCount % 6 === 1 || p >= 1)) {
									console.log("[dsh-turn-fold] anim frame " + frameCount + ": p=" + p.toFixed(2) + " h=" + Math.round(e * fullH));
								}
								if (p < 1) {
									rafId = raf(frame);
								} else {
									if (typeof console !== "undefined" && console.log) console.log("[dsh-turn-fold] expand done: h=" + Math.round(e * fullH) + " → auto");
									setVisible(true);
									setHeight("auto");
								}
							});
						}
						rafId = raf(measureLoop);
					}, 0);
					return function () {
						clearTimeout(timer);
						if (rafId !== null) caf(rafId);
						if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
					};
				}
				if (!open) {
					// 收起：播放收缩动画（高度→0 + 淡出 + 下移），完成后卸载内容；
					// 无 WAAPI / prefers-reduced-motion / 无元素时直接卸载。
					var el = elRef.current;
					var reduced = false;
					try { reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
					if (el && mounted && typeof el.animate === "function" && !reduced) {
						// 当前高度：优先从 state 读（"68px"）；auto/0px 时重新测量
						var cur = height === "auto" ? Math.max(0, el.firstElementChild ? el.firstElementChild.offsetHeight : el.scrollHeight) : (parseInt(height, 10) || 0);
						if (cur > 0) {
							if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
							var anim = el.animate(
								[
									{ height: cur + "px", opacity: 1, transform: "translateY(0)" },
									{ height: "0px", opacity: 0, transform: "translateY(-4px)" }
								],
								{ duration: 200, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" }
							);
							animRef.current = anim;
							anim.onfinish = function () {
								animRef.current = null;
								try { anim.commitStyles(); } catch (e) {}
								try { anim.cancel(); } catch (e) {}
								setHeight("0px");
								setMounted(false);
							};
							return function () {
								if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
							};
						}
					}
					setHeight("0px");
					setMounted(false);
				}
				// 初始即展开（open 从未变过）：保持 auto/1，无动画。
			}, [open]);
			if (!mounted) return null;
			return react.createElement(
				"div",
				{
					ref: elRef,
					className: "ccg-fold-clip",
					style: { height: height, opacity: visible ? 1 : 0 }
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
		// 滚到新数位（350ms + 轻微回弹缓动），呈现"滚轮/里程表"效果——耗时每秒
		// 变化一次，token/tok/s/缓存命中随流式数据到达而变化。首次挂载从 0 滚到
		// 当前值（计数感）；prefers-reduced-motion 或环境无 WAAPI（如 jsdom）时
		// 直接定位、无动画。
		function RollDigit(props) {
			var digit = props.digit;
			var stripRef = react.useRef(null);
			var animRef = react.useRef(null);
			var prevRef = react.useRef(0);
			react.useEffect(function () {
				var el = stripRef.current;
				if (!el) return undefined;
				var prev = prevRef.current;
				prevRef.current = digit;
				var target = "translateY(" + (-digit * 10) + "%)";
				var reduced = false;
				try { reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
				if (reduced || prev === digit || typeof el.animate !== "function") {
					el.style.transform = target;
					return undefined;
				}
				if (animRef.current) { try { animRef.current.cancel(); } catch (e) {} animRef.current = null; }
				var anim = el.animate(
					[
						{ transform: "translateY(" + (-prev * 10) + "%)" },
						{ transform: target }
					],
					{ duration: 350, easing: "cubic-bezier(.34,1.56,.64,1)" }
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
		function renderSegment(props, group, open, sessionId) {
			if (group.count === 1) return renderBuiltinToolCall(props);
			if (!group.isLeader) {
				return open ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinToolCall(props)) : hiddenMarker();
			}
			var toggle = function () {
				setGroupOpen(sessionId, group.leaderKey, !open);
			};
			// 组内有失败命令时：标题标红，并在"运行了 N 条命令"后追加失败数。
			var label = _T("headerPrefix") + " " + group.count + " " + _T("headerSuffix");
			if (group.failures > 0) {
				label += "——" + group.failures + _T("failureSuffix");
			}
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(group.count), "data-ccg-open": open ? "true" : undefined },
				react.createElement(
					GroupHeader,
					{ count: group.count, open: open, onToggle: toggle, label: label, danger: group.failures > 0, isTurn: false }
				),
				react.createElement(FoldClip, { open: open }, renderBuiltinToolCall(props))
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
			// 运行中展示指标：消耗token 在无新 usage 时按观测速率外推增长，真实值到达时校正
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
				if (!fold.isTurnHeader) {
					// 成员：大组头展开时显示自己的段级内容；收起时隐藏（整行 display:none）。
					return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderSegment(props, group, open, sessionId)) : hiddenMarker();
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
					react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderSegment(props, group, open, sessionId))
				);
			}

			// 未整回合折叠：现有段级分组逻辑。
			return renderSegment(props, group, open, sessionId);
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
			// 运行中展示指标：消耗token 在无新 usage 时按观测速率外推增长，真实值到达时校正
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);

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
			if (!fold.isTurnHeader) {
				// 中间 Think 节点：大组头展开时显示自己的 Think 行；收起时隐藏。
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
			// 运行中展示指标：消耗token 在无新 usage 时按观测速率外推增长，真实值到达时校正
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
