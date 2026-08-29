// dsh-turn-fold: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。只负责折叠。
//
// 行为：
//   1. 步骤分组自动折叠：两个 text 之间的所有工具调用和 Think（含纯 Think 段）收成一个
//      步骤折叠栏，默认折叠（运行中也不例外）。段未闭合（下一个 text 还没出现）时折叠栏
//      动态显示"正在运行 Xxx · 参数摘要 / 正在思考 · 内容"；下一个 text 出现后变为
//      "运行了 N 条命令"（think 不算命令数）；纯 think 段（段内无工具）闭合后显示
//      "思考了N次"。纯 think 段不预判后续是否出现工具——computeGroup 按当前快照实时归类，
//      步骤折叠栏自 think 一开始就出现（无翻转跳变），工具到达只是标题切换、内容区增长。
//   2. 回合折叠栏在 agent 回复开始就出现（运行中默认展开，回复在其下逐条加载），
//      折叠栏实时显示本轮耗时/token/tok/s/缓存命中率——直播指标按随机间隔刷新
//      （CONFIG.liveTickMs × 随机数 0.5~1，默认 125~250ms）：耗时秒数走动、tok/s
//      按已输出 token 实时估算；真实 usage 只在请求完成时到达，"消耗token"在两次
//      到达之间按固定动画节奏持续增长（+1/+11 交替：个位每 tick +1、十位每 2 tick
//      +1，tick 间隔随机、节奏不规律），真实值到达时只校正基线（数字只增不减）；
//      数值变化带"滚轮/里程表"式逐位滚动动画（每位数字独立滚动，变化快时用短动画、
//      慢速变化用 350ms 回弹缓动）；折叠栏下方常驻一条水平分隔线（收起/展开都显示）。
//   3. 回合结束后，整回合（所有 Think + 工具调用 + 上下文注入）收成一个回合折叠栏并
//      默认收起，只保留最终总结正文；非正常结束的回合带状态标签（已停止 / 已中断）。
//   4. 点击折叠栏可手动展开/折叠；展开带平滑过渡动画（CSS grid 0fr→1fr 轨道过渡 + 淡入，280ms），
//      收起带收缩过渡（280ms）后卸载内容；尊重 prefers-reduced-motion。
//   5. 界面文案自动适配中英文（navigator.language(s) 含 zh 即中文），
//      折叠栏带 aria-label / aria-expanded，键盘可操作（Enter / Space）。
//
// 实现方式：
//   - 用 priority:-1 覆盖（shadow）内置的 conversation.chat.node 渲染器：
//       key "tool-call"        -> 步骤分组 + 自动折叠
//       key "assistant-step"   -> 步骤分组（含纯 Think 段）+ 整回合折叠（Think/最终消息）
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
	id: "@winteries/dsh-turn-fold",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ---- 可调配置 ----
		var CONFIG = {
			// 折叠栏文案："运行了 N 条命令"；组内有失败命令时追加"——M条执行失败"
			headerPrefix: "运行了",
			headerSuffix: "条命令",
			failureSuffix: "条执行失败",
			// 运行中回合折叠栏直播指标的刷新间隔基准（毫秒）：耗时秒数、"消耗token"增长
			// 动画都按此频率刷新。"消耗token"在真实 usage 之间按固定节奏增长——偏移
			// 按 +1/+11 交替循环推进（个位每 tick +1、十位每 2 tick +1），营造
			// "一直在消耗"的观感；真实 usage 到达时只校正基线、偏移不回退。
			// 调小更"活跃"（渲染更频繁），调大更省资源。
			liveTickMs: 250,
			// 刷新间隔抖动比例：实际间隔 = liveTickMs × 随机数（liveTickJitter ~ 1），
			// 让数字跳动节奏不规律（时快时慢），更像真实的生成速率而不是节拍器。
			liveTickJitter: 0.5,
			// 排除在步骤折叠栏之外的工具（按工具名精确匹配，小写）：这类调用不套步骤
			// 折叠栏、也不并入任何段，始终以官方工具卡片原样渲染（如"更新任务清单"的
			// todo_write）；但仍参与整回合折叠——回合结束收进回合折叠栏。
			excludedSegmentTools: ["todo_write"]
		};

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
				// 步骤折叠运行中标题：当前正在执行的工具 / 思考内容（间隔由 CSS margin 控制）
				runningTool: "正在运行",
				runningThink: "正在思考",
				// 纯 think 段（无工具调用）闭合后的标题（段内 think 次数）
				segmentThink: "思考了",
				segmentThinkSuffix: "次",
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
				segmentOthersSuffix: "项操作",
				// 回合折叠栏字段设置弹窗
				fieldSettings: "回合折叠栏字段",
				fieldSettingsHint: "选择要在回合折叠栏中显示的字段",
				fieldDuration: "耗时",
				fieldDurationDesc: "回合总时长",
				fieldTtft: "首字",
				fieldTtftDesc: "TTFT 首字延迟",
				fieldTokens: "消耗token",
				fieldTokensDesc: "计费 token 数",
				fieldTps: "tok/s",
				fieldTpsDesc: "生成速率",
				fieldCacheHit: "缓存命中率",
				fieldCacheHitDesc: "缓存命中百分比",
				fieldFolded: "已折叠步数",
				fieldFoldedDesc: "回合折叠栏收纳的步骤数（运行中显示待折叠）",
				fieldSettingsDone: "完成",
				// 文件链接复制 Toast
				fileCopiedToast: "已复制绝对路径",
				// 折叠图标样式选择
				foldIconLabel: "折叠图标",
				foldIconDefault: "默认",
				foldIconDefaultDesc: "官方折叠箭头",
				foldIconPoker: "动态扑克牌",
				foldIconPokerDesc: "卡牌动画与牌堆",
				// 设置 → 对话 → 回合折叠方式 行（shadow 官方 transcript-view 行）
				// 标题/描述保留官方原文（对话显示 / 控制已完成轮次的过程内容）；
				// 选项文字用英文（与官方 Normal/Compact 风格一致）；悬浮提示用中文
				settingsTranscriptTitle: "对话显示",
				settingsTranscriptDesc: "控制已完成轮次的过程内容",
				settingsTranscriptNormal: "Normal",
				settingsTranscriptNormalTip: "不折叠：回合过程完整展示",
				settingsTranscriptCompact: "Compact",
				settingsTranscriptCompactTip: "官方紧凑折叠：只显示最终回复",
				settingsTranscriptTurnFold: "Turn-Fold",
				settingsTranscriptTurnFoldTip: "插件折叠：接管全部折叠并显示指标"
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
				segmentThink: "Thought ",
				segmentThinkSuffix: " times",
				segmentCommand: "Ran ",
				segmentCommandSuffix: " commands",
				segmentRead: "Read ",
				segmentReadSuffix: " files",
				segmentEdit: "Edited ",
				segmentEditSuffix: " files",
				segmentSearch: "Searched ",
				segmentSearchSuffix: " times",
				segmentOthers: "Executed ",
				segmentOthersSuffix: " operations",
				// Turn fold bar field settings popup
				fieldSettings: "Turn fold bar fields",
				fieldSettingsHint: "Choose which fields to show on the turn fold bar",
				fieldDuration: "Duration",
				fieldDurationDesc: "Turn elapsed time",
				fieldTtft: "TTFT",
				fieldTtftDesc: "Time to first token",
				fieldTokens: "Tokens",
				fieldTokensDesc: "Billed token count",
				fieldTps: "tok/s",
				fieldTpsDesc: "Generation rate",
				fieldCacheHit: "Cache hit",
				fieldCacheHitDesc: "Cache hit percentage",
				fieldFolded: "Folded steps",
				fieldFoldedDesc: "Steps folded into the turn bar (pending while running)",
				fieldSettingsDone: "Done",
				// File link copy toast
				fileCopiedToast: "Absolute path copied",
				// Fold icon style selector
				foldIconLabel: "Fold icon",
				foldIconDefault: "Default",
				foldIconDefaultDesc: "Official fold chevron",
				foldIconPoker: "Animated poker cards",
				foldIconPokerDesc: "Card animation & card stack",
				// Settings → Conversation → Transcript view mode
				settingsTranscriptTitle: "Conversation display",
				settingsTranscriptDesc: "Controls process content in completed turns",
				settingsTranscriptNormal: "Normal",
				settingsTranscriptNormalTip: "No folding: show the complete turn process",
				settingsTranscriptCompact: "Compact",
				settingsTranscriptCompactTip: "Official compact folding: final reply only",
				settingsTranscriptTurnFold: "Turn-Fold",
				settingsTranscriptTurnFoldTip: "Plugin folding: take over all folds and show metrics"
			}
		};
		/** 取当前语言下的文案；缺失键回退英文，再缺失返回键名本身。 */
		function _T(key) {
			var dict = TEXTS[currentLocale()] || TEXTS.en;
			return dict[key] !== undefined ? dict[key] : key;
		}

		// ---- 官方组件 t 座席兜底（修复 "message.think" / "message.contextInjection" 裸 key 露出）----
		// 新版 ui-chat 把对话词典挪进 'chat' 命名空间（'message.think'/'row.running' 等
		// key），官方 ReasoningRow 等组件用注入的 t 取标题；locale 服务查不到 key 时
		// 原样返回 key（`?? key` 兜底）。我们 shadow 条目若拿到错误命名空间（旧版是
		// 'conversation'）或宿主词典偏旧，转发给官方组件的 t 就会裸显原始 key。
		// 包装策略：查到原样透传；未命中（返回 key 本身 / 非 string / 抛错 / t 缺失）
		// 时用内嵌的完整官方 chat 词典（zh+en，见 CHAT_T_FALLBACK）兜底并做 {占位符}
		// 插值——整类裸显 key 一起消灭；宿主正常时兜底永不生效。
		var CHAT_T_FALLBACK = {
			// 完整内嵌官方词典合并（取自 0.1.2-alpha.1，按 key 排序；冲突时 chat 优先）：
			// chat=106 + conversation=139 + common=40 → 合计 282 词条。仅当宿主 t 座席未命中时兜底，
			// 宿主正常时永不生效；官方新增词条在更新前仍会裸显 key。
			zh: {
				"access.confirm.acknowledge": "我已了解风险，并愿意继续",
				"access.confirm.cancel": "取消",
				"access.confirm.description": "启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。",
				"access.confirm.enable": "启用 Full access",
				"access.confirm.title": "确认启用 Full access？",
				"access.fullLabel": "Full access",
				"ask.answered": "{answered}/{total} 已回答",
				"ask.cancelled": "已取消",
				"ask.cancelledDetail": "本轮已取消，未提交回答",
				"ask.interrupted": "已中断",
				"ask.interruptedDetail": "本轮已中断，未提交回答",
				"ask.rowTitle": "提问",
				"ask.skipped": "未回答",
				"ask.waiting": "等待回答",
				"back": "返回",
				"bash.failed": "失败",
				"bash.running": "运行中",
				"bash.stopped": "已停止",
				"brand.localBuild": "DSH 本地构建",
				"cancel": "取消",
				"chat.deepDiving": "深度求索中...",
				"chat.loadError": "历史加载失败：{message}（{code}）",
				"chat.loadOlder": "加载更早",
				"chat.loadingHistory": "载入历史…",
				"chat.toBottom": "回到底部",
				"chat.turnNavigation.jump": "跳转到第 {turn} 轮",
				"chat.turnNavigation.label": "轮次导航",
				"chat.turnNavigation.turn": "第 {turn} 轮",
				"clock.md": "{m}月{d}日",
				"clock.ymd": "{y}年{m}月{d}日",
				"close": "关闭",
				"collapse": "收起",
				"command.done": "已完成",
				"command.failed": "指令失败",
				"command.imagesUnsupported": "/{command} 不接受图片附件，请先移除图片",
				"command.running": "执行中…",
				"command.title": "指令",
				"connection.reconnecting": "连接已断开，正在重连…",
				"context.aria": "上下文已用 {percent}",
				"context.messages": "对话消息",
				"context.system": "系统提示词",
				"context.tools": "工具",
				"context.used": "上下文已用",
				"copied": "复制成功",
				"copy": "复制",
				"copy.compactJson": "复制紧凑 JSON",
				"copy.failed": "复制失败",
				"copy.json": "复制 JSON",
				"copy.optionsHint": "{action}；右键点击可选择复制方式",
				"copy.path": "复制属性路径",
				"copy.prettyJson": "复制格式化 JSON",
				"copy.value": "复制值",
				"delete": "删除",
				"details.close": "关闭详情",
				"details.empty": "点击消息流中的工具行查看详情",
				"details.input": "输入",
				"details.notInWindow": "该调用不在当前窗口内",
				"details.output": "输出",
				"details.running": "运行中…",
				"details.title": "详情",
				"diff.collapseAria": "收起差异",
				"diff.expandAria": "展开其余 {count} 行差异",
				"diff.expandRest": "… 其余 {count} 行",
				"diff.files.one": "{count} 个文件",
				"diff.files.other": "{count} 个文件",
				"duration.compactMinutes": "{minutes}分{seconds}秒",
				"duration.compactSeconds": "{seconds}秒",
				"duration.milliseconds": "{milliseconds}毫秒",
				"duration.minutes": "{minutes}分{seconds}秒",
				"duration.seconds": "{seconds}秒",
				"edit": "编辑",
				"expand": "展开",
				"fileOpen.folderTitle": "无法打开文件夹",
				"fileOpen.folderUnknown": "无法打开此文件夹",
				"fileOpen.title": "无法打开文件",
				"fileOpen.unknown": "无法打开此文件",
				"hero.chooseWorkspace": "选择工作区",
				"hero.headline": "探索未至之境",
				"hero.preview": "预览版",
				"hint.goal": "输入目标，智能体将持续执行",
				"hint.goal.active": "当前目标进行中。可输入 edit 修改 / pause 暂停 / resume 继续 / clear 清除",
				"image.closePreview": "关闭原图预览",
				"image.dimensionTooLarge": "图片宽高不能超过 {size}px，请缩小后重试",
				"image.dropBlocked": "当前无法添加图片",
				"image.dropDesc": "最多 {count} 张，每张 {size}",
				"image.dropTitle": "图片拖动到此处即可添加",
				"image.fileTooLarge": "单张图片不能超过 {size}",
				"image.label": "图片",
				"image.loadFailed": "图片加载失败，点击重试",
				"image.loading": "图片加载中…",
				"image.modelUnsupported": "当前模型不支持图片，请切换支持图片的模型",
				"image.openOriginal": "查看原图",
				"image.openOriginalLabel": "{label}，点击查看原图",
				"image.original": "原图",
				"image.pending": "待发送图片",
				"image.preview": "原图预览",
				"image.remove": "移除图片 {name}",
				"image.scrollLeft": "向左滚动图片",
				"image.scrollRight": "向右滚动图片",
				"image.sendFailed": "图片发送失败（{reason}），请重新添加图片后再试",
				"image.subagentUnsupported": "子智能体会话暂不支持图片",
				"image.tooMany": "一条消息最多添加 {count} 张图片",
				"image.tooManyPixels": "图片分辨率过大，请压缩后重试",
				"image.totalTooLarge": "图片总大小超过 {size}，请移除部分图片",
				"image.unsupportedType": "仅支持 PNG、JPG、WebP、GIF 格式的图片",
				"input.accessMode": "访问模式，当前：{name}",
				"input.commands": "指令",
				"input.send": "发送消息",
				"input.stop": "停止生成",
				"json.collapseNode": "收起 JSON 节点",
				"json.expandNode": "展开 JSON 节点",
				"json.label": "JSON",
				"json.truncated": "… 已截断，共 {total} 字符",
				"load.failed": "加载失败",
				"loading": "加载中…",
				"markdown.footnotes": "脚注",
				"markdown.truncatedCharacters": "… 已截断，共 {total} 字符",
				"message.branch": "在新对话中分支",
				"message.branchUnavailable": "仅可从已完成轮次的最后一条消息分支",
				"message.compaction": "上下文已压缩",
				"message.compaction.commandTitle": "compact",
				"message.compaction.completed": "已压缩 {items} 条历史记录（约 {tokens} tokens）",
				"message.compaction.expand": "点击查看压缩摘要",
				"message.compaction.running": "正在压缩…",
				"message.compaction.unavailable": "压缩摘要不可用",
				"message.context.catalog.more": "…还有 {count} 条",
				"message.context.catalog.replaced": "替换目录",
				"message.context.instructions.added": "已新增",
				"message.context.instructions.loaded": "已载入",
				"message.context.instructions.removed": "已移除",
				"message.context.instructions.updated": "已更新",
				"message.context.recall.counts": "保留 {retained} 条 · 省略 {omitted} 条",
				"message.context.recall.truncated": "已截断",
				"message.context.relay.from": "来自会话 {session}",
				"message.context.snapshot.supersedes": "取代先前的快照",
				"message.contextInjection": "上下文注入",
				"message.contextRecall": "跨会话召回",
				"message.extraBlock": "附加内容块",
				"message.failure.auth": "API 密钥无效",
				"message.maxTokens": "已达到输出 token 上限",
				"message.maxTokens.hint": "回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。",
				"message.ranFor": "用时 {duration}",
				"message.referenceSeparator": "、",
				"message.referenceSummary": "引用会话 · {labels}",
				"message.retry.active": "正在重试模型请求",
				"message.retry.cancelled": "模型请求重试已取消",
				"message.retry.delay": "重试延迟：",
				"message.retry.failure": "失败原因：",
				"message.retry.scheduled": "等待重试模型请求",
				"message.retry.started": "已重试模型请求",
				"message.retry.status": "{label}（{retry}/{maximum}） · {seconds}s",
				"message.stopped": "已停止",
				"message.systemPrompt": "系统提示词",
				"message.think": "思考",
				"message.tokensPerSecond": "{tps} tok/s",
				"message.ttft": "首 token {seconds}秒",
				"message.turnError": "本轮运行失败",
				"message.turnProcess.messages.one": "{count} 条消息",
				"message.turnProcess.messages.other": "{count} 条消息",
				"message.turnProcess.separator": " · ",
				"message.turnProcess.subagents.one": "{count} 个 subagent",
				"message.turnProcess.subagents.other": "{count} 个 subagent",
				"message.turnProcess.thoughtForAWhile": "已思考",
				"message.turnProcess.toolCalls.one": "{count} 次工具调用",
				"message.turnProcess.toolCalls.other": "{count} 次工具调用",
				"message.turnUsage.cacheRead": "缓存读取",
				"message.turnUsage.cacheWrite": "缓存写入",
				"message.turnUsage.count": "{count} tok",
				"message.turnUsage.input": "未缓存输入",
				"message.turnUsage.model": "提供方 / 模型",
				"message.turnUsage.output": "输出",
				"message.turnUsage.reasoning": "（其中推理 {tokens}）",
				"message.turnUsage.summaryWithCache": "{total} · 缓存命中率 {percent}%",
				"message.turnUsage.title": "本轮用量",
				"message.turnUsage.total": "总计",
				"message.unknownBlock": "未知内容块",
				"message.unknownSurface": "未知 surface 事件：{type}",
				"more": "更多",
				"next": "下一步",
				"none": "无",
				"number.groupSeparator": ",",
				"number.million": "{value}M",
				"number.thousand": "{value}K",
				"ok": "确定",
				"placeholder.default": "发消息或做任务… / 调用指令 @ 文件或对话",
				"placeholder.hero": "描述你想要构建的内容… / 调用指令 @ 文件或对话",
				"placeholder.parentOffline": "父会话已离线，无法继续发送；仍可停止当前运行",
				"placeholder.steerQueue": "Cmd/Ctrl+Enter 插话发送全部排队消息",
				"placeholder.unavailable": "会话不可用",
				"placeholder.workspace": "选择一个工作区开始",
				"previous": "上一步",
				"queue.cancelEdit": "取消编辑",
				"queue.count": "{n} 条排队消息",
				"queue.edit": "编辑排队消息",
				"queue.edit.unsupported": "包含非文本内容，暂不支持编辑",
				"queue.editFailed": "编辑失败：这条消息可能已经开始发送。",
				"queue.remove": "删除排队消息",
				"queue.removeFailed": "删除失败：这条消息可能已经开始发送。",
				"queue.save": "保存排队消息",
				"queue.steer": "插话发送",
				"queue.steer.unavailable": "仅运行中可插话发送",
				"queue.steerFailed": "插话发送失败，请重试。",
				"read.collapseAria": "收起内容",
				"read.expandAria": "展开其余 {count} 行",
				"read.expandRest": "… 其余 {count} 行",
				"read.window": "显示 {shown} / {total} 行",
				"retry": "重试",
				"row.failed": "失败",
				"row.input": "输入",
				"row.inspect": "查看",
				"row.output": "输出",
				"row.running": "运行中",
				"row.stopped": "已停止",
				"save": "保存",
				"search": "搜索",
				"search.collapseAria": "收起结果",
				"search.expandAria": "展开其余 {count} 行结果",
				"search.expandRest": "… 其余 {count} 行",
				"search.matches": "{shown} 处匹配 · {files} 个文件",
				"search.matches.truncated": "显示 {shown} / 共 {total} 处匹配 · {files} 个文件",
				"search.noResults": "无结果",
				"search.paths": "{shown} 个路径",
				"search.paths.truncated": "显示 {shown} / 共 {total} 个路径",
				"session.hierarchy": "会话层级",
				"settings.enter.description": "仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为",
				"settings.enter.queue": "排队发送",
				"settings.enter.steer": "插话发送",
				"settings.enter.title": "繁忙时 Enter 键行为",
				"settings.transcript.compact": "Compact",
				"settings.transcript.description": "控制已完成轮次的过程内容",
				"settings.transcript.normal": "Normal",
				"settings.transcript.title": "对话显示",
				"skip": "跳过",
				"stats.cacheHit": "缓存命中 {percent}%",
				"stats.counts": "{turns} 轮 · {steps} 步",
				"stats.llm": "LLM {duration}",
				"stats.tokens": "输入 {input} tok · 输出 {output} tok",
				"stats.tokensPerSecond": "{throughput} tok/s",
				"stats.toolCall": "工具调用 {duration}",
				"stats.ttftAverage": "首 token 平均 {duration}",
				"submit": "提交",
				"submitting": "正在提交…",
				"terminal.collapseAria": "收起输出",
				"terminal.done": "已完成",
				"terminal.exitCode": "退出码 {code}",
				"terminal.expandAria": "展开其余 {n} 行输出",
				"terminal.expandRest": "… 其余 {n} 行",
				"terminal.failed": "失败",
				"terminal.noOutput": "无输出",
				"terminal.running": "运行中",
				"terminal.sendInput": "（发送输入）",
				"terminal.session": "终端 {sessionId}",
				"terminal.signal": "信号 {signal}",
				"todo.completed": "{done}/{total} 已完成",
				"todo.progress.active": "{active} 进行中",
				"todo.progress.done": "{done} 已完成",
				"todo.progress.pending": "{pending} 待处理",
				"todo.rowTitle": "更新任务清单",
				"todo.title": "任务",
				"tool.title.bash": "Bash",
				"tool.title.code": "代码",
				"tool.title.edit": "编辑",
				"tool.title.generic": "工具调用",
				"tool.title.glob": "Glob",
				"tool.title.grep": "Grep",
				"tool.title.inspect": "查看",
				"tool.title.pwsh": "Pwsh",
				"tool.title.read": "读取",
				"tool.title.removeCordis": "移除 Cordis 插件",
				"tool.title.runCordis": "运行 Cordis 插件",
				"tool.title.search": "搜索",
				"tool.title.stopCordis": "停止 Cordis 插件",
				"tool.title.webFetch": "网页获取",
				"tool.title.webSearch": "网页搜索",
				"tool.title.write": "写入",
				"truncated": "已截断",
				"unknown": "未知",
				"view.chat": "对话",
				"web.contentTruncated": "内容已截断",
				"web.http": "HTTP",
				"web.noResults": "未找到结果",
				"web.sourcesTruncated": "来源列表已截断"
			},
			en: {
				"access.confirm.acknowledge": "I understand the risks and want to continue",
				"access.confirm.cancel": "Cancel",
				"access.confirm.description": "Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.",
				"access.confirm.enable": "Enable Full access",
				"access.confirm.title": "Enable Full access?",
				"access.fullLabel": "Full access",
				"ask.answered": "{answered}/{total} answered",
				"ask.cancelled": "cancelled",
				"ask.cancelledDetail": "This question set was cancelled before answers were submitted.",
				"ask.interrupted": "interrupted",
				"ask.interruptedDetail": "This question set was interrupted before answers were submitted.",
				"ask.rowTitle": "Ask question",
				"ask.skipped": "Not answered",
				"ask.waiting": "waiting",
				"back": "Back",
				"bash.failed": "Failed",
				"bash.running": "Running",
				"bash.stopped": "Stopped",
				"brand.localBuild": "DSH Local Build",
				"cancel": "Cancel",
				"chat.deepDiving": "Deep diving...",
				"chat.loadError": "Failed to load history: {message} ({code})",
				"chat.loadOlder": "Load earlier",
				"chat.loadingHistory": "Loading history…",
				"chat.toBottom": "Back to bottom",
				"chat.turnNavigation.jump": "Jump to turn {turn}",
				"chat.turnNavigation.label": "Turn navigation",
				"chat.turnNavigation.turn": "Turn {turn}",
				"clock.md": "{m}/{d}",
				"clock.ymd": "{y}-{m}-{d}",
				"close": "Close",
				"collapse": "Collapse",
				"command.done": "Completed",
				"command.failed": "Command failed",
				"command.imagesUnsupported": "/{command} does not accept image attachments; remove them first",
				"command.running": "Running…",
				"command.title": "Command",
				"connection.reconnecting": "Connection lost; reconnecting…",
				"context.aria": "{percent} of context used",
				"context.messages": "Messages",
				"context.system": "System prompt",
				"context.tools": "Tools",
				"context.used": "of context used",
				"copied": "Copied",
				"copy": "Copy",
				"copy.compactJson": "Copy compact JSON",
				"copy.failed": "Copy failed",
				"copy.json": "Copy JSON",
				"copy.optionsHint": "{action}; right-click for copy options",
				"copy.path": "Copy property path",
				"copy.prettyJson": "Copy pretty JSON",
				"copy.value": "Copy value",
				"delete": "Delete",
				"details.close": "Close details",
				"details.empty": "Click a tool row in the message flow to view its details",
				"details.input": "Input",
				"details.notInWindow": "This call is outside the current window",
				"details.output": "Output",
				"details.running": "Running…",
				"details.title": "Details",
				"diff.collapseAria": "Collapse diff",
				"diff.expandAria": "Expand {count} more diff lines",
				"diff.expandRest": "… {count} more lines",
				"diff.files.one": "{count} file",
				"diff.files.other": "{count} files",
				"duration.compactMinutes": "{minutes}m{seconds}s",
				"duration.compactSeconds": "{seconds}s",
				"duration.milliseconds": "{milliseconds}ms",
				"duration.minutes": "{minutes}m {seconds}s",
				"duration.seconds": "{seconds}s",
				"edit": "Edit",
				"expand": "Expand",
				"fileOpen.folderTitle": "Couldn’t open folder",
				"fileOpen.folderUnknown": "Couldn’t open this folder",
				"fileOpen.title": "Couldn’t open file",
				"fileOpen.unknown": "Couldn’t open this file",
				"hero.chooseWorkspace": "Choose workspace",
				"hero.headline": "Into the Unknown",
				"hero.preview": "Preview",
				"hint.goal": "describe the objective for a long-running task",
				"hint.goal.active": "goal active — edit / pause / resume / clear",
				"image.closePreview": "Close original image preview",
				"image.dimensionTooLarge": "Image sides must be at most {size}px; downscale it and try again",
				"image.dropBlocked": "Images cannot be added right now",
				"image.dropDesc": "Up to {count} images, {size} each",
				"image.dropTitle": "Drag images here to add them",
				"image.fileTooLarge": "Each image must be smaller than {size}",
				"image.label": "Image",
				"image.loadFailed": "Image failed to load; click to retry",
				"image.loading": "Loading image…",
				"image.modelUnsupported": "The current model does not support images; switch to a model that does",
				"image.openOriginal": "View original",
				"image.openOriginalLabel": "{label}, click to view original",
				"image.original": "Original image",
				"image.pending": "Pending images",
				"image.preview": "Original image preview",
				"image.remove": "Remove image {name}",
				"image.scrollLeft": "Scroll images left",
				"image.scrollRight": "Scroll images right",
				"image.sendFailed": "Sending images failed ({reason}); re-add them and try again",
				"image.subagentUnsupported": "Subagent sessions do not support images yet",
				"image.tooMany": "A message can include up to {count} images",
				"image.tooManyPixels": "Image resolution is too high; compress it and try again",
				"image.totalTooLarge": "Images exceed {size} in total; remove some and try again",
				"image.unsupportedType": "Only PNG, JPG, WebP, and GIF images are supported",
				"input.accessMode": "Access mode, current: {name}",
				"input.commands": "Commands",
				"input.send": "Send message",
				"input.stop": "Stop generating",
				"json.collapseNode": "Collapse JSON node",
				"json.expandNode": "Expand JSON node",
				"json.label": "JSON",
				"json.truncated": "… truncated, {total} characters total",
				"load.failed": "Failed to load",
				"loading": "Loading…",
				"markdown.footnotes": "Footnotes",
				"markdown.truncatedCharacters": "… truncated at {total} characters",
				"message.branch": "Branch into a new conversation",
				"message.branchUnavailable": "Available only on the last message of a completed turn",
				"message.compaction": "Context compacted",
				"message.compaction.commandTitle": "compact",
				"message.compaction.completed": "Compacted {items} history items (~{tokens} tokens)",
				"message.compaction.expand": "View compaction summary",
				"message.compaction.running": "Compacting context…",
				"message.compaction.unavailable": "Compaction summary unavailable",
				"message.context.catalog.more": "… {count} more",
				"message.context.catalog.replaced": "Replacement catalog",
				"message.context.instructions.added": "added",
				"message.context.instructions.loaded": "loaded",
				"message.context.instructions.removed": "removed",
				"message.context.instructions.updated": "updated",
				"message.context.recall.counts": "{retained} kept · {omitted} omitted",
				"message.context.recall.truncated": "truncated",
				"message.context.relay.from": "From session {session}",
				"message.context.snapshot.supersedes": "Supersedes earlier snapshots",
				"message.contextInjection": "Context injection",
				"message.contextRecall": "Session recall",
				"message.extraBlock": "Extra content block",
				"message.failure.auth": "API key is invalid",
				"message.maxTokens": "Output token limit reached",
				"message.maxTokens.hint": "The reply was cut off; earlier output is preserved in the conversation. Send \"continue\" to let the model resume.",
				"message.ranFor": "Ran for {duration}",
				"message.referenceSeparator": ", ",
				"message.referenceSummary": "Referenced session · {labels}",
				"message.retry.active": "Retrying model request",
				"message.retry.cancelled": "Model request retry cancelled",
				"message.retry.delay": "Retry delay: ",
				"message.retry.failure": "Failure reason: ",
				"message.retry.scheduled": "Waiting to retry model request",
				"message.retry.started": "Retried model request",
				"message.retry.status": "{label} ({retry}/{maximum}) · {seconds}s",
				"message.stopped": "Stopped",
				"message.systemPrompt": "System prompt",
				"message.think": "Think",
				"message.tokensPerSecond": "{tps} tok/s",
				"message.ttft": "TTFT {seconds}s",
				"message.turnError": "This turn failed",
				"message.turnProcess.messages.one": "{count} message",
				"message.turnProcess.messages.other": "{count} messages",
				"message.turnProcess.separator": " · ",
				"message.turnProcess.subagents.one": "{count} subagent",
				"message.turnProcess.subagents.other": "{count} subagents",
				"message.turnProcess.thoughtForAWhile": "Thought for a while",
				"message.turnProcess.toolCalls.one": "{count} tool call",
				"message.turnProcess.toolCalls.other": "{count} tool calls",
				"message.turnUsage.cacheRead": "Cached input",
				"message.turnUsage.cacheWrite": "Cache write",
				"message.turnUsage.count": "{count} tok",
				"message.turnUsage.input": "Uncached input",
				"message.turnUsage.model": "Provider / model",
				"message.turnUsage.output": "Output",
				"message.turnUsage.reasoning": " ({tokens} reasoning)",
				"message.turnUsage.summaryWithCache": "{total} · Cache hit {percent}%",
				"message.turnUsage.title": "Turn usage",
				"message.turnUsage.total": "Total",
				"message.unknownBlock": "Unknown content block",
				"message.unknownSurface": "Unknown surface event: {type}",
				"more": "More",
				"next": "Next",
				"none": "None",
				"number.groupSeparator": ",",
				"number.million": "{value}M",
				"number.thousand": "{value}K",
				"ok": "OK",
				"placeholder.default": "Message or run a task... / commands, @ files or sessions",
				"placeholder.hero": "Describe what you want to build... / commands, @ files or sessions",
				"placeholder.parentOffline": "Parent session offline; sending is unavailable but you can still stop the run",
				"placeholder.steerQueue": "Cmd/Ctrl+Enter steers all queued messages",
				"placeholder.unavailable": "Session unavailable",
				"placeholder.workspace": "Choose a workspace to start",
				"previous": "Previous",
				"queue.cancelEdit": "Cancel editing",
				"queue.count": "{n} queued messages",
				"queue.edit": "Edit queued message",
				"queue.edit.unsupported": "Contains non-text content; editing is not supported yet",
				"queue.editFailed": "Edit failed: this message may have already started sending.",
				"queue.remove": "Remove queued message",
				"queue.removeFailed": "Removal failed: this message may have already started sending.",
				"queue.save": "Save queued message",
				"queue.steer": "Steer queued message",
				"queue.steer.unavailable": "Steering is available only while the agent is running",
				"queue.steerFailed": "Steering failed. Try again.",
				"read.collapseAria": "Collapse content",
				"read.expandAria": "Expand {count} more lines",
				"read.expandRest": "… {count} more lines",
				"read.window": "Showing {shown} of {total} lines",
				"retry": "Retry",
				"row.failed": "Failed",
				"row.input": "IN",
				"row.inspect": "Inspect",
				"row.output": "OUT",
				"row.running": "Running",
				"row.stopped": "Stopped",
				"save": "Save",
				"search": "Search",
				"search.collapseAria": "Collapse results",
				"search.expandAria": "Expand {count} more result lines",
				"search.expandRest": "… {count} more lines",
				"search.matches": "{shown} matches · {files} files",
				"search.matches.truncated": "Showing {shown} of {total} matches · {files} files",
				"search.noResults": "No results",
				"search.paths": "{shown} paths",
				"search.paths.truncated": "Showing {shown} of {total} paths",
				"session.hierarchy": "Session hierarchy",
				"settings.enter.description": "Busy only; Cmd/Ctrl+Enter uses the other behavior",
				"settings.enter.queue": "Queue",
				"settings.enter.steer": "Steer",
				"settings.enter.title": "Enter behavior while busy",
				"settings.transcript.compact": "Compact",
				"settings.transcript.description": "Controls process content in completed turns",
				"settings.transcript.normal": "Normal",
				"settings.transcript.title": "Conversation display",
				"skip": "Skip",
				"stats.cacheHit": "Cache hit {percent}%",
				"stats.counts": "{turns} turns · {steps} steps",
				"stats.llm": "LLM {duration}",
				"stats.tokens": "Input {input} tok · Output {output} tok",
				"stats.tokensPerSecond": "{throughput} tok/s",
				"stats.toolCall": "Tool call {duration}",
				"stats.ttftAverage": "TTFT avg {duration}",
				"submit": "Submit",
				"submitting": "Submitting…",
				"terminal.collapseAria": "Collapse output",
				"terminal.done": "Done",
				"terminal.exitCode": "exit code {code}",
				"terminal.expandAria": "Expand the remaining {n} output lines",
				"terminal.expandRest": "… {n} more lines",
				"terminal.failed": "Failed",
				"terminal.noOutput": "No output",
				"terminal.running": "Running",
				"terminal.sendInput": "(send input)",
				"terminal.session": "Terminal {sessionId}",
				"terminal.signal": "signal {signal}",
				"todo.completed": "{done}/{total} completed",
				"todo.progress.active": "{active} in progress",
				"todo.progress.done": "{done} completed",
				"todo.progress.pending": "{pending} pending",
				"todo.rowTitle": "Update to-do list",
				"todo.title": "To-dos",
				"tool.title.bash": "Bash",
				"tool.title.code": "Code",
				"tool.title.edit": "Edit",
				"tool.title.generic": "Tool call",
				"tool.title.glob": "Glob",
				"tool.title.grep": "Grep",
				"tool.title.inspect": "Inspect",
				"tool.title.pwsh": "Pwsh",
				"tool.title.read": "Read",
				"tool.title.removeCordis": "Remove Cordis Plugin",
				"tool.title.runCordis": "Run Cordis Plugin",
				"tool.title.search": "Search",
				"tool.title.stopCordis": "Stop Cordis Plugin",
				"tool.title.webFetch": "Fetch",
				"tool.title.webSearch": "Search",
				"tool.title.write": "Write",
				"truncated": "Truncated",
				"unknown": "Unknown",
				"view.chat": "Chat",
				"web.contentTruncated": "Content truncated",
				"web.http": "HTTP",
				"web.noResults": "No results found",
				"web.sourcesTruncated": "Source list truncated"
			}
		};
		function wrapLocaleT(t) {
			return function (key, params) {
				var out;
				try { out = t ? t(key, params) : undefined; } catch (e) { out = undefined; }
				if (typeof out === "string" && out !== key) return out;
				var dict = CHAT_T_FALLBACK[currentLocale()] || CHAT_T_FALLBACK.en;
				if (dict && Object.prototype.hasOwnProperty.call(dict, key)) {
					// 兜底也要做 {placeholder} 插值（对齐官方 t 行为），否则参数化词条露模板
					var text = dict[key];
					if (params && typeof params === "object" && text.indexOf("{") !== -1) {
						text = text.replace(/\{(\w+)\}/g, function (m, name) {
							return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
						});
					}
					return text;
				}
				return typeof out === "string" ? out : key;
			};
		}

		// ---- React ----
		var react = require("react");
		var useMemo = react.useMemo;
		var useSyncExternalStore = react.useSyncExternalStore;

		// ---- react-dom（一次性更新说明通知用） ----
		// 仅用于把 UpdateNotice 挂到 <body> 上的独立 React 根；极简宿主 / 测试
		// loader（mockRequire 不提供 react-dom）下静默跳过，不影响插件主体。
		var ReactDOM = null;
		try { ReactDOM = require("react-dom"); } catch (e) { /* 无 react-dom 的宿主 */ }

		// ---- 一次性"新版本更新说明"通知 ----
		// 机制与 dsh-wallpaper-engine 同款：localStorage 记录"已通知过的版本号"，
		// 每次发布新版本时把 NOTICE_VERSION 改成新版本号并更新 NOTICE_CONTENT 正文，
		// 加载时存值与当前版本不符就弹一次，点「知道了」后写入当前版本、下次不再弹。
		// 注意：v0.4.0 起更新说明只保留一节（合并 v0.3.1 + v0.4.0 的内容）；更早的
		// v0.3.0 节已按用户要求移除——该版内容从未对老用户展示过，新用户看合并节即可。
		var NOTICE_KEY = "dsh-turn-fold:notice-version";
		var NOTICE_VERSION = "0.4.0";
		var NOTICE_CONTENT = {
			zh: {
				title: "v0.4.0 更新说明",
				sections: [
					{
						version: "v0.4.0",
						items: [
							{ title: "🧩 适配 DeepSeek Harness 新旧版本", detail: "完整适配新版 DSH 的界面与数据结构变化（对话词典命名空间拆分、快照结构、回合折叠设置行），旧版本继续无缝兼容——同一份代码在新旧版本上都正常折叠；此前新版下折叠失效、官方词条裸显（message.think 等）的问题全部修复。" },
							{ title: "🃏 扑克牌折叠图标", detail: "步骤折叠栏与回合折叠栏的前导图标改为扑克牌：运行中显示四花色循环卡牌动画，完成后收起为随机花色的牌堆（工具数 ≤3 用 3 张、>3 用 5 张），展开时牌张绕底边中点扇形展开并带形变过渡动画；牌张遮挡采用 luminance mask 动态挖空上层覆盖区域，牌身透明、不依赖背景色，壁纸/透明背景下依然正确。" },
							{ title: "🧠 纯 Think 段也折叠", detail: "思考内容统一收进步骤折叠栏：运行中标题「正在思考 · 最新一行」流式滚动（shimmer 光泽）、闭合后显示「思考了N次」；不再有「裸 Think 行直接显示」与「工具段折叠」之间的切换跳变。" },
							{ title: "🚫 排除工具不折叠", detail: "todo_write（更新任务清单）不套步骤折叠栏、也不并入任何步骤分组，始终以官方工具卡片原样显示；仍参与整回合折叠（回合结束收进回合折叠栏）。" },
							{ title: "🏷️ 包名更名", detail: "npm 包名由 dsh-turn-fold 变更为 @winteries/dsh-turn-fold，解决插件市场「已安装」页因同名插件歧义而缺失描述的问题；旧包名 dsh-turn-fold 仍会同步发布，无需迁移。" },
							{ title: "📣 版本更新说明", detail: "新增「新版本更新说明」机制：每个新版本首次加载时自动弹出一次。" },
							{ title: "🔤 新版 DSH 词条适配", detail: "适配新版 DSH 官方词典的命名空间拆分：折叠栏内的「思考」「上下文注入」等官方词条不再裸显 message.think / message.contextInjection 等原始 key；四个委托渲染入口分别跟随官方条目声明的语言命名空间。" },
							{ title: "📚 内置官方词典兜底", detail: "内嵌官方 chat / conversation / common 三本词典共 282 条词条（含 {占位符} 插值）作为兜底：宿主词典缺失或错位时，折叠栏内的官方文案仍全部正常显示。" }
						]
					}
				],
				hint: "本提示每个新版本只出现一次，点下方按钮即可关闭。",
				dismiss: "知道了"
			},
			en: {
				title: "What's new in v0.4.0",
				sections: [
					{
						version: "v0.4.0",
						items: [
							{ title: "🧩 Adapts to new and old DeepSeek Harness", detail: "Fully adapts to the latest DSH changes (locale-namespace split, snapshot restructuring, the fold-mode settings row) while older versions keep working unchanged — one codebase folds correctly on both; the new-DSH failures (folding silently off, raw keys like message.think) are all fixed." },
							{ title: "🃏 Poker-card fold icons", detail: "Step and turn fold bars now show poker-card icons: a four-suit card animation while running, collapsing to a random-suit deck on completion (3 cards for ≤3 tools, 5 cards for >3); expanding fans the cards out with morph transitions. Occlusion uses luminance masks that dynamically cut out the overlapping area of the card above — the card body stays transparent, so it works correctly over wallpapers and transparent backgrounds without any background-color dependency." },
							{ title: "🧠 Think-only segments fold too", detail: "All thinking now wraps into step fold bars: while running the header shows \"Thinking · latest line\" (streaming, shimmer), and \"Thought N times\" once closed — no more jump between a bare Think row and a folded tool segment when a tool arrives mid-segment." },
							{ title: "🚫 Excluded tools stay unfolded", detail: "todo_write (task-list updates) skips the step fold bar and doesn't join any segment — it renders as the bare official tool card; still participates in whole-turn collapse (folded into the turn fold bar when the turn ends)." },
							{ title: "🏷️ Package rename", detail: "The npm package was renamed from dsh-turn-fold to @winteries/dsh-turn-fold, resolving the missing description in the market Installed tab caused by a same-name collision; the legacy dsh-turn-fold package keeps receiving synchronized releases, so no migration is needed." },
							{ title: "📣 Release notes", detail: "Introduced the per-version \"What's new\" notice that appears automatically once after each release." },
							{ title: "🔤 New-DSH locale adaptation", detail: "Adapts to the new DSH locale-namespace split: official labels like \"Think\" and \"Context injection\" no longer leak raw keys (message.think / message.contextInjection) inside fold bars; each delegated renderer now follows the locale namespace declared by its official entry." },
							{ title: "📚 Embedded dictionary fallback", detail: "All three official dictionaries — chat / conversation / common, 282 entries total — are embedded with {placeholder} interpolation as a fallback: if the host dictionary is missing or mismatched, every official label inside fold bars still renders correctly." }
						]
					}
				],
				hint: "This notice appears once per version — dismiss to close.",
				dismiss: "Got it"
			}
		};
		function UpdateNotice() {
			var visibleState = react.useState(function () {
				try {
					if (typeof localStorage === "undefined") return true;
					return (localStorage.getItem(NOTICE_KEY) || "") !== NOTICE_VERSION;
				} catch (e) { return true; }
			});
			var visible = visibleState[0];
			var setVisible = visibleState[1];
			function dismiss() {
				try { localStorage.setItem(NOTICE_KEY, NOTICE_VERSION); } catch (e) { /* ignore */ }
				setVisible(false);
			}
			if (!visible) return null;
			var content = NOTICE_CONTENT[currentLocale()] || NOTICE_CONTENT.en;
			// 标题与描述的间隔符号：中文用全角冒号，英文用半角冒号加空格
			var sep = currentLocale() === "zh" ? "：" : ": ";
			var secs = [];
			for (var si = 0; si < content.sections.length; si++) {
				var sec = content.sections[si];
				var lis = [];
				for (var ii = 0; ii < sec.items.length; ii++) {
					// 每个条目：加粗功能名 + 间隔符 + 正式描述，一眼可扫
					lis.push(react.createElement("li", { key: "i" + ii },
						react.createElement("strong", null, sec.items[ii].title),
						sep + sec.items[ii].detail
					));
				}
				// 小节头：版本号胶囊 + 可选说明（如"大版本更新 · 此前未展示"）
				var head = [react.createElement("span", { key: "v", className: "ccg-notice-ver" }, sec.version)];
				if (sec.note) {
					head.push(react.createElement("span", { key: "n", className: "ccg-notice-ver-note" }, sec.note));
				}
				secs.push(react.createElement("div", { key: "s" + si, className: "ccg-notice-sec" },
					react.createElement("div", { className: "ccg-notice-sec-head" }, head),
					react.createElement("ul", { className: "ccg-notice-list" }, lis)
				));
			}
			return react.createElement("div", { className: "ccg-notice", role: "alert" },
				react.createElement("div", { className: "ccg-notice-title" }, content.title),
				react.createElement("div", { className: "ccg-notice-body" }, secs),
				react.createElement("p", { className: "ccg-notice-hint" }, content.hint),
				Button !== null
					? react.createElement(Button, { variant: "primary", size: "sm", className: "ccg-notice-btn-plat", onClick: dismiss }, content.dismiss)
					: react.createElement("button", { className: "ccg-notice-btn", type: "button", onClick: dismiss }, content.dismiss)
			);
		}

		// ---- 官方 UI 原语（可选依赖） ----
		// 折叠栏优先用官方 DisclosureRow 渲染（24px 行高、16px 前导、14px 官方 chevron、
		// 14px/24px 标题），与 Think / 工具卡片的折叠行逐像素一致。
		// @deepseek-ai/dsh-client-ui-primitives 是平台 seed 模块，插件工厂可直接 require；
		// 若某版本缺失则回退到自带兜底样式，保证插件仍可用。
		var DisclosureRow = null;
		var Button = null;
		var Menu = null;
		var IconChevronDownOutline14 = null;
		var IconChevronRightOutline14 = null;
		var IconThinkOutline14 = null;
		var IconSearchOutline16 = null;
		var IconEditOutline16 = null;
		var IconBrowseOutline16 = null;
		var IconCodeOutline16 = null;
		var IconApiOutline14 = null;
		var IconSparkle16 = null;
		var Toast = null;
		try {
			var uiPrimitives = require("@deepseek-ai/dsh-client-ui-primitives");
			DisclosureRow = uiPrimitives.DisclosureRow;
			Button = uiPrimitives.Button;
			Menu = uiPrimitives.Menu;
			IconChevronDownOutline14 = uiPrimitives.IconChevronDownOutline14;
			IconChevronRightOutline14 = uiPrimitives.IconChevronRightOutline14;
			IconThinkOutline14 = uiPrimitives.IconThinkOutline14;
			IconSearchOutline16 = uiPrimitives.IconSearchOutline16;
			IconEditOutline16 = uiPrimitives.IconEditOutline16;
			IconBrowseOutline16 = uiPrimitives.IconBrowseOutline16;
			IconCodeOutline16 = uiPrimitives.IconCodeOutline16;
			IconApiOutline14 = uiPrimitives.IconApiOutline14;
			IconSparkle16 = uiPrimitives.IconSparkle16;
			// 官方 Toast（消息通知原语）：短提示自动消失；平台缺失时静默跳过。
			Toast = uiPrimitives.Toast;
		} catch (e) {
			/* 平台模块缺失：走自带兜底样式 */
		}

		// ---- 注入样式 ----
		var CSS_ID = "dsh-turn-fold/style";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "@winteries/dsh-turn-fold";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				/* 组容器：不加 margin，行间距完全交给官方 column 的 16px 节奏 */
				".ccg-group-root{display:flex;flex-direction:column}",
				/* 展开时折叠栏与内容之间留 16px——与 .ccg-fold-body 的成员间距 gap:16px 同节奏。
				   间距必须挂在 .ccg-fold-clip（group-root 的直接子元素）上而非 .ccg-header：
				   GroupHeader 渲染的是 DisclosureRow，"ccg-header" 类在其内部 DOM、不是
				   group-root 的直接子元素——header 上用后代选择器会跨层泄漏（回合 FoldClip
				   内嵌套的步骤折叠栏被回合规则命中：0 规则压扁间距、16px 规则误加间距），
				   用 > 直接子选择器则什么都匹配不上。fold-clip 天然锚定最近的 group-root；
				   :not([data-ccg-turn]) 排除回合栏（其折叠栏-内容间距由分隔线 4px/8px 承担）。 */
				".ccg-group-root[data-ccg-open]:not([data-ccg-turn]) > .ccg-fold-clip{margin-top:16px}",
				/* 0 秒占位栏与正式回合栏的位置接续：占位栏渲染在 user 消息的 flowItem 内
				   （正下方、无间距），正式回合栏在下一个 flowItem 顶部（官方 column 有
				   16px flow gap）——不补这 16px，第一条中间节点到达、占位交接给正式栏的
				   瞬间整栏会向下跳一下。补齐后交接前后栏位置逐像素一致（只剩文案/图标
				   内容切换，无位移）。 */
				".ccg-group-root[data-ccg-placeholder]{margin-top:16px}",
				/* 分隔线颜色：--dsw-alias-line-secondary 在 DSH 0.1.1/0.1.2 均无定义（官方自身
				   也有悬空引用），两版的线 token 是 --dsw-alias-border-l1，var() 链式兜底后
				   仍回退字面量（老版本/未知主题） */
				".ccg-turn-divider{height:1px;flex:none;background:var(--dsw-alias-line-secondary,var(--dsw-alias-border-l1,#d1d5db));margin:4px 0 8px}",
				/* 折叠内容容器：grid 轨道 0fr→1fr 过渡（无需测量——1fr 轨道自动等于
				   内容完整高度，内容多少就展开多少；曲线/时长为本插件自有，与
				   常见的 grid 0fr 方案参数不同）。折叠态 opacity 0 淡入。 */
				".ccg-fold-clip{display:grid;grid-template-rows:0fr;min-width:0;max-width:100%;opacity:0;transition:grid-template-rows .28s cubic-bezier(.22,1,.36,1),opacity .2s ease-out,margin-top .28s cubic-bezier(.22,1,.36,1)}",
				".ccg-fold-clip.ccg-fold-clip-open{grid-template-rows:1fr;opacity:1}",
				/* 折叠内容：flex column + 16px gap——段内命令（工具卡片 / Think 行）之间的
				   间距与官方聊天流 column 节奏一致 */
				".ccg-fold-body{display:flex;flex-direction:column;gap:16px;min-width:0;min-height:0;overflow:hidden}",
				".ccg-fold-clip.ccg-fold-clip-open > .ccg-fold-body{overflow:visible}",
				"@media (prefers-reduced-motion: reduce){.ccg-fold-clip{transition:none!important}}",
				/* 回合折叠栏展开时，非第一个段的成员节点不经过 FoldClip 高度动画，
				   用淡入+微位移入场动画避免"瞬间出现"（.22s ease-out） */
				"@keyframes ccg-member-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}",
				".ccg-member-in{animation:ccg-member-in .22s ease-out both}",
				/* 官方 DisclosureRow 折叠栏微调：标题 400、可省略号（回合折叠栏指标文案可能较长）、chevron 用 label-secondary */
				".ccg-header-title{font-weight:400;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				/* 回合折叠栏标题占满行宽，指标与"第x轮"两端对齐（右对齐轮次） */
				".ccg-group-root[data-ccg-turn] .ccg-header-title{flex:1 1 auto}",
				".ccg-header-flex{display:flex;align-items:center;justify-content:space-between;width:100%;min-width:0;gap:12px}",
				/* 指标容器改为 inline-flex：齿轮图标与指标文字按 flex 交叉轴垂直居中
				   （原先是 inline 布局，齿轮按文本基线对齐导致纵向偏上） */
				".ccg-header-flex-metrics{min-width:0;display:inline-flex;align-items:center}",
				".ccg-header-round{flex:none;white-space:nowrap}",
				/* 组内有执行失败命令时标题标红（与官方错误色 token 一致） */
				/* 失败提示：仅 "——" 之后的部分标红（整标题不再整体标红） */
				".ccg-header-failure{color:var(--dsw-alias-state-error-primary,#ef4444)}",
				/* 编辑行数变更 [ +N -M ]：悬停括号范围时 +N 变绿、-N 变红 */
				".ccg-diff{transition:color .15s ease}",
				".ccg-diff:hover .ccg-diff-add{color:var(--dsw-alias-state-success-primary,#16a34a)}",
				".ccg-diff:hover .ccg-diff-del{color:var(--dsw-alias-state-error-primary,#ef4444)}",
				/* 文件名链接：悬停变 DeepSeek 官方蓝色 #4D6BFE（[ +12 -3 ] 同款变色逻辑），
				   点击复制绝对路径并弹官方 Toast 提示。
				   !important：DisclosureRow 官方 title 样式的 color 优先级更高，
				   不加 !important 时 hover 变色会被覆盖。不可用 CSS 变量
				   --dsw-alias-brand-primary（暗色主题下解析为白色）。 */
				".ccg-file-link{cursor:pointer;transition:color .15s ease,text-decoration-color .15s ease;text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:transparent;text-underline-offset:3px}",
				".ccg-file-link:hover{color:#4D6BFE!important;text-decoration-color:#fff!important}",
				".ccg-header-chevron{color:var(--dsw-alias-label-secondary,#9ca3af)}",
				/* 步骤折叠栏扑克牌图标：前导区隐藏（内建 chevron 一并消失），图标并入标题；
				   同一套牌张元素，开合时按 data-ccg-open 改写 transform，逐张牌形变过渡。
				   标题改为 flex 垂直居中（仅含扑克图标的标题，:has 隔离），避免 20px 图标
				   与 14px 文本基线错位被 overflow:hidden 裁掉一半。 */
				".ccg-poker-leading{display:none}",
				".ccg-poker-icon{display:inline-flex;align-items:center;justify-content:center;position:relative;width:24px;height:24px;flex:none;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				".ccg-poker-svg{display:flex;align-items:center}",
				".ccg-header-title:has(.ccg-poker-icon){display:inline-flex;align-items:center;gap:6px}",
				/* mask 遮挡方案：真实牌与 mask 里的 occluder 用同一套绝对 transform，
				   同样的过渡曲线 → 开合动画期间遮挡逐帧对齐。rect 不填充（纯轮廓，
				   壁纸可透出）；下层牌被上层覆盖的区域由 mask 动态扣掉，不透出下层。 */
				".ccg-poker-motion,.ccg-poker-mask-card{transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				/* 运行中折叠栏图标的开合角度过渡（CSS transform 覆盖 attribute，SMIL 动画不断流）：
				   牌面轮换（步骤折叠栏）：收起 0° ⇄ 展开 35.5°（绕图标中心 8,8）；
				   牌面翻转（回合折叠栏）：收起纵向中轴 ⇄ 展开竖直对角线轴
				   （axis-rest-rotation g 位于局部原点，CSS 绕 0,0 旋转与 attribute 等价）。
				   data-flat-open / data-spin-open 挂在外层 .ccg-poker-icon span（React 可控），
				   后代选择器切换内部 g 的 CSS transform，transition 播放平滑过渡。 */
				".ccg-poker-icon .ccg-flat-rotation{transform-box:view-box;transform-origin:8px 8px;transform:rotate(0deg);transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				".ccg-poker-icon[data-flat-open] .ccg-flat-rotation{transform:rotate(35.5deg)}",
				".ccg-poker-icon .ccg-axis-rest-rotation{transform-box:view-box;transform:rotate(0deg);transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				".ccg-poker-icon[data-spin-open] .ccg-axis-rest-rotation{transform:rotate(35.5377deg)}",
				/* 运行中卡牌动画：牌身透明（透壁纸），动画自身的 mask 扣掉上层覆盖区 */
				".anim-card{fill:transparent}",
				/* 兜底折叠栏（官方 DisclosureRow 不可用时）：24px 行高 + 14px chevron + 14px/24px 文案 */
				".ccg-header-fallback{display:flex;align-items:center;gap:6px;height:24px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:14px;line-height:24px;white-space:nowrap}",
				".ccg-header-fallback .ccg-chevron{flex:none;font-size:14px;width:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#6b7280);transition:transform .12s ease}",
				".ccg-header-fallback[data-open] .ccg-chevron{transform:rotate(90deg)}",
				".ccg-header-fallback .ccg-title{font-weight:400;overflow:hidden;text-overflow:ellipsis}",
				/* 被折叠的成员（步骤折叠 + 回合折叠，tool-call 与 assistant-step 通用）：
				   整个 flowItem 必须 display:none，否则空 flowItem 仍会占据 flex 布局
				   并吃掉 column 的 16px gap。注：每个 flowItem 里永远包着一个
				   <div data-slot style="display:contents">，所以 :empty 永远匹配不上，
				   必须用 :has() 按隐藏标记定位。 */
				"[data-chat-flow-kind]:has([data-ccg-hidden]){display:none}",
				"[data-chat-flow-kind]:empty{display:none}",
				/* 最终总结消息：回合结束后隐藏其内部 Think 行（官方 ReasoningRow 根节点带
				   data-variant="think"），只显示正文 —— 符合"只显示最终结果"的语义 */
				"[data-ccg-turn-folded] [data-variant=\"think\"]{display:none}",
				/* 滚轮数字（回合折叠栏直播指标）：每位数 1ch 宽视窗，竖排 0-9 用 transform
				   滚动，呈现里程表/滚轮式变化。文字部分保持原样内联。 */
				".ccg-roll-cell{display:inline-block;width:1ch;height:1em;overflow:hidden;vertical-align:-0.15em;text-align:center}",
				".ccg-roll-strip{display:flex;flex-direction:column}",
				".ccg-roll-strip .ccg-roll-d{flex:none;width:1ch;height:1em;line-height:1em;text-align:center}",
				".ccg-roll-text{display:inline}",
				".ccg-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				/* think 运行中摘要（步骤折叠栏标题）：前缀 + 最新一行，横向自动滚动跟随末尾
				   （官方 ReasoningRow 同款 data-follow-end）。滚动成立的前提是摘要自身
				   溢出（scrollWidth > clientWidth）：标题行必须块级 flex 撑满标题区
				   （width:100%），摘要 flex:1 1 auto + min-width:0 吃掉剩余宽度——
				   旧实现是 inline-flex/inline-block + max-width:100% 的 shrink-to-fit 链，
				   摘要从不被约束，溢出发生在祖先容器上，scrollLeft 永远无效。 */
				".ccg-think-title{display:flex;align-items:center;min-width:0;width:100%}",
				".ccg-think-prefix{flex:none}",
				/* 图标与 · 前后统一 4px 间隔：前缀 图标 名称 · 摘要 */
				".ccg-think-icon{flex:none;display:inline-flex;align-items:center;margin:0 4px}",
				/* 名称不设显式颜色：继承折叠栏标题色（label-secondary），与"运行了 N 条命令"
				   纯文本标题视觉一致（此前设 label-primary 白色导致观感字号不同） */
				".ccg-think-name{flex:none;font-weight:400}",
				".ccg-think-sep{flex:none;color:var(--dsw-alias-label-tertiary,#9ca3af);margin:0 4px}",
				".ccg-think-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".ccg-think-summary[data-follow-end]{text-overflow:clip}",
				/* 运行中步骤折叠栏标题：整行统一 shimmer 高光（官方 TurnStatus "Deep diving..."
				   同款）——渐变挂在父容器上，整行一个渐变背景 + background-clip:text +
				   背景位移动画，光泽扫过整个标题。
				   颜色方案：基线用 Codex 同款深灰 rgb(104,104,104) + 纯白高光
				   （对比更明显，动效可见且观感仍是灰色系）；高光区域加宽（35%~65%）。
				   图标 span 单独恢复颜色（background-clip:text 会把 currentColor 变透明）。 */
				".ccg-think-title-live{color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,rgb(113,113,113) 0%,rgb(113,113,113) 35%,rgb(219,219,219) 50%,rgb(113,113,113) 65%,rgb(113,113,113) 100%);background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;animation:3.8s linear infinite ccg-turn-status-shimmer}",
				".ccg-think-title-live .ccg-think-icon{color:rgb(113,113,113);-webkit-text-fill-color:rgb(113,113,113)}",
				/* 亮色模式：body 无 data-ds-dark-theme 时覆盖渐变色与图标色 */
				"body:not([data-ds-dark-theme]) .ccg-think-title-live{background-image:linear-gradient(90deg,rgb(167,168,169) 0%,rgb(167,168,169) 35%,rgb(232,233,233) 50%,rgb(167,168,169) 65%,rgb(167,168,169) 100%)}",
				"body:not([data-ds-dark-theme]) .ccg-think-title-live .ccg-think-icon{color:rgb(167,168,169);-webkit-text-fill-color:rgb(167,168,169)}",
				/* 高光流动 1.8s（47.4% 从右扫到左）→ 停顿 2s（100% 停在终态），循环 */
				"@keyframes ccg-turn-status-shimmer{0%{background-position:100% 0}47.4%{background-position:0 0}100%{background-position:0 0}}",
				"@media (prefers-reduced-motion:reduce){.ccg-think-title-live{background-position:0 0;background-size:100% 100%;animation:none}}",
				/* 含 think+text 节点拆分渲染：段外 text 正文的官方 think 行隐藏
				   （段外只显示 text 正文，段内展开时官方渲染含完整 think 行） */
				".ccg-text-only [data-variant=\"think\"]{display:none}",
				/* 段外 text 正文：顶部 16px 与步骤折叠栏行拉开。官方 MarkdownText 的 p 是
				   margin:16px 0，靠其自身 first/last-child 重置归零——但运行中的官方 bundle
				   该重置未必生效（版本差异），p 的上下 margin 会与这里的 16px padding、
				   官方 column 的 16px gap 叠加成 32~48px。插件侧用结构选择器镜像官方重置
				   （CSS Modules 哈希类名不可依赖，p/子元素用 >*>*>*> 定位到
				   .ccg-text-only > AssistantMarkdown root > body > .markdown > 首尾块），
				   保证 折叠栏→正文 = 16px、正文→下一元素 = 16px，不随官方版本漂移。 */
				".ccg-text-only{padding:16px 0 0}",
				".ccg-text-only>*>*>*>:first-child{margin-top:0!important}",
				".ccg-text-only>*>*>*>:last-child{margin-bottom:0!important}",
				/* 最终总结正文同理：think 行隐藏后首块即正文，p 的上下 margin 会额外叠加
				   （分隔线→正文应为本插件设计的 8px；展开回合内 上一成员→正文 = 官方 16px gap） */
				"[data-ccg-turn-folded]>*>*>*>:first-child{margin-top:0!important}",
				"[data-ccg-turn-folded]>*>*>*>:last-child{margin-bottom:0!important}",
				/* 一次性更新说明通知：右下角浮动卡片（独立于折叠样式，自成一类 ccg-notice） */
				".ccg-notice{position:fixed;right:16px;bottom:16px;z-index:9999;max-width:360px;max-height:70vh;overflow-y:auto;background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:12px 14px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f2328);animation:ccg-notice-in .24s ease-out}",
				".ccg-notice-title{font-weight:600;margin-bottom:8px}",
				".ccg-notice-body{display:flex;flex-direction:column;opacity:.92}",
				/* 版本小节：版本号胶囊标签 + 说明文字并排，区块之间用间距分隔 */
				".ccg-notice-sec + .ccg-notice-sec{margin-top:12px}",
				".ccg-notice-sec-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;min-width:0}",
				".ccg-notice-ver{flex:none;background:var(--dsw-alias-bg-layer-3,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:999px;padding:1px 9px;font-size:11px;font-weight:600;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280)}",
				".ccg-notice-ver-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				/* 条目列表：自定义圆点 + 悬挂缩进（换行对齐），拉开条目间距 */
				".ccg-notice-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}",
				".ccg-notice-list li{position:relative;margin:0;padding:0 0 0 14px;color:var(--dsw-alias-label-secondary,#6b7280)}",
				".ccg-notice-list li strong{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-notice-list li::before{content:\"\";position:absolute;left:1px;top:8px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9ca3af)}",
				".ccg-notice-hint{font-size:12px;opacity:.6;margin:6px 0 0}",
				/* 兜底按钮（平台 Button 缺失时）：用官方 button-primary token 对，暗色主题下
				   自动变浅底深字，而不是写死的品牌色+白字 */
				".ccg-notice-btn{display:block;margin:8px 0 0 auto;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f6ef7));color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:14px;padding:4px 12px;font-size:12px;line-height:18px;cursor:pointer}",
				".ccg-notice-btn:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4f6ef7))}",
				/* 平台 Button 路径：只补右对齐与上间距，颜色/圆角由官方 primary/sm 类负责 */
				".ccg-notice-btn-plat{display:block;margin:8px 0 0 auto}",
				"@keyframes ccg-notice-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}",
				"@media (prefers-reduced-motion:reduce){.ccg-notice{animation:none!important}}",
				/* 回合折叠栏字段设置齿轮图标：悬停向右旋转（90° 半圈，再松开回位） */
				".ccg-gear-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;margin-left:2px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#9ca3af);border-radius:4px;transition:color .15s ease}",
				".ccg-gear-icon:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
				".ccg-gear-icon svg{transition:transform .45s cubic-bezier(.22,1,.36,1)}",
				".ccg-gear-icon:hover svg{transform:rotate(90deg)}",
				"@media (prefers-reduced-motion:reduce){.ccg-gear-icon svg{transition:none!important}}",
				/* 字段设置弹窗：半透明遮罩 + 居中卡片，checkbox 逐字段开关 */
				".ccg-gear-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);animation:ccg-gear-fade .15s ease-out}",
				".ccg-gear-popup{background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:16px 18px;min-width:320px;max-width:400px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}",
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
				/* 折叠图标选择器：分隔线 + 标签 + 两行选项（每行预览图标 + 文字） */
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
				/* 预览组：右侧横排一列展示所有存在的图标状态 */
				".ccg-gear-icon-option-preview{flex:none;display:flex;align-items:center;gap:3px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				".ccg-gear-icon-option-preview-item{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:24px}",
				/* 预览里的扑克牌组件（原生 24px SVG）缩到 20px 适配预览项 */
				".ccg-gear-icon-option-preview-item svg{width:20px;height:20px}",
				".ccg-gear-icon-option-preview-item .ccg-poker-icon{width:20px;height:20px}",
				/* 预览放大气泡：悬浮预览图标时在其上方弹出放大版预览（2x），
				   底部尖尖指向原预览图。定位用 absolute 锚定预览项。 */
				".ccg-preview-tooltip{position:relative;display:inline-flex}",
				/* 气泡初始状态：隐藏 + 下移 3px（进场微动效） */
				".ccg-preview-bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(3px);z-index:11000;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .12s ease,transform .12s ease}",
				".ccg-preview-tooltip:hover .ccg-preview-bubble,.ccg-preview-tooltip:focus-within .ccg-preview-bubble{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}",
				/* 气泡卡片：圆角 + 阴影，内放放大图标 */
				".ccg-preview-bubble-body{background:var(--dsw-alias-bg-layer-2,#ffffff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:14px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#9ca3af)}",
				/* 放大图标 4x 显示：气泡内直接 src 元素 80px 矢量放大 */
				".ccg-preview-bubble-body svg{width:80px;height:80px;display:block}",
				".ccg-preview-bubble-body .ccg-poker-icon{width:80px;height:80px}",
				"@media (prefers-reduced-motion:reduce){.ccg-preview-bubble{transition:none!important}}",
				"@keyframes ccg-gear-fade{from{opacity:0}to{opacity:1}}",
				"@media (prefers-reduced-motion:reduce){.ccg-gear-overlay{animation:none!important}}",
				/* 设置 → 对话 → 回合折叠方式 行（shadow 官方 transcript-view 行）*/
				/* 样式与官方 TranscriptViewRow.module.css 逐像素一致：无描边、18px 胶囊、
				   平台模块背景、hover 交互高亮 */
				".ccg-settings-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
				".ccg-settings-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}",
				".ccg-settings-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}",
				".ccg-settings-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
				".ccg-settings-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}",
				".ccg-settings-selector:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".ccg-settings-selector-chevron{flex:none}",
				/* 设置行选项自定义 tooltip：即时响应（原生 title 有 ~1s 延迟） */
				".ccg-settings-tip{position:fixed;z-index:2147483000;max-width:220px;padding:6px 10px;border-radius:8px;background:var(--dsw-specific-menu,#1f2937);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;box-shadow:var(--dsw-shadow-lv3);pointer-events:none;white-space:normal;word-break:break-word}"
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
		// 回合进行中：回合折叠栏在回复开始就出现，默认展开；回合结束后整回合收成一个
		// 回合折叠栏，默认折叠；点击回合折叠栏展开/收起。手动选择永久记忆（三态：null=未干预）。
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

		// ---- 回合折叠栏字段显隐设置（模块级，全局共享） ----
		// 齿轮弹窗里逐字段开关，决定回合折叠栏标题显示哪些指标。字段键：
		//   duration / ttft / tokens / tokensPerSecond / cacheHit / folded。
		// 用版本号驱动重渲染（useSyncExternalStore 订阅）：改动后所有回合折叠栏
		// 立即按新设置重算文案。
		var FIELD_KEYS = ["duration", "ttft", "tokens", "tokensPerSecond", "cacheHit", "folded"];
		var defaultFieldVisibility = { duration: true, ttft: true, tokens: true, tokensPerSecond: true, cacheHit: true, folded: true };
		var fieldVisibility = Object.assign({}, defaultFieldVisibility);
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
			if (!fieldVisibility.hasOwnProperty(key)) return;
			if (fieldVisibility[key] === !!visible) return;
			fieldVisibility[key] = !!visible;
			notifyFieldVisibility();
		}
		/** 弹窗中逐字段开关（checkbox 双向绑定用）。 */
		function useFieldVisibility() {
			useSyncExternalStore(subscribeFieldVisibility, getFieldVisibilityVersion);
			return fieldVisibility;
		}
		/** 按当前字段显隐设置过滤指标对象：隐藏的字段从 metrics 里剔除，
		 *  turnHeaderLabel 据此不渲染对应文案。全部隐藏时返回原对象（fallback 文案兜底）。 */
		function filterVisibleMetrics(metrics) {
			if (!metrics) return metrics;
			var result = null;
			if (metrics.durationMs !== undefined && fieldVisibility.duration) {
				result = result || {};
				result.durationMs = metrics.durationMs;
			}
			if (metrics.ttftMs !== undefined && fieldVisibility.ttft) {
				result = result || {};
				result.ttftMs = metrics.ttftMs;
			}
			if (metrics.tokens !== undefined && fieldVisibility.tokens) {
				result = result || {};
				result.tokens = metrics.tokens;
			}
			if (metrics.tokensPerSecond !== undefined && fieldVisibility.tokensPerSecond) {
				result = result || {};
				result.tokensPerSecond = metrics.tokensPerSecond;
			}
			if (metrics.cacheHitPercent !== undefined && fieldVisibility.cacheHit) {
				result = result || {};
				result.cacheHitPercent = metrics.cacheHitPercent;
			}
			if (metrics.foldedRows !== undefined && fieldVisibility.folded) {
				result = result || {};
				result.foldedRows = metrics.foldedRows;
			}
			if (metrics.outputTokens !== undefined) {
				result = result || {};
				result.outputTokens = metrics.outputTokens;
			}
			return result ? result : metrics;
		}

		// ---- 字段设置弹窗可见状态（模块级；全局一个弹窗） ----
		var popupVisible = false;
		var popupListeners = new Set();
		function subscribePopup(fn) { popupListeners.add(fn); return function () { popupListeners.delete(fn); }; }
		function notifyPopup() {
			var fns = [];
			popupListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function setPopupVisible(v) {
			if (popupVisible === v) return;
			popupVisible = v;
			notifyPopup();
		}
		function getPopupVisible() { return popupVisible; }

		// ---- 折叠接管模式（模块级，全局共享） ----
		// DSH 0.1.2+ 官方自带"回合折叠方式"设置（normal/compact）。插件新增
		// "turn-fold" 选项：本插件接管全部折叠（官方 transcriptView 置为 normal，
		// 避免双重折叠）。mode="auto" 时插件不折叠，原样委托内置渲染，完全跟随
		// 官方设置。持久化到 localStorage，默认 "turn-fold"（保持历史行为）。
		var FOLD_MODE_KEY = "dsh-turn-fold:fold-mode";
		var foldMode = "turn-fold";
		var foldModeListeners = new Set();
		var foldModeVersion = 0;
		function subscribeFoldMode(fn) {
			foldModeListeners.add(fn);
			return function () { foldModeListeners.delete(fn); };
		}
		function notifyFoldMode() {
			foldModeVersion++;
			var fns = [];
			foldModeListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function loadFoldMode() {
			try {
				var raw = (typeof window !== "undefined" && window.localStorage && window.localStorage.getItem(FOLD_MODE_KEY)) || "";
				if (raw === "turn-fold" || raw === "auto") foldMode = raw;
			} catch (e) { /* 忽略 */ }
		}
		function setFoldMode(mode) {
			if (mode !== "turn-fold" && mode !== "auto") return;
			if (foldMode === mode) return;
			foldMode = mode;
			try { (typeof window !== "undefined" && window.localStorage) && window.localStorage.setItem(FOLD_MODE_KEY, mode); } catch (e) { /* 忽略 */ }
			notifyFoldMode();
		}
		function getFoldMode() { return foldMode; }
		/** 订阅折叠接管模式变化（组件内调用以触发重渲染）。 */
		function useFoldMode() {
			useSyncExternalStore(subscribeFoldMode, function () { return foldModeVersion; });
			return foldMode;
		}
		/** 本插件当前是否应接管折叠（turn-fold 模式）。 */
		function foldActive() { return foldMode === "turn-fold"; }
		loadFoldMode();

		// ---- 设置行选项悬浮提示（自定义 tooltip，即时响应）----
		// 原生 title 的 ~1s 延迟是浏览器控制的无法缩短，改为模块级 tooltip store +
		// 常驻组件：mouseenter 立即显示（定位在选项行旁）、mouseleave 立即消失。
		var settingsTip = null; // { text, left, top }
		var settingsTipListeners = new Set();
		function subscribeSettingsTip(fn) {
			settingsTipListeners.add(fn);
			return function () { settingsTipListeners.delete(fn); };
		}
		function getSettingsTip() { return settingsTip; }
		function showSettingsTip(text, rect) {
			if (!text || !rect) return;
			var gap = 8;
			var left = rect.right + gap;
			var top = rect.top + rect.height / 2;
			// 防溢出：右侧放不下则放左侧；垂直居中
			if (typeof window !== "undefined" && window.innerWidth && left + 220 > window.innerWidth) {
				left = rect.left - gap - 220;
				if (left < 8) left = 8;
			}
			if (typeof window !== "undefined" && window.innerHeight && top - 30 < 0) top = 30;
			settingsTip = { text: text, left: left, top: top };
			var fns = [];
			settingsTipListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function hideSettingsTip() {
			if (settingsTip === null) return;
			settingsTip = null;
			var fns = [];
			settingsTipListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		/** 常驻 tooltip：独立根渲染，fixed 定位跟随选项行。 */
		function SettingsTip() {
			var tip = useSyncExternalStore(subscribeSettingsTip, getSettingsTip);
			if (!tip) return null;
			return react.createElement(
				"div",
				{
					className: "ccg-settings-tip",
					style: { left: tip.left + "px", top: tip.top + "px" },
					role: "tooltip"
				},
				tip.text
			);
		}

		// ---- 折叠图标样式设置（模块级，全局共享） ----
		// 齿轮弹窗里下拉选择：poker（动态扑克牌，默认，当前行为）或 default（官方 chevron）。
		// 用版本号驱动重渲染：改动后所有步骤/回合折叠栏按新样式重渲染前导图标。
		var FOLD_ICON_STYLES = ["poker", "default"];
		var foldIconStyle = "poker";
		var foldIconListeners = new Set();
		var foldIconVersion = 0;
		function subscribeFoldIcon(fn) {
			foldIconListeners.add(fn);
			return function () { foldIconListeners.delete(fn); };
		}
		function notifyFoldIcon() {
			foldIconVersion++;
			var fns = [];
			foldIconListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function getFoldIconVersion() { return foldIconVersion; }
		function setFoldIconStyle(style) {
			if (FOLD_ICON_STYLES.indexOf(style) === -1) return;
			if (foldIconStyle === style) return;
			foldIconStyle = style;
			notifyFoldIcon();
		}
		function getFoldIconStyle() { return foldIconStyle; }
		/** 订阅折叠图标样式变化（组件内调用以触发重渲染）。 */
		function useFoldIconStyle() {
			useSyncExternalStore(subscribeFoldIcon, getFoldIconVersion);
			return foldIconStyle;
		}

		// ---- 实时直播时钟（回合运行中，回合折叠栏指标按随机间隔刷新） ----
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
		// 内置组件缺失时只警告一次（按 kind）：DSH 升级若改变内置条目的 key/priority 约定，
		// 委托渲染会拿不到组件、节点静默空白——留一条日志便于排查。
		var builtinWarned = {};
		function builtinComponent(kind) {
			if (!slotsService) return undefined;
			var entries = slotsService.entries("conversation.chat.node");
			for (var i = 0; i < entries.length; i++) {
				var e = entries[i];
				if (e.options && e.options.key === kind && (e.options.priority || 0) === 0) return e.component;
			}
			if (!builtinWarned[kind]) {
				builtinWarned[kind] = true;
				try {
					if (typeof console !== "undefined" && console.warn) {
						console.warn('[dsh-turn-fold] builtin renderer for conversation.chat.node key "' + kind +
							'" (priority 0) not found — delegated rendering will be empty; DSH UI contract may have changed.');
					}
				} catch (e) { /* 忽略 */ }
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
		 *  text 放在同一 assistant-step 的 blocks 里；think 部分收进步骤折叠栏，text 部分在
		 *  段外单独渲染保持可见）。 */
		function isThinkNode(node) {
			return hasReasoning(node);
		}
		/** 工具调用名（已结算/运行中统一取）：无则空串。 */
		function toolCallName(node) {
			if (!node || node.kind !== "tool-call" || !node.data) return "";
			var root = node.data.root;
			if (!root) return "";
			if ("kind" in root) {
				var call = root.call || root;
				return call.name || "";
			}
			return root.name || "";
		}
		/** 是否排除在步骤折叠栏之外的工具（CONFIG.excludedSegmentTools 精确匹配，小写）。 */
		function isExcludedSegmentTool(node) {
			var name = toolCallName(node).toLowerCase();
			var list = CONFIG.excludedSegmentTools;
			for (var i = 0; i < list.length; i++) {
				if (name === list[i]) return true;
			}
			return false;
		}
		/** 段成员：tool-call（排除工具除外）或含 reasoning 的 assistant-step
		 *  （两个 text 之间的内容都入段）。 */
		function isSegmentMember(node) {
			if (!node) return false;
			if (node.kind === "tool-call") return !isExcludedSegmentTool(node);
			return node.kind === "assistant-step" && isThinkNode(node);
		}
		/** 拼接节点的 reasoning 块文本（步骤折叠栏运行中显示 think 内容用）。 */
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
		// ---- 官方 diff hunks 读取链（双版本兼容，对应 dsh-client-ui-tool 的 diffCardModel） ----
		// 官方各版本把 diff 数据放在不同位置，hunk 形状 {path, oldText, newText}（oldText 可为
		// null，与官方 narrowDiffs 同构）。读到合法数组原样返回；缺失/不合法返回 undefined，
		// 上层走 argsRaw 解析兜底。
		//   - 0.1.1：wire 渲染意图——运行中 callView.diffs、结算后 resultView.diffs
		//     （card === "diff" 的视图才携带，结算侧权威）；
		//   - 0.1.2：结算 metadata root.meta.diffs（官方 appliedDiffs）。
		function validDiffHunks(raw) {
			if (!Array.isArray(raw) || raw.length === 0) return undefined;
			for (var vdi = 0; vdi < raw.length; vdi++) {
				var h = raw[vdi];
				if (!h || typeof h !== "object" || Array.isArray(h)) return undefined;
				if (typeof h.newText !== "string" && typeof h.oldText !== "string") return undefined;
			}
			return raw;
		}
		/** wire 渲染意图视图（0.1.1 的 callView/resultView）里的 diffs。 */
		function viewDiffs(view) {
			return view && view.card === "diff" ? validDiffHunks(view.diffs) : undefined;
		}
		/** 已结算 tool-result 的官方 diffs：0.1.2 meta.diffs 优先（结算侧权威），0.1.1
		 *  resultView.diffs 次之、callView.diffs 兜底，直接挂 call/root 上的旧数据最后兜底。 */
		function settledToolDiffs(root) {
			var meta = root.meta;
			if (meta && typeof meta === "object" && !Array.isArray(meta) && Array.isArray(meta.diffs)) {
				// 空数组 = 官方语义 "empty"（无实际变更）：不返回，交给 argsRaw 兜底
				return meta.diffs.length > 0 ? validDiffHunks(meta.diffs) : undefined;
			}
			return viewDiffs(root.resultView) || viewDiffs(root.callView) ||
				validDiffHunks(root.call && root.call.diffs) || validDiffHunks(root.diffs);
		}
		/** 运行中 tool call 的官方 diffs：仅 0.1.1 callView.diffs（意图 diff）可提供。 */
		function runningToolDiffs(root) {
			return viewDiffs(root.callView) || validDiffHunks(root.diffs);
		}
		/** 工具调用信息：名称 / 原始参数 JSON / 官方 diff 数据 / 是否仍在运行。 */
		function toolCallInfo(node) {
			var root = node && node.data && node.data.root;
			if (!root) return null;
			if ("kind" in root) {
				// 已结算：root.kind === "tool-result"，call 字段携带 name/argsRaw
				//（diffs 不在 call 上，按版本从 meta/resultView/callView 读取，见 settledToolDiffs）
				var call = root.call || root;
				return { name: call.name, argsRaw: call.argsRaw, diffs: settledToolDiffs(root), running: false };
			}
			// 运行中（in-flight）：root 就是调用本身
			return { name: root.name, argsRaw: root.argsRaw, diffs: runningToolDiffs(root), running: true };
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
		 * 计算本节点所属的"步骤分组"：
		 *   - 段 = 两个 text 之间的所有内容（tool-call + 含 reasoning 的 assistant-step
		 *     混排成一段；think 不打断段，text 是段边界）。含 think+text 的同一节点是
		 *     段的"收尾成员"：think 部分入段，text 部分使段闭合（text 正文在段外单独
		 *     渲染保持始终可见）。
		 *   - leader = 段内第一个节点（只有 leader 渲染步骤折叠栏）。
		 *   - 步骤折叠始终默认收起（autoCollapsed 恒 true）；运行中（textAfter=false）
		 *     步骤折叠栏动态显示"正在运行 Xxx · 描述 / 正在思考 · 内容"，出现下一个 text
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
			var thinkCount = 0;
			var failures = 0;
			var anyRunning = false;
			var segHasText = false;
			for (var m = 0; m < keys.length; m++) {
				var n = nodes.get(keys[m]);
				if (!n) continue;
				if (hasText(n)) segHasText = true;
				if (n.kind === "assistant-step" && isThinkNode(n)) thinkCount++;
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
				thinkCount: thinkCount,
				failures: failures,
				anyRunning: anyRunning,
				textAfter: textAfter,
				// 运行中步骤折叠栏标题取段内最后一个节点（当前正在执行的工具 / 思考内容）
				lastActiveKey: keys[keys.length - 1],
				// 步骤折叠始终默认收起（含 think+text 节点的 text 正文在段外单独渲染）
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
		 * 计算"整回合折叠"信息：把本回合所有 Think + 工具调用 + 上下文注入收成一个回合折叠栏。
		 * 运行中的回合同样成立（回合折叠栏在回复开始就出现、默认展开），只保留最终总结消息
		 * （+官方 turn-tail 脚注）可见发生在回合结束后（默认收起）。
		 *   - closed：回合是否已结束（turnEnds 里有记录，turn/end 事件驱动）。
		 *   - toolCount：回合内工具调用总数（回合折叠栏文案"运行了 N 条命令"的 N）。
		 *   - finalAssistantKey：回合结束后回合内最后一条 assistant-step（最终总结，绝不
		 *     折叠）；运行中的回合为 null——当前流式消息只是"最后一条中间节点"，同样可以
		 *     作为回合折叠栏锚点，保证回合折叠栏从回复第一条内容起就出现。
		 *   - headerKey：回合内第一条"中间节点"（tool-call / context / 非最终 assistant-step），由它渲染回合折叠栏。
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
			// 它同样可以作为回合折叠栏锚点（回复开始即出现回合折叠栏），不豁免于折叠栏候选。
			if (!closed) finalAssistantKey = null;
			// 折叠作用域 = (最后一个 user 节点, 当前 agent 回合]：
			// DSH 会把上下文注入（source 非 user 的 user/message 事件，如批准
			// 策略 / 权限 / skills 提醒）排到用户首条消息之前（anchorSeq 更小）。
			// 整回合折叠只能折叠"用户消息之后"的内容——锚定在最后一个 user 节点
			// 之前（含）的节点（如审批策略变更通知）不属于本回合的输出区间，
			// 绝不参与折叠、也绝不作折叠栏候选，否则回合折叠栏会"跨过"用户消息去折叠
			// 其上方的内容，破坏"折叠 = 收起用户消息与 agent 回复之间内容"的语义。
			var lastUserSeq = -1;
			for (var u = 0; u < keys.length; u++) {
				var un = nodes.get(keys[u]);
				if (un && un.kind === "user" && typeof un.anchorSeq === "number" && un.anchorSeq > lastUserSeq) lastUserSeq = un.anchorSeq;
			}
			// 已折叠行数：回合折叠栏收纳的内容行数 = 折叠作用域内（最后一个 user 节点之后）
			// 的中间节点数（tool-call / assistant-step / context），不含最终总结消息——
			// 回合结束后最终回复正文始终可见（data-ccg-turn-folded 包裹），不算折叠行。
			// 运行中回合 finalAssistantKey 为 null，最后一条流式 assistant-step 计入；
			// 回合结束后它成为 finalAssistantKey 被剔除（已折叠5行 → 已折叠4行）。
			var foldedRows = 0;
			for (var f = 0; f < keys.length; f++) {
				var fn = nodes.get(keys[f]);
				if (!fn || !(fn.kind === "tool-call" || fn.kind === "assistant-step" || fn.kind === "context")) continue;
				if (keys[f] === finalAssistantKey) continue;
				if (lastUserSeq >= 0 && typeof fn.anchorSeq === "number" && fn.anchorSeq <= lastUserSeq) continue;
				foldedRows++;
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
				// 折叠栏必须锚定在用户消息之后（anchorSeq > lastUserSeq）；
				// assistant-step / tool-call 在 settle 后必然位于用户消息之后。
				if (lastUserSeq >= 0 && typeof node.anchorSeq === "number" && node.anchorSeq <= lastUserSeq) continue;
				headerKey = key;
				break;
			}
			// 单节点回合（user + 唯一 assistant-step）：该节点既是最终总结又是唯一折叠栏候选，
			// 上面的循环因跳过 finalAssistantKey 而得不到 headerKey——此时用 finalAssistantKey
			// 兜底，保证这类纯问答回合同样生成回合折叠栏。
			if (headerKey === null && finalAssistantKey !== null) {
				headerKey = finalAssistantKey;
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
				foldedRows: foldedRows,
				headerKey: headerKey,
				finalAssistantKey: finalAssistantKey,
				ourKey: ourKey,
				outsideScope: outsideScope,
				turnStatus: turnStatus,
				// 只有能同时定位到"自己的 key"和"作用域内的折叠栏"时才允许折叠。
				// 运行中：finalAssistantKey 为 null（当前流式消息也是折叠栏候选），
				// 只要 headerKey 存在即可折叠。回合结束后额外要求 finalAssistantKey
				// 存在，避免 turn/end 与最终消息索引的瞬时竞态导致最终消息被误隐藏。
				foldable: ourKey !== null && headerKey !== null && (closed ? finalAssistantKey !== null : true),
				isTurnHeader: ourKey !== null && ourKey === headerKey,
				isFinalAssistant: ourKey !== null && finalAssistantKey !== null && ourKey === finalAssistantKey
			};
		}

		// ---- 回合性能指标（回合折叠栏文案） ----
		/** 缓存命中率：固定两位小数（如 "66.67"、"99.99"、"100.00"），比官方
		 *  仅接近 100% 才提精度的方案更高；无可计费输入返回 null。 */
		function cacheHitPercent(uncachedInputTokens, cacheReadTokens, cacheWriteTokens) {
			var denominator = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
			if (denominator === 0) return null;
			return (cacheReadTokens / denominator * 100).toFixed(2);
		}
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
			var tokensPerSecond, ttftMs;
			// 官方 TTFT（deriveTurnMetrics 同款语义）：回合结束后的 turn-tail 聚合值优先；
			// 回合未结束时，从已 settle 的 assistant-step 的 data.finalNode.timing 实时读取
			// ——官方在 step settle（assistant/message）后把 timing 写入 finalNode
			// （{ stepStartTime, firstTokenTime, completedTime }；中断的 step 无 timing），
			// 取 step 号最小者（第一个请求）的 firstTokenTime - stepStartTime。
			var liveTtft = null;
			var liveFirstStep = Infinity;
			for (var i = 0; i < keys.length; i++) {
				var n = nodes.get(keys[i]);
				if (!n) continue;
				if (n.kind === "assistant-step" && n.data) {
					if (n.data.usage) {
						var u = n.data.usage;
						if (typeof u.inputTokens === "number" && isFinite(u.inputTokens)) input += u.inputTokens;
						if (typeof u.outputTokens === "number" && isFinite(u.outputTokens)) output += u.outputTokens;
						if (typeof u.cacheReadTokens === "number" && isFinite(u.cacheReadTokens)) cacheRead += u.cacheReadTokens;
						if (typeof u.cacheWriteTokens === "number" && isFinite(u.cacheWriteTokens)) cacheWrite += u.cacheWriteTokens;
					}
					var fn = n.data.finalNode;
					var timing = fn && fn.timing;
					if (timing && typeof timing.stepStartTime === "number" && typeof timing.firstTokenTime === "number") {
						var stepNum = typeof fn.step === "number" ? fn.step
							: (typeof n.data.step === "number" ? n.data.step : (typeof n.step === "number" ? n.step : -1));
						if (stepNum < liveFirstStep) {
							liveFirstStep = stepNum;
							liveTtft = Math.max(0, timing.firstTokenTime - timing.stepStartTime);
						}
					}
				} else if (n.kind === "turn-tail" && n.data) {
					// 官方 turn-tail 节点携带权威的 tok/s 与 ttftMs（该回合第一个 step 的
					// firstTokenTime - stepStartTime，来自持久化事件日志，刷新页面不丢）。
					if (typeof n.data.tokensPerSecond === "number") tokensPerSecond = n.data.tokensPerSecond;
					if (typeof n.data.ttftMs === "number") ttftMs = n.data.ttftMs;
				}
			}
			// 回合未结束（turn-tail 未出现）时用 finalNode.timing 实时值
			if (ttftMs === undefined && liveTtft !== null) ttftMs = liveTtft;
			var billedInput = input + cacheRead + cacheWrite;
			var hasUsage = billedInput > 0 || output > 0;
			// 运行中（liveNow 存在）且官方 turn-tail 未给出 tok/s 时：
			// 按"已输出 token / 已耗时"实时估算（耗时 >=1s 且已有输出才显示，避免
			// 开场瞬间的巨大瞬时速率；回合结束后由 turn-tail 的权威值覆盖）。
			if (tokensPerSecond === undefined && typeof liveNow === "number" && durationMs !== undefined && durationMs >= 1000 && output > 0) {
				tokensPerSecond = output / (durationMs / 1000);
			}
			if (durationMs === undefined && !hasUsage && tokensPerSecond === undefined) return null;
			var metricsResult = {
				durationMs: durationMs,
				// 消耗 = 计费输入（uncached + cacheRead + cacheWrite）+ 输出
				tokens: hasUsage ? (billedInput + output) : undefined,
				// 输出 token 累计（tok/s 实时估算用）
				outputTokens: hasUsage ? output : undefined,
				tokensPerSecond: tokensPerSecond,
				// 缓存命中率：固定两位小数（如 "66.67"、"99.99"）
				cacheHitPercent: hasUsage && billedInput > 0 ? cacheHitPercent(input, cacheRead, cacheWrite) : undefined
			};
			// TTFT（官方 turn-tail 值，单回合第一个 step 的 firstTokenTime - stepStartTime）
			if (ttftMs !== undefined) metricsResult.ttftMs = ttftMs;
			return metricsResult;
		}

		/** TTFT（首字延迟，毫秒）：回合启动（turnTimings.startTime）到第一个 response
		 *  （首个 assistant-step 渲染时刻）的近似值，由组件渲染期同步冻结记录。
		 *  会话快照不提供官方 timing 数据，这是插件的自测近似（误差约一帧渲染延迟）。
		 *  记录幂等（has 检查），StrictMode 双调用/渲染中断重试均无害。 */
		var ttftCache = new Map();
		function recordTtft(sessionId, turn, closed, turnTimings) {
			if (closed || turn === undefined) return;
			var key = sessionId + "::" + turn;
			if (ttftCache.has(key)) return;
			var timing = turnTimings && typeof turnTimings.get === "function" ? turnTimings.get(turn) : null;
			if (timing && typeof timing.startTime === "number") {
				ttftCache.set(key, Math.max(0, Date.now() - timing.startTime));
			}
		}
		/** 会话切换时清理计算缓存与手动状态（保留 ttftCache）。
		 *
		 *  清理：
		 *  - segmentLabelCache：整体清空（key 不含 sessionId；每段一条标题字符串，
		 *    长会话可达数百 KB，是唯一有量级的计算缓存）；
		 *  - liveTokenCache：按 sessionId 前缀清（每回合 1-2 条，无可见差异）；
		 *  - overrides / turnOverrides（手动展开状态）：清空后回到自动规则
		 *    （已结束回合默认收起、运行中默认展开）。
		 *  保留：ttftCache（每回合一个毫秒数字，几百轮也只有几十 KB，不值得清）。
		 *  由各 Grouped 视图渲染开头调用（幂等：仅 sessionId 变化时执行一次）。
		 */
		var trackedSession = null;
		function trackSession(sessionId) {
			if (sessionId === undefined || sessionId === null || sessionId === trackedSession) return;
			var prev = trackedSession;
			trackedSession = sessionId;
			if (prev === null) return; // 首次调用（无前一会话）不清理
			// 清理计算缓存与手动状态
			if (liveTokenCache.size > 0) {
				var prefix = prev + "::";
				liveTokenCache.forEach(function (v, k) { if (k.indexOf(prefix) === 0) liveTokenCache.delete(k); });
			}
			segmentLabelCache.clear();
			segmentFilePathsCache.clear();
			foldSuitMap.clear();
			overrides.clear();
			turnOverrides.clear();
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
		/** 回合折叠栏展示指标：运行中把"消耗token"按动画节奏持续增长（真实 usage 到达时校正基线）。
		 *  兜底：回合运行中但尚无任何 usage（第一条 response 到达前/首节点无 usage）时，
		 *  token 从 0 按同一动画节奏增长——"第一个 response 就出现 token"；
		 *  真实 usage 到达后用独立缓存 key 切换，直接以真实值为基线。 */
		function turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow) {
			if (!metrics || closed || typeof liveNow !== "number" || turn === undefined) return metrics;
			var key = sessionId + "::" + turn;
			if (typeof metrics.tokens !== "number") {
				// 无 usage 兜底：独立 key（与真实值缓存隔离），基线 0 开始动画增长
				var projected = projectLiveTokens(key + ":pending", 0, undefined, liveNow, undefined);
				if (projected === 0) return metrics;
				return {
					durationMs: metrics.durationMs,
					tokens: projected,
					outputTokens: undefined,
					tokensPerSecond: undefined,
					cacheHitPercent: undefined,
					ttftMs: metrics.ttftMs
				};
			}
			var projected = projectLiveTokens(key, metrics.tokens, metrics.outputTokens, liveNow, metrics.tokensPerSecond);
			if (projected === metrics.tokens) return metrics;
			return {
				durationMs: metrics.durationMs,
				tokens: projected,
				outputTokens: metrics.outputTokens,
				tokensPerSecond: metrics.tokensPerSecond,
				cacheHitPercent: metrics.cacheHitPercent,
				ttftMs: metrics.ttftMs
			};
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
		/** 回合折叠栏文案："耗时…，消耗…token，…tok/s，缓存命中…%"；无数据返回空串。 */
		function turnHeaderLabel(metrics, closed) {
			if (!metrics) return "";
			var parts = [];
			if (metrics.durationMs !== undefined) {
				if (currentLocale() === "zh") parts.push("耗时" + formatTurnDuration(metrics.durationMs));
				else parts.push(formatTurnDuration(metrics.durationMs));
			}
			if (metrics.ttftMs !== undefined) {
				// 首字（TTFT 近似）：秒为单位、一位小数（毫秒不直观）
				var ttftSec = (metrics.ttftMs / 1000).toFixed(1);
				if (currentLocale() === "zh") parts.push("首字" + ttftSec + "s");
				else parts.push("TTFT " + ttftSec + "s");
			}
			if (metrics.tokens !== undefined) {
				if (currentLocale() === "zh") parts.push("消耗" + metrics.tokens + "token");
				else parts.push(metrics.tokens + " tokens");
			}
			if (metrics.tokensPerSecond !== undefined) {
				if (currentLocale() === "zh") parts.push(formatTokPerSec(metrics.tokensPerSecond) + "tok/s");
				else parts.push(formatTokPerSec(metrics.tokensPerSecond) + " tok/s");
			}
			if (metrics.cacheHitPercent !== undefined) {
				if (currentLocale() === "zh") parts.push("缓存命中" + metrics.cacheHitPercent + "%");
				else parts.push("cache hit " + metrics.cacheHitPercent + "%");
			}
			// 已折叠步数：紧跟缓存命中之后、设置齿轮之前；仅 foldedRows>0 时显示
			//（上游只在 >0 时注入指标，这里再兜底一次，绝不出现"已折叠0步"）。
			// 运行中（closed=false）是"待折叠N步"（这些节点还没真正收起、回合结束时
			// 才折叠）；回合结束后（closed=true）才是"已折叠N步"。closed 缺省按
			// 已折叠处理（调用点全部显式传值，缺省只影响测试/边界）。
			var foldedPending = closed === false;
			if (metrics.foldedRows !== undefined && metrics.foldedRows > 0) {
				if (currentLocale() === "zh") parts.push((foldedPending ? "待折叠" : "已折叠") + metrics.foldedRows + "步");
				else parts.push((foldedPending ? "pending " : "folded ") + metrics.foldedRows + " steps");
			}
			return parts.join(" · ");
		}

		// ---- 回合状态标签 ----
		/** 已结束的回合在回合折叠栏前置状态文本（如"已完成 | 耗时…"、"已停止 | 耗时…"）。 */
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
			// 双版本兼容：DSH 0.1.2+ 用 useConnectionGeneration，旧版用 useHostDescription，
			// 哪个存在就透传哪个（内置 ToolCallTree 只消费当前版本存在的那一个）。
			if (kit.useHostDescription) props.useHostDescription = kit.useHostDescription;
			if (kit.useConnectionGeneration) props.useConnectionGeneration = kit.useConnectionGeneration;
			for (var k in owner) if (Object.prototype.hasOwnProperty.call(owner, k)) props[k] = owner[k];
			return react.createElement(Comp, props);
		}

		// 给内置 ToolCallTree 补齐 renderSlot（我们的 entry 无 children，拿不到原装 renderSlot）
		function renderBuiltinToolCall(props) {
			var Builtin = builtinComponent("tool-call");
			if (!Builtin) return null;
			// t 一律走 wrapLocaleT 包装：宿主 t 命名空间/词典错位时官方组件不再裸显 key
			var kit = {
				useSession: props.useSession,
				sessionId: props.sessionId,
				useSessions: props.useSessions,
				useProjection: props.useProjection,
				useWorkspaces: props.useWorkspaces,
				t: wrapLocaleT(props.t),
				useHostDescription: props.useHostDescription,
				useConnectionGeneration: props.useConnectionGeneration
			};
			var customRenderSlot = function (key, owner, options) {
				if (key !== "tool.call.toolview") return options && options.fallback ? options.fallback : null;
				return renderToolview(kit, owner, options.entryKey, options.fallback);
			};
			return react.createElement(Builtin, Object.assign({}, props, { renderSlot: customRenderSlot, t: wrapLocaleT(props.t) }));
		}

		// 内置 AssistantNodeView 无需 renderSlot（只用 useTurnData 等注入 props），原样转发即可。
		function renderBuiltinAssistant(props) {
			var Builtin = builtinComponent("assistant-step");
			if (!Builtin) return null;
			return react.createElement(Builtin, Object.assign({}, props, { t: wrapLocaleT(props.t) }));
		}

		// 内置 ContextMessageNodeView 同样无 renderSlot，原样转发即可。
		function renderBuiltinContext(props) {
			var Builtin = builtinComponent("context");
			if (!Builtin) return null;
			return react.createElement(Builtin, Object.assign({}, props, { t: wrapLocaleT(props.t) }));
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

		// ---- 滚轮数字（回合折叠栏直播指标的逐位滚动动画） ----
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

		// ---- 回合折叠栏"已折叠/待折叠N步"滚轮渲染 ----
		// 闭合（非直播）态下标题整体仍是纯文本，但折叠步数的数字用 RollDigit 滚动
		// 动画渲染（与直播态 AnimatedLabel 的数字风格一致）。只滚步数数字，其他指标
		// （耗时/token 等）保持静态文本——避免闭合时所有数字从 0 滚一遍。
		// 找不到折叠数字段时原样返回字符串（兜底，不破坏调用方对 string 的假设）。
		function FoldedRollLabel(props) {
			var label = props.label;
			var re = /((?:已折叠|待折叠)|(?:folded |pending ))(\d+)(步| steps)/;
			var m = re.exec(label);
			if (!m) return label;
			var kids = [];
			if (m.index > 0) {
				kids.push(react.createElement("span", { key: "pre", className: "ccg-roll-text" }, label.slice(0, m.index)));
			}
			kids.push(react.createElement("span", { key: "pref", className: "ccg-roll-text" }, m[1]));
			var digits = [];
			for (var i = 0; i < m[2].length; i++) {
				digits.push(react.createElement(RollDigit, { key: "d" + i, digit: Number(m[2].charAt(i)) }));
			}
			kids.push(react.createElement("span", { key: "num", className: "ccg-roll-num", "aria-hidden": "true" }, digits));
			kids.push(react.createElement("span", { key: "suff", className: "ccg-roll-text" }, m[3]));
			if (m.index + m[0].length < label.length) {
				kids.push(react.createElement("span", { key: "post", className: "ccg-roll-text" }, label.slice(m.index + m[0].length)));
			}
			return react.createElement(
				"span",
				{ className: "ccg-roll-label" },
				react.createElement("span", { className: "ccg-sr-only" }, label),
				kids
			);
		}

		/** 回合轮次文案：回合折叠栏最右侧右对齐显示（"第3轮" / "Turn 3"，官方用 turns 一词）。 */
		function turnRoundLabel(turn) {
			if (turn === undefined || turn === null) return "";
			return currentLocale() === "zh" ? "第" + turn + "轮" : "Turn " + turn;
		}

		// ---- 齿轮图标（字段设置弹窗触发器） ----
		// Material 风格齿轮 ⚙，14×14，悬停向右旋转 90°（.45s 缓动）。
		function GearIcon() {
			// 齿轮在 DisclosureRow（expandOnRowClick=true）的 title 区内：
			// 点击/键盘必须 stopPropagation，否则会冒泡到折叠栏行的 onToggle，
			// 把"弹窗"误触成"展开/折叠"。
			function openPopup(e) {
				if (e) {
					if (e.stopPropagation) e.stopPropagation();
					if (e.preventDefault) e.preventDefault();
				}
				setPopupVisible(true);
			}
			return react.createElement("span", {
				className: "ccg-gear-icon",
				onClick: openPopup,
				title: _T("fieldSettings"),
				role: "button",
				tabIndex: 0,
				"aria-label": _T("fieldSettings"),
				onKeyDown: function (e) {
					if (e.key === "Enter" || e.key === " ") { openPopup(e); }
				}
			},
				react.createElement("svg", { viewBox: "0 0 24 24", width: "14", height: "14", fill: "currentColor" },
					react.createElement("path", { d: "M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" })
				)
			);
		}

		// ---- 字段设置弹窗 ----
		// 全局弹窗：列出回合折叠栏所有可显字段，每行一个 checkbox（勾选=显示）。
		// 使用 useSyncExternalStore 订阅模块级 popupVisible 状态决定显隐。
		var FIELD_CONFIG = [
			{ key: "duration", labelKey: "fieldDuration", descKey: "fieldDurationDesc" },
			{ key: "ttft", labelKey: "fieldTtft", descKey: "fieldTtftDesc" },
			{ key: "tokens", labelKey: "fieldTokens", descKey: "fieldTokensDesc" },
			{ key: "tokensPerSecond", labelKey: "fieldTps", descKey: "fieldTpsDesc" },
			{ key: "cacheHit", labelKey: "fieldCacheHit", descKey: "fieldCacheHitDesc" },
			{ key: "folded", labelKey: "fieldFolded", descKey: "fieldFoldedDesc" }
		];
		/** 默认图标预览：官方 outline chevron（描边折线，非实心三角形）。
		 *  用 points 区分方向：右箭头 "5.5 3 9.5 7 5.5 11" / 下箭头 "3 5.5 7 9.5 11 5.5"。 */
		function DefaultChevronIcon(props) {
			return react.createElement("svg", {
				viewBox: "0 0 14 14",
				width: "14",
				height: "14",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "1.6",
				"stroke-linecap": "round",
				"stroke-linejoin": "round"
			},
				react.createElement("polyline", { points: props.points })
			);
		}
		/** 复制文本到剪贴板（navigator.clipboard 优先，兜底 textarea fallback）。 */
		function copyToClipboard(text) {
			if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
				navigator.clipboard.writeText(text).catch(function () { /* 静默 */ });
			} else {
				try {
					var ta = document.createElement("textarea");
					ta.value = text;
					ta.style.position = "fixed";
					ta.style.left = "-9999px";
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
				} catch (e) { /* 静默 */ }
			}
		}
		// ---- 全局 Toast 消息通知（共享官方 Toast 组件） ----
		// 模块级状态 + useSyncExternalStore 驱动，单例 TurnFoldToast 组件常驻渲染。
		// 不受 FieldVisibilityPopup 弹窗显隐影响，始终可用。
		var toastSnapshot = { seq: 0, text: null };
		var toastListeners = new Set();
		function subscribeToast(fn) { toastListeners.add(fn); return function () { toastListeners.delete(fn); }; }
		function notifyToast() {
			var fns = [];
			toastListeners.forEach(function (fn) { fns.push(fn); });
			for (var i = 0; i < fns.length; i++) fns[i]();
		}
		function getToast() { return toastSnapshot; }
		/** 触发 Toast 通知（文案自动消失，时长由官方 Toast 组件控制）。 */
		function showToast(text) {
			toastSnapshot = { seq: toastSnapshot.seq + 1, text: text };
			notifyToast();
		}
		/** 清除当前 Toast（官方 Toast 自动消失后调用）。 */
		function clearToast() {
			if (toastSnapshot.text === null) return;
			toastSnapshot = { seq: toastSnapshot.seq, text: null };
			notifyToast();
		}
		/** 全局 Toast 宿主：订阅 toastSnapshot，官方 Toast 组件渲染；平台缺失时静默返回 null。 */
		function TurnFoldToast() {
			var t = useSyncExternalStore(subscribeToast, getToast);
			if (Toast === null || !t || !t.text) return null;
			return react.createElement(Toast, {
				key: String(t.seq),
				text: t.text,
				onDone: function () { clearToast(); }
			});
		}
		/** 步骤折叠栏标题中的文件链接：点击复制绝对路径，悬停变 DeepSeek 主题蓝色。 */
		function FileLink(props) {
			var fullPath = props.path;
			var name = props.name;
			function doCopy(e) {
				if (e) {
					if (e.stopPropagation) e.stopPropagation();
					if (e.preventDefault) e.preventDefault();
				}
				copyToClipboard(fullPath);
				showToast(_T("fileCopiedToast"));
			}
			return react.createElement("span", {
				className: "ccg-file-link",
				title: fullPath,
				onClick: doCopy,
				role: "button",
				tabIndex: 0,
				onKeyDown: function (e) {
					if (e.key === "Enter" || e.key === " ") { doCopy(e); }
				}
			}, name);
		}
		/** 把标题字符串中的文件名（filePaths Map 的 key）替换为可点击复制的 FileLink 组件。
		 *  返回字符串（无匹配时）或 React 元素数组/Fragment。 */
		function renderTitleFileLinks(text, filePaths) {
			if (!text || !filePaths || filePaths.size === 0) return text;
			var hits = [];
			filePaths.forEach(function (fullPath, basename) {
				if (!basename) return;
				var from = 0, idx;
				while ((idx = text.indexOf(basename, from)) !== -1) {
					hits.push({ idx: idx, len: basename.length, basename: basename, fullPath: fullPath });
					from = idx + basename.length;
				}
			});
			if (hits.length === 0) return text;
			hits.sort(function (a, b) { return a.idx - b.idx; });
			var kids = [];
			var cursor = 0;
			for (var i = 0; i < hits.length; i++) {
				var h = hits[i];
				if (h.idx < cursor) continue;
				if (h.idx > cursor) kids.push(text.slice(cursor, h.idx));
				kids.push(react.createElement(FileLink, { key: "f" + i, name: h.basename, path: h.fullPath }));
				cursor = h.idx + h.len;
			}
			if (cursor < text.length) kids.push(text.slice(cursor));
			return kids.length === 1 ? kids[0] : react.createElement.apply(react, [react.Fragment, null].concat(kids));
		}
		/** 折叠图标选项列表：每行标题 + 描述在左，右侧横排展示该选项下所有存在的图标状态。
		 *  previews 是 function(tick)（FoldIconSelector 每秒 tick 一次驱动重渲染）：
		 *  poker：3牌折叠 / 3牌展开 / 5牌折叠 / 5牌展开（每秒按牌面池轮换，四花色 +
		 *  DeepSeek Logo，各预览相位错开 → 同一时刻恰好展示 4 种不同牌面）+
		 *  牌面翻转 / 牌面轮换（真实组件，动画照常播放）；
		 *  default：右箭头 / 下箭头（官方 outline chevron）。 */
		var FOLD_ICON_STATIC_FORMS = [
			{ count: 3, open: false },
			{ count: 3, open: true },
			{ count: 5, open: false },
			{ count: 5, open: true }
		];
		var FOLD_ICON_OPTIONS = [
			{
				value: "poker",
				labelKey: "foldIconPoker",
				descKey: "foldIconPokerDesc",
				previews: function (tick) {
					var pool = pokerFacePool();
					var items = [];
					for (var fi = 0; fi < FOLD_ICON_STATIC_FORMS.length; fi++) {
						var form = FOLD_ICON_STATIC_FORMS[fi];
						items.push(react.createElement(PokerIcon, {
							key: "s" + fi,
							count: form.count,
							suit: pool[(tick + fi) % pool.length],
							open: form.open
						}));
					}
					items.push(react.createElement(PokerSpinIcon, { key: "spin", open: true }));
					items.push(react.createElement(PokerAnimIcon, { key: "anim", open: false }));
					return items;
				}
			},
			{
				value: "default",
				labelKey: "foldIconDefault",
				descKey: "foldIconDefaultDesc",
				previews: function () {
					return [
						react.createElement(DefaultChevronIcon, { key: "right", points: "5.5 3 9.5 7 5.5 11" }),
						react.createElement(DefaultChevronIcon, { key: "down", points: "3 5.5 7 9.5 11 5.5" })
					];
				}
			}
		];
		function FoldIconSelector() {
			var current = useFoldIconStyle();
			// 静态牌堆/扇形预览的牌面轮播计时：每 1s tick 一次（仅弹窗挂载期间运行，
			// 卸载即清理）。tick 递增不取模，suit 取 pool[(tick+相位) % pool.length]。
			var tickState = react.useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];
			react.useEffect(function () {
				var timer = setInterval(function () { setTick(function (t) { return t + 1; }); }, 1000);
				// 测试/SSR 环境下 setInterval 返回 Node timer——unref 使其不挂住进程退出
				// （浏览器返回数字，无 unref，自动跳过）。
				if (timer && typeof timer.unref === "function") timer.unref();
				return function () { clearInterval(timer); };
			}, []);
			var opts = [];
			for (var oi = 0; oi < FOLD_ICON_OPTIONS.length; oi++) {
				var opt = FOLD_ICON_OPTIONS[oi];
				var selected = current === opt.value;
				var previewEls = opt.previews(tick);
				var previewItems = [];
				for (var pi = 0; pi < previewEls.length; pi++) {
					// 每个预览项外包一层 .ccg-preview-tooltip：悬浮时在其上方弹出放大
					// 气泡（.ccg-preview-bubble，2x 图标放大预览）。
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
					onClick: function (v) { return function () { setFoldIconStyle(v); }; }(opt.value),
					role: "radio",
					"aria-checked": selected ? "true" : "false",
					tabIndex: 0,
					onKeyDown: function (v) { return function (e) {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFoldIconStyle(v); }
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
				react.createElement("div", { className: "ccg-gear-icon-selector-label" }, _T("foldIconLabel")),
				opts
			);
		}
		function FieldVisibilityPopup() {
			// 注意 Hooks 顺序：useFieldVisibility() 必须在条件 return 之前调用——
			// 若放在 `if (!visible) return null;` 之后，首次渲染（隐藏）只调 1 个 hook，
			// 弹窗显示时调 2 个 hook，React 报 "Rendered more hooks..." 导致弹窗根崩溃。
			var visible = useSyncExternalStore(subscribePopup, getPopupVisible);
			var visibility = useFieldVisibility();
			if (!visible) return null;
			var fields = [];			for (var fi = 0; fi < FIELD_CONFIG.length; fi++) {
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
				onClick: function (e) { if (e.target === e.currentTarget) setPopupVisible(false); },
				role: "dialog",
				"aria-modal": "true",
				"aria-label": _T("fieldSettings")
			},
				react.createElement("div", { className: "ccg-gear-popup" },
					react.createElement("div", { className: "ccg-gear-popup-title" }, _T("fieldSettings")),
					react.createElement("div", { className: "ccg-gear-popup-hint" }, _T("fieldSettingsHint")),
					react.createElement("div", { className: "ccg-gear-popup-fields" }, fields),
					react.createElement("div", { className: "ccg-gear-divider", "aria-hidden": "true" }),
					react.createElement(FoldIconSelector, null),
					react.createElement("div", { className: "ccg-gear-popup-foot" },
						react.createElement("button", {
							className: "ccg-gear-popup-btn",
							type: "button",
							onClick: function () { setPopupVisible(false); }
						}, _T("fieldSettingsDone"))
					)
				)
			);
		}

		// ---- 折叠栏组件 ----
		// 优先用官方 DisclosureRow（24px 行高、16px 前导、14px 官方 chevron、14px/24px 标题），
		// 与 Think / 工具卡片的折叠行样式一致；平台原语缺失时回退到自带兜底行。
		// 无障碍：两种路径都带 aria-label / aria-expanded，键盘可操作。
		// live：运行中的回合折叠栏——标题里的数字用滚轮动画逐位滚动；回合结束后纯文本。
		/** 段闭合标题拆分：把"编辑了b.js [ +12 -3 ] 运行了pwsh —— 1条执行失败"拆成
		 *  { base, after, diff, failure }——diff（编辑行数变更）供悬停高亮并保留原始位置
		 *  （diff 只跟在编辑文件名后，后面可能还有"运行了pwsh"等片段），failure（失败提示）
		 *  恒在末尾、独立标红。格式由本插件自建（" [ +N -M ]" 与 failurePrefix），拆分可靠。 */
		function splitLabelParts(label) {
			var base = label, after = "", failure = null, diff = null;
			var fi = base.lastIndexOf(_T("failurePrefix"));
			if (fi !== -1) {
				failure = base.slice(fi);
				base = base.slice(0, fi);
			}
			var m = / \[ ([+-]\d+(?: [+-]\d+)?) \]/.exec(base);
			if (m) {
				var nums = m[1].match(/[+-]\d+/g) || [];
				var added = 0, removed = 0;
				for (var ni = 0; ni < nums.length; ni++) {
					if (nums[ni].charAt(0) === "+") added = parseInt(nums[ni].slice(1), 10);
					else removed = parseInt(nums[ni].slice(1), 10);
				}
				diff = { added: added, removed: removed };
				after = base.slice(m.index + m[0].length);
				base = base.slice(0, m.index);
			}
			return { base: base, after: after, diff: diff, failure: failure };
		}
		/** 编辑行数变更 [ +N -M ]：悬停括号范围时 +N 变绿、-N 变红（官方 success/error token）。 */
		function renderDiff(diff) {
			var kids = [" [ "];
			if (diff.added > 0) {
				kids.push(react.createElement("span", { key: "a", className: "ccg-diff-add" }, "+" + diff.added));
				if (diff.removed > 0) kids.push(" ");
			}
			if (diff.removed > 0) kids.push(react.createElement("span", { key: "r", className: "ccg-diff-del" }, "-" + diff.removed));
			kids.push(" ]");
			return react.createElement("span", { className: "ccg-diff" }, kids);
		}
		function GroupHeader(props) {
			var count = props.count;
			var open = props.open;
			var onToggle = props.onToggle;
			// label 可选：回合折叠栏传指标文案；缺省用"运行了 N 条命令"（多语言）。
			var label = props.label || (_T("headerPrefix") + " " + count + " " + _T("headerSuffix"));
			// isTurn：回合折叠栏（整回合折叠）用回合语义的无障碍标签。
			var isTurn = props.isTurn === true;
			// live：运行中的回合折叠栏数值实时变化，用滚轮动画渲染（DisclosureRow 的
			// title 直接作为 children 渲染，传 React 元素即可）。
			var live = props.live === true;
			// filePaths：步骤折叠栏标题中的文件名映射（basename → 绝对路径），
			// 用于把文件名渲染为可点击复制元素（悬停变 DeepSeek 主题蓝色）。
			var filePaths = props.filePaths;
			// 纯文本标题拆分：编辑行数变更 [ +N -M ] 悬停高亮；"——"之后的失败提示单独标红
			// （整标题不再整体标红；运行中 JSX 标题无失败后缀，保持原色）。
			var titleContent;
			if (live) {
				titleContent = react.createElement(AnimatedLabel, { label: label });
			} else if (isTurn && typeof label === "string") {
				// 闭合的回合折叠栏：整体仍是纯文本，但"已折叠/待折叠N步"的数字用
				// 滚轮动画渲染（其余指标静态）。步骤折叠栏（isTurn=false）不受影响。
				titleContent = react.createElement(FoldedRollLabel, { label: label });
			} else if (typeof label === "string") {
				var parts = splitLabelParts(label);
				if (parts.diff !== null || parts.failure !== null) {
					var kids = [renderTitleFileLinks(parts.base, filePaths)];
					if (parts.diff !== null) kids.push(renderDiff(parts.diff));
					kids.push(parts.after);
					if (parts.failure !== null) kids.push(react.createElement("span", { key: "fail", className: "ccg-header-failure" }, parts.failure));
					titleContent = react.createElement.apply(react, [react.Fragment, null].concat(kids));
				} else {
					titleContent = renderTitleFileLinks(label, filePaths);
				}
			} else {
				titleContent = label;
			}
			// right：右对齐的尾部元素（回合折叠栏的"第x轮"）——flex 容器两端对齐，指标在左、轮次在右。
			// gearIcon：字段设置齿轮（回合折叠栏专属）——紧跟指标文案之后、轮次之前。
			if (props.right !== undefined && props.right !== null && props.right !== "") {
				var flexMetricsKids = [titleContent];
				if (props.gearIcon !== undefined) {
					flexMetricsKids.push(props.gearIcon);
				}
				titleContent = react.createElement(
					"span",
					{ className: "ccg-header-flex" },
					react.createElement("span", { className: "ccg-header-flex-metrics" }, flexMetricsKids),
					react.createElement("span", { className: "ccg-header-round" }, props.right)
				);
			} else if (props.gearIcon !== undefined) {
				// 无 right（极端情况：轮次文案为空）时齿轮仍跟随指标
				titleContent = react.createElement(react.Fragment, null, titleContent, props.gearIcon);
			}
			// pokerIcon：步骤折叠栏的扑克牌图标（收起=牌堆、展开=扇形，CSS 按开合切换）——置于标题最前
			if (props.pokerIcon !== undefined) {
				titleContent = react.createElement(react.Fragment, null, props.pokerIcon, titleContent);
			}
			var titleClass = "ccg-header-title";
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
						// poker（步骤折叠栏扑克图标）：前导区隐藏（内建 chevron 随之消失），图标已并入标题
						leadingClassName: "ccg-header-leading" + (props.pokerIcon !== undefined ? " ccg-poker-leading" : ""),
						titleClassName: titleClass,
						chevronClassName: "ccg-header-chevron",
						// 收起：有传入 icon（回合折叠栏等）用之；缺省用官方右向 chevron（14px）；
						// 展开：DisclosureRow 内建的下向 chevron（14px，poker 时随前导区一起隐藏）
						icon: props.icon !== undefined ? props.icon : react.createElement(IconChevronRightOutline14, { size: 14 }),
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
				props.pokerIcon !== undefined
					? null
					: (props.icon !== undefined
						? props.icon
						: react.createElement("span", { className: "ccg-chevron" }, "›")),
				react.createElement("span", { className: "ccg-title" }, titleContent)
			);
		}

		// ---- 步骤分组渲染（现有行为）：单条原样 / 非 leader 隐藏 / leader 渲染折叠栏 ----
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
		// ---- 图标配置（外置数据源） ----
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
      "2": "translate(0, -0.18) rotate(26 8 12)",
      "3": "translate(0, -0.18)"
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

		// ---- 步骤折叠栏收起态：扑克牌堆图标（3 张/5 张 × 随机花色） ----
		// 花色 path（24 单位空间，fill currentColor 跟随折叠栏图标色）已外置到
		// icons/default.json（pokerPips），经 ICON_DEFAULTS / localStorage 注入。
		/** 花色信息：path + 包围盒中心 + 宽度系数。新版统一居中于 (12,12)，factor 全 1。 */
		var POKER_PIPS = (iconConfig && iconConfig.pokerPips) || {
			spade: { path: "", cx: 12, cy: 12, factor: 1 },
			heart: { path: "", cx: 12, cy: 12, factor: 1 },
			diamond: { path: "", cx: 12, cy: 12, factor: 1 },
			club: { path: "", cx: 12, cy: 12, factor: 1 }
		};
		var POKER_SUITS = ["spade", "heart", "diamond", "club"];
		/** 牌面池：四花色 + DeepSeek Logo（Logo 仅在 pokerSpinDeepseek 数据存在时入池；
		 *  池在调用时计算，兼容 localStorage 图标包覆盖的加载时机）。 */
		function pokerFacePool() {
			return POKER_SPIN_DEEPSEEK ? POKER_SUITS.concat(["deepseek"]) : POKER_SUITS;
		}
		/** 每个步骤/回合折叠栏随机一个"牌面"（五选一，按 leaderKey 记忆，重渲染保持
		 *  同一牌面不变）。 */
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
/* 运行中的步骤折叠栏：四花色卡牌动画（docs/icon-candidates.html 第三行内联）。
		 *  与 HTML 同款：card-base 无 fill（由 .anim-card CSS 控制，透明 → 壁纸透出），
		 *  mask 动态扣掉上层覆盖区 → 重叠区不透出下层。每个实例给 defs id / use href /
		 *  mask 引用加唯一前缀，避免同页多实例冲突。 */
		var POKER_ANIM_SVG = (iconConfig && iconConfig.pokerAnimSVG) || '';
		// ---- 回合折叠栏运行中图标：竖直对角线轴旋转卡牌（真实比例 5:7）----
		// 移植自 docs/icon-candidates.html 的 svgAxisSpin（axisAngle=0 + restAngle=对角线倾角）：
		// 卡牌绕自身左上→右下对角线轴连续翻转，正面显示黑桃、背面显示 DeepSeek 鲸鱼 Logo。
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
		// DeepSeek 标准 24×24 鲸鱼 Logo（牌背按当前图标体系用 currentColor）。
		var POKER_SPIN_DEEPSEEK = (iconConfig && iconConfig.pokerSpinDeepseek) || "";
		// scaleX(cosθ) 关键帧（72 帧，0.013889 步长，2.4s 循环）：1→0→-1→0→1 平滑翻转。
		var POKER_SPIN_SCALE = '1 1;0.996195 1;0.984808 1;0.965926 1;0.939693 1;0.906308 1;0.866025 1;0.819152 1;0.766044 1;0.707107 1;0.642788 1;0.573576 1;0.5 1;0.422618 1;0.34202 1;0.258819 1;0.173648 1;0.087156 1;0 1;-0.087156 1;-0.173648 1;-0.258819 1;-0.34202 1;-0.422618 1;-0.5 1;-0.573576 1;-0.642788 1;-0.707107 1;-0.766044 1;-0.819152 1;-0.866025 1;-0.906308 1;-0.939693 1;-0.965926 1;-0.984808 1;-0.996195 1;-1 1;-0.996195 1;-0.984808 1;-0.965926 1;-0.939693 1;-0.906308 1;-0.866025 1;-0.819152 1;-0.766044 1;-0.707107 1;-0.642788 1;-0.573576 1;-0.5 1;-0.422618 1;-0.34202 1;-0.258819 1;-0.173648 1;-0.087156 1;0 1;0.087156 1;0.173648 1;0.258819 1;0.34202 1;0.422618 1;0.5 1;0.573576 1;0.642788 1;0.707107 1;0.766044 1;0.819152 1;0.866025 1;0.906308 1;0.939693 1;0.965926 1;0.984808 1;0.996195 1;1 1';
		var POKER_SPIN_KEYS = '0;0.013889;0.027778;0.041667;0.055556;0.069444;0.083333;0.097222;0.111111;0.125;0.138889;0.152778;0.166667;0.180556;0.194444;0.208333;0.222222;0.236111;0.25;0.263889;0.277778;0.291667;0.305556;0.319444;0.333333;0.347222;0.361111;0.375;0.388889;0.402778;0.416667;0.430556;0.444444;0.458333;0.472222;0.486111;0.5;0.513889;0.527778;0.541667;0.555556;0.569444;0.583333;0.597222;0.611111;0.625;0.638889;0.652778;0.666667;0.680556;0.694444;0.708333;0.722222;0.736111;0.75;0.763889;0.777778;0.791667;0.805556;0.819444;0.833333;0.847222;0.861111;0.875;0.888889;0.902778;0.916667;0.930556;0.944444;0.958333;0.972222;0.986111;1';
		var pokerSpinSeq = 0;
		/** 四种花色的可见性关键帧（6.4s 一个完整花色循环：4 次 360° 翻牌，
		 *  每次翻到背面固定显示 DeepSeek，越过背面后切到下一种花色）。
		 *  移植自 docs/icon-candidates.html svgAxisSpin 的 suitVisibility。 */
		var POKER_SPIN_SUIT_VIS = {
			spade:   { initial: "visible", values: "visible;hidden;visible;visible", keyTimes: "0;0.0625;0.9375;1" },
			heart:   { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.1875;0.3125;1" },
			diamond: { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.4375;0.5625;1" },
			club:    { initial: "hidden",  values: "hidden;visible;hidden;hidden",  keyTimes: "0;0.6875;0.8125;1" }
		};
		var POKER_SPIN_BACK_VIS = "hidden;visible;hidden;visible;hidden;visible;hidden;visible;hidden;hidden";
		var POKER_SPIN_BACK_KEYS = "0;0.0625;0.1875;0.3125;0.4375;0.5625;0.6875;0.8125;0.9375;1";
		/** 生成牌面翻转 SVG（四花色循环 + DeepSeek 背面，6.4s 完整循环）。
		 *  移植自 docs/icon-candidates.html svgAxisSpin（axisAngle=0 + restAngle=对角线倾角）。
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
		/** 回合折叠栏运行中图标：牌面翻转（四花色循环 ♠ → ♥ → ♦ → ♣ 正面 / DeepSeek Logo 背面），
		 *  开合轴按 open 切换纵向中轴（0°）⇄ 竖直对角线轴（~35.54°），CSS transition 平滑过渡。 */
		function PokerSpinIcon(props) {
			var open = props.open === true;
			var uidRef = react.useRef(null);
			if (uidRef.current === null) uidRef.current = "ccg-poker-spin-" + (++pokerSpinSeq);
			var html = react.useMemo(function () { return buildPokerSpinSVG(uidRef.current); }, []);
			return react.createElement("span", { className: "ccg-poker-icon", "data-spin-open": open ? "true" : undefined },
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
		/** 扇形/牌堆变换表（与 demo 一致，中心对齐 (8,8)；card-3 纯 translate 防过渡 bug）。
		 *  变换表从 iconConfig.pokerTransforms 读取，可被图标包覆盖。 */
		function pokerTransforms(count, fan) {
			var five = count > 3;
			var t = (iconConfig && iconConfig.pokerTransforms) || {};
			if (fan) {
				return five
					? t.fan5 || { 1: "translate(0, -0.608) rotate(-32 8 12)", 2: "translate(0, -0.608) rotate(-16 8 12)", 3: "translate(0, -0.608)", 4: "translate(0, -0.608) rotate(16 8 12)", 5: "translate(0, -0.608) rotate(32 8 12)" }
					: t.fan3 || { 1: "translate(0, -0.18) rotate(-26 8 12)", 2: "translate(0, -0.18) rotate(26 8 12)", 3: "translate(0, -0.18)" };
			}
			return five
				? t.stack5 || { 1: "translate(1.6, 1.6)", 2: "translate(0.8, 0.8)", 3: "translate(0, 0)", 4: "translate(-0.8, -0.8)", 5: "translate(-1.6, -1.6)" }
				: t.stack3 || { 1: "translate(1, 2.25)", 2: "translate(0, 0.25)", 3: "translate(-1, -1.75)" };
		}
		/** 运行中步骤折叠栏的卡牌动画图标：四花色循环动画（旋转+平移+缩放，含 mask 挖空）。
		 *  uid 用 useRef 固定 + useMemo 缓存 SVG 字符串（只生成一次）——折叠栏重渲染
		 *  （token/耗时刷新）时 __html 不变，React 不重设 innerHTML，SMIL 动画持续不重启。 */
		var pokerAnimSeq = 0;
		/** 回合折叠栏的扑克牌图标：运行中（!closed）→ 牌面翻转（纵向中轴/竖直对角线轴，按 turnOpen）；
		 *  完成后 → 牌堆/扇形（mask 方案）。折叠图标样式设为 default 时返回 undefined
		 *  （GroupHeader 回退官方 chevron）。 */
		function turnPokerIcon(fold, closed, turnOpen) {
			if (foldIconStyle !== "poker") return undefined;
			if (!closed) return react.createElement(PokerSpinIcon, { open: turnOpen });
			return react.createElement(PokerIcon, { count: fold.toolCount, suit: foldSuitFor("turn:" + fold.turn), open: turnOpen });
		}
		/** 步骤折叠栏运行中图标：五牌面轮换动画（四花色 + DeepSeek），开合角度按 open 切换 0°/35.5°。
		 *  uid 固定 + useMemo 缓存 SVG 字符串——折叠栏重渲染（token/耗时刷新）时 __html 不变，
		 *  SMIL 动画持续不重启；开合角度由外层 span 的 data-flat-open 触发 CSS transition。 */
		function PokerAnimIcon(props) {
			var open = props.open === true;
			var uidRef = react.useRef(null);
			if (uidRef.current === null) uidRef.current = "ccg-poker-anim-" + (++pokerAnimSeq);
			var html = react.useMemo(function () {
				var uid = uidRef.current;
				return POKER_ANIM_SVG
					.replace(/<svg[^>]*>/, '<svg viewBox="0 0 16 16" width="24" height="24" style="color:var(--dsw-alias-label-secondary,#9ca3af)">')
					.replace(/id="(pip-[a-z]+|card-[a-z]+|phase-\d+|mask-(?:plus|minus)-(?:in|out))"/g, function (m, id) { return 'id="' + id + '-' + uid + '"'; })
					.replace(/href="#(pip-[a-z]+|card-[a-z]+)"/g, function (m, id) { return 'href="#' + id + '-' + uid + '"'; })
					.replace(/url\(#(mask-(?:plus|minus)-(?:in|out))\)/g, function (m, id) { return 'url(#' + id + '-' + uid + ')'; })
					// 五牌面轮换动画组外包旋转层：收起 0°（CSS 默认）⇄ 展开 35.5°（data-flat-open 触发过渡）
					.replace(/(<g id="phase-1-[^"]+">)/, '<g class="ccg-flat-rotation" transform="rotate(0 8 8)">$1')
					.replace(/<\/svg>\s*$/, '</g></svg>');
			}, []);
			return react.createElement("span", { className: "ccg-poker-icon", "data-flat-open": open ? "true" : undefined },
				react.createElement("span", { className: "ccg-poker-svg", dangerouslySetInnerHTML: { __html: html } })
			);
		}
		/** 扑克图标组件：开合时逐张牌从牌堆变形为扇形（或反向），CSS transition 驱动形变；
		 *  mask 遮挡方案的 occluder 与真实牌使用同一套绝对 transform + 过渡，动画期间逐帧对齐。 */
		function PokerIcon(props) {
			var count = props.count, suit = props.suit, open = props.open;
			var svgRef = react.useRef(null);
			// __html 用 useMemo 缓存（同 PokerAnimIcon）：折叠栏重渲染（token/耗时刷新、
			// 回合展开/收起、live 状态切换）时字符串稳定 → React 不重设 innerHTML，
			// layout effect 设置的 transform/mask/visibility 得以保留；只有 count/suit
			// 变化才重新生成（此时 layout effect 同依赖重跑，重新应用全部状态）。
			// 否则每次渲染 seq++ 都产生新字符串 → innerHTML 被清空重写而 effect 不重跑
			// → 牌全部重叠在 (0,0) 且 mask 未应用 → 看起来只剩一张牌（单张卡牌 bug）。
			var html = react.useMemo(function () { return buildPokerSVGBase(count, suit); }, [count, suit]);
			react.useLayoutEffect(function () {
				var holder = svgRef.current;
				// svgRef 指向包裹 span；牌张 g 必须在 <svg> 内才会渲染，先定位 svg 元素
				var svg = holder ? holder.querySelector("svg") : null;
				if (!svg) return;
				var five = count > 3;
				var n = five ? 5 : 3;
				// 叠放顺序：牌堆顶牌最后画；扇形最右的牌最后画（右手握牌）
				var order = open ? (five ? [1, 2, 3, 4, 5] : [1, 3, 2]) : (five ? [1, 2, 3, 4, 5] : [1, 2, 3]);
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
				var item = { name: name, filePath: filePath, fileName: pathBasename(filePath), lineChanges: lineChanges };
				// 单条命令标题需要命令详情（"运行了Pwsh · cd x:/abc"），command 条目带上 argsRaw
				if (kind === "command") item.argsRaw = info ? info.argsRaw : undefined;
				stats[kind].push(item);
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
		/** 单条命令详情：优先取 argsRaw 的 command 字段（DSH bash/pwsh 的标准形状），
		 *  兜底取最长字符串值（summarizeArgs 行为）；空白折叠 + 60 字截断。
		 *  仅在段内只有一次命令调用时显示。 */
		function commandDetail(argsRaw) {
			if (!argsRaw) return "";
			var fallback = summarizeArgs(argsRaw);
			try {
				var obj = JSON.parse(argsRaw);
				if (obj && typeof obj.command === "string" && obj.command.trim() !== "") {
					var c = obj.command.replace(/\s+/g, " ").trim();
					return c.length > 60 ? c.slice(0, 60) + "…" : c;
				}
			} catch (e) { /* 非 JSON 走兜底 */ }
			return fallback;
		}
		/** 组内 command 类的描述：单次命令显示"运行了Pwsh · 命令详情"（工具名首字母大写），
		 *  多次显示次数+单位。 */
		function commandPartLabel(stats) {
			var items = stats.command;
			if (!items || items.length === 0) return "";
			if (items.length === 1) {
				var name = capitalizeFirst(items[0].name || "");
				var detail = commandDetail(items[0].argsRaw);
				return _T("segmentCommand") + name + (detail ? " · " + detail : "");
			}
			return _T("segmentCommand") + items.length + _T("segmentCommandSuffix");
		}
		// 段闭合标题缓存：段闭合后（textAfter=true）标题不再随流式变化，按
		// leaderKey+keys+工具轻量指纹记忆只计算一次，避免每次渲染重复解析 argsRaw。
		// 指纹 = 每个 tool 的 name + isError + argsRaw 长度（不解析内容，O(1)）——
		// 段闭合后这些字段稳定；不同内容但同 keys 的段（如测试场景）长度不同也能区分。
		var segmentLabelCache = new Map();
		function segmentCacheKey(group, nodes) {
			var parts = [currentLocale(), group.leaderKey, group.keys.join(",")];
			for (var i = 0; i < group.keys.length; i++) {
				var n = nodes.get(group.keys[i]);
				if (!n || n.kind !== "tool-call") continue;
				var root = n.data && n.data.root;
				var name = "", isErr = "0", rawLen = 0, raw = "";
				if (root && "kind" in root) {
					var call = root.call || root;
					name = call.name || "";
					if (root.isError === true) isErr = "1";
					if (typeof call.argsRaw === "string") { raw = call.argsRaw; rawLen = raw.length; }
				} else if (root) {
					name = root.name || "";
					if (typeof root.argsRaw === "string") { raw = root.argsRaw; rawLen = raw.length; }
				}
				// 单条命令标题含命令详情（argsRaw 内容），command 工具必须把内容写进指纹，
				// 否则同长度不同命令会命中错误缓存（如 "cd x" 与 "cd y"）。
				var kind = TOOL_KINDS[name.toLowerCase()] || "others";
				if (kind === "command" && raw !== "") parts.push(name + ":" + isErr + ":" + rawLen + ":" + raw);
				else parts.push(name + ":" + isErr + ":" + rawLen);
			}
			return parts.join("|");
		}
		/** 步骤折叠栏标题：运行中（textAfter=false）取最后一个节点显示当前执行内容，闭合后按
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
				var label = parts.join(" ");
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
				// 纯 think 段闭合后显示"思考了N次"（"运行了 0 条命令"不好看）；
				// 兜底：段内无 think 节点（理论上不可能）时按 1 次计。
				var thinkCount = group.thinkCount > 0 ? group.thinkCount : 1;
				return _T("segmentThink") + thinkCount + _T("segmentThinkSuffix");
			}
			// 运行中（段未闭合）：显示段内最后一个节点（当前正在执行的工具 / 思考内容）
			var last = group.lastActiveKey ? nodes.get(group.lastActiveKey) : null;
			if (last && last.kind === "tool-call") {
				var info = toolCallInfo(last);
				if (info && info.name) {
					var desc = summarizeArgs(info.argsRaw);
					return _T("runningTool") + capitalizeFirst(info.name) + (desc ? " · " + desc : "");
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
		/** 段内文件路径（basename → 绝对路径）：read/edit 类工具调用解析出的文件。
		 *  供 GroupHeader 把标题里的文件名渲染成可点击复制元素。复用 classifySegmentTools
		 *  的结果，按 leaderKey 缓存（段闭合后字段稳定）。 */
		var segmentFilePathsCache = new Map();
		function segmentFilePaths(group, nodes) {
			if (!group || !group.textAfter || group.toolCount === 0) return null;
			var cacheKey = segmentCacheKey(group, nodes);
			if (segmentFilePathsCache.has(cacheKey)) return segmentFilePathsCache.get(cacheKey);
			var stats = classifySegmentTools(group, nodes);
			var map = new Map();
			var kinds = ["read", "edit"];
			for (var k = 0; k < kinds.length; k++) {
				var items = stats[kinds[k]];
				for (var i = 0; i < items.length; i++) {
					var it = items[i];
					if (it && it.fileName && it.filePath) {
						// 同一 basename 多个路径时保留最后一个（标题只显示一个文件名）
						map.set(it.fileName, it.filePath);
					}
				}
			}
			segmentFilePathsCache.set(cacheKey, map);
			return map;
		}
		/** think 摘要行：运行中横向自动滚动跟随末尾（官方 ReasoningRow 的 data-follow-end 行为）。
		 *  节流逻辑与官方 useThrottledVisualUpdate 一致：变化时排队一条 3 帧的 rAF 链，
		 *  链到期后执行"最新"闭包（读最新 scrollWidth / 写 scrollLeft）；链已排队则合并，
		 *  绝不中途 cancel——旧实现每帧渲染先 cancel 再排队，流式高频渲染下 rAF 永远
		 *  来不及触发，滚动卡死在几个单词处（换行后新行开头尤为明显）。 */
		function ThinkSummary(props) {
			var text = props.text;
			var running = props.running === true;
			var ref = react.useRef(null);
			var rafRef = react.useRef(null);     // 待执行的 rAF 链
			var updateRef = react.useRef(null);  // 始终指向最新滚动闭包
			var line = running ? latestLine(text) : firstLine(text);

			// 每帧渲染都刷新最新闭包：链到期时读到的是当前 DOM 尺寸与 running 状态
			updateRef.current = function () {
				var el = ref.current;
				if (!el) return;
				el.scrollLeft = running ? el.scrollWidth - el.clientWidth : 0;
			};

			// 调度：仅当显示内容（line）或运行状态变化时启动/合并一条 3 帧链。
			// 父级指标 tick 等无关渲染不会触发（依赖收窄），也不会 cancel 已排队的链。
			react.useEffect(function () {
				if (rafRef.current !== null) return; // 链已排队，合并本次变化
				var remaining = 3;
				var advance = function () {
					remaining -= 1;
					if (remaining > 0) {
						rafRef.current = raf(advance);
						return;
					}
					rafRef.current = null;
					updateRef.current();
				};
				rafRef.current = raf(advance);
			}, [line, running]);

			// 仅卸载时取消未触发的链
			react.useEffect(function () {
				return function () {
					if (rafRef.current !== null) { caf(rafRef.current); rafRef.current = null; }
				};
			}, []);

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
		/** 名称首字母大写（"pwsh" → "Pwsh"，与官方 TOOL_TITLES 的显示风格一致）。 */
		function capitalizeFirst(s) {
			return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
		}
		/** 步骤折叠栏标题元素：think / 工具运行中用"前缀 + 官方图标 + 名称 + 摘要"（官方行风格），
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
							react.createElement("span", { className: "ccg-think-name" }, capitalizeFirst(info.name)),
							desc ? react.createElement("span", { className: "ccg-think-sep" }, " · ") : null,
							desc ? react.createElement("span", { className: "ccg-think-summary" }, desc) : null
						);
					}
				}
			}
			return segmentLabel(group, nodes);
		}
		/** 构造「仅正文」节点：过滤掉 reasoning（think）块——段外 text 正文与最终总结用
		 *  它渲染官方 AssistantMarkdown，从结构上不产生 Think 行。此前依赖 CSS
		 *  `.ccg-text-only [data-variant="think"]{display:none}` 隐藏完整节点里的 Think 行，
		 *  但运行中的官方构建 ReasoningRow 属性/结构有版本差异，隐藏失效时 Think 行
		 *  （24px + 上下 gap）会露在折叠栏与正文之间——正是"行间距过高"的主因。
		 *  保留 text / image 块（图属于正文），过滤 reasoning / tool-call。 */
		function textOnlyNode(n) {
			return Object.assign({}, n, {
				data: Object.assign({}, n.data, {
					blocks: (n.data.blocks || []).filter(function (b) {
						return !!b && (b.kind === "text" || b.kind === "image");
					})
				})
			});
		}
		/** 步骤分组渲染：只有 leader 渲染（成员渲染 hiddenMarker，内容由 leader 统一渲染，
		 *  保证 DOM 顺序：步骤折叠栏行 → 段内内容（工具卡片 / think 完整内容）→ text 正文）。
		 *  段内所有含 text 的节点的 text 正文统一在步骤折叠栏下方渲染（始终显示、不折叠、
		 *  唯一一份——官方渲染 + CSS 隐藏 think 行）。
		 *  finalKey：回合最终总结节点（由 turn 级单独渲染，段内跳过避免重复）。 */
		function renderSegment(props, group, open, sessionId, nodes, finalKey, closed) {
			if (!group.isLeader) return hiddenMarker();
			var inner = [];
			var textBodies = [];
			for (var i = 0; i < group.keys.length; i++) {
				var n = nodes.get(group.keys[i]);
				if (!n || n.key === finalKey) continue;
				if (n.kind === "tool-call") {
					inner.push(react.createElement("div", { key: "c" + n.key }, renderBuiltinToolCall(Object.assign({}, props, { node: n }))));
				} else if (n.kind === "assistant-step" && hasText(n)) {
					// 含 think+text：段内构造仅含 reasoning 块的节点，官方渲染只出 Think 行
					//（官方 ReasoningRow：收起显示"Think · 摘要"，点击展开完整内容）；
					// text 正文进段外（textOnlyNode：官方渲染且结构上无 Think 行）
					var thinkOnlyNode = Object.assign({}, n, {
						data: Object.assign({}, n.data, {
							blocks: (n.data.blocks || []).filter(function (b) { return !b || b.kind !== "text"; })
						})
					});
					inner.push(react.createElement("div", { key: "t" + n.key }, renderBuiltinAssistant(Object.assign({}, props, { node: thinkOnlyNode }))));
					textBodies.push(react.createElement(
						"div",
						{ key: "x" + n.key, className: "ccg-text-only" },
						renderBuiltinAssistant(Object.assign({}, props, { node: textOnlyNode(n) }))
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
			var filePaths = segmentFilePaths(group, nodes);
			var danger = group.failures > 0;
			// 运行中 = 段未闭合（!textAfter）且回合未结束（!closed）。一个步骤 = 步骤折叠栏内
			// 所有工具调用+思考（computeGroup 以 text 为边界向前/向后扩展），text 是唯一闭合标记：
			//   步骤开始（text 尚未出现）→ 卡牌动画；text 出现（步骤结束）→ 牌堆/扇形。
			// 回合结束后（closed，含中断/出错）强制牌堆，即使最后一个步骤段没有 text
			// （中断/出错时可能没有最终总结 text），避免永久动画。
			// 注意：整回合折叠下 text 常只在回合最终总结出现，此前该回合所有步骤折叠栏
			// 都保持动画，直至最终 text 一并切牌堆——这正是"未闭合全程动画"的语义。
			var running = !group.textAfter && !closed;
			var pokerIcon = (foldIconStyle === "poker" && running)
				? react.createElement(PokerAnimIcon, { open: open })
				: (foldIconStyle === "poker"
					? react.createElement(PokerIcon, { count: group.toolCount, suit: foldSuitFor(group.leaderKey), open: open })
					: undefined);
			// 顺序：步骤折叠栏行 → 段内内容（think 完整内容 / 工具卡片，折叠时不可见）
			// → 段内 text 正文（始终显示）——think 在 text 上方，符合"先思考后正文"的阅读顺序
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(group.toolCount), "data-ccg-open": open ? "true" : undefined },
				react.createElement(
					GroupHeader,
					{ count: group.toolCount, open: open, onToggle: toggle, label: title, danger: danger, isTurn: false, filePaths: filePaths, pokerIcon: pokerIcon }
				),
				react.createElement(FoldClip, { open: open }, inner),
				textBodies
			);
		}

		// ---- 会话快照读取层（DSH 0.1.1 / 0.1.2 双版本兼容） ----
		// 0.1.1：useSession 快照（ConversationSnapshot）自带 .chat（ChatSnapshot：order/
		//        nodes/locations/timeline/legacy），顶层另有 turnEnds/turnTimings 兼容字段。
		// 0.1.2：快照拆分——SessionSnapshot 不再有 chat/turnEnds/turnTimings；chat 数据由
		//        框架注入的 useChat 提供（props.useChat，快照即 ChatSnapshot），turnEnds/
		//        turnTimings 收进 ChatSnapshot.legacy（两个版本的 ChatSnapshot.legacy 切片
		//        均有这两个 Map，统一从这里读，顶层兼容字段兜底）。
		// hooks 顺序安全：useChat 的存在性由宿主版本决定、进程内恒定 → 任一环境下 hook
		// 数量恒定；0.1.2 上对 useSession 读已移除的顶层字段只是普通属性访问，得到
		// undefined 不抛错。快照缺省（store 未就绪）时各字段为 undefined，由下游
		// computeGroup/computeTurnFold 的空值守卫兜底回内置渲染。
		function useChatSnapshotData(props) {
			var useSession = props.useSession;
			var useChat = props.useChat;
			var chat = useChat
				? useChat(function (s) { return s; })
				: (useSession ? useSession(function (s) { return s.chat; }) : undefined);
			var topEnds = useSession ? useSession(function (s) { return s.turnEnds; }) : undefined;
			var topTimings = useSession ? useSession(function (s) { return s.turnTimings; }) : undefined;
			var safe = chat && typeof chat === "object" ? chat : {};
			var legacy = safe.legacy && typeof safe.legacy === "object" ? safe.legacy : {};
			return {
				order: safe.order,
				nodes: safe.nodes,
				locations: safe.locations,
				timeline: safe.timeline,
				turnEnds: legacy.turnEnds !== undefined ? legacy.turnEnds : topEnds,
				turnTimings: legacy.turnTimings !== undefined ? legacy.turnTimings : topTimings
			};
		}

		// ---- 工具调用节点：步骤分组 + 整回合折叠 ----
		function GroupedToolCallView(props) {
			var node = props.node;
			var sessionId = props.sessionId;
			// 快照订阅与缓存清理必须无条件调用（React hooks 顺序：foldActive() 的条件 return
			// 不能插在快照 hooks 之间——切换折叠模式重渲染时 hook 数量变化会崩条目）。
			// 会话切换时清理纯计算缓存（幂等：仅 sessionId 变化时执行一次）
			trackSession(sessionId);
			var chatSnap = useChatSnapshotData(props);
			var order = chatSnap.order;
			var nodes = chatSnap.nodes;
			var locations = chatSnap.locations;
			var turnEnds = chatSnap.turnEnds;
			var turnTimings = chatSnap.turnTimings;
			var timeline = chatSnap.timeline;
			// 订阅折叠模式（与快照订阅同为无条件调用，保持 hooks 顺序）
			useFoldMode();
			// 数据计算与订阅和"是否接管折叠"无关，全部无条件执行：折叠模式切换会让组件
			// 在接管/委托两条渲染路径间切换，任何 hook 放在条件 return 之后都会因 hook
			// 数量变化而崩条目。接管与否只决定渲染路径（foldActive() 判定在全部 hooks 之后）。
			var group = useMemo(function () { return computeGroup(order, nodes, node); }, [order, nodes, node]);
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var leaderKey = group ? group.leaderKey : "";
			var manual = useGroupOverride(sessionId, leaderKey);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			// 运行中：回合折叠栏默认展开（回复逐条加载、指标实时刷新）；回合结束后默认收起。
			// 只有回合折叠栏节点需要实时秒表（成员不渲染折叠栏）。
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(foldActive() && isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);
			// TTFT（首字）：运行中（turn-tail 未出现）用渲染时刻近似——首个 assistant-step
			// 渲染时同步冻结记录（回合启动 → 首个 response）；渲染期副作用需幂等（has 检查），
			// StrictMode 双调无害。回合结束后优先用官方持久化值（turn-tail 携带的 ttftMs：
			// 该回合第一个 step 的 firstTokenTime - stepStartTime，来自事件日志，刷新不丢）。
			recordTtft(sessionId, turn, closed, turnTimings);
			var officialTtft = displayMetrics && typeof displayMetrics.ttftMs === "number" ? displayMetrics.ttftMs : undefined;
			var approxTtft = turn !== undefined ? ttftCache.get(sessionId + "::" + turn) : undefined;
			var ttftMs = officialTtft !== undefined ? officialTtft : approxTtft;
			var headerMetrics = ttftMs !== undefined && displayMetrics ? Object.assign({}, displayMetrics, { ttftMs: ttftMs }) : displayMetrics;
			// 已折叠行数：回合折叠栏收纳的内容行数（仅 >0 时注入指标，绝不显示"已折叠0行"）。
			if (fold && fold.foldedRows > 0) {
				headerMetrics = headerMetrics ? Object.assign({}, headerMetrics, { foldedRows: fold.foldedRows }) : { foldedRows: fold.foldedRows };
			}
			// 订阅字段显隐设置（改动后立即重算标题文案）
			useFieldVisibility();
			// 订阅折叠图标样式（改动后立即切换前导图标）
			useFoldIconStyle();
			var filteredMetrics = filterVisibleMetrics(headerMetrics);

			// 未接管折叠：整段委托内置渲染（此时全部 hooks 已执行完毕，路径切换安全）
			if (!foldActive()) return renderBuiltinToolCall(props);

			// 兜底：找不到自己的节点时，原样委托内置渲染（补齐 renderSlot），绝不白屏。
			if (!group) return renderBuiltinToolCall(props);

			// 有效展开状态 = 手动选择优先；否则跟随自动规则。
			var open = manual === null ? !group.autoCollapsed : manual;

			// 整回合折叠成一个回合折叠栏（步骤折叠栏不再各自显示）：回合进行中同样成立——
			// 回合折叠栏在 agent 回复开始就出现（默认展开），折叠栏实时显示耗时/token 指标。
			// 折叠作用域之外（用户消息上方）的节点不参与整回合折叠。
			// 判定只看"是否存在可折叠的中间节点"（foldable），不要求本回合必须有
			// 工具调用：仅上下文注入/思考的纯问答回合同样收成一个回合折叠栏。
			if (fold && fold.foldable && !fold.outsideScope) {
				var turnOpen = turnOverride === null ? !closed : turnOverride;
				var finalKey = fold.finalAssistantKey;
				if (isExcludedSegmentTool(node)) {
					// 排除工具（如 todo_write）：不套步骤折叠栏、也不并入任何段，官方工具卡片
					// 原样渲染；只参与整回合折叠——回合折叠栏展开时显示、收起时隐藏。
					if (fold.isTurnHeader) {
						// 排除工具恰好是回合第一条中间节点：由它渲染回合折叠栏 + 官方工具卡片。
						var toggleTurnX = function () {
							setTurnOpen(sessionId, fold.turn, !turnOpen);
						};
						var baseLabelX = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
						var turnLabelX = closed ? turnLabelWithStatus(baseLabelX, fold.turnStatus) : baseLabelX;
						return react.createElement(
							"div",
							{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
							react.createElement(GroupHeader, { label: turnLabelX, count: fold.toolCount, open: turnOpen, onToggle: toggleTurnX, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), gearIcon: react.createElement(GearIcon, null), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
							react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
							react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinToolCall(props))
						);
					}
					return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinToolCall(props)) : hiddenMarker();
				}
				if (!fold.isTurnHeader) {
					// 成员：回合折叠栏展开时显示自己的段内内容（非 leader 由段 leader 统一渲染）；收起时隐藏。
					return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderSegment(props, group, open, sessionId, nodes, finalKey, closed)) : hiddenMarker();
				}
				// 折叠栏节点：渲染回合折叠栏（文案 = 本回合性能指标 + 状态标签，无数据则退回
				// "运行了 N 条命令"）；折叠栏下方常驻分隔线（收起/展开都显示），其下接自己的段内内容。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnOpen);
				};
				var baseLabel = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
				var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(GroupHeader, { label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), gearIcon: react.createElement(GearIcon, null), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
					react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
					react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderSegment(props, group, open, sessionId, nodes, finalKey, closed))
				);
			}

			// 未整回合折叠：步骤分组逻辑。
			return renderSegment(props, group, open, sessionId, nodes, fold ? fold.finalAssistantKey : undefined, closed);
		}

		// ---- 助手节点（Think / 最终消息）：整回合折叠支持 ----
		// 回合进行中：回合折叠栏在回复开始就出现，默认展开，内容原样流式加载；
		// 回合结束后，除最终总结消息外的所有 assistant-step（即 Think 行）都收进回合折叠栏。
		function GroupedAssistantView(props) {
			var node = props.node;
			var sessionId = props.sessionId;
			// 快照订阅必须无条件调用（见 GroupedToolCallView 的 hooks 顺序说明）
			var chatSnap = useChatSnapshotData(props);
			var order = chatSnap.order;
			var nodes = chatSnap.nodes;
			var locations = chatSnap.locations;
			var turnEnds = chatSnap.turnEnds;
			var turnTimings = chatSnap.turnTimings;
			var timeline = chatSnap.timeline;
			// 订阅折叠模式（与快照订阅同为无条件调用，保持 hooks 顺序）
			useFoldMode();
			// 数据计算与订阅和"是否接管折叠"无关，全部无条件执行（hooks 顺序说明见
			// GroupedToolCallView）；接管与否只决定渲染路径（foldActive() 判定在全部 hooks 之后）。
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(foldActive() && isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);
			// TTFT（首字）：运行中（turn-tail 未出现）用渲染时刻近似——首个 assistant-step
			// 渲染时同步冻结记录（回合启动 → 首个 response）；渲染期副作用需幂等（has 检查），
			// StrictMode 双调无害。回合结束后优先用官方持久化值（turn-tail 携带的 ttftMs：
			// 该回合第一个 step 的 firstTokenTime - stepStartTime，来自事件日志，刷新不丢）。
			recordTtft(sessionId, turn, closed, turnTimings);
			var officialTtft = displayMetrics && typeof displayMetrics.ttftMs === "number" ? displayMetrics.ttftMs : undefined;
			var approxTtft = turn !== undefined ? ttftCache.get(sessionId + "::" + turn) : undefined;
			var ttftMs = officialTtft !== undefined ? officialTtft : approxTtft;
			var headerMetrics = ttftMs !== undefined && displayMetrics ? Object.assign({}, displayMetrics, { ttftMs: ttftMs }) : displayMetrics;
			// 已折叠行数：回合折叠栏收纳的内容行数（仅 >0 时注入指标，绝不显示"已折叠0行"）。
			if (fold && fold.foldedRows > 0) {
				headerMetrics = headerMetrics ? Object.assign({}, headerMetrics, { foldedRows: fold.foldedRows }) : { foldedRows: fold.foldedRows };
			}
			// 订阅字段显隐设置（改动后立即重算标题文案）
			useFieldVisibility();
			// 订阅折叠图标样式（改动后立即切换前导图标）
			useFoldIconStyle();
			var filteredMetrics = filterVisibleMetrics(headerMetrics);
			// 纯 think 节点也参与步骤分组（段 = 两个 text 之间的 tool-call + think）。
			var segGroup = useMemo(function () { return computeGroup(order, nodes, node); }, [order, nodes, node]);
			var segManual = useGroupOverride(sessionId, segGroup ? segGroup.leaderKey : "");
			var segOpen = segManual === null ? !(segGroup && segGroup.autoCollapsed) : segManual;

			// 未接管折叠：整段委托内置渲染（此时全部 hooks 已执行完毕，路径切换安全）
			if (!foldActive()) return renderBuiltinAssistant(props);
			// 无法安全定位折叠栏（回合内无任何中间节点）/ 节点在折叠作用域之外（用户消息上方）：
			// 原样委托内置渲染。不要求本回合必须有工具调用——仅上下文注入/思考的回合同样折叠。
			if (!fold || !fold.foldable || fold.outsideScope) {
				return renderBuiltinAssistant(props);
			}
			var turnOpen = turnOverride === null ? !closed : turnOverride;
			if (fold.isFinalAssistant) {
				// 最终总结只显示正文：渲染过滤掉 reasoning 块的节点（textOnlyNode），官方
				// 组件结构上不产生 Think 行。此前依赖 CSS
				// [data-ccg-turn-folded] [data-variant="think"]{display:none} 隐藏，运行中
				// 的官方构建属性有版本差异时会露出 Think 行（保留 CSS 作兜底）。
				var finalBodyNode = textOnlyNode(node);
				if (fold.isTurnHeader) {
					// 单节点回合：该节点既是回合折叠栏又是最终总结消息（headerKey 兜底自
					// finalAssistantKey）。渲染回合折叠栏 + 分隔线 + 最终总结正文——正文始终
					// 可见（回合折叠栏收起也保留）。
					var toggleTurnF = function () {
						setTurnOpen(sessionId, fold.turn, !turnOpen);
					};
					var baseLabelF = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
					var turnLabelF = closed ? turnLabelWithStatus(baseLabelF, fold.turnStatus) : baseLabelF;
					return react.createElement(
						"div",
						{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
						react.createElement(GroupHeader, { label: turnLabelF, count: fold.toolCount, open: turnOpen, onToggle: toggleTurnF, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
						react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
						react.createElement("div", { "data-ccg-turn-folded": "true", style: { display: "contents" } },
							renderBuiltinAssistant(Object.assign({}, props, { node: finalBodyNode }))
						)
					);
				}
				// 最终总结消息保持可见（"只显示最终结果"）。
				// 运行中（isFinalAssistant 恒为 false）不会走到这里，流式 Think 保持内置行为。
				return react.createElement(
					"div",
					{ "data-ccg-turn-folded": "true", style: { display: "contents" } },
					renderBuiltinAssistant(Object.assign({}, props, { node: finalBodyNode }))
				);
			}
			// think 节点（含 think+text 同一节点）：统一收进步骤折叠栏——纯 think 段同样套
			// 步骤折叠栏（运行中标题"正在思考 · 摘要"流式滚动、闭合后标题"思考了N次"），
			// 工具段 think 用官方 Think 行、text 正文由 renderSegment 统一在段外渲染。
			// 不做"纯 think / 混合步骤"的预判：computeGroup 按当前快照实时归类，工具到达
			// 只是折叠栏标题切换、内容区增长，步骤折叠栏自 think 一开始就存在，无翻转跳变。
			if (isThinkNode(node) && segGroup) {
				if (fold.isTurnHeader) {
					// think 是回合第一条中间节点：同时是 turn 折叠栏和段 leader——回合折叠栏下方接步骤折叠行。
					var toggleTurn2 = function () {
						setTurnOpen(sessionId, fold.turn, !turnOpen);
					};
					var baseLabel2 = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
					var turnLabel2 = closed ? turnLabelWithStatus(baseLabel2, fold.turnStatus) : baseLabel2;
					return react.createElement(
						"div",
						{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
						react.createElement(GroupHeader, { label: turnLabel2, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn2, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), gearIcon: react.createElement(GearIcon, null), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
						react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
						react.createElement(FoldClip, { open: turnOpen, live: !closed },
							renderSegment(props, segGroup, segOpen, sessionId, nodes, fold.finalAssistantKey, closed)
						)
					);
				}
				if (!turnOpen) return hiddenMarker();
				return renderSegment(props, segGroup, segOpen, sessionId, nodes, fold.finalAssistantKey, closed);
			}
			if (!fold.isTurnHeader) {
				// 中间 Think 节点（含 text 的普通消息）：回合折叠栏展开时显示；收起时隐藏。
				return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinAssistant(props)) : hiddenMarker();
			}
			// 折叠栏节点：渲染回合折叠栏（文案 = 本回合性能指标 + 状态标签）；折叠栏下方常驻
			// 分隔线（收起/展开都显示），其下接自己的内容（Think 行）。
			var toggleTurn = function () {
				setTurnOpen(sessionId, fold.turn, !turnOpen);
			};
			var baseLabel = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
			var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
			return react.createElement(
				"div",
				{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
				react.createElement(GroupHeader, { label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), gearIcon: react.createElement(GearIcon, null), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
				react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
				react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinAssistant(props))
			);
		}

		// ---- 上下文注入节点（context）：整回合折叠时收进回合折叠栏 ----
		// 若上下文注入恰好是回合第一条"中间节点"，则由它渲染回合折叠栏。
		function GroupedContextView(props) {
			var node = props.node;
			var sessionId = props.sessionId;
			// 快照订阅必须无条件调用（见 GroupedToolCallView 的 hooks 顺序说明）
			var chatSnap = useChatSnapshotData(props);
			var order = chatSnap.order;
			var nodes = chatSnap.nodes;
			var locations = chatSnap.locations;
			var turnEnds = chatSnap.turnEnds;
			var turnTimings = chatSnap.turnTimings;
			var timeline = chatSnap.timeline;
			// 订阅折叠模式（与快照订阅同为无条件调用，保持 hooks 顺序）
			useFoldMode();
			// 数据计算与订阅和"是否接管折叠"无关，全部无条件执行（hooks 顺序说明见
			// GroupedToolCallView）；接管与否只决定渲染路径（foldActive() 判定在全部 hooks 之后）。
			var fold = useMemo(function () { return computeTurnFold(order, nodes, locations, turnEnds, node, timeline); }, [order, nodes, locations, turnEnds, node, timeline]);
			var turn = fold ? fold.turn : undefined;
			var turnOverride = useTurnOverride(sessionId, turn);
			var closed = fold ? fold.closed : true;
			var isTurnHeaderNode = !!(fold && fold.foldable && !fold.outsideScope && fold.isTurnHeader);
			var liveNow = useLiveNow(foldActive() && isTurnHeaderNode && !closed);
			var metrics = useMemo(function () { return computeTurnMetrics(turn, nodes, locations, turnTimings, liveNow); }, [turn, nodes, locations, turnTimings, liveNow]);
			// 运行中展示指标：消耗token 在真实基线之上叠加动画偏移持续增长（真实值到达时校正基线）
			var displayMetrics = useMemo(function () { return turnDisplayMetrics(sessionId, turn, metrics, closed, liveNow); }, [sessionId, turn, metrics, closed, liveNow]);
			// TTFT（首字）：运行中（turn-tail 未出现）用渲染时刻近似——首个 assistant-step
			// 渲染时同步冻结记录（回合启动 → 首个 response）；渲染期副作用需幂等（has 检查），
			// StrictMode 双调无害。回合结束后优先用官方持久化值（turn-tail 携带的 ttftMs：
			// 该回合第一个 step 的 firstTokenTime - stepStartTime，来自事件日志，刷新不丢）。
			recordTtft(sessionId, turn, closed, turnTimings);
			var officialTtft = displayMetrics && typeof displayMetrics.ttftMs === "number" ? displayMetrics.ttftMs : undefined;
			var approxTtft = turn !== undefined ? ttftCache.get(sessionId + "::" + turn) : undefined;
			var ttftMs = officialTtft !== undefined ? officialTtft : approxTtft;
			var headerMetrics = ttftMs !== undefined && displayMetrics ? Object.assign({}, displayMetrics, { ttftMs: ttftMs }) : displayMetrics;
			// 已折叠行数：回合折叠栏收纳的内容行数（仅 >0 时注入指标，绝不显示"已折叠0行"）。
			if (fold && fold.foldedRows > 0) {
				headerMetrics = headerMetrics ? Object.assign({}, headerMetrics, { foldedRows: fold.foldedRows }) : { foldedRows: fold.foldedRows };
			}
			// 订阅字段显隐设置（改动后立即重算标题文案）
			useFieldVisibility();
			// 订阅折叠图标样式（改动后立即切换前导图标）
			useFoldIconStyle();
			var filteredMetrics = filterVisibleMetrics(headerMetrics);

			// 未接管折叠：整段委托内置渲染（此时全部 hooks 已执行完毕，路径切换安全）
			if (!foldActive()) return renderBuiltinContext(props);
			// 无法安全定位折叠栏（回合内无任何中间节点）/ 折叠作用域之外（用户消息上方）的
			// 上下文行不参与折叠，始终原样渲染。不要求本回合必须有工具调用——仅上下文
			// 注入/思考的回合同样折叠。
			if (!fold || !fold.foldable || fold.outsideScope) {
				return renderBuiltinContext(props);
			}
			var turnOpen = turnOverride === null ? !closed : turnOverride;
			if (fold.isTurnHeader) {
				// 折叠栏节点：渲染回合折叠栏（文案 = 本回合性能指标 + 状态标签）；折叠栏下方常驻
				// 分隔线（收起/展开都显示），其下接自己的内容（上下文注入行）。
				var toggleTurn = function () {
					setTurnOpen(sessionId, fold.turn, !turnOpen);
				};
				var baseLabel = turnHeaderLabel(filteredMetrics, closed) || (_T("headerPrefix") + " " + fold.toolCount + " " + _T("headerSuffix"));
				var turnLabel = closed ? turnLabelWithStatus(baseLabel, fold.turnStatus) : baseLabel;
				return react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": String(fold.toolCount), "data-ccg-open": turnOpen ? "true" : undefined, "data-ccg-turn": "true" },
					react.createElement(GroupHeader, { label: turnLabel, count: fold.toolCount, open: turnOpen, onToggle: toggleTurn, isTurn: true, live: !closed, right: turnRoundLabel(fold.turn), gearIcon: react.createElement(GearIcon, null), pokerIcon: turnPokerIcon(fold, closed, turnOpen) }),
					react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" }),
					react.createElement(FoldClip, { open: turnOpen, live: !closed }, renderBuiltinContext(props))
				);
			}
			return turnOpen ? react.createElement("div", { className: "ccg-member-in" }, renderBuiltinContext(props)) : hiddenMarker();
		}

		// 内置 UserMessageNodeView 无 renderSlot，原样转发即可。
		function renderBuiltinUser(props) {
			var Builtin = builtinComponent("user");
			if (!Builtin) return null;
			return react.createElement(Builtin, Object.assign({}, props, { t: wrapLocaleT(props.t) }));
		}

		// ---- 回合折叠栏 0 秒占位 ----
		// 用户发送消息后、agent 输出第一条中间节点前，会话处于"运行中且最后一条消息是
		// user"：此时没有任何节点承载回合折叠栏（官方回合折叠栏由回合第一条中间节点渲染），
		// 模型响应前的等待期回合折叠栏迟迟不出现。这里在 user 消息下方渲染回合折叠栏占位
		// （耗时从回合开始计时，0 秒即出现）；第一条中间节点到达后条件失效，占位消失，
		// 回合折叠栏转交中间节点正式渲染（位置连续：都在 user 消息下方）。
		function GroupedUserView(props) {
			var node = props.node;
			var useSession = props.useSession;
			var sessionId = props.sessionId;
			// 快照订阅与缓存清理必须无条件调用（见 GroupedToolCallView 的 hooks 顺序说明）。
			// running 在两个版本都在 Session/Conversation 快照顶层（0.1.2 未被拆分移走），
			// 继续从 useSession 读；order/turnTimings 走双版本适配层。
			trackSession(sessionId);
			var chatSnap = useChatSnapshotData(props);
			var order = chatSnap.order;
			var running = useSession ? useSession(function (s) { return s.running === true; }) : false;
			var turnTimings = chatSnap.turnTimings;
			// 订阅折叠模式（与快照订阅同为无条件调用，保持 hooks 顺序）
			useFoldMode();
			// 占位条件：接管折叠 + 会话运行中 + 该 user 是最后一条消息（其后尚无任何中间节点）。
			// 在 hooks 之前计算（只依赖订阅值），直播秒表只在占位真正显示时启动。
			var isPending = foldActive() && running && Array.isArray(order) && order.length > 0 && order[order.length - 1] === node.key;
			var liveNow = useLiveNow(isPending);
			// 订阅字段显隐设置与折叠图标样式（无条件调用——hooks 顺序）
			useFieldVisibility();
			useFoldIconStyle();
			if (!foldActive()) return renderBuiltinUser(props);
			if (!isPending) return renderBuiltinUser(props);
			// 回合开始时间 / 回合号：turnTimings 中运行中（有 startTime、无 endTime）的回合
			var startTime = null;
			var runningTurn = null;
			if (turnTimings && typeof turnTimings.forEach === "function") {
				turnTimings.forEach(function (t, turn) {
					if (startTime === null && t && typeof t.startTime === "number" && typeof t.endTime !== "number") {
						startTime = t.startTime;
						runningTurn = turn;
					}
				});
			}
			var now = typeof liveNow === "number" ? liveNow : Date.now();
			var durationMs = typeof startTime === "number" ? Math.max(0, now - startTime) : 0;
			var label = turnHeaderLabel(filterVisibleMetrics({ durationMs: durationMs }), false) || (_T("headerPrefix") + " 0 " + _T("headerSuffix"));
			var placeholderPokerIcon = foldIconStyle === "poker"
				? react.createElement(PokerSpinIcon, { open: true })
				: undefined;
			return react.createElement(
				"div",
				{ style: { display: "contents" } },
				renderBuiltinUser(props),
				react.createElement(
					"div",
					{ className: "ccg-group-root", "data-ccg-count": "0", "data-ccg-open": "true", "data-ccg-turn": "true", "data-ccg-placeholder": "true" },
					react.createElement(GroupHeader, { label: label, count: 0, open: true, onToggle: function () {}, isTurn: true, live: true, right: turnRoundLabel(runningTurn), gearIcon: react.createElement(GearIcon, null), pokerIcon: placeholderPokerIcon }),
					react.createElement("div", { className: "ccg-turn-divider", "aria-hidden": "true" })
				)
			);
		}

		// ---- 设置 → 对话 → 「回合折叠方式」行（shadow 官方 transcript-view 行）----
		// DSH 0.1.2+ 官方注册了 settings.general.item 的 "transcript-view" 行（normal/compact
		// 两选项）。本插件以 priority:-1 + 同 id shadow 覆盖该行，提供三个选项：
		//   normal    → 官方 normal（不折叠）
		//   compact   → 官方 compact（官方折叠）
		//   turn-fold → 官方 normal + 插件接管（foldMode=turn-fold）
		// 选项状态 = 官方 transcriptView 值；turn-fold 额外用插件的 foldMode 标记。
		// 依赖 settingsScope 服务（DSH 0.1.2+）；旧版无该服务时静默跳过（不注册行）。
		function SettingsTranscriptViewRow(props) {
			var useTranscriptView = props.useTranscriptView;
			var setTranscriptView = props.setTranscriptView;
			// 订阅官方 transcriptView（normal/compact）与插件 foldMode（turn-fold 标记）。
			var official = useTranscriptView(function (v) { return v; });
			useFoldMode();
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			// 行卸载（菜单开着时切换设置分区/离开设置页）时菜单项随行一起卸载，同样
			// 不会派发 mouseleave——用 cleanup 兜底清掉滞留的悬浮提示。
			react.useEffect(function () {
				return function () { hideSettingsTip(); };
			}, []);
			var officialMode = (official && official.value && official.value.transcriptView) || "normal";
			// 展示选中项：插件标记 turn-fold 时显示 turn-fold（官方已被我们置为 normal）。
			// 选项文字用英文（与官方 Normal/Compact 风格一致）；悬浮 title 用中文提示。
			var OPTIONS = [
				{ id: "normal", label: _T("settingsTranscriptNormal"), tip: _T("settingsTranscriptNormalTip") },
				{ id: "compact", label: _T("settingsTranscriptCompact"), tip: _T("settingsTranscriptCompactTip") },
				{ id: "turn-fold", label: _T("settingsTranscriptTurnFold"), tip: _T("settingsTranscriptTurnFoldTip") }
			];
			var selected = foldMode === "turn-fold" ? "turn-fold" : officialMode;
			var selectedLabel = OPTIONS[0].label;
			var selectedTip = OPTIONS[0].tip;
			for (var oi = 0; oi < OPTIONS.length; oi++) {
				if (OPTIONS[oi].id === selected) { selectedLabel = OPTIONS[oi].label; selectedTip = OPTIONS[oi].tip; }
			}
			// 菜单关闭（选中一项 / 点击外部 / Esc / 再点选择器）时菜单项整体卸载，React
			// 不会再派发 mouseleave，悬浮提示会滞留到下一次 hover——关闭时一并清除。
			var closeMenu = function () { setOpen(false); hideSettingsTip(); };
			var selectMode = function (id) {
				closeMenu();
				if (id === "turn-fold") {
					// 插件接管：官方置 normal（避免双重折叠）+ 插件标记 turn-fold
					setFoldMode("turn-fold");
					if (officialMode !== "normal") setTranscriptView("normal");
				} else {
					setFoldMode("auto");
					setTranscriptView(id);
				}
			};
			var selector = react.createElement(
				"button",
				{
					type: "button",
					className: "ccg-settings-selector",
					"aria-haspopup": "menu",
					"aria-expanded": open ? "true" : undefined,
					onClick: function () { if (open) { closeMenu(); } else { setOpen(true); } }
				},
				selectedLabel,
				Menu ? react.createElement(IconChevronDownOutline14, { size: 14, className: "ccg-settings-selector-chevron" }) : null
			);
			var items = [];
			for (var mi = 0; mi < OPTIONS.length; mi++) {
				// 自定义即时 tooltip（原生 title 有 ~1s 延迟）：mouseenter 用当前项
				// 的 DOM rect 定位，mouseleave 立即隐藏。display:block + width:100%
				// 让整行都可触发（itemLabel flex:1 占满按钮宽）。
				// 注意：var mi 是函数作用域，闭包必须立即捕获当前 tip（IIFE），
				// 否则循环结束后 mi=length，所有 handler 都访问 OPTIONS[length] 崩溃。
				(function (tip) {
					items.push({
						id: OPTIONS[mi].id,
						label: react.createElement(
							"span",
							{
								key: "opt-" + OPTIONS[mi].id,
								style: { display: "block", width: "100%" },
								onMouseEnter: function (e) { showSettingsTip(tip, e.currentTarget.getBoundingClientRect()); },
								onMouseLeave: hideSettingsTip
							},
							OPTIONS[mi].label
						)
					});
				})(OPTIONS[mi].tip);
			}
			return react.createElement(
				"div",
				{ className: "ccg-settings-row" },
				react.createElement(
					"div",
					{ className: "ccg-settings-row-text" },
					react.createElement("div", { className: "ccg-settings-row-title" }, _T("settingsTranscriptTitle")),
					react.createElement("div", { className: "ccg-settings-row-desc" }, _T("settingsTranscriptDesc"))
				),
				Menu
					? react.createElement(Menu, {
						open: open,
						onClose: closeMenu,
						items: items,
						selectedId: selected,
						onSelect: selectMode,
						align: "end",
						portal: true,
						anchor: selector
					})
					: selector
			);
		}

		// ---- Cordis 插件入口 ----
		// 关键：委托渲染内置组件时，内置组件（ToolCallTree 等）依赖由"条目自身
		// inject 声明"提供的 hook（如 useConnectionGeneration，来自 connection 服务的
		// generation 可观察源）。我们的条目必须声明同样的 inject，否则手动
		// createElement 内置组件会因缺少这些 hook 而崩溃，SlotErrorBoundary 会把
		// 我们的条目"abdicate"（踢出槽位），折叠随即永久失效。
		exports.inject = ["slots", "connection", "settingsScope"];
		exports.apply = function (ctx) {
			// 设置 → 对话 → 「回合折叠方式」行：shadow 官方 transcript-view 行（priority:-1）。
			// 通过 ctx.settingsScope（DSH 服务注入）读写官方 ui-chat 命名空间的 transcriptView 字段。
			// 旧版/测试环境无 settingsScope 或 slots 时静默跳过。
			try {
				var slotsService2 = ctx.slots;
				if (slotsService2 && ctx.settingsScope && typeof ctx.settingsScope.bind === "function") {
					var transcriptScope = ctx.settingsScope.bind({ namespace: "ui-chat" });
					var settingsRowInject = function () {
						return {
							hooks: { transcriptView: transcriptScope },
							setTranscriptView: function (mode) { transcriptScope.set("transcriptView", mode); }
						};
					};
					slotsService2.inject("settings.general.item", function () {
						return slotsService2.register({
							name: "settings.general.item",
							id: "transcript-view",
							order: 12,
							locale: "conversation",
							priority: -1,
							inject: settingsRowInject
						}, SettingsTranscriptViewRow);
					});
				}
			} catch (e) { /* settingsScope 或 slots 不可用：跳过设置行注册 */ }
			// 一次性"新版本更新说明"通知：独立 React 根挂在 <body> 上，与折叠渲染无关。
			// 一次性"新版本更新说明"通知：独立 React 根挂在 <body> 上，与折叠渲染无关。
			// 特性检测（document / react-dom createRoot / ctx.effect）让极简宿主与
			// 测试环境（mock ctx 无 effect、loader 不提供 react-dom）静默跳过。
			if (typeof document !== "undefined" && ReactDOM !== null && typeof ReactDOM.createRoot === "function" && typeof ctx.effect === "function") {
				ctx.effect(function () {
					var host = document.getElementById("__dsh-turn-fold-notice");
					if (!host && document.body && typeof document.createElement === "function") {
						host = document.createElement("div");
						host.id = "__dsh-turn-fold-notice";
						document.body.appendChild(host);
					}
					if (!host) return undefined;
					var root = ReactDOM.createRoot(host);
					root.render(react.createElement(UpdateNotice));
					return function () {
						try { root.unmount(); } catch (e) { /* already gone */ }
						if (host.parentNode) host.parentNode.removeChild(host);
					};
				});
				// 字段设置弹窗 + 全局 Toast：同一独立 React 根（Toast 常驻，不随弹窗显隐）。
				ctx.effect(function () {
					var host = document.getElementById("__dsh-turn-fold-gear");
					if (!host && document.body && typeof document.createElement === "function") {
						host = document.createElement("div");
						host.id = "__dsh-turn-fold-gear";
						document.body.appendChild(host);
					}
					if (!host) return undefined;
					var root = ReactDOM.createRoot(host);
					root.render(react.createElement(react.Fragment, null,
						react.createElement(FieldVisibilityPopup, null),
						react.createElement(TurnFoldToast, null),
						react.createElement(SettingsTip, null)
					));
					return function () {
						try { root.unmount(); } catch (e) { /* already gone */ }
						if (host.parentNode) host.parentNode.removeChild(host);
					};
				});
			}
			ctx.inject(["slots", "connection"], function (scope) {
				slotsService = scope.slots;
				var connection = scope.connection;
				// 双版本兼容：DSH 0.1.2+ 用 connection.generation（Host facts，含 .host.home），
				// 旧版用 connection.hostDescription（直接含 .home），哪个存在就注入哪个。
				// 内置组件（ToolCallTree）通过 use<Name> prop 消费钩子，插件透传 props 时
				// 同时带上两个 hook 名，内置组件只消费当前版本存在的那一个。
				var hostDescriptionInject = function () {
					if (connection && connection.generation) {
						return { hooks: { connectionGeneration: connection.generation } };
					}
					return { hooks: { hostDescription: connection && connection.hostDescription } };
				};
				// shadow 条目的 locale 命名空间按条目 key 对应跟随官方——新版同一个 slot 上
				// 官方条目的 locale 不一致：tool-call 由 ui-tool 注册、声明 'conversation'
				//（工具标题词 tool.title.read=读取 / tool.title.write=写入 在 conversation
				// 词典），assistant-step/context/user 由 ui-chat 注册、声明 'chat'
				//（message.think=思考 在 chat 词典）。声明错命名空间时注入的 t 查不到词，
				// locale 服务原样返回 key → 官方组件裸显 "message.think"/"tool.title.read"。
				// 探测顺序：同 key 官方条目声明的 locale → ctx.locale 的 'chat' 词典是否
				// 有词（bind 后试查 message.think）→ 回退 'conversation'（0.1.1 行为不变）。
				// 残余错位由 wrapLocaleT 兜底词典兜住。
				var detectChatLocale = function (slots, key) {
					try {
						var entries = slots && typeof slots.entries === "function" ? slots.entries("conversation.chat.node") : null;
						for (var i = 0; entries && i < entries.length; i++) {
							var o = entries[i] && entries[i].options;
							if (o && o.key === key && (o.priority || 0) === 0 && typeof o.locale === "string") return o.locale;
						}
					} catch (e) { /* 旧版 entries 不可用时忽略 */ }
					try {
						if (ctx.locale && typeof ctx.locale.bind === "function") {
							var probe = ctx.locale.bind("chat");
							if (typeof probe === "function" && probe("message.think") !== "message.think") return "chat";
						}
					} catch (e) { /* 旧版无 chat 命名空间或 bind 抛错 */ }
					return "conversation";
				};
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "tool-call",
						priority: -1,
						locale: detectChatLocale(scope.slots, "tool-call"),
						inject: hostDescriptionInject
					}, GroupedToolCallView);
				});
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "assistant-step",
						priority: -1,
						locale: detectChatLocale(scope.slots, "assistant-step"),
						inject: hostDescriptionInject
					}, GroupedAssistantView);
				});
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "context",
						priority: -1,
						locale: detectChatLocale(scope.slots, "context"),
						inject: hostDescriptionInject
					}, GroupedContextView);
				});
				scope.slots.inject("conversation.chat.node", function () {
					return scope.slots.register({
						name: "conversation.chat.node",
						key: "user",
						priority: -1,
						locale: detectChatLocale(scope.slots, "user"),
						inject: hostDescriptionInject
					}, GroupedUserView);
				});
			});
		};

		return module.exports;
	}
});
}
