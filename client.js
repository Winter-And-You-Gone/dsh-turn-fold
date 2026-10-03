// dsh-turn-fold: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。
//
// 架构（Native Fold Engine 重构版）：
//   DSH 官方负责全部折叠语义——分组、成员归属、展开/收起状态、分页、搜索显隐、
//   历史状态。本插件只替换官方 `conversation.chat.node` 的 `turn-process` 渲染器，
//   提供一根比官方更丰富的 Turn 栏（扑克牌视觉 + 真实性能指标 + 运行中状态条），
//   并用一层纯 CSS 的 Poker 皮给官方 Step 分组栏换装。
//
//   - Turn 折叠状态完全来自官方 owner state（TurnProcessOwnerProps）：
//       turnProcess.foldable / hasContent / open / setOpen / spec
//     点击 Turn 栏只调用 turnProcess.setOpen()；官方 ChatNodeSeat 自己负责
//     隐藏/显示折叠成员（data-turn-process-hidden），插件绝不碰成员可见性。
//   - 运行中（回合未结束）：官方 turn-process 节点在 turn/start 即投影，但官方
//     渲染器此时返回 null；本渲染器在此阶段显示 Running Turn Bar——0 秒即出现、
//     耗时实时走动、token/tok/s/缓存随真实数据到达而更新。它只是状态表面：
//     不维护任何 Fold 状态、不隐藏任何成员、回合结束后由同一根栏平滑交接为
//     完整的收起态 Turn 栏。
//   - 指标全部来自官方真实数据：TurnLocation.start/end（耗时）、step data 的
//     assistant usage 与 finalNode.timing（token / TTFT）、turn-tail 的官方聚合
//     tokenUsage（精确计费）。没有伪造增长（旧版的 +1/+11 动画偏移已删除）：
//     真实数据变化 → 数字滚轮动画；真实数据不变 → 数字不变。
//   - Step 分组栏完全由官方渲染（ChatGroupSeat / ProcessGroupHeader / useDisclosure），
//     插件只通过官方 DOM 钩子（data-step-process / data-step-process-icon /
//     data-process-activity）做一层 CSS Poker 皮。软依赖：钩子失效时皮消失、
//     官方图标与折叠行为原样保留。
//   - 设置完全独立于官方 transcriptView（插件绝不读、更不写该字段）：
//     localStorage `dsh-turn-fold:settings`——Turn 栏字段显隐、图标风格、
//     Step 皮开关。官方 Compact / Standard / Detailed / Verbose 四档照常工作。
//   - 规范收尾（practices 对齐）：零宿主包运行时依赖（chevron/通知全自有，
//     不 require 任何 @deepseek-ai/* client 包）；设置面板由打开它的 Turn 栏
//     自身 React 树渲染（无 body portal / 独立 root）；订阅走官方最小切片
//     （useTurnData('turn-tail') + turnDataSource(turn,'assistant-step')，不订阅
//     整份快照）；唯一记录在案的软兼容点 = 最小 <style> 注入（官方尚无插件样式
//     注册 API，见 README「软依赖」）。
//
// 实现方式：
//   - priority:-1 覆盖（shadow）官方 conversation.chat.node 的 key "turn-process"
//     （这是插件替换的唯一官方渲染器）。
//   - Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})。
// 纯浏览器 bundle：仅在 window 存在时注册。host（Node）进程若误导入本文件
// 应静默跳过，而不是抛 ReferenceError 拖垮整个插件树。
if (typeof window !== "undefined" && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
	id: "@winteries/dsh-turn-fold",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ---- 多语言支持 ----
		// 动态语言：DSH 切换界面语言时设置 document.documentElement.lang
		// （dsh-client-locale），插件每次读取当前值，随 DSH 语言切换而切换；
		// 无 document（部分测试/SSR）时回退 navigator 语言；两者都无则英语。
		function currentLocale() {
			var lang = "";
			try {
				if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang) {
					lang = document.documentElement.lang;
				}
			} catch (e) { /* 忽略 */ }
			if (!lang && typeof navigator !== "undefined" && navigator) {
				var langList = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]);
				for (var li = 0; li < langList.length; li++) {
					if (langList[li] && String(langList[li]).indexOf("zh") !== -1) { lang = "zh"; break; }
				}
			}
			return String(lang).toLowerCase().indexOf("zh") !== -1 ? "zh" : "en";
		}
		// 插件自有文案（只覆盖插件自己的 UI；官方折叠文案/Step 标题一律由官方 t 提供）。
		var TEXTS = {
			zh: {
				ariaTurn: "展开回合",
				ariaTurnExpanded: "折叠回合",
				statusStopped: "已停止",
				statusFailed: "运行失败",
				statusInterrupted: "已中断",
				// 回合折叠栏字段设置弹窗
				fieldSettings: "回合折叠栏字段",
				fieldSettingsHint: "选择要在回合折叠栏中显示的字段",
				fieldDuration: "耗时",
				fieldDurationDesc: "回合总时长",
				fieldTtft: "首字",
				fieldTtftDesc: "TTFT 首字延迟",
				fieldTokens: "Token",
				fieldTokensDesc: "官方计费 token 总数",
				fieldTps: "tok/s",
				fieldTpsDesc: "生成速率",
				fieldCacheHit: "缓存命中",
				fieldCacheHitDesc: "缓存命中百分比",
				fieldSettingsDone: "完成",
				// 统一折叠栏图标模式（Turn 前导图标 + Step 皮共用一个设置）
				foldIconLabel: "折叠栏图标",
				foldIconPoker: "动态扑克牌",
				foldIconPokerDesc: "回合栏与步骤栏使用扑克牌动画",
				foldIconNative: "官方图标",
				foldIconNativeDesc: "回合栏使用官方折叠箭头风格，步骤栏恢复官方活动图标",
			},
			en: {
				ariaTurn: "Expand turn",
				ariaTurnExpanded: "Collapse turn",
				statusStopped: "Stopped",
				statusFailed: "Failed",
				statusInterrupted: "Interrupted",
				// Turn fold bar field settings popup
				fieldSettings: "Turn bar fields",
				fieldSettingsHint: "Choose which fields to show on the turn bar",
				fieldDuration: "Duration",
				fieldDurationDesc: "Turn elapsed time",
				fieldTtft: "TTFT",
				fieldTtftDesc: "Time to first token",
				fieldTokens: "Tokens",
				fieldTokensDesc: "Official billed token total",
				fieldTps: "tok/s",
				fieldTpsDesc: "Generation rate",
				fieldCacheHit: "Cache hit",
				fieldCacheHitDesc: "Cache hit percentage",
				fieldSettingsDone: "Done",
				// Unified fold-icon mode (one setting drives Turn leading icon + Step skin)
				foldIconLabel: "Fold icons",
				foldIconPoker: "Poker",
				foldIconPokerDesc: "Turn and Step bars use the poker animation",
				foldIconNative: "Native",
				foldIconNativeDesc: "Turn keeps enhanced fields with an official-style chevron; Step restores official activity icons",
			}
		};
		/** 取当前语言下的文案；缺失键回退英文，再缺失返回键名本身。 */
		function _T(key) {
			var dict = TEXTS[currentLocale()] || TEXTS.en;
			return dict[key] !== undefined ? dict[key] : key;
		}

		// ---- React ----
		var react = require("react");
		var useSyncExternalStore = react.useSyncExternalStore;

		// ---- 独立 React 根：不再使用 ----
		// 设置面板已改由打开它的 Turn 栏自身 React 树渲染（无 body portal / 独立 root），
		// 插件不再引入任何宿主侧渲染器包，也不再往 document.body 写任何节点。

		// ---- 插件版本号 ----
		// 仅用于图标包兼容校验：loadIconConfig 读取 localStorage 图标包时，其 meta.compat
		// 若声明 ">=x.y.z" 就与这个版本号逐段比较，决定图标包是否仍适用。发版时随
		// package.json 的 version 同步更新。
		var NOTICE_VERSION = "0.5.4";

		// ---- 自有 UI 原语（零宿主包依赖） ----
		// 官方插件实践（cordis-plugin-development/references/practices.md）：不要运行时
		// require 任何 Harness Client 包。native 模式的折叠 chevron 用插件自己的 SVG，
		// 几何**逐值对齐官方 IconChevronDownOutlineRegular**（ui-primitives icons/index.tsx）：
		// viewBox 0 0 16 16、size 14、fill none、stroke currentColor、
		// strokeWidth = ICON_REGULAR_STROKE = 1、
		// path "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"；
		// 展开态 = 官方同款 transform rotate(180deg)（TurnProcessNodeView.module.css：
		// .root[data-open] .chevron，transition transform 100ms ease）。
		// SVG 属性必须用 React 驼峰命名（strokeWidth/strokeLinecap/strokeLinejoin）：
		// 连字符形式 React 会逐条报 "Invalid DOM property"。
		function NativeChevronIcon(props) {
			var open = props.open === true;
			return react.createElement("svg", {
				viewBox: "0 0 16 16",
				width: props.size || 14,
				height: props.size || 14,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: props.strokeWidth || 1,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				style: props.open === undefined ? undefined : {
					transform: open ? "rotate(180deg)" : undefined,
					transition: "transform 100ms ease"
				}
			},
				// 官方 down 折线（展开由 rotate(180deg) 翻成向上，与官方 CSS 同机制）
				react.createElement("path", { d: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" })
			);
		}

		// ---- 插件设置（独立于官方 transcriptView；localStorage 持久化） ----
		// DSH Settings 决定"怎么折叠"（Compact/Standard/Detailed/Verbose 官方四档照常），
		// 本插件设置只决定"折叠长什么样"：Turn 栏字段显隐、前导图标风格、Step 皮。
		// key: dsh-turn-fold:settings。
		var SETTINGS_KEY = "dsh-turn-fold:settings";
		// Turn 栏可显字段（旧版的 folded 字段随插件折叠引擎一起删除——步数由官方
		// 折叠语义决定，插件不再自行统计）。
		var FIELD_KEYS = ["duration", "ttft", "tokens", "tokensPerSecond", "cacheHit"];
		var FIELD_DEFAULTS = { duration: true, ttft: true, tokens: true, tokensPerSecond: true, cacheHit: true };
		// 统一图标模式：Turn 前导图标与 Step 皮的唯一开关（一个设置管两处，
		// 不再允许 Turn=poker/Step=native 这类不一致组合）。
		var ICON_STYLES = ["poker", "native"];
		var settings = { fields: Object.assign({}, FIELD_DEFAULTS), iconStyle: "poker" };
		(function loadSettings() {
			try {
				var raw = (typeof window !== "undefined" && window.localStorage && window.localStorage.getItem(SETTINGS_KEY)) || "";
				if (raw) {
					var parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object") {
						if (parsed.fields && typeof parsed.fields === "object") {
							for (var fi = 0; fi < FIELD_KEYS.length; fi++) {
								var fk = FIELD_KEYS[fi];
								if (typeof parsed.fields[fk] === "boolean") settings.fields[fk] = parsed.fields[fk];
							}
						}
						// 统一图标模式：新字段优先；旧双字段（foldIcon / stepSkin）只作一次性
						// 迁移读取——任一曾明确选过 native，升级后保持 native（老用户不会突然
						// 重新出现 Poker）。迁移只发生在 load 层，运行时不再维护两套状态。
						if (parsed.iconStyle === "poker" || parsed.iconStyle === "native") settings.iconStyle = parsed.iconStyle;
						else if (parsed.foldIcon === "native" || parsed.stepSkin === "native") settings.iconStyle = "native";
					}
				}
			} catch (e) { /* localStorage 不可用或数据损坏：走默认 */ }
		})();
		function saveSettings() {
			try {
				var store = typeof window !== "undefined" && window.localStorage;
				if (!store) return;
				// 合并保存：不主动清空用户 localStorage 里的其它未知字段，
				// 只覆盖本插件管理的两个键（fields / iconStyle）。
				var merged = {};
				try {
					var previous = store.getItem(SETTINGS_KEY);
					if (previous) {
						var parsedPrevious = JSON.parse(previous);
						if (parsedPrevious && typeof parsedPrevious === "object") merged = parsedPrevious;
					}
				} catch (e) { /* 旧值损坏：直接覆盖 */ }
				// 旧双字段（foldIcon / stepSkin）在 load 层已迁移进 iconStyle，这里一次性
				// 删除——下一次真实保存后不再永久残留（未知字段保留）。
				delete merged.foldIcon;
				delete merged.stepSkin;
				merged.fields = settings.fields;
				merged.iconStyle = settings.iconStyle;
				store.setItem(SETTINGS_KEY, JSON.stringify(merged));
			} catch (e) { /* 忽略写入失败 */ }
		}

		// -- 字段显隐 --
		var fieldVisibilityListeners = new Set();
		var fieldVisibilityVersion = 0;
		function subscribeFieldVisibility(fn) {
			fieldVisibilityListeners.add(fn);
			return function () { fieldVisibilityListeners.delete(fn); };
		}
		function notifyFieldVisibility() {
			fieldVisibilityVersion++;
			var fns = [];
			fieldVisibilityListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function getFieldVisibilityVersion() { return fieldVisibilityVersion; }
		function setFieldVisible(key, visible) {
			if (!settings.fields.hasOwnProperty(key)) return;
			if (settings.fields[key] === !!visible) return;
			settings.fields[key] = !!visible;
			saveSettings();
			notifyFieldVisibility();
		}
		/** 弹窗中逐字段开关（checkbox 双向绑定用）。 */
		function useFieldVisibility() {
			useSyncExternalStore(subscribeFieldVisibility, getFieldVisibilityVersion);
			return settings.fields;
		}
		/** 按字段显隐设置归一化指标槽位（turnHeaderLabel 据此渲染值或 "—"）：
		 *  启用的字段槽位始终存在（key 显式设置——有值带值、无值 undefined），
		 *  运行中从 0 秒起布局稳定，真实值到达只替换 "—"，完成瞬间不新增字段段；
		 *  隐藏的字段整体剔除（既不显示值也不显示 "—"——关闭的字段绝不因占位加回）。
		 *  全部隐藏时返回空对象（turnHeaderLabel → 空文案 → 调用方 fallback 兜底）。
		 *  outputTokens（tok/s 计算用）非 UI 字段，有值则透传。 */
		function filterVisibleMetrics(metrics) {
			if (!metrics) return metrics;
			var m = metrics;
			var result = null;
			if (settings.fields.duration) { result = result || {}; result.durationMs = m.durationMs; }
			if (settings.fields.ttft) { result = result || {}; result.ttftMs = m.ttftMs; }
			if (settings.fields.tokens) { result = result || {}; result.tokens = m.tokens; }
			if (settings.fields.tokensPerSecond) { result = result || {}; result.tokensPerSecond = m.tokensPerSecond; }
			if (settings.fields.cacheHit) { result = result || {}; result.cacheHitPercent = m.cacheHitPercent; }
			if (!result) return {};
			if (m.outputTokens !== undefined) result.outputTokens = m.outputTokens;
			return result;
		}

		// -- 统一图标模式（poker / native）：Turn 前导图标 + Step 皮的唯一状态 --
		// 一套 listeners / version / notify 同时驱动两处：Turn 组件经 useIconStyle()
		// 重渲染换前导图标，Step 皮经 applyIconStyle() 切样式表总闸——运行时不可能
		// 再出现 Turn 与 Step 不同步的组合。
		var iconStyleListeners = new Set();
		var iconStyleVersion = 0;
		function subscribeIconStyle(fn) {
			iconStyleListeners.add(fn);
			return function () { iconStyleListeners.delete(fn); };
		}
		function notifyIconStyle() {
			iconStyleVersion++;
			var fns = [];
			iconStyleListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function getIconStyleVersion() { return iconStyleVersion; }
		function setIconStyle(style) {
			if (ICON_STYLES.indexOf(style) === -1) return;
			if (settings.iconStyle === style) return;
			settings.iconStyle = style;
			saveSettings();
			applyIconStyle();
			notifyIconStyle();
		}
		function getIconStyle() { return settings.iconStyle; }
		/** 订阅图标模式变化（组件内调用以触发重渲染）。 */
		function useIconStyle() {
			useSyncExternalStore(subscribeIconStyle, getIconStyleVersion);
			return settings.iconStyle;
		}
		/** 统一视觉应用：Step 皮的两张样式表（皮肤 + 牌数桥）随 iconStyle 总闸启停——
		 *  native 时 disabled=true，官方 ProcessGroupHeader 自己的 activity icon /
		 *  chevron / shimmer / title / disclosure 原样恢复（插件不改官方 DOM）。
		 *  Turn 没有 DOM 副作用：组件经 useIconStyle() 重渲染决定前导图标。 */
		function applyIconStyle() {
			try {
				var native = settings.iconStyle !== "poker";
				if (skinStyleEl !== null) skinStyleEl.disabled = native;
				// 牌数桥样式表同受总闸控制（native = 官方图标原样，桥规则一并停用）
				if (stepCardStyleEl) stepCardStyleEl.disabled = native;
			} catch (e) { /* 忽略 */ }
		}

		// ---- 图标配置（外置数据源；先于 CSS 注入——Step 皮的 CSS 由花色数据生成） ----
		// 图标数据从独立文件夹 icons/default.json 注入到 ICON_DEFAULTS（见
		// scripts/sync-icons.mjs，`node scripts/sync-icons.mjs --inject`）。
		// 运行时优先使用 localStorage 的图标包（key: dsh-turn-fold:icons），
		// 未设置/损坏时回退 ICON_DEFAULTS 内置默认。图标包结构 = default.json。
		var ICONS_STORAGE_KEY = "dsh-turn-fold:icons";
		var ICON_DEFAULTS = /*__ICON_DEFAULTS__*/ 


{
  "meta": {
    "version": 1,
    "description": "dsh-turn-fold 图标唯一数据源",
    "compat": ">=0.3.1"
  },
  "pokerR": 1.08,
  "pokerPips": {
    "spade": {
      "path": "<path d=\"M12 2.35 C10.25 5.05 4.15 8.65 4.15 13.05 C4.15 15.65 6.05 17.35 8.45 17.35 C9.75 17.35 10.75 16.82 11.35 15.88 C11.28 18.05 10.55 19.48 8.55 21.45 H15.45 C13.45 19.48 12.72 18.05 12.65 15.88 C13.25 16.82 14.25 17.35 15.55 17.35 C17.95 17.35 19.85 15.65 19.85 13.05 C19.85 8.65 13.75 5.05 12 2.35 Z\" fill=\"currentColor\"/>",
      "cx": 12,
      "cy": 12,
      "factor": 1
    },
    "heart": {
      "path": "<path d=\"M12 21.25 C10.35 19.35 4 15.1 4 9.65 C4 6.55 6.1 4.4 8.75 4.4 C10.25 4.4 11.35 5.18 12 6.45 C12.65 5.18 13.75 4.4 15.25 4.4 C17.9 4.4 20 6.55 20 9.65 C20 15.1 13.65 19.35 12 21.25 Z\" fill=\"currentColor\"/>",
      "cx": 12,
      "cy": 12,
      "factor": 1
    },
    "diamond": {
      "path": "<path d=\"M12 2.45 L20.1 12 L12 21.55 L3.9 12 Z\" fill=\"currentColor\"/>",
      "cx": 12,
      "cy": 12,
      "factor": 1
    },
    "club": {
      "path": "<circle cx=\"12\" cy=\"7.05\" r=\"4.15\" fill=\"currentColor\"/><circle cx=\"7.45\" cy=\"14.05\" r=\"4.15\" fill=\"currentColor\"/><circle cx=\"16.55\" cy=\"14.05\" r=\"4.15\" fill=\"currentColor\"/><path d=\"M10.25 13.65 C10.85 16.55 10.7 18.7 8.45 21.45 H15.55 C13.3 18.7 13.15 16.55 13.75 13.65 Z\" fill=\"currentColor\"/>",
      "cx": 12,
      "cy": 12,
      "factor": 1
    }
  },
  "pokerSVGBase": {
    "hThree": 8.5,
    "hFive": 8,
    "pokerRatio": 0.7142857142857143,
    "pipScaleThree": 0.28,
    "pipScaleFive": 0.24
  },
  "pokerTransforms": {
    "stack3": {
      "1": "translate(1, 2.25)",
      "2": "translate(0, 0.25)",
      "3": "translate(-1, -1.75)"
    },
    "stack5": {
      "1": "translate(1.6, 1.6)",
      "2": "translate(0.8, 0.8)",
      "3": "translate(0, 0)",
      "4": "translate(-0.8, -0.8)",
      "5": "translate(-1.6, -1.6)"
    },
    "fan3": {
      "1": "translate(0, -0.18) rotate(-26 8 12)",
      "2": "translate(0, -0.18)",
      "3": "translate(0, -0.18) rotate(26 8 12)"
    },
    "fan5": {
      "1": "translate(0, -0.608) rotate(-32 8 12)",
      "2": "translate(0, -0.608) rotate(-16 8 12)",
      "3": "translate(0, -0.608)",
      "4": "translate(0, -0.608) rotate(16 8 12)",
      "5": "translate(0, -0.608) rotate(32 8 12)"
    }
  },
  "pokerSpin": {
    "h": 9.6,
    "pokerRatio": 0.7142857142857143,
    "r": 1.296,
    "pipScale": 0.2347826086956522,
    "strokeW": 0.84,
    "restAngle": 35.5377,
    "scaleKeys": "1 1;0.996195 1;0.984808 1;0.965926 1;0.939693 1;0.906308 1;0.866025 1;0.819152 1;0.766044 1;0.707107 1;0.642788 1;0.573576 1;0.5 1;0.422618 1;0.34202 1;0.258819 1;0.173648 1;0.087156 1;0 1;-0.087156 1;-0.173648 1;-0.258819 1;-0.34202 1;-0.422618 1;-0.5 1;-0.573576 1;-0.642788 1;-0.707107 1;-0.766044 1;-0.819152 1;-0.866025 1;-0.906308 1;-0.939693 1;-0.965926 1;-0.984808 1;-0.996195 1;-1 1;-0.996195 1;-0.984808 1;-0.965926 1;-0.939693 1;-0.906308 1;-0.866025 1;-0.819152 1;-0.766044 1;-0.707107 1;-0.642788 1;-0.573576 1;-0.5 1;-0.422618 1;-0.34202 1;-0.258819 1;-0.173648 1;-0.087156 1;0 1;0.087156 1;0.173648 1;0.258819 1;0.34202 1;0.422618 1;0.5 1;0.573576 1;0.642788 1;0.707107 1;0.766044 1;0.819152 1;0.866025 1;0.906308 1;0.939693 1;0.965926 1;0.984808 1;0.996195 1;1 1",
    "scaleKeyTimes": "0;0.013889;0.027778;0.041667;0.055556;0.069444;0.083333;0.097222;0.111111;0.125;0.138889;0.152778;0.166667;0.180556;0.194444;0.208333;0.222222;0.236111;0.25;0.263889;0.277778;0.291667;0.305556;0.319444;0.333333;0.347222;0.361111;0.375;0.388889;0.402778;0.416667;0.430556;0.444444;0.458333;0.472222;0.486111;0.5;0.513889;0.527778;0.541667;0.555556;0.569444;0.583333;0.597222;0.611111;0.625;0.638889;0.652778;0.666667;0.680556;0.694444;0.708333;0.722222;0.736111;0.75;0.763889;0.777778;0.791667;0.805556;0.819444;0.833333;0.847222;0.861111;0.875;0.888889;0.902778;0.916667;0.930556;0.944444;0.958333;0.972222;0.986111;1"
  },
  "pokerAnimSVG": "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  viewBox=\"0 0 16 16\"\n  width=\"16\"\n  height=\"16\"\n  style=\"color:var(--card-stroke,#fff)\">\n\n  <defs>\n    <g id=\"pip-heart\">\n      <path d=\"M12 21.25 C10.35 19.35 4 15.1 4 9.65 C4 6.55 6.1 4.4 8.75 4.4 C10.25 4.4 11.35 5.18 12 6.45 C12.65 5.18 13.75 4.4 15.25 4.4 C17.9 4.4 20 6.55 20 9.65 C20 15.1 13.65 19.35 12 21.25 Z\"/>\n    </g>\n\n    <g id=\"pip-diamond\">\n      <path d=\"M12 2.45 L20.1 12 L12 21.55 L3.9 12 Z\"/>\n    </g>\n\n    <g id=\"pip-spade\">\n      <path d=\"M12 2.35 C10.25 5.05 4.15 8.65 4.15 13.05 C4.15 15.65 6.05 17.35 8.45 17.35 C9.75 17.35 10.75 16.82 11.35 15.88 C11.28 18.05 10.55 19.48 8.55 21.45 H15.45 C13.45 19.48 12.72 18.05 12.65 15.88 C13.25 16.82 14.25 17.35 15.55 17.35 C17.95 17.35 19.85 15.65 19.85 13.05 C19.85 8.65 13.75 5.05 12 2.35 Z\"/>\n    </g>\n\n    <g id=\"pip-club\">\n      <circle cx=\"12\" cy=\"7.05\" r=\"4.15\"/>\n      <circle cx=\"7.45\" cy=\"14.05\" r=\"4.15\"/>\n      <circle cx=\"16.55\" cy=\"14.05\" r=\"4.15\"/>\n      <path d=\"M10.25 13.65 C10.85 16.55 10.7 18.7 8.45 21.45 H15.55 C13.3 18.7 13.15 16.55 13.75 13.65 Z\"/>\n    </g>\n\n    <!-- 第五种牌面：DeepSeek 标准 24×24 鲸鱼 Logo，作为 currentColor 单色花色。 -->\n    <path id=\"pip-deepseek\" d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\"/>\n\n    <!-- 不在这里写 fill：\n         卡面透明度由统一的动态蒙版遮挡样式控制。 -->\n    <g id=\"card-base\">\n      <rect class=\"anim-base-rect\"\n        x=\"-2.8571\" y=\"-4\"\n        width=\"5.7143\" height=\"8\"\n        rx=\"1.08\"\n        stroke=\"currentColor\"\n        stroke-width=\"0.7\"/>\n    </g>\n\n    <g id=\"card-diamond\">\n      <use href=\"#card-base\"/>\n      <g transform=\"scale(.1956521739130435) translate(-12 -12)\">\n        <use href=\"#pip-diamond\" fill=\"currentColor\"/>\n      </g>\n    </g>\n\n    <g id=\"card-club\">\n      <use href=\"#card-base\"/>\n      <g transform=\"scale(.1956521739130435) translate(-12 -12)\">\n        <use href=\"#pip-club\" fill=\"currentColor\"/>\n      </g>\n    </g>\n\n    <g id=\"card-spade\">\n      <use href=\"#card-base\"/>\n      <g transform=\"scale(.1956521739130435) translate(-12 -12)\">\n        <use href=\"#pip-spade\" fill=\"currentColor\"/>\n      </g>\n    </g>\n\n    <g id=\"card-heart\">\n      <use href=\"#card-base\"/>\n      <g transform=\"scale(.1956521739130435) translate(-12 -12)\">\n        <use href=\"#pip-heart\" fill=\"currentColor\"/>\n      </g>\n    </g>\n\n    <g id=\"card-deepseek\">\n      <use href=\"#card-base\"/>\n      <g transform=\"scale(.18) translate(-12 -12)\">\n        <use href=\"#pip-deepseek\" fill=\"currentColor\"/>\n      </g>\n    </g>\n\n    <!--\n      关键修复：\n      mask 只作用于“下层卡牌”本身，不画任何背景色。\n      因此动态蒙版遮挡方案下：\n      1. 卡面仍然透明，页面/壁纸可透出；\n      2. 上层牌覆盖范围内的下层 stroke + pip 会被扣掉。\n    -->\n    \n    <mask\n      id=\"mask-plus-out\"\n      x=\"-2\" y=\"-2\" width=\"20\" height=\"20\"\n      maskUnits=\"userSpaceOnUse\"\n      maskContentUnits=\"userSpaceOnUse\"\n      style=\"mask-type:luminance\">\n      <rect x=\"-2\" y=\"-2\" width=\"20\" height=\"20\" fill=\"white\"/>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><rect class=\"anim-mask-rect\" x=\"-3.1143\" y=\"-4.36\" width=\"6.2286\" height=\"8.72\" rx=\"1.3286\" fill=\"black\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </mask>\n    \n    <mask\n      id=\"mask-plus-in\"\n      x=\"-2\" y=\"-2\" width=\"20\" height=\"20\"\n      maskUnits=\"userSpaceOnUse\"\n      maskContentUnits=\"userSpaceOnUse\"\n      style=\"mask-type:luminance\">\n      <rect x=\"-2\" y=\"-2\" width=\"20\" height=\"20\" fill=\"white\"/>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><rect class=\"anim-mask-rect\" x=\"-3.1143\" y=\"-4.36\" width=\"6.2286\" height=\"8.72\" rx=\"1.3286\" fill=\"black\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </mask>\n    \n    <mask\n      id=\"mask-minus-out\"\n      x=\"-2\" y=\"-2\" width=\"20\" height=\"20\"\n      maskUnits=\"userSpaceOnUse\"\n      maskContentUnits=\"userSpaceOnUse\"\n      style=\"mask-type:luminance\">\n      <rect x=\"-2\" y=\"-2\" width=\"20\" height=\"20\" fill=\"white\"/>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><rect class=\"anim-mask-rect\" x=\"-3.1143\" y=\"-4.36\" width=\"6.2286\" height=\"8.72\" rx=\"1.3286\" fill=\"black\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </mask>\n    \n    <mask\n      id=\"mask-minus-in\"\n      x=\"-2\" y=\"-2\" width=\"20\" height=\"20\"\n      maskUnits=\"userSpaceOnUse\"\n      maskContentUnits=\"userSpaceOnUse\"\n      style=\"mask-type:luminance\">\n      <rect x=\"-2\" y=\"-2\" width=\"20\" height=\"20\" fill=\"white\"/>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><rect class=\"anim-mask-rect\" x=\"-3.1143\" y=\"-4.36\" width=\"6.2286\" height=\"8.72\" rx=\"1.3286\" fill=\"black\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </mask>\n  </defs>\n\n  \n    \n\n<g id=\"phase-1\">\n    <animate\n      attributeName=\"opacity\"\n      values=\"1;0;0;0;0\"\n      keyTimes=\"0;0.2;0.4;0.6;0.8\"\n      dur=\"4s\"\n      repeatCount=\"indefinite\"\n      calcMode=\"discrete\"/>\n\n    <!-- 前半段：下一张在下层；当前牌透明区域会从下层牌里动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"1;0\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-out)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-club\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-diamond\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n\n    <!-- 后半段：当前牌在下层；下一张成为上层并负责动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"0;1\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-in)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-diamond\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-club\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n  </g>\n  \n  <g id=\"phase-2\">\n    <animate\n      attributeName=\"opacity\"\n      values=\"0;1;0;0;0\"\n      keyTimes=\"0;0.2;0.4;0.6;0.8\"\n      dur=\"4s\"\n      repeatCount=\"indefinite\"\n      calcMode=\"discrete\"/>\n\n    <!-- 前半段：下一张在下层；当前牌透明区域会从下层牌里动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"1;0\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-minus-out)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-spade\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-club\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n\n    <!-- 后半段：当前牌在下层；下一张成为上层并负责动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"0;1\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-minus-in)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-club\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-spade\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n  </g>\n  \n  <g id=\"phase-3\">\n    <animate\n      attributeName=\"opacity\"\n      values=\"0;0;1;0;0\"\n      keyTimes=\"0;0.2;0.4;0.6;0.8\"\n      dur=\"4s\"\n      repeatCount=\"indefinite\"\n      calcMode=\"discrete\"/>\n\n    <!-- 前半段：下一张在下层；当前牌透明区域会从下层牌里动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"1;0\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-out)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-heart\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-spade\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n\n    <!-- 后半段：当前牌在下层；下一张成为上层并负责动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"0;1\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-in)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-spade\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-heart\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n  </g>\n  \n  <g id=\"phase-4\">\n    <animate\n      attributeName=\"opacity\"\n      values=\"0;0;0;1;0\"\n      keyTimes=\"0;0.2;0.4;0.6;0.8\"\n      dur=\"4s\"\n      repeatCount=\"indefinite\"\n      calcMode=\"discrete\"/>\n\n    <!-- 前半段：下一张在下层；当前牌透明区域会从下层牌里动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"1;0\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-minus-out)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-deepseek\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-heart\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n\n    <!-- 后半段：当前牌在下层；下一张成为上层并负责动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"0;1\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-minus-in)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-heart\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-deepseek\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n  </g>\n  <g id=\"phase-5\">\n    <animate\n      attributeName=\"opacity\"\n      values=\"0;0;0;0;1\"\n      keyTimes=\"0;0.2;0.4;0.6;0.8\"\n      dur=\"4s\"\n      repeatCount=\"indefinite\"\n      calcMode=\"discrete\"/>\n\n    <!-- 前半段：下一张在下层；当前牌透明区域会从下层牌里动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"1;0\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-out)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-diamond\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-deepseek\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n\n    <!-- 后半段：当前牌在下层；下一张成为上层并负责动态挖空 -->\n    <g>\n      <animate\n        attributeName=\"opacity\"\n        values=\"0;1\"\n        keyTimes=\"0;0.5\"\n        dur=\"0.8s\"\n        repeatCount=\"indefinite\"\n        calcMode=\"discrete\"/>\n\n      <g mask=\"url(#mask-plus-in)\">\n        \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-deepseek\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n      </g>\n      \n      <g transform=\"translate(8 8)\">\n        <g>\n          <animateTransform\n            attributeName=\"transform\"\n            type=\"translate\"\n            values=\"0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0\"\n            keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n            dur=\"0.8s\"\n            repeatCount=\"indefinite\"\n            calcMode=\"linear\"/>\n          <g>\n            <animateTransform\n              attributeName=\"transform\"\n              type=\"rotate\"\n              values=\"0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0\"\n              keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n              dur=\"0.8s\"\n              repeatCount=\"indefinite\"\n              calcMode=\"linear\"/>\n            <g>\n              <animateTransform\n                attributeName=\"transform\"\n                type=\"scale\"\n                values=\"1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1\"\n                keyTimes=\"0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1\"\n                dur=\"0.8s\"\n                repeatCount=\"indefinite\"\n                calcMode=\"linear\"/>\n              <g transform=\"scale(1.2)\"><use class=\"anim-card\" href=\"#card-diamond\"/></g>\n            </g>\n          </g>\n        </g>\n      </g>\n    </g>\n  </g>\n  \n  </svg>",
  "pokerSpinDeepseek": "<path id=\"axis-deepseek-UID\" d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\"/>"
};
		/** 读取生效的图标配置：localStorage 图标包优先（校验 meta.compat 兼容性），
		 *  缺失/损坏/不兼容时回退内置默认。每次加载执行一次，结果供所有图标常量引用。 */
		function loadIconConfig() {
			var fallback = ICON_DEFAULTS || {};
			try {
				// 在浏览器 / jsdom 中用 window.localStorage（Node 无全局 localStorage）
				var storage = typeof window !== "undefined" && window.localStorage;
				if (storage) {
					var raw = storage.getItem(ICONS_STORAGE_KEY);
					if (raw) {
						var parsed = JSON.parse(raw);
						if (parsed && typeof parsed === "object") {
							// compat 校验：图标包声明 ">=x.y.z" 时与插件版本（NOTICE_VERSION）逐段
							// 比较——某段大于即兼容、小于即不兼容、相等继续比下一段。注意不能
							// 逐段只判"小于"：0.4.0 满足 ">=0.3.1"（minor 4>3 已定局，patch 0<1
							// 不能翻案），否则升版后 localStorage 图标包会被误判不兼容。
							var compat = parsed.meta && parsed.meta.compat;
							var ok = true;
							if (typeof compat === "string" && /^>=/.test(compat)) {
								var need = compat.slice(2).split(".").map(Number);
								var have = String(NOTICE_VERSION || "0").split(".").map(Number);
								for (var ci = 0; ci < Math.max(need.length, have.length); ci++) {
									var nv = need[ci] || 0, hv = have[ci] || 0;
									if (hv > nv) break;
									if (hv < nv) { ok = false; break; }
								}
							}
							if (ok) return parsed;
						}
					}
				}
			} catch (e) { /* localStorage 不可用或数据损坏：走内置默认 */ }
			return fallback;
		}
		var iconConfig = loadIconConfig();
		/** 花色信息：path + 包围盒中心 + 宽度系数。新版统一居中于 (12,12)，factor 全 1。 */
		var POKER_PIPS = (iconConfig && iconConfig.pokerPips) || {
			spade: { path: "", cx: 12, cy: 12, factor: 1 },
			heart: { path: "", cx: 12, cy: 12, factor: 1 },
			diamond: { path: "", cx: 12, cy: 12, factor: 1 },
			club: { path: "", cx: 12, cy: 12, factor: 1 }
		};
		// DeepSeek 标准 24×24 鲸鱼 Logo（Step 皮的鲸鱼花色与运行中牌背共用；
		// fill 继承 currentColor / 独立 SVG 中默认黑）。
		var POKER_SPIN_DEEPSEEK = (iconConfig && iconConfig.pokerSpinDeepseek) || "";

		// ---- Step Poker Skin（纯 CSS，软依赖官方 DOM 钩子） ----
		// 官方 ChatGroupSeat/ProcessGroupHeader 的 DOM 钩子：
		//   [data-step-process]（组根）、[data-step-process-icon]（活动图标 span）、
		//   [data-process-activity]（header 按钮上的当前活动值）。
		// 皮肤 = 隐藏官方图标内容 + 在图标 span 上用 ::before 渲染一张"牌身透明"
		// 的扑克牌（CSS mask，当前色描边 + 花色点），花色按官方 activity 映射。
		// 软依赖：任一钩子改名/移除 → 选择器不再命中 → 官方图标原样显示，
		// 官方折叠行为不受任何影响（最坏退化 = 皮消失）。
		// 官方 ProcessActivity 词表（ui-chat contract/process-groups.ts）。
		var ACTIVITY_SUIT = {
			thinking: "heart", questions: "heart",
			read: "spade", readImage: "spade", search: "spade", webSearch: "spade", webFetch: "spade",
			edit: "diamond", write: "diamond",
			commands: "club", code: "club",
			subagents: "whale", plan: "whale", tools: "whale"
		};
		/** 活动类型 → 花色（未登记活动回退 heart，与官方默认 activity=thinking 一致）。 */
		function activitySuitOf(activity) {
			return ACTIVITY_SUIT[activity] || "heart";
		}
		/** 一张牌身透明的扑克牌 SVG（10×14 视箱，5:7 比例）转 CSS mask data-URI：
		 *  rect 纯描边 + 花色点（fill 黑 = alpha 不透明），中间镂空透壁纸。
		 *  suitMarkup 是花色 path 的 SVG 标记（POKER_PIPS[suit].path / 鲸鱼 path）。 */
		function suitCardMask(suitMarkup) {
			var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 14">' +
				'<rect x="0.5" y="0.5" width="9" height="13" rx="1.1" fill="none" stroke="#000" stroke-width="1"/>' +
				'<g transform="translate(5 7) scale(0.2) translate(-12 -12)">' + suitMarkup + '</g></svg>';
			return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
		}
		/** 花色 → mask 图像。鲸鱼（whale）用 DeepSeek Logo path（缺数据时回退 club）。 */
		function suitMaskImage(suit) {
			var markup = null;
			if (suit === "whale") {
				markup = POKER_SPIN_DEEPSEEK
					? String(POKER_SPIN_DEEPSEEK).replace(/id="[^"]*"/, "")
					: (POKER_PIPS.club && POKER_PIPS.club.path);
			} else {
				var pip = POKER_PIPS[suit];
				markup = pip && pip.path;
			}
			return markup ? suitCardMask(String(markup)) : "";
		}
		/** completed 组牌 SVG（给定牌数与变换表）：N 张真实牌（rect 轮廓 + 花色 pip，
		 *  牌身透明透壁纸）+ 每张 owner 一个内嵌 luminance mask，挖掉绘制序更高牌的
		 *  实心黑牌面覆盖区。mask 挂在无变换的外层 g（用户系 = 视箱全局系），变换放
		 *  内层 g——cut 与真实牌同系对齐（Turn 动态方案的同款分层）。
		 *  几何与 Turn 栏 buildPokerSVGBase 同源同规则：3 张 = hThree/pipScaleThree/y=3.5、
		 *  5 张 = hFive/pipScaleFive/y=4；牌面取运行态轮换序列的前 N 张（同序前缀），
		 *  不新建 Step 专属牌面池。
		 *  ⚠ occluder 必须直接内联实心黑 rect，不能用 <use> 引用 defs——Chromium 不渲染
		 *  <mask> 内容里的 <use>；也不能用透明牌形（fill=none 只挖线）——下层 pip 会从
		 *  上层"牌面"里穿透。fill=#000 是 luminance knockout 机制本体（不可见填充），
		 *  与参考实现 mask rect fill="black"、Turn pokerDynamicMask 同款。 */
		function stepCompletedGroupSvg(count, tfs) {
			var cfgB = iconConfig && iconConfig.pokerSVGBase;
			var five = count > 3;
			var n = five ? 5 : 3;
			var h = (cfgB && (five ? cfgB.hFive : cfgB.hThree)) || (five ? 8 : 8.5);
			var w = h * ((cfgB && cfgB.pokerRatio) || 0.7142857142857143);
			var x = 8 - w / 2, y = five ? 4 : 3.5;
			var pipScale = (cfgB && (five ? cfgB.pipScaleFive : cfgB.pipScaleThree)) || (five ? 0.24 : 0.28);
			// rx 直接读 iconConfig.pokerR（= POKER_R 同源）：本函数在 CSS 注入段执行，
			// 早于 POKER_R 的 var 赋值点
			var rx = (iconConfig && iconConfig.pokerR) || 1.08;
			var suits = ["diamond", "club", "spade", "heart", POKER_SPIN_DEEPSEEK ? "deepseek" : "club"].slice(0, n);
			var defs = "", cards = "";
			var occluder = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
				'" rx="' + rx + '" fill="#000" stroke="#000" stroke-width="0.7"/>';
			var glyphBodies = [];
			for (var ci = 1; ci <= n; ci++) {
				var suit = suits[ci - 1];
				var markup = suit === "deepseek"
					? String(POKER_SPIN_DEEPSEEK).replace(/id="[^"]*"/, "")
					: (POKER_PIPS[suit] && POKER_PIPS[suit].path);
				glyphBodies[ci] = null;
				if (!markup) continue;
				// 鲸鱼墨迹几乎填满 24 盒，按卡牌几何独立取缩放（buildPokerSVGBase 同款公式）
				var usedScale = suit === "deepseek" ? (Math.min(w * 0.72, h * 0.58) / 24) : pipScale;
				glyphBodies[ci] = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
					'" rx="' + rx + '" fill="none" stroke="#000" stroke-width="0.7"/>' +
					'<g transform="translate(8 8) scale(' + usedScale + ') translate(-12 -12)">' + markup + '</g>';
				defs += '<g id="scc-g' + ci + '">' + glyphBodies[ci] + '</g>';
			}
			for (var ci2 = 1; ci2 <= n; ci2++) {
				if (!glyphBodies[ci2]) continue;
				// 挖掉绘制序在本牌之后（z 更高）的牌：cut 与真实牌同为全局系变换、同一几何。
				// z-order（绘制序 1→N，N 最上）：stack = card1 右下 → cardN 左上顶牌；
				// fan = card1 最左 → cardN 最右、视觉最前。owner 只被 z 更高者挖。
				var cuts = "";
				for (var zj = ci2 + 1; zj <= n; zj++) {
					if (!glyphBodies[zj]) continue;
					cuts += '<g transform="' + tfs[zj] + '">' + occluder + '</g>';
				}
				defs += '<mask id="scc-m' + ci2 + '" x="0" y="0" width="16" height="16" maskUnits="userSpaceOnUse" ' +
					'maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect x="0" y="0" width="16" height="16" fill="#fff"/>' +
					cuts + '</mask>';
				cards += '<g mask="url(#scc-m' + ci2 + ')"><g transform="' + tfs[ci2] + '"><use href="#scc-g' + ci2 + '"/></g></g>';
			}
			return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs>' + defs + '</defs>' + cards + '</svg>';
		}
		function svgMaskUri(svg) {
			return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
		}
		/** completed 双态端点 mask（closed = N 张花色牌堆 / open = N 张扇形）。
		 *  与 Turn 栏扑克图标同一几何语言：16 视箱、N 张牌（3 → hThree、5 → hFive）、
		 *  stack/fan 变换直接取 pokerTransforms(count, …)（iconConfig 数据源可覆盖）；
		 *  mask-size 24px 时 5 张牌外缘 ≈9.62×13.05px、stroke 1.05px，与 .ccg-poker-icon
		 *  里的牌逐像素一致；3 张牌与 Turn 栏 3 张牌（hThree/同扇角）逐像素一致。
		 *  牌面 = 运行态轮换序列的前 N 张（diamond→club→spade→heart→deepseek，
		 *  鲸鱼缺数据时回退 club）。 */
		function stepCompletedGroupMask(count, fan) {
			return svgMaskUri(stepCompletedGroupSvg(count, pokerTransforms(count, !!fan)));
		}
		/** cubic-bezier(.22,1,.36,1)（CSS 与 SMIL spline 同构）在 x 处的 y 值（二分求参数 t）。 */
		function cssBezierEase(x) {
			if (x <= 0) return 0;
			if (x >= 1) return 1;
			var x1 = 0.22, y1 = 1, x2 = 0.36, y2 = 1;
			var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
			var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
			var sample = function (t, a, b, c) { return ((a * t + b) * t + c) * t; };
			var lo = 0, hi = 1, t = x;
			for (var i = 0; i < 24; i++) {
				t = (lo + hi) / 2;
				if (sample(t, ax, bx, cx) < x) lo = t; else hi = t;
			}
			return sample(t, ay, by, cy);
		}
		/** stackN → fanN 的纯几何插值表（progress ∈ [0,1]；0 恒等 stackN、1 恒等 fanN）。
		 *  fanN 的 rotate 中心 (8,12) 恒定、stackN 无 rotate——同一 "translate(tx,ty) rotate(θ 8 12)"
		 *  结构下对 tx/ty/θ 做**线性**插值，端点与现有真实数据逐值一致。count 决定几何
		 *  （3 张读 stack3/fan3、5 张读 stack5/fan5），插值公式与牌数无关。
		 *  ⚠ 这里不做任何时间缓动：progress 是"已算好的几何位置"（0=牌堆、1=扇形），
		 *  时间 → progress 的映射由 stepMorphProgress 在 keyframes 层统一负责。
		 *  早先版本在这里对入参再套一次 cssBezierEase()，而 keyframes 传的是"反转后的时间"
		 *  （close: t = 1-u），等价于 close 的几何进度 = E(1-u)：起手速度 0、收尾最陡，
		 *  于是收起看起来"前慢后急"，与展开（= E(u)，起手最快、平滑减速）手感相反。 */
		function stepMorphTransforms(count, progress) {
			var stack = pokerTransforms(count, false), fan = pokerTransforms(count, true);
			var out = {};
			for (var i = 1; i <= count; i++) {
				// 解析 "translate(a, b) [rotate(deg cx cy)]"
				var sm = /translate\(([-\d.]+)[, ]+([-\d.]+)\)/.exec(stack[i]) || [0, "0", "0"];
				var fm = /translate\(([-\d.]+)[, ]+([-\d.]+)\)/.exec(fan[i]) || [0, "0", "0"];
				var fr = /rotate\(([-\d.]+) ([\-\d.]+) ([\-\d.]+)\)/.exec(fan[i]);
				var tx = Number(sm[1]) + (Number(fm[1]) - Number(sm[1])) * progress;
				var ty = Number(sm[2]) + (Number(fm[2]) - Number(sm[2])) * progress;
				var deg = fr ? Number(fr[1]) * progress : 0;
				out[i] = 'translate(' + tx.toFixed(3) + ', ' + ty.toFixed(3) + ')' +
					(deg ? ' rotate(' + deg.toFixed(3) + ' 8 12)' : '');
			}
			return out;
		}
		/** 帧的时间进度 u（0 → 1）→ 几何进度 progress（0 = 牌堆、1 = 扇形）。
		 *  open : progress = E(u)        —— 起手最快、后半程减速（ease-out 正向）
		 *  close: progress = 1 - E(u)    —— 同一 easing 的**镜像**：起手最快、后半程减速
		 *  ⚠ 不是"时间反转" progress = E(1-u)。区别：
		 *    · 1-E(u) 在 u=0 处导数为 -E'(0)（最陡）→ 点击后立即明显运动；u=1 处为 0 → 柔和停住；
		 *    · E(1-u) 在 u=0 处导数为 -E'(1) = 0（不动）→ 前半程偏慢，u=1 处最陡 → 收尾偏急。
		 *  两者端点相同（u=0 → 1、u=1 → 0），只在中间段手感相反；对称性由
		 *  openProgress(u) + closeProgress(u) = 1 保证（见测试）。 */
		function stepMorphProgress(u, fromFan) {
			var e = cssBezierEase(u);
			return fromFan ? 1 - e : e;
		}
		/* >>> step-running-poker-svg (generated; do not edit; regenerate: node scripts/sync-step-anim.mjs) */
		var STEP_RUNNING_POKER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" style="color:#fff"><defs><g id="pip-heart"><path d="M12 21.25 C10.35 19.35 4 15.1 4 9.65 C4 6.55 6.1 4.4 8.75 4.4 C10.25 4.4 11.35 5.18 12 6.45 C12.65 5.18 13.75 4.4 15.25 4.4 C17.9 4.4 20 6.55 20 9.65 C20 15.1 13.65 19.35 12 21.25 Z"/></g><g id="pip-diamond"><path d="M12 2.45 L20.1 12 L12 21.55 L3.9 12 Z"/></g><g id="pip-spade"><path d="M12 2.35 C10.25 5.05 4.15 8.65 4.15 13.05 C4.15 15.65 6.05 17.35 8.45 17.35 C9.75 17.35 10.75 16.82 11.35 15.88 C11.28 18.05 10.55 19.48 8.55 21.45 H15.45 C13.45 19.48 12.72 18.05 12.65 15.88 C13.25 16.82 14.25 17.35 15.55 17.35 C17.95 17.35 19.85 15.65 19.85 13.05 C19.85 8.65 13.75 5.05 12 2.35 Z"/></g><g id="pip-club"><circle cx="12" cy="7.05" r="4.15"/><circle cx="7.45" cy="14.05" r="4.15"/><circle cx="16.55" cy="14.05" r="4.15"/><path d="M10.25 13.65 C10.85 16.55 10.7 18.7 8.45 21.45 H15.55 C13.3 18.7 13.15 16.55 13.75 13.65 Z"/></g><path id="pip-deepseek" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/><g id="card-base"><rect class="anim-base-rect" x="-2.857142857142857" y="-4" width="5.714285714285714" height="8" rx="1.08" stroke="currentColor" stroke-width="0.7"/></g><g id="card-diamond"><use href="#card-base"/><g transform="scale(.1956521739130435) translate(-12 -12)"><use href="#pip-diamond" fill="currentColor"/></g></g><g id="card-club"><use href="#card-base"/><g transform="scale(.1956521739130435) translate(-12 -12)"><use href="#pip-club" fill="currentColor"/></g></g><g id="card-spade"><use href="#card-base"/><g transform="scale(.1956521739130435) translate(-12 -12)"><use href="#pip-spade" fill="currentColor"/></g></g><g id="card-heart"><use href="#card-base"/><g transform="scale(.1956521739130435) translate(-12 -12)"><use href="#pip-heart" fill="currentColor"/></g></g><g id="card-deepseek"><use href="#card-base"/><g transform="scale(.18) translate(-12 -12)"><use href="#pip-deepseek" fill="currentColor"/></g></g><mask id="mask-plus-out" x="-2" y="-2" width="20" height="20" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect x="-2" y="-2" width="20" height="20" fill="white"/><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><rect class="anim-mask-rect" x="-3.217142857142857" y="-4.36" width="6.434285714285714" height="8.72" rx="1.44" fill="black"/></g></g></g></g></g></mask><mask id="mask-plus-in" x="-2" y="-2" width="20" height="20" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect x="-2" y="-2" width="20" height="20" fill="white"/><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><rect class="anim-mask-rect" x="-3.217142857142857" y="-4.36" width="6.434285714285714" height="8.72" rx="1.44" fill="black"/></g></g></g></g></g></mask><mask id="mask-minus-out" x="-2" y="-2" width="20" height="20" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect x="-2" y="-2" width="20" height="20" fill="white"/><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><rect class="anim-mask-rect" x="-3.217142857142857" y="-4.36" width="6.434285714285714" height="8.72" rx="1.44" fill="black"/></g></g></g></g></g></mask><mask id="mask-minus-in" x="-2" y="-2" width="20" height="20" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect x="-2" y="-2" width="20" height="20" fill="white"/><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><rect class="anim-mask-rect" x="-3.217142857142857" y="-4.36" width="6.434285714285714" height="8.72" rx="1.44" fill="black"/></g></g></g></g></g></mask></defs><style>.anim-card{fill:transparent}</style><g id="phase-1"><animate attributeName="opacity" values="1;0;0;0;0" keyTimes="0;0.2;0.4;0.6;0.8" dur="4s" repeatCount="indefinite" calcMode="discrete"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-out)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-club"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-diamond"/></g></g></g></g></g></g><g><animate attributeName="opacity" values="0;1" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-in)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-diamond"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-club"/></g></g></g></g></g></g></g><g id="phase-2"><animate attributeName="opacity" values="0;1;0;0;0" keyTimes="0;0.2;0.4;0.6;0.8" dur="4s" repeatCount="indefinite" calcMode="discrete"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-minus-out)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-spade"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-club"/></g></g></g></g></g></g><g><animate attributeName="opacity" values="0;1" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-minus-in)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-club"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-spade"/></g></g></g></g></g></g></g><g id="phase-3"><animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.2;0.4;0.6;0.8" dur="4s" repeatCount="indefinite" calcMode="discrete"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-out)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-heart"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-spade"/></g></g></g></g></g></g><g><animate attributeName="opacity" values="0;1" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-in)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-spade"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-heart"/></g></g></g></g></g></g></g><g id="phase-4"><animate attributeName="opacity" values="0;0;0;1;0" keyTimes="0;0.2;0.4;0.6;0.8" dur="4s" repeatCount="indefinite" calcMode="discrete"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-minus-out)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-deepseek"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-heart"/></g></g></g></g></g></g><g><animate attributeName="opacity" values="0;1" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-minus-in)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 0.02503;0.58342 0.04944;0.85713 0.07264;1.10974 0.09405;1.33502 0.11314;1.52742 0.12944;1.68222 0.14256;1.79559 0.15217;1.86476 0.15803;1.888 0.16;1.86476 0.15803;1.79559 0.15217;1.68222 0.14256;1.52742 0.12944;1.33502 0.11314;1.10974 0.09405;0.85713 0.07264;0.58342 0.04944;0.29535 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-heart"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 -0.02503;-0.41862 -0.04944;-0.61501 -0.07264;-0.79625 -0.09405;-0.95789 -0.11314;-1.09595 -0.12944;-1.20702 -0.14256;-1.28836 -0.15217;-1.33799 -0.15803;-1.35467 -0.16;-1.33799 -0.15803;-1.28836 -0.15217;-1.20702 -0.14256;-1.09595 -0.12944;-0.95789 -0.11314;-0.79625 -0.09405;-0.61501 -0.07264;-0.41862 -0.04944;-0.21192 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;0.4849;0.958;1.4074;1.8221;2.192;2.508;2.7621;2.9483;3.0618;3.1;3.0618;2.9483;2.7621;2.508;2.192;1.8221;1.4074;0.958;0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-deepseek"/></g></g></g></g></g></g></g><g id="phase-5"><animate attributeName="opacity" values="0;0;0;0;1" keyTimes="0;0.2;0.4;0.6;0.8" dur="4s" repeatCount="indefinite" calcMode="discrete"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-out)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-diamond"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-deepseek"/></g></g></g></g></g></g><g><animate attributeName="opacity" values="0;1" keyTimes="0;0.5" dur="0.8s" repeatCount="indefinite" calcMode="discrete"/><g mask="url(#mask-plus-in)"><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;0.29535 -0.02503;0.58342 -0.04944;0.85713 -0.07264;1.10974 -0.09405;1.33502 -0.11314;1.52742 -0.12944;1.68222 -0.14256;1.79559 -0.15217;1.86476 -0.15803;1.888 -0.16;1.86476 -0.15803;1.79559 -0.15217;1.68222 -0.14256;1.52742 -0.12944;1.33502 -0.11314;1.10974 -0.09405;0.85713 -0.07264;0.58342 -0.04944;0.29535 -0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.95873;0.91792;0.87802;0.83947;0.80265;0.76792;0.73558;0.70587;0.67898;0.655;0.63398;0.61587;0.60058;0.58792;0.57765;0.56947;0.56302;0.55792;0.55373;0.55" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-deepseek"/></g></g></g></g></g></g><g transform="translate(8 8)"><g><animateTransform attributeName="transform" type="translate" values="0 0;-0.21192 0.02503;-0.41862 0.04944;-0.61501 0.07264;-0.79625 0.09405;-0.95789 0.11314;-1.09595 0.12944;-1.20702 0.14256;-1.28836 0.15217;-1.33799 0.15803;-1.35467 0.16;-1.33799 0.15803;-1.28836 0.15217;-1.20702 0.14256;-1.09595 0.12944;-0.95789 0.11314;-0.79625 0.09405;-0.61501 0.07264;-0.41862 0.04944;-0.21192 0.02503;0 0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="rotate" values="0;-0.4849;-0.958;-1.4074;-1.8221;-2.192;-2.508;-2.7621;-2.9483;-3.0618;-3.1;-3.0618;-2.9483;-2.7621;-2.508;-2.192;-1.8221;-1.4074;-0.958;-0.4849;0" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g><animateTransform attributeName="transform" type="scale" values="1;0.97919;0.9589;0.93962;0.92182;0.90595;0.8924;0.8815;0.87351;0.86864;0.867;0.86864;0.87351;0.8815;0.8924;0.90595;0.92182;0.93962;0.9589;0.97919;1" keyTimes="0;0.05;0.1;0.15;0.2;0.25;0.3;0.35;0.4;0.45;0.5;0.55;0.6;0.65;0.7;0.75;0.8;0.85;0.9;0.95;1" dur="0.8s" repeatCount="indefinite" calcMode="linear"/><g transform="scale(1.2)"><use class="anim-card" href="#card-diamond"/></g></g></g></g></g></g></g></svg>';
		/* <<< step-running-poker-svg */
		/** 五牌面轮换 SVG → CSS mask data-URI。作为 mask 仅使用 alpha 通道，
		 *  伪元素的 background-color:currentColor 决定实际牌线颜色（跟随 DSH 主题）。 */
		var STEP_RUNNING_POKER_MASK = (function () {
			return 'url("data:image/svg+xml,' + encodeURIComponent(STEP_RUNNING_POKER_SVG)
				.replace(/[()']/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase(); }) + '")';
		})();
		// morph 帧时间轴与帧序生成器（放在 factory 作用域：5 张 / 3 张两套共用同一
		// 帧数、时长与缓动，只有几何不同）。
		// 帧时间轴：keyframes 0% = 出发端点（与切换前显示同值，无缝起步）、每
		// 100/17≈5.88% 一帧（discrete 在相邻对中点切换 → 有效 morph ≈353ms、总
		// 400ms、≈42fps——8 帧版有肉眼台阶感，16 帧是"仍可接受体积"下的密度上限）、
		// 100% 省略回落常驻端点（无缝收尾 = freeze 语义）。
		var MORPH_FRAMES = 16;
		function morphMaskDecl(uri) {
			// keyframes 帧内只写标准 mask-image：32 帧 × 2 份 URI 的 -webkit- 双写会让
			// 皮肤样式表膨胀近一倍；DSH 桌面端是新 Chromium（标准属性早已支持），
			// 旧内核最坏退化 = 动画期间不换帧（直接端点），不是破图。
			return 'mask-image:' + uri;
		}
		function stepMorphKeyframes(name, count, fromFan) {
			var fromMask = stepCompletedGroupMask(count, !!fromFan);
			var stops = ['0%{' + morphMaskDecl(fromMask) + '}'];
			for (var k = 1; k <= MORPH_FRAMES; k++) {
				// 时间进度 u 线性推进；几何进度由 stepMorphProgress 施加 easing
				// （open: E(u)、close: 1-E(u) —— 两个方向共用同一 easing，起手/收尾手感一致）
				var u = k / (MORPH_FRAMES + 1);
				// 百分比 = k/(帧数+1)——随 MORPH_FRAMES 自适应（6 帧 → 12.5% 步进、
				// 16 帧 → 5.882353%），永远不触达 100%（回落停靠点留给常驻端点）
				stops.push((k * 100 / (MORPH_FRAMES + 1)).toFixed(6) + '%{' +
					morphMaskDecl(svgMaskUri(stepCompletedGroupSvg(count, stepMorphTransforms(count, stepMorphProgress(u, fromFan))))) + '}');
			}
			// 100% 省略：回落规则常驻端点（= to 端点），与末帧视觉一致
			return '@keyframes ' + name + '{' + stops.join('') + '}';
		}
		/** 生成 Step Poker Skin 的 CSS（依赖注入的图标数据，只能在 ICON_DEFAULTS 就绪后调用）。
		 *  规则不带任何 body 前缀——总闸是皮肤样式元素自身的 disabled。
		 *  结构：官方图标内容隐藏 → ::before 卡牌位；completed 双态（收起牌堆/展开扇形）；
		 *  每个官方 activity 一条 --tf-suit 变量规则（reduced-motion 的 running 回落）；
		 *  running（shimmer 双契约）= 五牌面轮换，优先于 completed 双态。
		 *  牌数：默认/fallback = 5 张（静态规则）；3 张覆盖规则由牌数桥按官方 groupKey
		 *  生成（buildStepCardRulesCss），资产（--tf-stack-3 / --tf-fan-3 / 3 张帧序）在这里预置。 */
		function buildStepSkinCss() {
			var rules = [];
			// 统一牌规格（与 Turn 栏 .ccg-poker-icon 完全同款）：伪元素 24×24 = Turn 容器；
			// 16 视箱 mask 按 24px 渲染（1 单位 = 1.5px）→ 牌外缘 ≈9.62×13.05px、stroke 1.05px，
			// 与 Turn 栏扑克牌逐像素一致。官方 leading 16×16 与标题位置不动——伪元素
			// absolute + inset:0 + margin:auto 居中、不参与 flex 布局，24px 盒右缘 x≈20
			// 仍在标题起点（leading 16 + gap 6 = x22）左侧，轮换/扇形的运动包络不压标题。
			var cfgB = iconConfig && iconConfig.pokerSVGBase;
			var cardH = (cfgB && cfgB.hFive) || 8;
			var cardW = cardH * ((cfgB && cfgB.pokerRatio) || 0.7142857142857143);
			// 静态单张花色牌（suitCardMask，10×14 视箱 = 牌外缘满视箱）的 mask-size：
			// 缩放到与 Turn 五张牌同一外缘（含 stroke）
			var suitCardSize = ((cardW + 0.7) * 1.5).toFixed(2) + "px " + ((cardH + 0.7) * 1.5).toFixed(2) + "px";
			var stackMask = stepCompletedGroupMask(5, false);
			var fanMask = stepCompletedGroupMask(5, true);
			// 3 张牌端点资产：不进任何常驻规则，只作为 CSS 变量供"牌数桥"按
			// [data-chat-group-key] 逐组覆盖（见 buildStepCardRulesCss）。默认不生效
			// → 桥缺失/旧宿主/数据不可得时行为 = 五张 fallback（绝不猜 3 张）。
			var stackMask3 = stepCompletedGroupMask(3, false);
			var fanMask3 = stepCompletedGroupMask(3, true);
			// stack ↔ fan morph：预采样插值帧（每帧 = 静态 SVG，牌与 occluder 都在当帧
			// 插值位置）。为什么用帧序列而非 SMIL/transition：
			//   · 同 URL 的 mask 图像在 Chromium 全页共享单一实例、SMIL 时间线从首次应用
			//     延续、重应用不 restart（真机实验证实）——"mask-image 换 animated URI 触发
			//     morph"只能播一次；
			//   · mask-image 是离散属性，transition/两个静态 URI 之间无中间帧；
			//   · CSS animation 每次规则命中都从头重放 → 帧序列放 keyframes 里即可做到
			//     每次 aria-expanded 变化都完整 morph，且每帧的 occluder 逐帧同步 knockout。
			// 帧时间轴：keyframes 0% = 出发端点（与切换前显示同值，无缝起步）、每
			// 100/17≈5.88% 一帧（有效 morph ≈353ms、总 400ms、≈42fps）、100% 省略
			// 回落常驻端点（无缝收尾 = freeze 语义）。生成器在 factory 作用域。
			// 5 张（默认/fallback）与 3 张两套完整 morph 帧序：帧数、时长、缓动完全一致，
			// 只有几何不同。
			rules.push(stepMorphKeyframes("tf-step-open", 5, false));
			rules.push(stepMorphKeyframes("tf-step-close", 5, true));
			rules.push(stepMorphKeyframes("tf-step-open-3", 3, false));
			rules.push(stepMorphKeyframes("tf-step-close-3", 3, true));
			// 3 张牌覆盖资产（data-URI 只声明一次；牌数桥的逐组规则只引用变量）
			rules.push('[data-step-process]{--tf-stack-3:' + stackMask3 + ';--tf-fan-3:' + fanMask3 + '}');
			rules.push('[data-step-process] [data-step-process-icon] > *{display:none}');
			// 基础 = completed 收起：五张花色牌堆（closed = 牌收好未翻看）+ 收拢帧序动画
			rules.push('[data-step-process] [data-step-process-icon]::before{content:"";position:absolute;inset:0;margin:auto;width:24px;height:24px;background-color:currentColor;-webkit-mask:' + stackMask + ' center/24px 24px no-repeat;mask:' + stackMask + ' center/24px 24px no-repeat;animation:tf-step-close .4s linear 1}');
			// 默认花色（未知/未登记活动）：heart（官方默认 activity=thinking 同款）。
			// --tf-suit 单张花色牌不再作 completed 主渲染（双态取代），仅供 reduced-motion
			// 的 running 回落与钩子失效兜底保留。
			rules.push('[data-step-process] [data-step-process-icon]{--tf-suit:' + suitMaskImage("heart") + '}');
			// 按官方 activity 值逐条映射（自定义属性挂在图标 span 上，::before 读取）
			var seen = {};
			for (var activity in ACTIVITY_SUIT) {
				if (!Object.prototype.hasOwnProperty.call(ACTIVITY_SUIT, activity)) continue;
				var suit = ACTIVITY_SUIT[activity];
				if (seen[suit]) continue; // 同花色只出一条规则（CSS 后代选择器无法合并变量值）
				seen[suit] = true;
				var image = suitMaskImage(suit);
				if (!image) continue;
				// 同一花色的所有 activity 合并成一条选择器
				var acts = [];
				for (var a2 in ACTIVITY_SUIT) {
					if (Object.prototype.hasOwnProperty.call(ACTIVITY_SUIT, a2) && ACTIVITY_SUIT[a2] === suit) acts.push(a2);
				}
				var selectors = [];
				for (var ai = 0; ai < acts.length; ai++) {
					selectors.push('[data-process-activity="' + acts[ai] + '"] [data-step-process-icon]');
				}
				rules.push(selectors.join(",") + '{--tf-suit:' + image + '}');
			}
			// ── Poker skin 下官方图标位 / chevron 的可见性总控（normal/hover/focus/active 一致）──
			// 官方 ChatGroupSeat 的 CSS 在 hover/focus-visible/展开时把 activityIcon 淡出、
			// 显示 chevron（“换箭头”交互）。Poker skin 接管图标语义后：icon 恒显、
			// chevron 恒隐——不做任何 hover/focus 让位。按钮的 hover 变色、focus ring、
			// 键盘 Enter/Space、aria-expanded 折叠语义全部保持官方原样。
			// 特异性 (0,3,1) 高于官方 .title:is(:hover,:focus-visible) .activityIcon、
			// .title[aria-expanded="true"] .activityIcon/.chevron 等全部四条 (0,3,0)。
			// 软依赖：官方若不再是 button → 规则不命中 → 官方行为原样回归（退化安全）。
			rules.push('[data-step-process] button[data-process-activity] [data-step-process-icon]{opacity:1}');
			rules.push('[data-step-process] button[data-process-activity] [data-step-process-chevron]{opacity:0}');
			// ── completed 展开态：mask = 扇形（open = 牌已翻看）+ 展开帧序动画（收起时
			// animation-name 变回 tf-step-close → 收拢帧序播放）。shimmer（running）在场的
			// 展开组不换——轮换动画优先。软依赖：aria-expanded 钩子失效 → 规则不命中 →
			// 收起牌堆，官方折叠行为不受影响。
			var completedFan = '[data-step-process] [data-process-activity][aria-expanded="true"]' +
				':not(:has([data-shimmer="true"])):not(:has([data-text-shimmer="true"]))';
			rules.push(completedFan + ' [data-step-process-icon]::before{-webkit-mask-image:' + fanMask + ';mask-image:' + fanMask + ';-webkit-mask-size:24px 24px;mask-size:24px 24px;-webkit-mask-position:center;mask-position:center;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;animation:tf-step-open .4s linear 1}');
			rules.push(completedFan + ' [data-step-process-icon]{opacity:1}');
			rules.push(completedFan + ' [data-step-process-chevron]{opacity:0}');
			// ── 运行态五牌面轮换（运行状态完全由官方 DOM 识别，插件零 JS 判定） ──
			// 官方 ProcessGroupHeader 的标题用 <TextShimmer active={!data.closed}>：
			// active 时最终 DOM 出现 shimmer 属性，回合结束属性消失。属性名随官方
			// 版本演进，两个都是官方真实历史契约，插件双契约同时兼容（缺一即只在
			// 另一个版本上失效）：
			//   DSH 0.1.7（release 787b746b80）→ data-text-shimmer={active || undefined}
			//   DSH 0.2.0+（master 639ed01539）→ data-shimmer={active || undefined}
			// running 识别 = [data-step-process]:has([<任一官方 shimmer 属性>="true"])
			// （软依赖：钩子失效 → :has() 不命中 → 回落 completed 双态，官方折叠不受影响）。
			// 动画 = 五牌面轮换（♠ ♥ ♦ ♣ + DeepSeek 鲸鱼，五张地位相同的牌面，无正/背面）：
			//   自运行 SVG（SMIL）由参考实现 docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html
			//   第三行「牌面轮换 · 正向」机械化移植（scripts/sync-step-anim.mjs 可重生成）：
			//     · 每 0.8s 一组：两张完整平面牌对角轻微错开再合拢；唯一的 rotate 是 ±3.1°
			//       二维平面小角度（没有 3D、没有牌侧、没有 scaleX 收窄换面）；
			//     · 期间用 discrete 在 50% 切换上下层，配合四个动态蒙版（mask-plus/minus-out/in）
			//       把下层牌与上层牌重叠处的线条挖空（透明卡面仍透壁纸、但不透下层牌）；
			//     · 五组相位各占 0.8s（每组 opacity 只在自身窗口可见），连成 4s 完整循环；
			//     · 牌面顺序：diamond → club → spade → heart → deepseek →（回到 diamond）。
			//   运行态把伪元素 mask 换成该 SVG 的 data URI（16 视箱、mask-size 24px =
			//   Turn 渲染比例，轮换牌与 completed 双态牌同尺寸）；SMIL 在 Chromium 的
			//   CSS mask-image 数据 URI 中会继续播放（真机实测）。shimmer 消失 → 规则
			//   不再命中 → 自动回落 completed 双态（纯 CSS cascade，无任何 JS running 状态）。
			// 旧版 Step 无 poker 实现（Step 皮随 Native Fold 重构引入）；本动画不依赖 Turn 侧代码。
			var runningCard = ['data-text-shimmer', 'data-shimmer'].map(function (attr) {
				return '[data-step-process]:has([' + attr + '="true"]) [data-step-process-icon]::before';
			}).join(",");
			rules.push(runningCard + '{-webkit-mask-image:' + STEP_RUNNING_POKER_MASK + ';mask-image:' + STEP_RUNNING_POKER_MASK + ';-webkit-mask-size:24px 24px;mask-size:24px 24px;-webkit-mask-position:center;mask-position:center;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}');
			// reduced-motion：不播放轮换动画——直接显示静态 activity 花色牌（mask 换回 --tf-suit）；
			// completed 双态同理——stack/fan morph 帧序动画禁用，直接显示静态端点
			// （常驻 mask 本就是端点静态 SVG，只需关 animation；SMIL 不受媒体查询控制，
			// 帧序动画必须显式关闭）
			rules.push('@media (prefers-reduced-motion:reduce){' + runningCard + '{-webkit-mask-image:var(--tf-suit);mask-image:var(--tf-suit);-webkit-mask-size:' + suitCardSize + ';mask-size:' + suitCardSize + '}}');
			rules.push('@media (prefers-reduced-motion:reduce){' +
				'[data-step-process] [data-step-process-icon]::before{animation:none}' +
				completedFan + ' [data-step-process-icon]::before{animation:none}}');
			return rules.join("\n");
		}

		// ---- Step 牌数桥（官方 group snapshot → 视觉选择器；纯只读，零分组重算） ----
		// 规则：本 Process Group 的 toolCallCount = Σ 官方 summary.counts[].count
		//         ≤ 3 → 3 张牌；≥ 4 → 5 张牌。取不到 = 5 张（绝不猜 3 张）。
		//
		// 数据路径（全部是官方现成 API，只读）：
		//   组件 props.useConversation（官方 SessionStandardProps 成员；ui-conversation 经
		//     ctx.uiSession.provide({hooks:['conversation']}) 下发给所有 session 作用域条目）
		//   → ConversationSnapshot.views.grouped('chat')（ConversationViewSnapshotStore 公开契约）
		//   → ConversationGroupedView.entries（{kind:'group', key: GroupKey}）
		//   → groupSource(key) → ObservableSnapshot<GroupSnapshot<ProcessGroupData>|undefined>
		//   → snapshot.data.summary.counts（{kind, count}[]，官方按 distinct callId 递归统计）
		// 注：官方 conversation.view 的 keyedHooks.chatGroup 就是同一函数的封装
		//   （ui-chat apply.ts：conversation.snapshot…views.grouped('chat').groupSource(key)）；
		//   插件拿不到 conversation.view 的 keyedHooks 面（那是官方 ChatView 的 inject），
		//   走的是每个 session 作用域条目都能拿到的标准 kit。差别只在取值方式，不在数据。
		//
		// 出口 = 官方稳定的结构化 DOM 事实 data-chat-group-key（ChatGroupSeat 组根上的官方属性）：
		//   插件只在自己样式表里按该属性生成覆盖规则——不写官方 DOM、不加官方属性、
		//   不替换 ChatGroupSeat/ProcessGroupHeader、不拥有 disclosure、不碰成员可见性、
		//   不定义成员/分组。插件只做 "官方事实 → 视觉表现"。
		var STEP_CARD_CSS_ID = "dsh-turn-fold/style-step-cards";
		var STEP_CARD_SMALL_MAX = 3;
		var STEP_CARD_COUNT_SMALL = 3;
		var STEP_CARD_COUNT_LARGE = 5;
		var stepCardStyleEl = null;
		var stepCardRulesCache = null;
		var stepCardLeaderToken = null;
		/** 官方 counts → 本组 tool call 总数（求和，不是 counts.length）。 */
		function stepCardToolCallCount(counts) {
			if (!counts || typeof counts.length !== "number") return undefined;
			var total = 0;
			for (var i = 0; i < counts.length; i++) {
				var item = counts[i];
				var n = item ? item.count : undefined;
				if (typeof n !== "number" || !isFinite(n) || n < 0) return undefined;
				total += n;
			}
			return total;
		}
		/** 官方 group snapshot → 牌数；形状异常/缺席 → undefined（调用方回落 5 张）。 */
		function stepCardCountOfGroup(snapshot) {
			if (!snapshot || !snapshot.data || !snapshot.data.summary) return undefined;
			var total = stepCardToolCallCount(snapshot.data.summary.counts);
			if (total === undefined) return undefined;
			return total <= STEP_CARD_SMALL_MAX ? STEP_CARD_COUNT_SMALL : STEP_CARD_COUNT_LARGE;
		}
		/** CSS 属性选择器里的字符串转义（groupKey 是 JSON 文本，含引号）。 */
		function cssAttrValue(value) {
			return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		}
		/** groupKey → 3 张牌覆盖规则。两条规则都必须：(a) 特异性压过同名静态端点规则，
		 *  (b) 带 shimmer 排除子句——否则会把运行中的五牌面轮换 mask 压掉（软依赖：
		 *  官方 shimmer 钩子改名 → 排除失效 → 最坏退化为 3 张牌堆/扇形，轮换不再显示）。
		 *  组根同时带 data-step-process 与 data-chat-group-key（官方真实 DOM）。 */
		function buildStepCardRulesCss(map) {
			var rules = [];
			if (map) {
				for (var key in map) {
					if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
					if (map[key] !== STEP_CARD_COUNT_SMALL) continue;
					var host = '[data-step-process][data-chat-group-key="' + cssAttrValue(key) + '"]';
					var idle = ':not(:has([data-shimmer="true"])):not(:has([data-text-shimmer="true"]))';
					rules.push(host + idle + ' [data-step-process-icon]::before' +
						'{-webkit-mask-image:var(--tf-stack-3);mask-image:var(--tf-stack-3);animation-name:tf-step-close-3}');
					rules.push(host + ' [data-process-activity][aria-expanded="true"]' + idle +
						' [data-step-process-icon]::before' +
						'{-webkit-mask-image:var(--tf-fan-3);mask-image:var(--tf-fan-3);animation-name:tf-step-open-3}');
				}
			}
			return rules.join("\n");
		}
		/** 把逐组覆盖规则写进专属样式元素（幂等：内容不变不写）。 */
		function writeStepCardRules(map) {
			try {
				if (!stepCardStyleEl) return;
				var css = buildStepCardRulesCss(map);
				if (css === stepCardRulesCache) return;
				stepCardRulesCache = css;
				stepCardStyleEl.textContent = css;
			} catch (e) { /* 视觉增强可以坏，官方折叠不受影响 */ }
		}
		/** 官方会话快照 → 分组读端（身份稳定；数据更新不改变它，只改 entries/组快照）。 */
		function selectChatGroupedView(snapshot) {
			try {
				if (!snapshot || !snapshot.views || typeof snapshot.views.grouped !== "function") return undefined;
				return snapshot.views.grouped("chat");
			} catch (e) { return undefined; }
		}
		/** 官方根渲染序列（含 {kind:'group', key}）——entries 身份变化 = 分组结构变化。 */
		function selectChatGroupedEntries(snapshot) {
			var grouped = selectChatGroupedView(snapshot);
			return grouped ? grouped.entries : undefined;
		}
		/** 牌数桥 leader 判定：宿主里每个回合都有一个 turn-process 条目，但桥只需要一个
		 *  订阅者（会话级）。第一个挂载的实例当 leader；leader 卸载 = 清空规则（回落
		 *  5 张安全态），下一个挂载的实例接手。其余实例零订阅、零渲染。 */
		function useStepCardBridgeLeader() {
			var pair = react.useState(false);
			var isLeader = pair[0], setIsLeader = pair[1];
			react.useEffect(function () {
				if (stepCardLeaderToken !== null) return undefined;
				var token = {};
				stepCardLeaderToken = token;
				setIsLeader(true);
				return function () {
					if (stepCardLeaderToken !== token) return;
					stepCardLeaderToken = null;
					writeStepCardRules(null);
				};
			}, []);
			return isLeader;
		}
		/** 一个 group key → 官方组快照 → 牌数（uSES 订阅官方 groupSource；source 身份稳定）。 */
		function StepCardGroupProbe(props) {
			var groupKey = props.groupKey;
			var report = props.report;
			var grouped = props.grouped;
			var source = react.useMemo(function () {
				try {
					return grouped && typeof grouped.groupSource === "function" ? grouped.groupSource(groupKey) : undefined;
				} catch (e) { return undefined; }
			}, [grouped, groupKey]);
			var snapshot = useSyncExternalStore(
				source && typeof source.subscribe === "function" ? source.subscribe : subscribeNothing,
				source && typeof source.getSnapshot === "function" ? source.getSnapshot : getUndefinedSnapshot
			);
			var count = stepCardCountOfGroup(snapshot);
			react.useEffect(function () {
				report(groupKey, count === undefined ? null : count);
				return function () { report(groupKey, null); };
			}, [groupKey, count, report]);
			return null;
		}
		/** 会话级只读订阅者：官方 group entries → 每组一个 probe → 汇总 → 生成视觉选择器规则。
		 *  不渲染任何 DOM、不持有 Fold 状态、不接管 click/hidden/搜索展开。 */
		function StepCardRuleWriter(props) {
			var useConversation = props.useConversation;
			var entries = useConversation(selectChatGroupedEntries);
			var grouped = useConversation(selectChatGroupedView);
			var countsRef = react.useRef({});
			var versionPair = react.useState(0);
			var version = versionPair[0], setVersion = versionPair[1];
			var report = react.useCallback(function (groupKey, count) {
				var map = countsRef.current;
				var had = Object.prototype.hasOwnProperty.call(map, groupKey);
				if (count === null) {
					if (!had) return;
					delete map[groupKey];
				} else {
					if (had && map[groupKey] === count) return;
					map[groupKey] = count;
				}
				setVersion(function (v) { return v + 1; });
			}, []);
			// version 驱动重写；entries 变化（增删组）时 probe 的 effect 也会补齐/清掉，
			// 这里同时兜一次（防 entries 变了但计数没变的边界）。
			react.useEffect(function () {
				writeStepCardRules(countsRef.current);
			}, [version, entries]);
			var probes = [];
			if (entries && grouped) {
				for (var i = 0; i < entries.length; i++) {
					var entry = entries[i];
					if (!entry || entry.kind !== "group") continue;
					probes.push(react.createElement(StepCardGroupProbe, {
						key: entry.key, groupKey: entry.key, grouped: grouped, report: report
					}));
				}
			}
			return probes.length ? react.createElement(react.Fragment, null, probes) : null;
		}
		/** 牌数桥入口（由官方 turn-process 渲染器承载：插件既有的官方挂载点）。
		 *  旧宿主 / 非 session 作用域 / 拿不到 useConversation → 不订阅、不产出规则
		 *  → 默认 5 张牌（安全 fallback）。 */
		function StepCardRulesBridge(props) {
			var isLeader = useStepCardBridgeLeader();
			if (!isLeader || typeof props.useConversation !== "function") return null;
			return react.createElement(StepCardRuleWriter, { useConversation: props.useConversation });
		}


		// ---- 注入样式（记录在案的软兼容点） ----
		// 官方插件实践禁止在组件外写 DOM；但截至当前 master（21638c5631）DSH 没有给
		// plain-JS client plugin 提供样式注册 API（全宿主唯一的 createElement('style')
		// 在 web 自身的 apply-injections 里），而 Step 皮必须作用在"官方 Header 的官方
		// DOM"上——无法收敛进插件 React 子树。因此保留最小 <style> 注入并在 README
		// 明确标注为非理想软依赖：宿主未来提供样式注册面时迁过去；若注入失败，最坏
		// 退化 = 无 Turn 栏样式与无 Step 皮，官方折叠行为不受任何影响。
		// 拆成两个元素：base（Turn 栏/弹窗/滚轮，常开）+ skin（Step 扑克皮，
		// disabled 属性即皮肤总闸——不再写 document.body attribute）。
		var CSS_ID = "dsh-turn-fold/style";
		var SKIN_CSS_ID = "dsh-turn-fold/style-skin";
		var skinStyleEl = null;
		if (typeof document !== "undefined") {
			if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@winteries/dsh-turn-fold";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				/* ── Turn 栏（插件渲染器；官方 turn-process 栏的增强替换） ── */
				/* 兄弟交互结构：.ccg-turn-row = 主按钮（fold toggle）+ 齿轮按钮（设置），
				   视觉上仍是一根栏；交互不再依赖 stopPropagation */
				".ccg-turn-wrap{display:flex;flex-direction:column;min-width:0}",
				".ccg-turn-row{display:flex;align-items:center;gap:2px;width:100%;min-width:0}",
				".ccg-turn-bar-main{flex:1 1 auto;display:flex;align-items:center;gap:6px;min-width:0;background:none;border:none;padding:0;margin:0;font:inherit;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;text-align:left}",
				".ccg-turn-bar-main:hover:not([data-tf-static]):not([data-tf-running]){color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-turn-bar-main[data-tf-static],.ccg-turn-bar-main[data-tf-running]{cursor:default}",
				".ccg-turn-bar-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".ccg-turn-bar-status{flex:none;color:inherit}",
				/* 失败态：状态词标红（与官方错误色 token 一致） */
				".ccg-turn-bar-status.ccg-turn-status-failed{color:var(--dsw-alias-state-error-primary,#ef4444)}",
				".ccg-turn-bar-right{flex:none;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}",
				/* 齿轮：独立 <button>，与主按钮兄弟——只负责设置，Tab 次序紧随主按钮 */
				".ccg-gear-button{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:24px;background:none;border:none;padding:0;margin:0;cursor:pointer;color:var(--dsw-alias-label-tertiary,#9ca3af);border-radius:4px;transition:color .15s ease}",
				".ccg-gear-button:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-gear-button svg{transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				".ccg-gear-button:hover svg{transform:rotate(90deg)}",
				".ccg-gear-button:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4f6ef7)}",
				"@media (prefers-reduced-motion:reduce){.ccg-gear-button svg{transition:none!important}}",
				/* 回合栏下常驻分隔线（收起/展开/运行中都显示）：--dsw-alias-line-secondary
				   在部分版本无定义（官方自身也有悬空引用），链式兜底到 border-l1 与字面量 */
				".ccg-turn-divider{height:1px;flex:none;background:var(--dsw-alias-line-secondary,var(--dsw-alias-border-l1,#d1d5db));margin:4px 0 8px}",
				/* ── 扑克牌图标（Turn 栏 React 组件 + 选择器预览共用） ── */
				".ccg-poker-icon{display:inline-flex;align-items:center;justify-content:center;position:relative;width:24px;height:24px;flex:none;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				".ccg-poker-svg{display:flex;align-items:center}",
				/* mask 遮挡方案：真实牌与 mask 里的 occluder 用同一套绝对 transform，
				   同样的过渡曲线 → 开合动画期间遮挡逐帧对齐。rect 不填充（纯轮廓，
				   壁纸可透出）；下层牌被上层覆盖的区域由 mask 动态扣掉，不透出下层。 */
				".ccg-poker-motion,.ccg-poker-mask-card{transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				/* 运行中图标的开合角度过渡（CSS transform 覆盖 attribute，SMIL 动画不断流）：
				   牌面翻转：收起纵向中轴 ⇄ 展开竖直对角线轴。
				   data-spin-open 挂在外层 .ccg-poker-icon span（React 可控），
				   后代选择器切换内部 g 的 CSS transform，transition 播放平滑过渡。 */
				".ccg-poker-icon .ccg-axis-rest-rotation{transform-box:view-box;transform:rotate(0deg);transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				".ccg-poker-icon[data-spin-open] .ccg-axis-rest-rotation{transform:rotate(35.5377deg)}",
				/* 运行中卡牌动画：牌身透明（透壁纸），动画自身的 mask 扣掉上层覆盖区 */
				".anim-card{fill:transparent}",
				/* ── 滚轮数字（真实数据变化的里程表式滚动动画） ── */
				".ccg-roll-cell{display:inline-block;width:1ch;height:1em;overflow:hidden;vertical-align:-0.15em;text-align:center}",
				".ccg-roll-strip{display:flex;flex-direction:column}",
				".ccg-roll-strip .ccg-roll-d{flex:none;width:1ch;height:1em;line-height:1em;text-align:center}",
				".ccg-roll-text{display:inline}",
				".ccg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				/* ── 字段设置弹窗（由打开它的 Turn 栏自身 React 树渲染，无 body portal） ── */
				".ccg-gear-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);animation:ccg-gear-fade .15s ease-out}",
				".ccg-gear-popup{background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:16px 18px;min-width:320px;max-width:400px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-gear-popup:focus{outline:none}",
				".ccg-gear-popup:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#4f6ef7)}",
				".ccg-gear-popup-title{font-weight:600;font-size:14px;margin-bottom:4px}",
				".ccg-gear-popup-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin-bottom:10px}",
				".ccg-gear-popup-fields{display:flex;flex-direction:column;gap:2px}",
				".ccg-gear-popup-field{display:flex;align-items:center;gap:8px;padding:4px 2px;cursor:pointer;border-radius:6px;color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-gear-popup-field:hover{background:var(--dsw-alias-bg-layer-3,#f3f4f6)}",
				".ccg-gear-popup-field input[type=checkbox]{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary,#4f6ef7);cursor:pointer}",
				".ccg-gear-popup-field label{flex:1;cursor:pointer;user-select:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".ccg-gear-popup-field-desc{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af)}",
				".ccg-gear-popup-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
				".ccg-gear-popup-btn{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f6ef7));color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:14px;padding:4px 14px;font-size:12px;line-height:18px;cursor:pointer}",
				".ccg-gear-popup-btn:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4f6ef7))}",
				/* 选择器（图标风格 / Step 皮共用）：分隔线 + 标签 + 选项行 */
				".ccg-gear-divider{height:1px;background:var(--dsw-alias-border-l2,#e5e7eb);margin:10px 0 8px}",
				".ccg-gear-icon-selector{margin-bottom:2px}",
				".ccg-gear-icon-selector-label{font-size:12px;font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-secondary,#6b7280)}",
				".ccg-gear-icon-option{display:flex;align-items:center;gap:10px;padding:6px 8px;cursor:pointer;border-radius:8px;border:1.5px solid transparent;transition:border-color .15s ease,background .15s ease;margin-bottom:4px}",
				".ccg-gear-icon-option:hover{background:var(--dsw-alias-bg-layer-3,#f3f4f6)}",
				".ccg-gear-icon-option[data-selected]{border-color:var(--dsw-alias-brand-primary,#4f6ef7);background:var(--dsw-alias-bg-layer-3,#f3f4f6)}",
				/* 选项文字在左、预览图标组在右 */
				".ccg-gear-icon-option-text{flex:1;min-width:0}",
				".ccg-gear-icon-option-title{font-size:13px;font-weight:500;line-height:1.3;color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-gear-icon-option-desc{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af)}",
				".ccg-gear-icon-option-preview{flex:none;display:flex;align-items:center;gap:3px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				".ccg-gear-icon-option-preview-item{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:24px}",
				".ccg-gear-icon-option-preview-item svg{width:20px;height:20px}",
				".ccg-gear-icon-option-preview-item .ccg-poker-icon{width:20px;height:20px}",
				/* 预览放大气泡：悬浮预览图标时在其上方弹出放大版预览（2x） */
				".ccg-preview-tooltip{position:relative;display:inline-flex}",
				".ccg-preview-bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(3px);z-index:11000;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s ease,transform .12s ease}",
				".ccg-preview-tooltip:hover .ccg-preview-bubble,.ccg-preview-tooltip:focus-within .ccg-preview-bubble{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}",
				".ccg-preview-bubble-body{background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:14px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				".ccg-preview-bubble-body svg{width:80px;height:80px;display:block}",
				".ccg-preview-bubble-body .ccg-poker-icon{width:80px;height:80px}",
				"@media (prefers-reduced-motion:reduce){.ccg-preview-bubble{transition:none!important}}",
				"@keyframes ccg-gear-fade{from{opacity:0}to{opacity:1}}",
				"@media (prefers-reduced-motion:reduce){.ccg-gear-overlay{animation:none!important}}",
				/* 运行中数字动画尊重系统减弱动效设置 */
				"@media (prefers-reduced-motion:reduce){.ccg-roll-strip{transition:none!important}}"
			].join("\n");
			document.head.appendChild(tag);
			// 皮肤样式元素：Step 扑克皮（规则不带 body 前缀——总闸是本元素的 disabled）
			var skinTag = document.createElement("style");
			skinTag.dataset.plugin = "@winteries/dsh-turn-fold";
			skinTag.dataset.pluginCss = SKIN_CSS_ID;
			skinTag.textContent = buildStepSkinCss();
			document.head.appendChild(skinTag);
			skinStyleEl = skinTag;
			} else {
				// 已存在（热重载/测试重复加载）：重新持有皮肤元素引用
				skinStyleEl = document.querySelector('style[data-plugin-css="' + SKIN_CSS_ID + '"]');
			}
			// 牌数桥样式元素：必须排在皮肤表之后（逐组覆盖规则与静态端点规则特异性接近，
			// 靠"后者胜出"接管）；内容由 StepCardRulesBridge 写入，牌数不可得时保持空表
			// → 静态规则原样生效 = 5 张 fallback。
			if (skinStyleEl !== null) {
				var cardsTag = document.querySelector('style[data-plugin-css="' + STEP_CARD_CSS_ID + '"]');
				if (cardsTag === null) {
					cardsTag = document.createElement("style");
					cardsTag.dataset.plugin = "@winteries/dsh-turn-fold";
					cardsTag.dataset.pluginCss = STEP_CARD_CSS_ID;
					document.head.appendChild(cardsTag);
				}
				stepCardStyleEl = cardsTag;
				stepCardRulesCache = cardsTag.textContent;
			}
			applyIconStyle();
		}

		// ---- 运行中秒表时钟（Running Turn Bar 的耗时刷新） ----
		// 运行中回合的 TurnLocation 只有 start 没有 end：耗时需要时钟驱动刷新。
		// 固定 1000ms 一次（无随机抖动）：假 token 增长删除后，秒表只显示整数秒、
		// usage 更新由真实数据事件驱动（turn-tail / assistant-step 订阅），没有理由
		// 每秒刷新 4-8 次。共享一个模块级定时器（递归 setTimeout）：有组件订阅才启动，
		// 全部退订即停止。
		var liveTickMs = 1000;
		var tickListeners = new Set();
		var tickVersion = 0;
		var tickTimer = null;
		// 定时器回调正在执行中（回调期间 tickTimer 为 null，续订由回调末尾统一决定）。
		// 没有这个标志会有两个方向的竞态：
		//   ① 回调里若无条件 scheduleTick()——最后一个订阅者在回调栈内退订（React 对
		//      uSES 通知做同步重渲染时，组件切到 subscribeNothing 的清理就跑在这里）时，
		//      退订分支看到 tickTimer===null 什么也不做，回调末尾又续上一只表 →
		//      留下一只永远空转、没人停的定时器。
		//   ② 回调期间若有新订阅者进来，subscribeTicks 看到 tickTimer===null 会再起
		//      一条链 → 两条链并行，tick 速率翻倍且其中一条无人持有。回调期间不新起
		//      链，由末尾按订阅者数量统一续订即可。
		var tickRunning = false;
		function scheduleTick() {
			tickTimer = setTimeout(function () {
				tickTimer = null;
				tickRunning = true;
				tickVersion++;
				// 逐个监听者兜异常：单个订阅者抛错（React 的 uSES 通知链路异常）不能
				// 带走时钟本身——否则耗时秒表静默停死到刷新页面为止。
				// 用 try/finally 保证 tickRunning 一定复位，状态机不会卡在"回调中"。
				try {
					var fns = [];
					tickListeners.forEach(function (fn) { fns.push(fn); });
					for (var i = 0; i < fns.length; i++) {
						try { fns[i](); } catch (errOne) {
							try {
								if (typeof console !== "undefined" && console.warn) {
									console.warn("[dsh-turn-fold] 直播时钟监听者抛错（已跳过该监听者）：", errOne);
								}
							} catch (e) { /* 忽略 */ }
						}
					}
				} finally {
					tickRunning = false;
					// 回调期间无人持有新链，这里按"是否还有订阅者"决定续订——无订阅者即停表。
					if (tickListeners.size > 0 && tickTimer === null) scheduleTick();
				}
			}, liveTickMs);
		}
		function subscribeTicks(fn) {
			tickListeners.add(fn);
			if (tickTimer === null && !tickRunning) scheduleTick();
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

		// ---- 回合性能指标（全部来自官方真实数据） ----
		/** 缓存命中率：固定两位小数（如 "66.67"、"99.99"、"100.00"）；无可计费输入返回 null。 */
		function cacheHitPercent(uncachedInputTokens, cacheReadTokens, cacheWriteTokens) {
			var denominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
			if (denominator === 0) return null;
			return (cacheReadTokens / denominator * 100).toFixed(2);
		}
		/**
		 * 从回合定位对象提取计时/状态（官方 TurnLocation 契约）：
		 *   - startMs/endMs：turn/start 与 turn/end 事件的墙钟时间（毫秒）。
		 *   - status：'open' | 'closed' | 'unknown'。
		 *   - reason：turn/end 的 reason.kind（completed / aborted / error / max-tokens / blocked）。
		 * 非回合/步骤定位（如 session 级）返回 null。
		 */
		function turnClockOf(node) {
			var loc = node && node.location;
			var turn = loc && (loc.kind === "turn" || loc.kind === "step") ? loc.turn : undefined;
			if (!turn) return null;
			var startMs = turn.start && typeof turn.start.time === "number" ? turn.start.time : undefined;
			var endMs = turn.end && typeof turn.end.time === "number" ? turn.end.time : undefined;
			var reason = turn.end && turn.end.data && turn.end.data.reason && turn.end.data.reason.kind;
			return {
				turn: turn,
				number: turn.turn,
				startMs: startMs,
				endMs: endMs,
				status: turn.status,
				reason: typeof reason === "string" ? reason : undefined,
				/** Turn-scoped 业务数据读取器（官方 ConversationLocationDataStore）。 */
				data: typeof turn.data === "object" && turn.data ? turn.data : null,
				/** 已解析的 Step 定位序列（每步带 data store）。 */
				steps: Array.isArray(turn.steps) ? turn.steps : []
			};
		}
		/** step 号 → step/start 事件时间。官方 StepLocation.start 与
		 *  AssistantTiming.stepStartTime 是同一事件时间戳（assistant.ts:
		 *  context.start?.event.time），无任何估算。 */
		function stepStartMsOf(clock, stepNo) {
			if (typeof stepNo !== "number") return undefined;
			for (var j = 0; j < clock.steps.length; j++) {
				var loc = clock.steps[j];
				if (loc && loc.step === stepNo) {
					return loc.start && typeof loc.start.time === "number" ? loc.start.time : undefined;
				}
			}
			return undefined;
		}
		/** 官方 usageOutputTokens 同款（turn-metrics.ts）：有限且 ≥0 才算数。 */
		function outputTokensOf(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			var v = usage.outputTokens;
			return typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
		}
		/** 累加一个 assistant-step 数据的 usage / TTFT / decode 证据（acc 为可变累加器）。
		 *  数据来自官方 step data store（turn.steps[].data.get('assistant-step')）——
		 *  官方按 step 发布、与节点可见性无关，隐藏纯工具步骤的 usage 同样计入。
		 *  同一数据只累加一次（acc.counted 按对象引用去重；官方每次发布都是新快照对象，
		 *  status/usage/finalNode 的更新不会被旧引用挡住）。
		 *
		 *  TTFT 两层值（绝不伪造时间）：
		 *  - exact：settled 后 finalNode.timing {stepStartTime, firstTokenTime}（官方
		 *    turn-metrics.assistantStepReading 同款，firstTokenTime 含 tool delta、
		 *    retry 保留首个）——始终优先；
		 *  - provisional：running 且官方 timing 未就绪时，data.time（官方
		 *    projectAssistant：settled?.time ?? firstVisibleTime，即第一个可见
		 *    text/reasoning block 的事件时间，不含 tool-call）- step/start 时间
		 *    （stepStartMsOf）——"可见首字延迟"，settled 后被 exact 校正。
		 *  两者取 step 号最小者（第一个请求）；任何一方缺数据该 step 不产生候选。 */
		function readStepUsage(data, acc, stepStartMs) {
			if (!data || acc.counted.has(data)) return;
			acc.counted.add(data);
			var u = data.usage;
			if (u && typeof u === "object") {
				// 计费输入：官方 wire usage 用 inputTokens；容忍 uncachedInputTokens 命名
				if (typeof u.inputTokens === "number" && isFinite(u.inputTokens)) acc.input += u.inputTokens;
				else if (typeof u.uncachedInputTokens === "number" && isFinite(u.uncachedInputTokens)) acc.input += u.uncachedInputTokens;
				if (typeof u.outputTokens === "number" && isFinite(u.outputTokens)) { acc.output += u.outputTokens; acc.has = true; }
				if (typeof u.cacheReadTokens === "number" && isFinite(u.cacheReadTokens)) { acc.cacheRead += u.cacheReadTokens; acc.has = true; }
				if (typeof u.cacheWriteTokens === "number" && isFinite(u.cacheWriteTokens)) { acc.cacheWrite += u.cacheWriteTokens; acc.has = true; }
			}
			// TTFT 候选（exact 优先，provisional 兜底；step 号最小者生效）
			var candidate = null, exact = false;
			var fn = data.finalNode;
			var timing = fn && fn.timing;
			if (timing && typeof timing.stepStartTime === "number" && typeof timing.firstTokenTime === "number") {
				candidate = Math.max(0, timing.firstTokenTime - timing.stepStartTime);
				exact = true;
			} else if (data.status === "running" && typeof data.time === "number" && data.time > 0
				&& typeof stepStartMs === "number") {
				candidate = Math.max(0, data.time - stepStartMs);
			}
			if (candidate !== null) {
				var stepNum = typeof data.step === "number" ? data.step : -1;
				if (stepNum < acc.ttftStep || (stepNum === acc.ttftStep && exact && !acc.ttftExact)) {
					acc.ttftStep = stepNum;
					acc.ttft = candidate;
					acc.ttftExact = exact;
				}
			}
			// decode 聚合（官方 assistantStepReading 语义）：只计 settled 且
			// firstTokenTime 与 outputTokens 齐备的 step——running/缺一项都不进分母
			if (fn && timing && typeof timing.firstTokenTime === "number" && typeof timing.completedTime === "number") {
				var out = outputTokensOf(fn.usage);
				if (out !== null) {
					acc.decodeMs += Math.max(0, timing.completedTime - timing.firstTokenTime);
					acc.decodeTokens += out;
				}
			}
		}
		// ---- 观察到的真实 TTFT（运行时缓存；只解决"settle 后不无缘无故退回 —"） ----
		// 只缓存**真实观察过**的数值（客户端 exact / running provisional / durable），
		// 绝不估算、绝不插值；页面刷新后自然清空（reload / 历史会话的正确性由
		// durable projection 负责，不靠这个缓存）。
		var OBSERVED_TTFT_MAX = 500;
		var observedTtft = new Map();
		function observedTtftKey(sessionId, turn) {
			return String(sessionId === undefined ? "" : sessionId) + ":" + String(turn);
		}
		function rememberObservedTtft(sessionId, turn, ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms < 0 || typeof turn !== "number") return;
			var key = observedTtftKey(sessionId, turn);
			if (observedTtft.has(key)) observedTtft.delete(key);
			observedTtft.set(key, ms);
			while (observedTtft.size > OBSERVED_TTFT_MAX) {
				var oldest = observedTtft.keys().next();
				if (oldest.done) break;
				observedTtft.delete(oldest.value);
			}
		}
		function readObservedTtft(sessionId, turn) {
			if (typeof turn !== "number") return null;
			var value = observedTtft.get(observedTtftKey(sessionId, turn));
			return typeof value === "number" ? value : null;
		}

		/** 汇总回合指标：{ durationMs, ttftMs, tokens, outputTokens, tokensPerSecond, cacheHitPercent }。
		 *
		 *  数据源优先级（全部为官方真实数据，无任何伪造增长）：
		 *  ① 回合结束后 turn-tail 携带的官方聚合 tokenUsage（deriveTurnTokenUsage 在
		 *     持久化事件日志上折叠全部 attempt 的精确值——含被重试请求与隐藏步骤）；
		 *  ② step usage 累加值（turn.steps[].data 的 assistant-step，含隐藏步骤）。
		 *  tok/s 与官方 StatsPills 同一 decode-speed 定义：Σ outputTokens ÷ Σ
		 *  (completedTime - firstTokenTime)——只统计 settled 且两项齐备的 step；
		 *  TTFT/tool 执行/step 间等待不进分母（turn-metrics.assistantStepReading）。
		 *  Turn Bar 只聚合当前 Turn 的 step；官方底部是整个 Session 的 sessionStats——
		 *  同一定义、不同范围，数值不同是正常的。
		 *
		 *  TTFT 数据源（exact 优先，绝不估算）：
		 *  ① durable：插件自己的官方 projection「turnFoldMetrics」——host 按落盘事件
		 *     （step/start + assistant/attempt/assistant/message 的 compact stream）折叠，
		 *     与官方 sessionStats 用同一个 first-token 谓词；**reload / 历史会话后仍存在**；
		 *  ② 客户端 exact：finalNode.timing（同一谓词，但只在本次页面里 live 流过时才有）；
		 *  ③ running provisional：官方 firstVisibleTime（data.time，第一个可见 text/reasoning
		 *     block）− step/start 时间 = "可见首字延迟"，settled 后被 exact 校正；
		 *  ④ 运行时缓存：本次页面真实观察过的值，settle 后 exact 缺失时继续显示它（不退回 —）。
		 *  decode 同理：durable 的 decodeMs/decodeTokens 优先，客户端 step 聚合兜底。 */
		function computeTurnMetrics(clock, stepDataList, tail, liveNow, durable, sessionId) {
			if (!clock) return null;
			var durationMs;
			if (typeof clock.startMs === "number") {
				var end = typeof clock.endMs === "number" ? clock.endMs
					: (clock.status !== "closed" && typeof liveNow === "number" ? liveNow : undefined);
				if (typeof end === "number") durationMs = Math.max(0, end - clock.startMs);
			}
			var acc = {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false,
				ttft: null, ttftStep: Infinity, ttftExact: false,
				decodeMs: 0, decodeTokens: 0, counted: new Set()
			};
			for (var i = 0; i < stepDataList.length; i++) {
				var sd = stepDataList[i];
				readStepUsage(sd, acc, stepStartMsOf(clock, sd && sd.step));
			}
			var billedInput = acc.input + acc.cacheRead + acc.cacheWrite;
			var hasUsage = acc.has && (billedInput > 0 || acc.output > 0);
			var tokens, outputTokens, cacheHit;
			if (tail && tail.tokenUsage && typeof tail.tokenUsage.totalTokens === "number") {
				// 官方聚合值优先（TurnUsagePanel 同款语义）：totalTokens = 全部 attempt 的
				// 精确 prompt+output；缓存命中率分母 = prompt 侧总量；cacheRead 缺报时
				// 回退 step 累加值。
				tokens = tail.tokenUsage.totalTokens;
				outputTokens = typeof tail.tokenUsage.outputTokens === "number" ? tail.tokenUsage.outputTokens : undefined;
				var promptSide = outputTokens !== undefined ? tokens - outputTokens : undefined;
				cacheHit = typeof tail.tokenUsage.cacheReadTokens === "number" && promptSide > 0
					? (tail.tokenUsage.cacheReadTokens / promptSide * 100).toFixed(2)
					: (hasUsage && billedInput > 0 ? cacheHitPercent(acc.input, acc.cacheRead, acc.cacheWrite) : undefined);
			} else if (hasUsage) {
				// 消耗 = 计费输入（uncached + cacheRead + cacheWrite）+ 输出
				tokens = billedInput + acc.output;
				outputTokens = acc.output;
				cacheHit = billedInput > 0 ? cacheHitPercent(acc.input, acc.cacheRead, acc.cacheWrite) : undefined;
			}
			// decode 证据：durable（官方 projection）优先，客户端 step 聚合兜底
			var decodeMs = acc.decodeMs, decodeTokens = acc.decodeTokens;
			if (durable && (durable.decodeMs > 0 || durable.decodeTokens > 0)) {
				decodeMs = durable.decodeMs;
				decodeTokens = durable.decodeTokens;
			}
			// TTFT：durable exact → 客户端 exact → running provisional → 运行时缓存
			var ttftMs = null;
			if (durable && typeof durable.ttftMs === "number") ttftMs = durable.ttftMs;
			else if (acc.ttft !== null) ttftMs = acc.ttft;
			if (ttftMs === null) ttftMs = readObservedTtft(sessionId, clock.number);
			else rememberObservedTtft(sessionId, clock.number, ttftMs);
			// tok/s：官方 decode-speed 语义（与整个 Turn 墙钟时长无关）
			var tps = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : undefined;
			if (durationMs === undefined && tokens === undefined && ttftMs === null && tps === undefined) return null;
			var result = { durationMs: durationMs, tokens: tokens, outputTokens: outputTokens, tokensPerSecond: tps, cacheHitPercent: cacheHit };
			if (ttftMs !== null) result.ttftMs = ttftMs;
			return result;
		}

		/** 耗时格式化：中英文各自的单位写法；>=1 小时 → "x时x分x秒" / "xh xm xs"。 */
		function formatTurnDuration(ms) {
			var total = Math.floor(ms / 1000);
			if (total >= 3600) {
				var h = Math.floor(total / 3600);
				var m = Math.floor((total % 3600) / 60);
				var s = total % 60;
				if (currentLocale() === "zh") return h + "时" + m + "分" + s + "秒";
				return h + "h " + m + "m " + s + "s";
			}
			if (total >= 60) {
				var mm = Math.floor(total / 60);
				var ss = total % 60;
				if (currentLocale() === "zh") return mm + "分" + ss + "秒";
				return mm + "m " + ss + "s";
			}
			if (currentLocale() === "zh") return total + "秒";
			return total + "s";
		}
		/** tok/s：>=10 取整，<10 保留一位小数（与官方一致）。 */
		function formatTokPerSec(tps) {
			var v = Math.max(0, tps);
			return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
		}
		/** token 数千位分组（"12345" → "12,345"；非有限数值原样字符串化）。 */
		function formatTokenCount(n) {
			if (typeof n !== "number" || !isFinite(n)) return String(n);
			var neg = n < 0 ? "-" : "";
			var digits = String(Math.floor(Math.abs(n)));
			var out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
			return neg + out;
		}
		/** Turn 栏指标文案（目标样式，见 README）：
		 *  zh: "耗时1分32秒 · 首字1.2s · 12,345 token · 34 tok/s · 缓存80%"
		 *  en: "1m 32s · TTFT 1.2s · 12,345 tokens · 34 tok/s · Cache 80%"
		 *  槽位模式（filterVisibleMetrics 归一化的启用字段）：key 存在但无值 →
		 *  显示 "—"（有真实数据才显示真实值，绝不伪造；运行中 0 秒起布局稳定）。
		 *  非槽位入参（无该 key）不渲染该段。无任何字段返回空串（fallback 兜底）。 */
		function turnHeaderLabel(metrics) {
			if (!metrics) return "";
			var zh = currentLocale() === "zh";
			var parts = [];
			if (metrics.durationMs !== undefined) {
				parts.push(zh ? "耗时" + formatTurnDuration(metrics.durationMs) : formatTurnDuration(metrics.durationMs));
			} else if ("durationMs" in metrics) {
				parts.push(zh ? "耗时—" : "—");
			}
			if (metrics.ttftMs !== undefined) {
				var ttftSec = (metrics.ttftMs / 1000).toFixed(1);
				parts.push(zh ? "首字" + ttftSec + "s" : "TTFT " + ttftSec + "s");
			} else if ("ttftMs" in metrics) {
				parts.push(zh ? "首字—" : "TTFT —");
			}
			if (metrics.tokens !== undefined) {
				parts.push(zh ? formatTokenCount(metrics.tokens) + " token" : formatTokenCount(metrics.tokens) + " tokens");
			} else if ("tokens" in metrics) {
				parts.push(zh ? "— token" : "— tokens");
			}
			if (metrics.tokensPerSecond !== undefined) {
				parts.push(formatTokPerSec(metrics.tokensPerSecond) + (zh ? "tok/s" : " tok/s"));
			} else if ("tokensPerSecond" in metrics) {
				parts.push("— tok/s");
			}
			if (metrics.cacheHitPercent !== undefined) {
				parts.push(zh ? "缓存" + metrics.cacheHitPercent + "%" : "Cache " + metrics.cacheHitPercent + "%");
			} else if ("cacheHitPercent" in metrics) {
				parts.push(zh ? "缓存—" : "Cache —");
			}
			return parts.join(" · ");
		}
		/** 回合结束状态词（仅异常结束有词；正常完成/无数据返回 null——完成态不加前缀）。
		 *  @param {string|undefined} reason - turn/end 的 reason.kind。 */
		function turnStatusLabel(reason) {
			if (reason === "aborted") return _T("statusStopped");
			if (reason === "error") return _T("statusFailed");
			if (reason === "max-tokens") return _T("statusInterrupted");
			return null;
		}
		/** 回合轮次文案：回合栏最右侧右对齐显示（"第3轮" / "Turn 3"）。 */
		function turnRoundLabel(turn) {
			if (turn === undefined || turn === null) return "";
			return currentLocale() === "zh" ? "第" + turn + "轮" : "Turn " + turn;
		}

		// ---- 扑克牌视觉（插件签名视觉，保留自原版） ----
		// 花色 path（24 单位空间，fill currentColor 跟随图标色）外置到 icons/default.json
		//（pokerPips），经 ICON_DEFAULTS / localStorage 注入（POKER_PIPS / 鲸鱼数据
		// 在"图标配置"节已就绪——Step 皮 CSS 生成同样依赖它）。
		/** 牌面池：四花色 + DeepSeek Logo（Logo 仅在 pokerSpinDeepseek 数据存在时入池；
		 *  池在调用时计算，兼容 localStorage 图标包覆盖的加载时机）。 */
		var POKER_SUITS = ["spade", "heart", "diamond", "club"];
		function pokerFacePool() {
			return POKER_SPIN_DEEPSEEK ? POKER_SUITS.concat(["deepseek"]) : POKER_SUITS;
		}
		/** 每个回合栏随机一个"牌面"（五选一，按回合号记忆，重渲染保持同一牌面不变）。 */
		var foldSuitMap = new Map();
		function foldSuitFor(key) {
			if (foldSuitMap.has(key)) return foldSuitMap.get(key);
			var pool = pokerFacePool();
			var suit = pool[Math.floor(Math.random() * pool.length)];
			foldSuitMap.set(key, suit);
			return suit;
		}
		/** ── mask 遮挡方案（不依赖填充色，壁纸/透明背景下也正确）──
		 *  每个下层牌一个 luminance mask：白底默认显示，黑色 occluder 跟随"上层牌"的
		 *  绝对 transform，把上层覆盖区域从下层牌上扣掉 → 牌身透明（透壁纸）时重叠区
		 *  也不透出下层轮廓。真实牌与 occluder 用同一套 transform + 过渡 → 动画期间逐帧对齐。 */
		var POKER_R = (iconConfig && iconConfig.pokerR) || 1.08;  // 圆角半径（真实扑克牌 5:7 比例）
		var pokerSVGSeq = 0;                     // mask id 唯一性计数器
		// ---- 回合栏运行中图标：竖直对角线轴旋转卡牌（真实比例 5:7）----
		// 卡牌绕自身左上→右下对角线轴连续翻转，正面显示花色、背面显示 DeepSeek 鲸鱼 Logo。
		// scaleX(cosθ) 共轭变换：θ 过 90°/270° 时零宽切面切换正/背面，视觉无跳变。
		var POKER_SPIN_REST = (iconConfig && iconConfig.pokerSpin && iconConfig.pokerSpin.restAngle) || 35.5377;   // 竖直对角线轴倾角 ≈ 35.54°
		var POKER_SPIN_H = (iconConfig && iconConfig.pokerSpin && iconConfig.pokerSpin.h) || 9.6;
		var POKER_SPIN_W = POKER_SPIN_H * ((iconConfig && iconConfig.pokerSpin && iconConfig.pokerSpin.pokerRatio) || 0.7142857142857143);                 // ≈ 6.8571（5:7 比例）
		var POKER_SPIN_X = 8 - POKER_SPIN_W / 2;
		var POKER_SPIN_Y = 8 - POKER_SPIN_H / 2;
		var POKER_SPIN_R = (iconConfig && iconConfig.pokerSpin && iconConfig.pokerSpin.r) || 1.296;                                 // 5:7 比例圆角
		var POKER_SPIN_STROKE = 0.84;
		var POKER_SPIN_PIP = (iconConfig && iconConfig.pokerSpin && iconConfig.pokerSpin.pipScale) || 0.2347826086956522;
		var POKER_SPIN_LOGO_SCALE = (Math.min(POKER_SPIN_W * 0.72, POKER_SPIN_H * 0.58)) / 24;
		// scaleX(cosθ) 关键帧（72 帧，0.013889 步长，2.4s 循环）：1→0→-1→0→1 平滑翻转。
		var POKER_SPIN_SCALE = '1 1;0.996195 1;0.984808 1;0.965926 1;0.939693 1;0.906308 1;0.866025 1;0.819152 1;0.766044 1;0.707107 1;0.642788 1;0.573576 1;0.5 1;0.422618 1;0.34202 1;0.258819 1;0.173648 1;0.087156 1;0 1;-0.087156 1;-0.173648 1;-0.258819 1;-0.34202 1;-0.422618 1;-0.5 1;-0.573576 1;-0.642788 1;-0.707107 1;-0.766044 1;-0.819152 1;-0.866025 1;-0.906308 1;-0.939693 1;-0.965926 1;-0.984808 1;-0.996195 1;-1 1;-0.996195 1;-0.984808 1;-0.965926 1;-0.939693 1;-0.906308 1;-0.866025 1;-0.819152 1;-0.766044 1;-0.707107 1;-0.642788 1;-0.573576 1;-0.5 1;-0.422618 1;-0.34202 1;-0.258819 1;-0.173648 1;-0.087156 1;0 1;0.087156 1;0.173648 1;0.258819 1;0.34202 1;0.422618 1;0.5 1;0.573576 1;0.642788 1;0.707107 1;0.766044 1;0.819152 1;0.866025 1;0.906308 1;0.939693 1;0.965926 1;0.984808 1;0.996195 1;1 1';
		var POKER_SPIN_KEYS = '0;0.013889;0.027778;0.041667;0.055556;0.069444;0.083333;0.097222;0.111111;0.125;0.138889;0.152778;0.166667;0.180556;0.194444;0.208333;0.222222;0.236111;0.25;0.263889;0.277778;0.291667;0.305556;0.319444;0.333333;0.347222;0.361111;0.375;0.388889;0.402778;0.416667;0.430556;0.444444;0.458333;0.472222;0.486111;0.5;0.513889;0.527778;0.541667;0.555556;0.569444;0.583333;0.597222;0.611111;0.625;0.638889;0.652778;0.666667;0.680556;0.694444;0.708333;0.722222;0.736111;0.75;0.763889;0.777778;0.791667;0.805556;0.819444;0.833333;0.847222;0.861111;0.875;0.888889;0.902778;0.916667;0.930556;0.944444;0.958333;0.972222;0.986111;1';
		var pokerSpinSeq = 0;
		/** 四种花色的可见性关键帧（6.4s 一个完整花色循环：4 次 360° 翻牌，
		 *  每次翻到背面固定显示 DeepSeek，越过背面后切到下一种花色）。 */
		var POKER_SPIN_SUIT_VIS = {
			spade:   { initial: "visible", values: "visible;hidden;visible;visible", keyTimes: "0;0.0625;0.9375;1" },
			heart:   { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.1875;0.3125;1" },
			diamond: { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.4375;0.5625;1" },
			club:    { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.6875;0.8125;1" }
		};
		var POKER_SPIN_BACK_VIS = "hidden;visible;hidden;visible;hidden;visible;hidden;visible;hidden;hidden";
		var POKER_SPIN_BACK_KEYS = "0;0.0625;0.1875;0.3125;0.4375;0.5625;0.6875;0.8125;0.9375;1";
		/** 生成牌面翻转 SVG（四花色循环 + DeepSeek 背面，6.4s 完整循环）。
		 *  卡牌绕自身左上→右下对角线轴连续翻转，正面按 ♠ → ♥ → ♦ → ♣ 循环，
		 *  每次翻到背面都固定显示 DeepSeek 鲸鱼 Logo，再翻出下一种花色。
		 *  scaleX(cosθ) 共轭变换：θ 过 90°/270° 时零宽切面切换正/背面，视觉无跳变。 */
		function buildPokerSpinSVG(uid) {
			var faceRect = '<rect class="anim-card axis-spin-card" x="' + POKER_SPIN_X + '" y="' + POKER_SPIN_Y +
				'" width="' + POKER_SPIN_W + '" height="' + POKER_SPIN_H + '" rx="' + POKER_SPIN_R +
				'" stroke="currentColor" stroke-width="' + POKER_SPIN_STROKE + '"/>';
			var deepseek = POKER_SPIN_DEEPSEEK.replace("axis-deepseek-UID", "axis-deepseek-" + uid);
			// 四种花色正面
			var faces = "";
			var suits = ["spade", "heart", "diamond", "club"];
			for (var fi = 0; fi < suits.length; fi++) {
				var suit = suits[fi];
				var info = POKER_PIPS[suit];
				var vis = POKER_SPIN_SUIT_VIS[suit];
				var scale = POKER_SPIN_PIP * info.factor;
				faces += '<g visibility="' + vis.initial + '">' +
					'<animate attributeName="visibility" values="' + vis.values + '" keyTimes="' + vis.keyTimes +
					'" dur="6.4s" repeatCount="indefinite" calcMode="discrete"/>' +
					faceRect +
					'<g transform="translate(8 8) scale(' + scale + ') translate(' + (-info.cx) + ' ' + (-info.cy) + ')">' +
					info.path + '</g></g>';
			}
			return '<svg viewBox="0 0 16 16" width="24" height="24" style="color:var(--dsw-alias-label-secondary,#9ca3af)">' +
				'<defs>' + deepseek + '</defs>' +
				'<g transform="translate(8 8)">' +
				'<g>' +
				'<animateTransform attributeName="transform" type="scale" values="' + POKER_SPIN_SCALE +
				'" keyTimes="' + POKER_SPIN_KEYS + '" dur="1.6s" repeatCount="indefinite" calcMode="linear"/>' +
				'<g class="ccg-axis-rest-rotation" transform="rotate(' + POKER_SPIN_REST + ')">' +
				'<g transform="translate(-8 -8)">' +
				faces +
				'<g visibility="hidden">' +
				'<animate attributeName="visibility" values="' + POKER_SPIN_BACK_VIS +
				'" keyTimes="' + POKER_SPIN_BACK_KEYS + '" dur="6.4s" repeatCount="indefinite" calcMode="discrete"/>' +
				faceRect +
				'<g transform="translate(8 8) scale(' + POKER_SPIN_LOGO_SCALE + ') translate(12 -12) scale(-1 1)">' +
				'<use href="#axis-deepseek-' + uid + '" fill="currentColor"/></g></g>' +
				'</g></g></g></g></svg>';
		}
		/** 回合栏运行中图标：牌面翻转（四花色循环 ♠ → ♥ → ♦ → ♣ 正面 / DeepSeek Logo 背面）。
		 *  uid 固定 + useMemo 缓存 SVG 字符串——栏重渲染（指标刷新）时 __html 不变，
		 *  SMIL 动画持续不重启。 */
		function PokerSpinIcon() {
			var uidRef = react.useRef(null);
			if (uidRef.current === null) uidRef.current = "ccg-poker-spin-" + (++pokerSpinSeq);
			var html = react.useMemo(function () { return buildPokerSpinSVG(uidRef.current); }, []);
			return react.createElement("span", { className: "ccg-poker-icon" },
				react.createElement("span", { className: "ccg-poker-svg", dangerouslySetInnerHTML: { __html: html } })
			);
		}
		/** 生成某牌的 mask：白底 + 每张其他牌一个黑色 occluder（transform 由 PokerIcon 动态设置）。 */
		function pokerDynamicMask(maskId, owner, n, x, y, w, h) {
			var cuts = "";
			for (var j = 1; j <= n; j++) {
				if (j === owner) continue;
				cuts += '<g class="ccg-poker-mask-card" data-i="' + j + '" data-mask-owner="' + owner +
					'" visibility="hidden" transform="translate(0, 0)">' +
					'<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + POKER_R +
					'" fill="black" stroke="black" stroke-width="0.7"/></g>';
			}
			return '<mask id="' + maskId + '" x="-4" y="-4" width="24" height="24" ' +
				'maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance">' +
				'<rect x="-4" y="-4" width="24" height="24" fill="white"/>' + cuts + '</mask>';
		}
		/** 生成扑克牌 SVG 标记（mask 遮挡方案）：每张牌 = 外层 card-i（根坐标系，带 mask-id）+
		 *  内层 card-motion（变换）；defs 里为每张牌生成 mask。rect 不填充（纯轮廓，壁纸透出）。
		 *  保持真实扑克牌 5:7 比例（w = h × 5/7），几何参数从 iconConfig 读取。 */
		function buildPokerSVGBase(count, suit) {
			var five = count > 3;
			// suit = "deepseek"：牌面用 DeepSeek 鲸鱼 Logo（与四花色一起入随机池）。
			// Logo path 与花色同为 24 单位空间、几何中心 (12,12)，无 fill 属性（继承
			// currentColor）；defs 里以每实例唯一 id 注入一次，pip 处 <use> 引用。
			var isLogo = suit === "deepseek" && !!POKER_SPIN_DEEPSEEK;
			var info = isLogo ? { cx: 12, cy: 12, factor: 1 } : (POKER_PIPS[suit] || POKER_PIPS.spade);
			var cfg = iconConfig && iconConfig.pokerSVGBase;
			// 真实扑克牌比例 5:7：高不变，宽 = 高 × 5/7，中心对齐
			var h = five ? (cfg && cfg.hFive) || 8 : (cfg && cfg.hThree) || 8.5;
			var w = h * ((cfg && cfg.pokerRatio) || 0.7142857142857143);
			var x = 8 - w / 2, y = five ? 4 : 3.5;
			var pipScale = (five ? (cfg && cfg.pipScaleFive) || 0.24 : (cfg && cfg.pipScaleThree) || 0.28) * info.factor;
			var n = five ? 5 : 3;
			var seq = (++pokerSVGSeq);
			var maskBase = "ccg-poker-mask-" + seq;
			var logoId = null;
			var defs = "";
			if (isLogo) {
				logoId = "ccg-poker-logo-" + seq;
				defs += POKER_SPIN_DEEPSEEK.replace("axis-deepseek-UID", logoId);
			}
			var parts = [];
			for (var ci = 1; ci <= n; ci++) {
				var mid = maskBase + "-" + ci;
				defs += pokerDynamicMask(mid, ci, n, x, y, w, h);
				var hasPip = five ? (ci === 5 || ci === 3) : (ci === 2 || ci === 3);
				var pip = "";
				if (hasPip) {
					// Logo 不用花色的 pipScale：花色 glyph 的 24 盒自带内边距，而鲸鱼墨迹
					// 几乎填满 24 盒，同 scale 会撑出卡边。按卡牌几何独立取缩放（与翻牌
					// 动画 POKER_SPIN_LOGO_SCALE 同款公式），宽度向约束自然留出描边余量。
					var pipScaleUsed = isLogo ? (Math.min(w * 0.72, h * 0.58) / 24) * info.factor : pipScale;
					var pipInner = isLogo ? '<use href="#' + logoId + '" fill="currentColor"/>' : info.path;
					pip = '<g class="ccg-poker-pip" transform="translate(' + (x + w / 2) + ', ' + (y + h / 2) + ') scale(' + pipScaleUsed + ') translate(' + (-info.cx) + ', ' + (-info.cy) + ')">' + pipInner + '</g>';
				}
				parts.push(
					'<g class="ccg-poker-card" data-i="' + ci + '" data-mask-id="' + mid + '">' +
					'<g class="ccg-poker-motion" transform="translate(0, 0)">' +
					'<rect class="ccg-poker-rect" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + POKER_R + '" fill="none" stroke="currentColor" stroke-width="0.7"/>' +
					pip + '</g></g>'
				);
			}
			return '<svg viewBox="0 0 16 16" width="24" height="24" style="display:block">' +
				'<defs>' + defs + '</defs>' + parts.join("") + '</svg>';
		}
		/** 扇形/牌堆变换表（中心对齐 (8,8)；card-3 纯 translate 防过渡 bug）。
		 *  变换表从 iconConfig.pokerTransforms 读取，可被图标包覆盖。
		 *  **牌身份连续**：同一 card id 在 stack 与 fan 里是同一张牌，层级不变——
		 *  stack3 的顶牌 card3 在 fan3 里必须是最右那张（与 fan5 同构：居中那张不带旋转，
		 *  两侧对称展开、id 越大越靠右）。 */
		function pokerTransforms(count, fan) {
			var five = count > 3;
			var t = (iconConfig && iconConfig.pokerTransforms) || {};
			if (fan) {
				return five
					? t.fan5 || { 1: "translate(0, -0.608) rotate(-32 8 12)", 2: "translate(0, -0.608) rotate(-16 8 12)", 3: "translate(0, -0.608)", 4: "translate(0, -0.608) rotate(16 8 12)", 5: "translate(0, -0.608) rotate(32 8 12)" }
					: t.fan3 || { 1: "translate(0, -0.18) rotate(-26 8 12)", 2: "translate(0, -0.18)", 3: "translate(0, -0.18) rotate(26 8 12)" };
			}
			return five
				? t.stack5 || { 1: "translate(1.6, 1.6)", 2: "translate(0.8, 0.8)", 3: "translate(0, 0)", 4: "translate(-0.8, -0.8)", 5: "translate(-1.6, -1.6)" }
				: t.stack3 || { 1: "translate(1, 2.25)", 2: "translate(0, 0.25)", 3: "translate(-1, -1.75)" };
		}
		/** 牌的绘制顺序（index 越大越在上，同时决定 mask 遮挡集合）。
		 *  **开合两态共用同一顺序** = 牌身份连续性：同一张牌在 morph 全过程中保持自己的
		 *  层级，最右的牌（最大 id，也是 stack 的顶牌）永远最后绘制。
		 *  旧实现给 3 张展开用了 [1,3,2]（让当时的"最右牌"card2 压顶），配合旧的
		 *  fan3（card2 在右、card3 居中）造成顶牌身份在展开时被 card2 顶替——
		 *  位置与遮挡同时交换。fan3 修正为 card3 在右后，顺序回归身份序即可。 */
		function pokerPaintOrder(count) {
			var n = count > 3 ? 5 : 3;
			var order = [];
			for (var i = 1; i <= n; i++) order.push(i);
			return order;
		}
		/** 扑克牌堆/扇形图标组件：开合时逐张牌从牌堆变形为扇形（或反向），CSS transition 驱动形变；
		 *  mask 遮挡方案的 occluder 与真实牌使用同一套绝对 transform + 过渡，动画期间逐帧对齐。 */
		function PokerIcon(props) {
			var count = props.count, suit = props.suit, open = props.open;
			var svgRef = react.useRef(null);
			// __html 用 useMemo 缓存：栏重渲染（指标刷新、开合切换）时字符串稳定 →
			// React 不重设 innerHTML，layout effect 设置的 transform/mask/visibility 得以
			// 保留；只有 count/suit 变化才重新生成（此时 layout effect 同依赖重跑，
			// 重新应用全部状态）。
			var html = react.useMemo(function () { return buildPokerSVGBase(count, suit); }, [count, suit]);
			react.useLayoutEffect(function () {
				var holder = svgRef.current;
				// svgRef 指向包裹 span；牌张 g 必须在 <svg> 内才会渲染，先定位 svg 元素
				var svg = holder ? holder.querySelector("svg") : null;
				if (!svg) return;
				var five = count > 3;
				var n = five ? 5 : 3;
				// 叠放顺序 = 牌身份序（1 < 2 < 3 / 1 … 5），开合两态一致：
				// stack 的顶牌与 fan 最右的牌是同一张（最大 id），morph 全程不换身份。
				var order = pokerPaintOrder(count);
				// z-order 映射：index 越大越在上（越后画）
				var z = {};
				for (var zi = 0; zi < order.length; zi++) z[order[zi]] = zi;
				var tfs = pokerTransforms(count, !!open);
				// 首次应用（新挂载 / innerHTML 重建后）：模板 transform 是 translate(0,0)，
				// 直接设目标值会从中心"滑入"牌堆（0.45s 内看起来像单张牌）。先禁用过渡
				// 提交最终位姿再恢复 CSS 过渡 → 只有后续 open 切换才播放形变动画。
				var fresh = svg.getAttribute('data-ccg-ready') !== '1';
				if (fresh) {
					var freshEls = svg.querySelectorAll('.ccg-poker-motion,.ccg-poker-mask-card');
					for (var fi = 0; fi < freshEls.length; fi++) freshEls[fi].style.transition = 'none';
				}
				for (var i = 0; i < order.length; i++) {
					var g = svg.querySelector('.ccg-poker-card[data-i="' + order[i] + '"]');
					if (g) svg.appendChild(g);
				}
				// 强制同步布局：DOM 移动后先提交当前样式，transform 变化才能触发 transition
				void svg.getBoundingClientRect();
				// 更新真实牌 + 本牌 mask 的 occluder
				for (var j = 1; j <= n; j++) {
					var card = svg.querySelector('.ccg-poker-card[data-i="' + j + '"]');
					if (!card) continue;
					var motion = card.querySelector('.ccg-poker-motion');
					if (motion) {
						motion.style.transitionDelay = '0ms';
						motion.setAttribute('transform', tfs[j]);
					}
					var mid = card.getAttribute('data-mask-id');
					if (mid) card.setAttribute('mask', 'url(#' + mid + ')');
					var cuts = svg.querySelectorAll('.ccg-poker-mask-card[data-mask-owner="' + j + '"]');
					for (var k = 0; k < cuts.length; k++) {
						var cut = cuts[k];
						var ci = Number(cut.getAttribute('data-i'));
						cut.style.transitionDelay = '0ms';
						cut.setAttribute('transform', tfs[ci]);
						// 只有绘制顺序在 owner 之上的牌（z 更大）才挖空 owner
						cut.setAttribute('visibility', (z[ci] > z[j]) ? 'visible' : 'hidden');
					}
				}
				if (fresh) {
					// 无过渡地提交最终位姿后恢复 CSS 过渡（后续 open 切换正常动画）
					svg.setAttribute('data-ccg-ready', '1');
					void svg.getBoundingClientRect();
					var restored = svg.querySelectorAll('.ccg-poker-motion,.ccg-poker-mask-card');
					for (var ri = 0; ri < restored.length; ri++) restored[ri].style.transition = '';
				}
			}, [open, count, suit]);
			return react.createElement("span", { className: "ccg-poker-icon" },
				react.createElement("span", { ref: svgRef, className: "ccg-poker-svg", dangerouslySetInnerHTML: { __html: html } })
			);
		}
		/** Turn 栏前导图标：native 风格（foldIconStyle="native"）返回官方 chevron；
		 *  poker 风格运行中返回翻牌动画、结束后返回牌堆/扇形。 */
		/** Turn 栏前导图标（前导位 = Poker 与 native chevron 共用的同一槽位）。
		 *  poker 模式：运行中翻牌动画、结束后牌堆/扇形。
		 *  native 模式：官方风格折叠 chevron（收起向下、展开 rotate(180deg) 向上，
		 *  几何对齐官方 IconChevronDownOutlineRegular）；running 与不可折叠的回合
		 *  官方本就不渲染折叠 chevron → 不渲染前导图标（官方 presentation 原样）。 */
		function turnPokerIcon(iconStyle, cardCount, running, open, turn, canCollapse) {
			if (iconStyle !== "poker") {
				if (running || !canCollapse) return undefined;
				// 元素带 key（进 TurnBarView 的 kids 数组）——React 数组子元素必须有 key
				return react.createElement(NativeChevronIcon, { key: "native", open: open });
			}
			if (running) return react.createElement(PokerSpinIcon, { key: "poker" });
			return react.createElement(PokerIcon, { key: "poker", count: cardCount, suit: foldSuitFor("turn:" + turn), open: open });
		}

		// ---- 滚轮数字（真实数据变化的逐位滚动动画） ----
		// 每个数位是一个 1ch 宽、1em 高的视窗（overflow:hidden），内部竖排 0-9
		//（flex column，每格恰好 1em）；数值变化时用 Web Animations API 从旧数位
		// 滚到新数位（回弹缓动）。只对真实数据变化做动画——没有伪造增长源，
		// 数字不变的渲染不会触发任何滚动。prefers-reduced-motion 或环境无 WAAPI
		//（如 jsdom）时直接定位、无动画。
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
				// 快速连续变化（<500ms）用短动画（200ms）：指标刷新快时每拍也能完整走完；
				// 慢速变化（如耗时秒数）保持 350ms 回弹滚动。
				var dur = sinceLast < 500 ? 200 : 350;
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
		// 只让新数字挂载滚动，已显示的数值不重滚。仅运行中（running）使用：
		// 结束态的数字是最终值，静态渲染（闭合数字不再从 0 滚一遍）。
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

		// ---- 设置面板共享状态（模块级；全局同时最多一个面板） ----
		// 不再有 <body> 上的独立 React root：面板由"打开它的那根 Turn 栏"在自己的
		// React 树里渲染（open + openerId 记录打开者），其余栏只订阅状态不渲染。
		var popupState = { open: false, openerId: null };
		var popupListeners = new Set();
		var popupVersion = 0;
		function subscribePopup(fn) { popupListeners.add(fn); return function () { popupListeners.delete(fn); }; }
		function notifyPopup() {
			popupVersion++;
			var fns = [];
			popupListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function getPopupState() { return popupState; }
		/** 打开/关闭设置面板。open=true 时必须带 openerId（哪根栏打开的）；
		 *  关闭时 openerId 置空。 */
		function setPopupOpen(open, openerId) {
			var nextOpen = open === true && openerId !== undefined && openerId !== null;
			var nextOpener = nextOpen ? openerId : null;
			if (popupState.open === nextOpen && popupState.openerId === nextOpener) return;
			popupState = { open: nextOpen, openerId: nextOpener };
			notifyPopup();
		}

		var turnBarSeq = 0;
		// ---- Turn 栏（插件渲染器的 UI 核心） ----
		// TurnBarView 是运行中（running）与结束态（closed）共用的单根视觉：
		//   [扑克图标] [状态词?] [指标文案（运行中滚轮/结束静态）] ...... [第N轮] [箭头?] | [⚙]
		// 兄弟交互结构：主按钮只负责 Fold toggle、齿轮 <button> 只负责设置——
		// 不嵌套交互控件、不依赖 stopPropagation，Tab 次序 = 主按钮 → 齿轮。
		// 折叠语义全部来自外部：canCollapse/open/onToggle 由 EnhancedTurnProcessView
		// 从官方 turnProcess 派生，本组件绝不自持 Fold 状态。运行中主区域渲染为
		// 非交互 div（data-tf-running，点击无动作），齿轮仍可用。
		function TurnBarView(props) {
			var running = props.running === true;
			var open = props.open === true;
			var canToggle = props.canToggle === true;
			var onToggle = props.onToggle;
			var label = props.label || "";
			var statusText = props.statusText;
			var statusFailed = props.statusFailed === true;
			var poker = props.poker;
			var round = props.round;
			var ariaLabel = (open ? _T("ariaTurnExpanded") : _T("ariaTurn")) + (label ? "：" + label : "");
			// 面板共享状态订阅 + 本栏身份：只有"打开者"渲染面板
			var popup = useSyncExternalStore(subscribePopup, getPopupState);
			var uidRef = react.useRef(null);
			if (uidRef.current === null) uidRef.current = "tf-bar-" + (++turnBarSeq);
			var gearRef = react.useRef(null);
			var isOpener = popup.open && popup.openerId === uidRef.current;
			// 卸载时若面板由本栏打开 → 关闭（会话切换不留僵尸 open 状态）
			react.useEffect(function () {
				var uid = uidRef.current;
				return function () {
					var s = getPopupState();
					if (s.open && s.openerId === uid) setPopupOpen(false, uid);
				};
			}, []);
			var titleContent = running ? react.createElement(AnimatedLabel, { label: label }) : label;
			var kids = [];
			if (poker) kids.push(poker);
			if (statusText) {
				kids.push(react.createElement(
					"span",
					{ key: "status", className: "ccg-turn-bar-status" + (statusFailed ? " ccg-turn-status-failed" : "") },
					statusText
				));
				kids.push(" · ");
			}
			kids.push(react.createElement("span", { key: "label", className: "ccg-turn-bar-label" }, titleContent));
			var rightKids = [];
			if (round) rightKids.push(react.createElement("span", { key: "round" }, round));
			if (rightKids.length > 0) {
				kids.push(react.createElement("span", { key: "right", className: "ccg-turn-bar-right" }, rightKids));
			}
			// 主区域：closed → button（fold toggle）；running / 不可折叠 → div（静态）。
			// 不用 disabled 属性——用 data-tf-static（样式回退默认光标）+ aria-disabled，
			// onClick 只在 canToggle 时挂载，点击天然无效果。
			var main = react.createElement(running ? "div" : "button", {
				className: "ccg-turn-bar-main",
				type: running ? undefined : "button",
				"data-tf-turn-bar": running ? "running" : "closed",
				"data-tf-running": running ? "true" : undefined,
				"data-tf-static": !running && !canToggle ? "true" : undefined,
				"data-open": !running && open ? "true" : undefined,
				"data-turn-process": props.turnNumber !== undefined ? String(props.turnNumber) : undefined,
				"aria-disabled": !running && !canToggle ? "true" : undefined,
				"aria-expanded": !running && canToggle ? open : undefined,
				"aria-label": running ? undefined : ariaLabel,
				onClick: canToggle ? onToggle : undefined,
				onKeyDown: canToggle ? function (e) {
					if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
				} : undefined
			}, kids);
			// 齿轮：独立 <button>（主按钮的兄弟节点），只负责设置面板
			var gear = react.createElement("button", {
				ref: gearRef,
				type: "button",
				className: "ccg-gear-button",
				title: _T("fieldSettings"),
				"aria-label": _T("fieldSettings"),
				"aria-haspopup": "dialog",
				"aria-expanded": isOpener ? "true" : "false",
				onClick: function () {
					var s = getPopupState();
					var mine = s.open && s.openerId === uidRef.current;
					setPopupOpen(!mine, uidRef.current);
				}
			}, GearIconSvg());
			return react.createElement(
				"div",
				{ className: "ccg-turn-wrap", "data-tf-turn": props.turnNumber !== undefined ? String(props.turnNumber) : undefined },
				react.createElement("div", { className: "ccg-turn-row" }, main, gear),
				isOpener ? react.createElement(SettingsDialog, { openerRef: gearRef }) : null,
				react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" })
			);
		}

		// ---- 齿轮图标（纯 SVG；交互在宿主 <button class="ccg-gear-button"> 上） ----
		// Material 风格齿轮 ⚙，14×14，悬停向右旋转 90°（.45s 缓动，CSS 驱动）。
		function GearIconSvg() {
			return react.createElement("svg", { viewBox: "0 0 24 24", width: "14", height: "14", fill: "currentColor", "aria-hidden": "true" },
				react.createElement("path", { d: "M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" })
			);
		}

		// ---- 注册异常软降级（防启动崩溃） ----
		// slots.inject 的回调若让异常外泄，延迟执行路径（目标 slot 声明晚于插件加载时，
		// 回调在官方声明者的 register 栈里跑 / 声明订阅里 queueMicrotask re-throw）会
		// 打断官方 UI 激活 → web 整页无法启动。两层都必须兜：register 的异常 catch 在
		// 回调内（返回 undefined 即"无可清理资源"，官方 cachedSlotInject 对 falsy 返回
		// 无害）；slots.inject 本身同步抛（声明等待 setup 失败等）也 catch 在调用点。
		// 降级提示 = console.warn（官方实践不建 body portal，Toast 原语不再使用）。
		// 以下函数只在 catch 块里调用，自身任何异常都必须吞掉。
		function noteSlotDegradation(slot, cell, err) {
			try {
				var detail = err && typeof err.message === "string" ? err.message : String(err);
				try {
					if (typeof console !== "undefined" && console.warn) {
						console.warn("[dsh-turn-fold] 渲染位注册失败（" + slot + " → " + cell + "）：" + detail + " —— 该条目已跳过，插件其余功能不受影响，DSH 启动不受影响");
					}
				} catch (e) { /* 忽略 */ }
			} catch (e) { /* 通知路径绝不外泄 */ }
		}
		/** 统一的注册管道：inject 声明等待 + 回调内 register 各自兜异常，单个条目降级
		 *  绝不外泄（外泄会带崩 web 启动）。所有 slot 注册一律走这里，别再手写双 try。 */
		function safeRegisterSlot(slotsSvc, options, component) {
			var slot = options.name;
			var cell = options.key !== undefined ? options.key : (options.id !== undefined ? options.id : "?");
			try {
				slotsSvc.inject(slot, function () {
					try {
						return slotsSvc.register(options, component);
					} catch (err) {
						noteSlotDegradation(slot, cell, err);
						return undefined;
					}
				});
			} catch (err) {
				// inject 本身同步抛（声明等待 setup 失败等）：同样降级 + 提示，不外泄
				noteSlotDegradation(slot, cell, err);
			}
		}
		/** 注册前探测同 key 的 priority -1 是否已被其他插件占用；被占则自动让位到
		 *  第一个空闲值（放弃该渲染位——lowest renders 语义下 p>=1 永远压不过官方 0，
		 *  让位即弃权），避免 "keyed slot ... already has an entry ... at priority ..."
		 *  启动失败。官方 0 位无需探测占用（官方条目就在那里，撞 0 才是错），free 扫描
		 *  从 1 开始。 */
		function resolveSlotPriority(slots, slotName, match, label) {
			try {
				var entries = slots && typeof slots.entries === "function" ? slots.entries(slotName) : null;
				var taken = {};
				for (var i = 0; entries && i < entries.length; i++) {
					var e = entries[i] && entries[i].options;
					if (e && match(e)) taken[e.priority || 0] = true;
				}
				if (!taken[-1]) return -1;
				var p = 1;
				while (taken[p]) p += 1;
				console.warn("[dsh-turn-fold] " + label + " 的 priority -1 已被其他插件占用，自动让位到 priority " + p + "，该渲染位已让给对方");
				return p;
			} catch (err) {
				return -1;
			}
		}

		// ---- 字段设置弹窗 ----
		// 全局弹窗：Turn 栏可显字段 + 图标风格 + Step 皮。checkbox/选项行即时生效并
		// 持久化到 localStorage（dsh-turn-fold:settings）。
		var FIELD_CONFIG = [
			{ key: "duration", labelKey: "fieldDuration", descKey: "fieldDurationDesc" },
			{ key: "ttft", labelKey: "fieldTtft", descKey: "fieldTtftDesc" },
			{ key: "tokens", labelKey: "fieldTokens", descKey: "fieldTokensDesc" },
			{ key: "tokensPerSecond", labelKey: "fieldTps", descKey: "fieldTpsDesc" },
			{ key: "cacheHit", labelKey: "fieldCacheHit", descKey: "fieldCacheHitDesc" }
		];
		/** 通用选项行选择器（radio 语义）：options = [{value,labelKey,descKey,previews(fn)}]。 */
		function GearOptionSelector(props) {
			var current = props.current;
			var labelKey = props.labelKey;
			var options = props.options;
			var opts = [];
			for (var oi = 0; oi < options.length; oi++) {
				var opt = options[oi];
				var selected = current === opt.value;
				var previewEls = opt.previews ? opt.previews() : [];
				var previewItems = [];
				for (var pi = 0; pi < previewEls.length; pi++) {
					// 每个预览项外包一层 .ccg-preview-tooltip：悬浮时在其上方弹出放大气泡。
					previewItems.push(react.createElement(
						"span",
						{ key: "p" + pi, className: "ccg-preview-tooltip" },
						react.createElement("span", { className: "ccg-gear-icon-option-preview-item" }, previewEls[pi]),
						react.createElement(
							"span",
							{ className: "ccg-preview-bubble" },
							react.createElement("span", { className: "ccg-preview-bubble-body" }, previewEls[pi])
						)
					));
				}
				opts.push(react.createElement("div", {
					key: opt.value,
					className: "ccg-gear-icon-option",
					"data-selected": selected ? "true" : undefined,
					onClick: function (v) { return function () { props.onSelect(v); }; }(opt.value),
					role: "radio",
					"aria-checked": selected ? "true" : "false",
					tabIndex: 0,
					onKeyDown: function (v) { return function (e) {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelect(v); }
					}; }(opt.value)
				},
					react.createElement("span", { className: "ccg-gear-icon-option-text" },
						react.createElement("div", { className: "ccg-gear-icon-option-title" }, _T(opt.labelKey)),
						react.createElement("div", { className: "ccg-gear-icon-option-desc" }, _T(opt.descKey))
					),
					react.createElement("span", { className: "ccg-gear-icon-option-preview", "aria-hidden": "true" }, previewItems)
				));
			}
			return react.createElement("div", { className: "ccg-gear-icon-selector" },
				react.createElement("div", { className: "ccg-gear-icon-selector-label" }, _T(labelKey)),
				opts
			);
		}
		/** 扑克牌预览（3 牌折叠 / 3 牌展开 / 5 牌折叠 / 5 牌展开 + 运行中翻牌）。 */
		function pokerPreviews() {
			var pool = pokerFacePool();
			var items = [];
			for (var fi = 0; fi < 4; fi++) {
				var five = fi >= 2;
				var open = fi % 2 === 1;
				items.push(react.createElement(PokerIcon, {
					key: "s" + fi,
					count: five ? 5 : 3,
					suit: pool[fi % pool.length],
					open: open
				}));
			}
			items.push(react.createElement(PokerSpinIcon, { key: "spin" }));
			return items;
		}
		/** 统一图标模式选择器（折叠栏图标）：一个设置同时管 Turn 前导图标与 Step 皮，
		 *  不再提供"Turn=native / Step=poker"这类不一致组合。 */
		function IconStyleSelector() {
			var current = useIconStyle();
			return react.createElement(GearOptionSelector, {
				current: current,
				labelKey: "foldIconLabel",
				onSelect: setIconStyle,
				options: [
					{ value: "poker", labelKey: "foldIconPoker", descKey: "foldIconPokerDesc", previews: pokerPreviews },
					{
						value: "native", labelKey: "foldIconNative", descKey: "foldIconNativeDesc",
						previews: function () {
							// 官方语义：收起 = down chevron；展开 = 同一图标 rotate(180deg) 朝上
							return [
								react.createElement(NativeChevronIcon, { key: "down", size: 14 }),
								react.createElement(NativeChevronIcon, { key: "up", size: 14, open: true })
							];
						}
					}
				]
			});
		}
		/** 设置面板（由打开它的 Turn 栏自身 React 树渲染——无 body portal、无独立 root）。
		 *  无障碍：role=dialog + aria-modal；打开时焦点移入面板；Escape / 遮罩点击 /
		 *  Done 关闭；关闭后焦点还给齿轮；Tab 在面板内圈定（轻量自实现，无外部依赖）。 */
		function SettingsDialog(props) {
			var openerRef = props.openerRef;
			// 注意 Hooks 顺序：useFieldVisibility() 等必须在条件 return 之前调用——
			// 本组件只在打开时挂载、关闭即卸载，hooks 数量恒定。
			var visibility = useFieldVisibility();
			var dialogRef = react.useRef(null);
			// 焦点往返：挂载时焦点移入面板；卸载（关闭）时焦点还给齿轮按钮
			react.useEffect(function () {
				var el = dialogRef.current;
				if (el && typeof el.focus === "function") { try { el.focus(); } catch (e) { /* 忽略 */ } }
				return function () {
					var opener = openerRef && openerRef.current;
					if (opener && typeof opener.focus === "function") { try { opener.focus(); } catch (e) { /* 忽略 */ } }
				};
			}, []);
			// Escape 关闭 + Tab 圈定：document 级捕获监听（监听器不是 DOM 写入，卸载即移除）
			react.useEffect(function () {
				function onKeyDown(e) {
					if (e.key === "Escape") {
						e.preventDefault();
						setPopupOpen(false, null);
						return;
					}
					if (e.key !== "Tab") return;
					var overlay = dialogRef.current ? dialogRef.current.parentNode : null;
					if (!overlay) return;
					var focusables = overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
					if (focusables.length === 0) { e.preventDefault(); return; }
					var first = focusables[0];
					var last = focusables[focusables.length - 1];
					var active = document.activeElement;
					if (e.shiftKey && (active === first || !overlay.contains(active))) {
						e.preventDefault(); last.focus();
					} else if (!e.shiftKey && (active === last || !overlay.contains(active))) {
						e.preventDefault(); first.focus();
					}
				}
				document.addEventListener("keydown", onKeyDown, true);
				return function () { document.removeEventListener("keydown", onKeyDown, true); };
			}, []);
			var fields = [];
			for (var fi = 0; fi < FIELD_CONFIG.length; fi++) {
				var cfg = FIELD_CONFIG[fi];
				var checked = visibility[cfg.key];
				var fieldKey = cfg.key;
				fields.push(react.createElement("div", { key: fieldKey, className: "ccg-gear-popup-field" },
					react.createElement("input", {
						type: "checkbox",
						id: "ccg-field-" + fieldKey,
						checked: checked,
						onChange: function (k, v) { return function () { setFieldVisible(k, !v); }; }(fieldKey, checked)
					}),
					react.createElement("label", { htmlFor: "ccg-field-" + fieldKey }, _T(cfg.labelKey)),
					react.createElement("span", { className: "ccg-gear-popup-field-desc" }, _T(cfg.descKey))
				));
			}
			return react.createElement("div", {
				className: "ccg-gear-overlay",
				onClick: function (e) { if (e.target === e.currentTarget) setPopupOpen(false, null); },
				onKeyDown: function (e) { if (e.key === "Escape") { e.preventDefault(); setPopupOpen(false, null); } }
			},
				react.createElement("div", {
					ref: dialogRef,
					className: "ccg-gear-popup",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": _T("fieldSettings"),
					tabIndex: -1
				},
					react.createElement("div", { className: "ccg-gear-popup-title" }, _T("fieldSettings")),
					react.createElement("div", { className: "ccg-gear-popup-hint" }, _T("fieldSettingsHint")),
					react.createElement("div", { className: "ccg-gear-popup-fields" }, fields),
					react.createElement("div", { className: "ccg-gear-divider", "aria-hidden": "true" }),
					react.createElement(IconStyleSelector, null),
					react.createElement("div", { className: "ccg-gear-popup-foot" },
						react.createElement("button", {
							className: "ccg-gear-popup-btn",
							type: "button",
							onClick: function () { setPopupOpen(false, null); }
						}, _T("fieldSettingsDone"))
					)
				)
			);
		}

		// ---- Enhanced Turn Process View（官方 turn-process 渲染器的插件替换） ----
		// 官方 props 契约（ui-chat contract/slots.ts）：node / turnProcess / t (+ 标准-kit)。
		//   turnProcess: { spec, foldable, hasContent, open, setOpen } —— 官方 ChatNodeSeat 构建；
		//   折叠可见性（成员隐藏/显示）由官方 seat 自己完成（data-turn-process-hidden）。
		// 本渲染器：
		//   - 回合未结束（turn.status !== 'closed'）→ RunningTurnBar：状态表面，无 Fold 状态；
		//   - 回合结束 → 完整 Turn 栏：canCollapse/open 全部从 turnProcess 派生，点击只调
		//     turnProcess.setOpen()；
		//   - turnProcess 缺失（极旧宿主/异常）→ 降级渲染非交互栏（数据取自 node.data 与
		//     location），绝不抛错——UI 增强可以坏，官方 Fold 不被插件拖坏。
		// 订阅面（官方"最小切片"实践，整快照订阅已废除）：
		//   ① turn-tail（官方聚合 tokenUsage）→ slot 注入面自动绑定的 useTurnData(key)
		//      （uSES over turn.data.source(key)，官方 AssistantNodeView 同款）；
		//   ② assistant-step usage/timing 数组 → 官方 ChatNodeStore.turnDataSource(turn, kind)
		//      （增量发布：仅本 Turn 本 kind 的成员/成员数据变化才通知；经 useChat 取
		//      identity-stable source——selector 只返回 source 本身，快照再怎么发布也
		//      不会触发本组件重渲染，数据变化由 source 自己的 uSES 驱动）；
		//   ③ TurnLocation 计时/状态（start/end/reason）→ 不订阅：node prop 由 turn-process
		//      定义在 turn/start、assistant/message、tool/call、turn/end 等事件上重发布，
		//      天然是这些变化的信号。
		function EnhancedTurnProcessView(props) {
			var node = props.node;
			var turnProcess = props.turnProcess;
			var clock = turnClockOf(node);
			var running = !!clock && clock.status !== "closed" && typeof clock.startMs === "number";
			// ① turn-tail：官方 useTurnData（hook 顺序恒定：宿主是否提供该 prop 进程内恒定）
			var useTurnData = props.useTurnData;
			var tail = typeof useTurnData === "function" ? useTurnData("turn-tail")
				: (clock && clock.data && typeof clock.data.get === "function" ? clock.data.get("turn-tail") : undefined);
			// ② assistant-step 数组：turnDataSource（identity-stable source）+ 自己的 uSES
			//    useChat 无条件调用（hooks 顺序安全；turn 未定位时 selector 返回 null）。
			var useChat = props.useChat;
			var number = clock ? clock.number : undefined;
			var stepsSource = null;
			if (useChat) {
				stepsSource = useChat(selectTurnNodeSource(number, "assistant-step"));
			}
			// ③ durable per-turn 指标：插件自己注册的官方 projection（host 侧按落盘事件
			//    折叠，经 projection wire 推给客户端）。这是 reload / 历史会话下 TTFT 与
			//    decode-speed 的唯一可靠来源——客户端 assistant 节点的
			//    finalNode.timing.firstTokenTime 只由 live chunk 记录，历史重建时为 null
			//    （官方 assistant.ts 的 settleMessage/fallbackState 都不恢复它）。
			//    旧宿主 / projection 未注册 → undefined → 自动回落到客户端 step 数据。
			//    订阅面 = 本回合的那一条记录（具名 selector，不订阅整表）。
			var useProjection = props.useProjection;
			var durableTurn = typeof useProjection === "function"
				? useProjection("turnFoldMetrics", selectDurableTurnMetrics(number))
				: undefined;
			var stepDataList = useSyncExternalStore(
				stepsSource && typeof stepsSource.subscribe === "function" ? stepsSource.subscribe : subscribeNothing,
				stepsSource && typeof stepsSource.getSnapshot === "function" ? stepsSource.getSnapshot : getUndefinedSnapshot
			);
			if (!stepDataList && clock) {
				// 无 turnDataSource（极简宿主/测试）：回退逐 step 直读（node prop 驱动重算）
				stepDataList = [];
				for (var si = 0; si < clock.steps.length; si++) {
					var stepLoc = clock.steps[si];
					stepDataList.push(stepLoc && stepLoc.data && typeof stepLoc.data.get === "function"
						? stepLoc.data.get("assistant-step") : undefined);
				}
			}
			// 设置订阅（字段显隐/图标风格变化 → 所有栏立即重渲染）。
			// iconStyle 在本组件只订阅这一次（无条件、位于全部条件 return 之前），
			// 之后作为**普通字符串 prop** 下传给 TurnBarView 与前导图标工厂——
			// TurnBarView 不得再自行 useIconStyle()：它的 canToggle 随回合生命周期
			// 变化，条件调用 Hook 会让 hook 数量在 running→settled 之间变化
			//（Rules of Hooks 违规，可能触发 "Rendered more hooks…"）。
			useFieldVisibility();
			var iconStyle = useIconStyle();
			// Step 牌数桥：会话级只读订阅者，由本渲染器承载（插件既有的官方挂载点；
			// 每个回合挂一份，leader 选举保证只有一个真的订阅与写规则）。
			// 官方 turn-process 是 turn 级控制器节点、不是 Process Group 成员，所以桥
			// 不从这里取"本组"数据——它订阅官方 group snapshot 全集，按官方 groupKey
			// 生成视觉选择器（见 buildStepCardRulesCss）。
			var cardBridge = react.createElement(StepCardRulesBridge, { useConversation: props.useConversation });
			var liveNow = useLiveNow(running);
			if (!clock) {
				// 无法定位回合（异常数据）：渲染最小占位栏（仅官方 data 字段），不可折叠。
				var data = node && node.data;
				return react.createElement(react.Fragment, null,
					react.createElement(TurnBarView, {
						running: false, open: false, canToggle: false,
						turnNumber: data && data.turn,
						label: "",
						round: turnRoundLabel(data && data.turn)
					}),
					cardBridge
				);
			}
			var metrics = computeTurnMetrics(clock, stepDataList, tail, running ? liveNow : undefined, durableTurn, props.sessionId);
			var filtered = filterVisibleMetrics(metrics);
			var label = turnHeaderLabel(filtered);
			var round = turnRoundLabel(clock.number);
			if (running) {
				// 运行中：状态表面（非交互）。无 Fold 状态、不隐藏任何成员、
				// 不调用任何 setOpen——官方 liveProcess 阶段成员本来就展开显示。
				var cardCountRunning = specCardCount(clock);
				return react.createElement(react.Fragment, null,
					react.createElement(TurnBarView, {
						running: true,
						turnNumber: clock.number,
						label: label || (currentLocale() === "zh" ? "0秒" : "0s"),
						poker: turnPokerIcon(iconStyle, cardCountRunning, true, false, clock.number, false),
						round: round
					}),
					cardBridge
				);
			}
			// 回合结束：折叠语义全部来自官方 turnProcess。
			var spec = turnProcess && turnProcess.spec ? turnProcess.spec : (clock.data && typeof clock.data.get === "function" ? clock.data.get("turn-process") : undefined);
			// turnProcessAlwaysOpen（官方 contract/turn-process.ts 同款语义）：
			// live（不可能，已在 running 分支）、aborted、error 的回合不可折叠。
			var alwaysOpen = clock.status === "open" || clock.reason === "aborted" || clock.reason === "error";
			var canCollapse = !!(turnProcess && turnProcess.foldable && turnProcess.hasContent) && !alwaysOpen;
			// 官方 TurnProcessNodeView 语义：open = !foldable || open——foldable=false
			//（如 Verbose，官方 foldCompletedTurns=false）时内容实际始终展开，
			// Poker 必须呈扇形/展开态；turnProcess 缺失（降级）同理按展开态处理。
			var foldable = !!(turnProcess && turnProcess.foldable);
			var open = !foldable || (turnProcess && turnProcess.open === true);
			var statusText = turnStatusLabel(clock.reason);
			return react.createElement(react.Fragment, null,
				react.createElement(TurnBarView, {
					running: false,
					open: open,
					canToggle: canCollapse,
					turnNumber: clock.number,
					label: label,
					statusText: statusText,
					statusFailed: clock.reason === "error",
					poker: turnPokerIcon(iconStyle, specCardCountFromSpec(spec), false, open, clock.number, canCollapse),
					round: round,
					onToggle: function () {
						// 唯一合法的折叠通道：官方 owner state 的 setOpen。
						if (turnProcess && typeof turnProcess.setOpen === "function") turnProcess.setOpen(!open);
					}
				}),
				cardBridge
			);
		}
		/** useChat 的 selector：只取本 (turn, kind) 的 identity-stable 增量数据源——
		 *  绝不返回整个 snapshot（架构守卫测试禁止内联 selector）。
		 *  turn 未定位（异常数据）时返回 null → 上层 uSES 走空源，不订阅。 */
		function selectTurnNodeSource(turn, kind) {
			return function (s) {
				if (turn === undefined) return null;
				try {
					if (s && s.nodes && typeof s.nodes.turnDataSource === "function") {
						return s.nodes.turnDataSource(turn, kind);
					}
				} catch (e) { /* 存储未就绪 */ }
				return null;
			};
		}
		/** useProjection 的 selector：只取本回合那一条 durable 记录（具名、最小切片）。
		 *  projection 值形如 { turns: { "<turn>": { ttftMs?, decodeMs, decodeTokens } } }，
		 *  单条记录只在它自己变化时换引用 → 本栏不会因别的回合更新而重渲染。 */
		function selectDurableTurnMetrics(turn) {
			return function (metrics) {
				if (turn === undefined) return undefined;
				var turns = metrics && metrics.turns;
				return turns ? turns[String(turn)] : undefined;
			};
		}
		/** uSES 空源兜底（stepsSource 缺失时恒 undefined，不订阅任何东西）。 */
		function getUndefinedSnapshot() { return undefined; }
		/** 回合栏牌堆张数：官方 TurnProcessSpec 的 toolCallCount + subagentCount
		 *  （spec 不可用时取回合数据 store 里的官方 spec，再兜底 0）。 */
		function specCardCountFromSpec(spec) {
			var toolCalls = spec && typeof spec.toolCallCount === "number" ? spec.toolCallCount : 0;
			var subagents = spec && typeof spec.subagentCount === "number" ? spec.subagentCount : 0;
			return toolCalls + subagents;
		}
		function specCardCount(clock) {
			var spec = clock && clock.data && typeof clock.data.get === "function" ? clock.data.get("turn-process") : undefined;
			return specCardCountFromSpec(spec);
		}

		// ---- Cordis 插件入口 ----
		// 只替换官方 conversation.chat.node 的 "turn-process" 渲染器（keyed slot）。
		// 不声明任何 inject 面：官方 ChatNodeSeat 会把 turnProcess owner state 与
		// 标准 kit（含 SessionStandardProps 的 useChat）一起传给条目；useChat 是
		// SessionStandardProps 的合并成员，无需（也不应该）在此声明。
		// ⚠️ 绝不把设置服务写进 inject：声明不存在/未就绪的服务会让整个客户端条目
		// 永久停在 PENDING —— 0.1.7 的 assertEntriesActive 把 pending 条目当启动失败。
		exports.inject = ["slots"];
		exports.apply = function (ctx) {
			// Step 皮总闸：皮肤样式元素的 disabled（幂等；模块初始化时已同步过一次，
			// 此处兜底宿主时序）。不写 document.body attribute——官方实践禁止组件外 DOM 写入。
			applyIconStyle();
			ctx.inject(["slots"], function (scope) {
				var slotsSvc = scope.slots;
				safeRegisterSlot(slotsSvc, {
					name: "conversation.chat.node",
					key: "turn-process",
					priority: resolveSlotPriority(slotsSvc, "conversation.chat.node", function (o) { return o.key === "turn-process"; }, 'conversation.chat.node key "turn-process"'),
					locale: "chat"
				}, EnhancedTurnProcessView);
			});
		};

		return module.exports;
	}
});
}
