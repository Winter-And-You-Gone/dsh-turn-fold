// 真实会话结构 fixtures。提取自 session 898a7246 turn 13 和当前会话 turn 3。
// 这些结构用于数据驱动回归测试 · 确保插件逻辑对真实会话行为正确。
// 来源：.dsh/sessions/--X-DeepSeek~0020Harness--/session-898a7246-.../session.jsonl.zstd

import { makeNode, toolNode, asNode, userNode, tailNode, contextNode, buildSnapshot } from './store.mjs'

// ──────────────── turn 13 of session 898a7246（PATH 修复 · 22m35s · 4 个工具调用）───────────────
// 用户消息 "撤销" (seq 35277) · 然后是 4 个 pwsh 步骤 + 1 个最终总结。
// 步骤 1: as → tool (Revert); 步骤 2: as → tool (Check); 步骤 3: as → tool (Restore);
// 步骤 4: as → tool (Verify); 步骤 5: as (final summary)
// 来源：session-898a7246 seq 35272–38330
const T13_NODES = [
  userNode('u-35277', 35277),
  asNode('as-1', 35764, { step: 1, usage: { inputTokens: 10970, outputTokens: 904, cacheReadTokens: 76544 } }),
  toolNode('tc-revert', 35765, { step: 1, isError: false }),
  asNode('as-2', 36359, { step: 2, usage: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 50000 } }),
  toolNode('tc-check', 36360, { step: 2, isError: false }),
  asNode('as-3', 36822, { step: 3, usage: { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 60000 } }),
  toolNode('tc-restore', 36823, { step: 3, isError: false }),
  asNode('as-4', 37743, { step: 4, usage: { inputTokens: 4000, outputTokens: 700, cacheReadTokens: 70000 } }),
  toolNode('tc-verify', 37744, { step: 4, isError: false }),
  asNode('as-5', 38326, { step: 5, status: 'settled', usage: { inputTokens: 2095, outputTokens: 569, cacheReadTokens: 88320 } }),
  tailNode('tail-13', 38330, { tokensPerSecond: 144, ttftMs: 4900 }),
]
export const TURN13 = buildSnapshot(T13_NODES, {
  turnEnds: new Map([[13, 38330]]),
  turnTimings: new Map([[13, { startTime: 1787394826374, endTime: 1787396180925 }]]),
})
export const TURN13_NODES = T13_NODES
// 手动核算（与 computeTurnMetrics 的公式一致）：
// input = 10970+2000+3000+4000+2095 = 22065；cacheRead = 76544+50000+60000+70000+88320 = 344864
// billedInput = 22065+344864 = 366929；output = 904+500+600+700+569 = 3273
// tokens = billedInput + output = 370202
// cacheHitPercent = round(344864 / 366929 * 100) = 94
// durationMs = 1787396180925 - 1787394826374 = 1354551 → "22分34秒"
export const TURN13_METRICS = { durationMs: 1354551, ttftMs: 4900, tokens: 370202, outputTokens: 3273, tokensPerSecond: 144, cacheHitPercent: '93.99' }
export const TURN13_LABEL = '耗时22分34秒 · 首字4.9s · 消耗370202token · 144tok/s · 缓存命中93.99%'

// ──────────────── turn 11 of session 898a7246（调试 · 34s · 3 个工具调用）───────────────
// 用户消息 "继续" (seq 31135) · 然后是 3 个步骤 + 1 个最终总结。
// 步骤 1: as → read; 步骤 2: as → grep; 步骤 3: as → read; 步骤 4: as (final)
const T11_NODES = [
  userNode('u-31135', 31135),
  asNode('as-11-1', 31624, { step: 1, usage: { inputTokens: 5000, outputTokens: 200, cacheReadTokens: 20000 } }),
  toolNode('tc-read', 31625, { step: 1 }),
  asNode('as-11-2', 32594, { step: 2, usage: { inputTokens: 3000, outputTokens: 150, cacheReadTokens: 15000 } }),
  toolNode('tc-grep', 32595, { step: 2 }),
  asNode('as-11-3', 32663, { step: 3, usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 10000 } }),
  toolNode('tc-read2', 32664, { step: 3 }),
  asNode('as-11-4', 33988, { step: 4, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 5000 } }),
  tailNode('tail-11', 33989, { tokensPerSecond: 142 }),
]
export const TURN11 = buildSnapshot(T11_NODES, {
  turnEnds: new Map([[11, 33989]]),
  turnTimings: new Map([[11, { startTime: 1787394570026, endTime: 1787394600026 }]]),
})

// ──────────────── 无工具调用的回合（仅上下文注入 + Think）───────────────
// 验证"无工具调用也折叠"功能（v0.2.3）
const NO_TOOL_NODES = [
  userNode('u-100', 100),
  contextNode('ctx-skills', 105),
  asNode('as-nt-1', 200, { step: 1 }),
  asNode('as-nt-2', 300, { step: 2, status: 'settled', usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 } }),
  tailNode('tail-nt', 400),
]
export const NO_TOOL = buildSnapshot(NO_TOOL_NODES, {
  turnEnds: new Map([[13, 400]]),
  turnTimings: new Map([[13, { startTime: 0, endTime: 30000 }]]),
})

// ──────────────── outsideScope 场景：上下文注入在用户消息之前 ────────────────
// ctx-approval (seq 15) 在 user (seq 16) 之前 → ctx 不参与折叠
const OUTSIDE_NODES = [
  contextNode('ctx-approval', 15, { data: { seq: 15, source: { kind: 'plugin' } } }),
  userNode('u-16', 16),
  asNode('as-o-1', 130, { step: 1 }),
  toolNode('tc-o-1', 131, { step: 1 }),
  asNode('as-o-2', 300, { step: 2, status: 'settled', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } }),
  tailNode('tail-o', 400),
]
export const OUTSIDE_SCOPE = buildSnapshot(OUTSIDE_NODES, {
  turnEnds: new Map([[13, 400]]),
  turnTimings: new Map([[13, { startTime: 0, endTime: 10000 }]]),
})

// ──────────────── 两个用户消息（中间有上下文注入）───────────────
// 验证 headerKey 取最后一个 user 之后的第一条中间节点
const TWO_USERS_NODES = [
  userNode('u-a', 200),
  contextNode('ctx-mid', 201, { data: { seq: 201, source: { kind: 'plugin' } } }),
  userNode('u-b', 202),
  asNode('as-2u-1', 203, { step: 1 }),
  toolNode('tc-2u-1', 204, { step: 1 }),
  asNode('as-2u-2', 205, { step: 2, status: 'settled', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } }),
  tailNode('tail-2u', 300),
]
export const TWO_USERS = buildSnapshot(TWO_USERS_NODES, {
  turnEnds: new Map([[13, 300]]),
  turnTimings: new Map([[13, { startTime: 0, endTime: 5000 }]]),
})