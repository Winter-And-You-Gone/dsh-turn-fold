// dsh-turn-fold: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。只负责折叠。
//
// 行为：
//   1. Think 块保持内置默认（收起、点击展开），不做任何改动。
//   2. 工具调用按 Think 段级分组：下一个 Think 出现后自动折叠成段级组头；运行中保持展开。
//   3. 回合结束后，整回合（所有 Think + 工具调用 + 上下文注入）收成一个大组头，
//      大组头显示本轮耗时/token/tok/s/缓存命中率；最终总结消息只显示正文。
//   4. 点击组头可手动展开/折叠。
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
			failureSuffix: "条执行失败"
		};

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
				"[data-ccg-turn-folded] [data-variant=\"think\"]{display:none}"
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
		// 回合结束后整回合收成一个大组头，默认折叠；点击大组头展开/收起。
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
		/** 回合折叠状态：false = 折叠（默认）；true = 已手动展开。 */
		function useTurnExpanded(sessionId, turn) {
			return useSyncExternalStore(subscribeTurnOverrides, function () {
				if (turn === undefined) return false;
				var v = turnOverrides.get(turnKeyOf(sessionId, turn));
				return v === undefined ? false : v;
			});
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
		 * 计算"整回合折叠"信息：回合结束后，把本回合所有 Think + 工具调用收成一个大组头，
		 * 只保留最终总结消息（+官方 turn-tail 脚注）可见。
		 *   - closed：回合是否已结束（turnEnds 里有记录，turn/end 事件驱动）。
		 *   - toolCount：回合内工具调用总数（大组头文案"运行了 N 条命令"的 N）。
		 *   - finalAssistantKey：回合内最后一条 assistant-step（最终总结，绝不折叠）。
		 *   - headerKey：回合内第一条"中间节点"（tool-call / context / 非最终 assistant-step），由它渲染大组头。
		 */
		function computeTurnFold(order, nodes, locations, turnEnds, ourNode) {
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
			return {
				turn: turn,
				closed: closed,
				toolCount: toolCount,
				headerKey: headerKey,
				finalAssistantKey: finalAssistantKey,
				ourKey: ourKey,
				outsideScope: outsideScope,
				// 只有能同时定位到"自己的 key"、"最终总结消息"和"作用域内的组头"
				// 时才允许折叠：否则（比如 turn/end 与最终消息索引的瞬时竞态，
				// 或回合内没有任何位于用户消息之后的中间节点）绝不能隐藏任何内容。
				foldable: ourKey !== null && finalAssistantKey !== null && headerKey !== null,
				isTurnHeader: ourKey !== null && ourKey === headerKey,
				isFinalAssistant: ourKey !== null && ourKey === finalAssistantKey
			};
		}

		// ---- 回合性能指标（大组头文案） ----
		/** 汇总本回合的耗时 / 消耗 token / tok/s / 缓存命中率。 */
		function computeTurnMetrics(turn, nodes, locations, turnTimings) {
			if (turn === undefined || !nodes || !locations || !turnTimings) return null;
			var keys = locations.getTurn(turn) || [];
			var durationMs;
			var timing = turnTimings.get(turn);
			if (timing && typeof timing.startTime === "number" && typeof timing.endTime === "number") {
				durationMs = Math.max(0, timing.endTime - timing.startTime);
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
			if (durationMs === undefined && !hasUsage && tokensPerSecond === undefined) return null;
			return {
				durationMs: durationMs,
				// 消耗 = 计费输入（uncached + cacheRead + cacheWrite）+ 输出
				tokens: hasUsage ? (billedInput + output) : undefined,
				tokensPerSecond: tokensPerSecond,
				cacheHitPercent: hasUsage && billedInput > 0 ? Math.round(cacheRead / billedInput * 100) : undefined
			};
		}
		/** 耗时格式化：>=1 小时 → "x时x分x秒"；>=1 分钟 → "x分x秒"；否则 → "x秒"。 */
		function formatTurnDuration(ms) {
			var total = Math.floor(ms / 1000);
			if (total >= 3600) {
				return Math.floor(total / 3600) + "时" + Math.floor((total % 3600) / 60) + "分" + (total % 60) + "秒";
			}
			if (total >= 60) {
				return Math.floor(total / 60) + "分" + (total % 60) + "秒";
			}
			return total + "秒";
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
			if (metrics.durationMs !== undefined) parts.push("耗时" + formatTurnDuration(metrics.durationMs));
			if (metrics.tokens !== undefined) parts.push("消耗" + metrics.tokens + "token");
			if (metrics.tokensPerSecond !== undefined) parts.push(formatTokPerSec(metrics.tokensPerSecond) + "tok/s");
			if (metrics.cacheHitPercent !== undefined) parts.push("缓存命中" + metrics.cacheHitPercent + "%");
			return parts.join("，");
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

		// ---- 组头组件 ----
		// 优先用官方 DisclosureRow（24px 行高、16px 前导、14px 官方 chevron、14px/24px 标题），
		// 与 Think / 工具卡片的折叠行样式一致；平台原语缺失时回退到自带兜底行。
		function GroupHeader(props) {
			var count = props.count;
			var open = props.open;
			var onToggle = props.onToggle;
			// label 可选：大组头传指标文案；缺省用"运行了 N 条命令"。
			var label = props.label || (CONFIG.headerPrefix + " " + count + " " + CONFIG.headerSuffix);
			// danger：组内有执行失败的命令时标题标红。
			var danger = props.danger === true;
			var titleClass = "ccg-header-title" + (danger ? " ccg-header-danger" : "");
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
						title: label,
						open: open,
						expandable: true,
						expandOnRowClick: true,
						previewChevron: false,
						onToggle: onToggle
					},
					props.children
				);
			}
			return react.createElement(
				"div",
				{
					className: "ccg-header ccg-header-fallback",
					role: "button",
					tabIndex: 0,
					"aria-expanded": !!open,
					title: open ? "折叠本组" : "展开本组",
					"data-open": open ? "true" : undefined,
					onClick: onToggle,
					onKeyDown: function (e) {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
					}
				},
				react.createElement("span", { className: "ccg-chevron" }, "›"),
				react.createElement("span", { className: "ccg-title" + (danger ? " ccg-header-danger" : "") }, label),
				open ? props.children : null
			);
		}

		// ---- 段级分组渲染（现有行为）：单条原样 / 非 leader 隐藏 / leader 渲染组头 ----
		function renderSegment(props, group, open, sessionId) {
			if (group.count === 1) return renderBuiltinToolCall(props);
			if (!group.isLeader) {
				return open ? renderBuiltinToolCall(props) : hiddenMarker();
			}
			var toggle = function () {
				setGroupOpen(sessionId, group.leaderKey, !open);
			};
			// 组内有失败命令时：标题标红，并在"运行了 N 条命令"后追加失败数。
			var label = CONFIG.headerPrefix + " " + group.count + " " + CONFIG.headerSuffix;
			if (group.failures > 0) {
				label += "——" + group.failures + CONFIG.failureSuffix;
			}
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(group.count), "data-ccg-open": open ? "true" : undefined },
				react.createElement(
					GroupHeader,
					{ count: group.count, open: open, onToggle: toggle, label: label, danger: group.failures > 0 },
					open ? renderBuiltinToolCall(props) : null
				)
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
			var group = useMemo(function () { return computeGroup(order, nodes, node); }, [order, nodes, node]);
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node); }, [order, nodes, locations, turnEnds, node]);
			var leaderKey = group ? group.leaderKey : "";
			var manual = useGroupOverride(sessionId, leaderKey);
			var turn = fold ? fold.turn : undefined;
			var turnExpanded = useTurnExpanded(sessionId, turn);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings); }, [turn, nodes, locations, turnTimings]);

			// 兜底：找不到自己的节点时，原样委托内置渲染（补齐 renderSlot），绝不白屏。
			if (!group) return renderBuiltinToolCall(props);

			// 有效展开状态 = 手动选择优先；否则跟随自动规则。
			var open = manual === null ? !group.autoCollapsed : manual;

			// 回合已结束 → 整回合折叠成一个大组头（段级组头不再各自显示）。
			// 折叠作用域之外（用户消息上方）的节点不参与整回合折叠。
			// 判定只看"是否存在可折叠的中间节点"（foldable），不要求本回合必须有
			// 工具调用：仅上下文注入/思考的纯问答回合同样收成一个大组头。
			if (fold && fold.closed && fold.foldable && !fold.outsideScope) {
				if (!fold.isTurnHeader) {
					// 成员：折叠时隐藏；展开大组头后显示自己的段级内容。
					return turnExpanded ? renderSegment(props, group, open, sessionId) : hiddenMarker();
				}
				// 组头节点：渲染大组头（文案 = 本回合性能指标，无数据则退回"运行了 N 条命令"）；
				// 展开时其下接自己的段级内容。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnExpanded);
				};
				var turnLabel = turnHeaderLabel(metrics) || (CONFIG.headerPrefix + " " + fold.toolCount + " " + CONFIG.headerSuffix);
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnExpanded ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(
						GroupHeader,
						{ label: turnLabel, count: fold.toolCount, open: turnExpanded, onToggle: toggleTurn },
						turnExpanded ? renderSegment(props, group, open, sessionId) : null
					)
				);
			}

			// 未整回合折叠：现有段级分组逻辑。
			return renderSegment(props, group, open, sessionId);
		}

		// ---- 助手节点（Think / 最终消息）：整回合折叠支持 ----
		// 回合结束后，除最终总结消息外的所有 assistant-step（即 Think 行）都收进大组头；
		// 运行中 / 未折叠时原样委托内置渲染，行为与官方完全一致。
		function GroupedAssistantView(props) {
			var node = props.node;
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			var order = useSession(function (s) { return s.chat.order; });
			var nodes = useSession(function (s) { return s.chat.nodes; });
			var locations = useSession(function (s) { return s.chat.locations; });
			var turnEnds = useSession(function (s) { return s.turnEnds; });
			var turnTimings = useSession(function (s) { return s.turnTimings; });
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node); }, [order, nodes, locations, turnEnds, node]);
			var turn = fold ? fold.turn : undefined;
			var turnExpanded = useTurnExpanded(sessionId, turn);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings); }, [turn, nodes, locations, turnTimings]);

			// 未到回合结束 / 无法安全定位最终消息或组头（回合内无任何中间节点）/
			// 节点在折叠作用域之外（用户消息上方）：原样委托内置渲染。
			// 不要求本回合必须有工具调用——仅上下文注入/思考的回合同样折叠。
			if (!fold || !fold.closed || !fold.foldable || fold.outsideScope) {
				return renderBuiltinAssistant(props);
			}
			if (fold.isFinalAssistant) {
				// 最终总结消息保持可见，但回合结束后隐藏其内部的 Think 行（"只显示最终结果"）。
				return react.createElement(
					"div",
					{ "data-ccg-turn-folded": "true", style: { display: "contents" } },
					renderBuiltinAssistant(props)
				);
			}
			if (!fold.isTurnHeader) {
				// 中间 Think 节点：折叠时隐藏；展开大组头后显示自己的 Think 行。
				return turnExpanded ? renderBuiltinAssistant(props) : hiddenMarker();
			}
			// 组头节点：渲染大组头（文案 = 本回合性能指标）；展开时其下接自己的内容（Think 行）。
			var toggleTurn = function () {
				setTurnOpen(sessionId, fold.turn, !turnExpanded);
			};
			var turnLabel = turnHeaderLabel(metrics) || (CONFIG.headerPrefix + " " + fold.toolCount + " " + CONFIG.headerSuffix);
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnExpanded ? "true" : undefined, "data-ccg-turn": "true" },
				react.createElement(
					GroupHeader,
					{ label: turnLabel, count: fold.toolCount, open: turnExpanded, onToggle: toggleTurn },
					turnExpanded ? renderBuiltinAssistant(props) : null
				)
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
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node); }, [order, nodes, locations, turnEnds, node]);
			var turn = fold ? fold.turn : undefined;
			var turnExpanded = useTurnExpanded(sessionId, turn);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings); }, [turn, nodes, locations, turnTimings]);

			// 未折叠：原样渲染；折叠时作为成员隐藏，展开大组头后恢复。
			// 折叠作用域之外（用户消息上方）的上下文行不参与折叠，始终原样渲染。
			// 不要求本回合必须有工具调用——仅上下文注入/思考的回合同样折叠。
			if (!fold || !fold.closed || !fold.foldable || fold.outsideScope) {
				return renderBuiltinContext(props);
			}
			if (fold.isTurnHeader) {
				// 组头节点：渲染大组头（文案 = 本回合性能指标）；展开时其下接自己的内容（上下文注入行）。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnExpanded);
				};
				var turnLabel = turnHeaderLabel(metrics) || (CONFIG.headerPrefix + " " + fold.toolCount + " " + CONFIG.headerSuffix);
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnExpanded ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(
						GroupHeader,
						{ label: turnLabel, count: fold.toolCount, open: turnExpanded, onToggle: toggleTurn },
						turnExpanded ? renderBuiltinContext(props) : null
					)
				);
			}
			return turnExpanded ? renderBuiltinContext(props) : hiddenMarker();
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
