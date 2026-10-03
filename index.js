// dsh-turn-fold: DeepSeek Harness 插件（宿主半边）。
//
// 折叠 / 整回合折叠 / 回合折叠栏指标的全部逻辑都在前端 client.js，宿主半边
// 只做一件事：把「自定义图标」agent skill 注册进 DSH 的 skill 目录
// （ctx.skills.registerProvider），让 AI 代理在用户想改折叠栏图标时能加载
// 完整自定义流程（icons/default.json → sync:icons 注入 → 校验 → 重启提醒）。
//
// skill 正文在 assets/dsh-turn-fold-customize-icons.md，随 npm 包分发；
// 与官方 skill-badge 插件（@deepseek-ai/dsh-skill-badge）同一机制。
//
// 注意：本文件必须「零外部依赖」——不 import 任何 @deepseek-ai/ 或第三方包，
// 避免在 DSH 不同版本/装配下因包解析失败导致整个插件加载崩溃。
// - node:fs 和 node:url 是 Node 内置，安全。
// - @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK = 600，直接写死。
// - ctx.skills 通过 ctx.inject 延迟注入，不存在时不阻塞。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-turn-fold'

// BUNDLED_SKILL_RANK 硬编码（来自 @deepseek-ai/dsh-skill，值 = 600）。
// 不在顶层 import 该包：profile node_modules 里可能没有它，会导致加载失败。
const BUNDLED_SKILL_RANK = 600

/** skill 正文（随包 asset，与 index.js 同目录的 assets/ 下）。 */
const SKILL_BODY_URL = new URL('assets/dsh-turn-fold-customize-icons.md', import.meta.url)
/** 相对资源基目录：skill 正文提到的 icons/、scripts/、docs/ 都相对插件包根。 */
const RESOURCE_BASE = Object.freeze({
  kind: 'directory',
  path: fileURLToPath(new URL('.', import.meta.url)),
})
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })
const DESCRIPTION = 'Customize the dsh-turn-fold plugin\'s fold-bar icons (poker cards / card stack / fan / flip / spin animations). Use this Skill when the user wants to change the look of the step/turn fold bar icons, add a new suit or face design, tweak card geometry (corner radius, fan angle, stack offset), replace the running spin animation, or restore the official default chevron. Covers the icon data source (icons/default.json), the sync-inject pipeline (npm run sync:icons), the runtime localStorage override (dsh-turn-fold:icons), validation & fallback rules, and the SVG pitfalls unique to this user\'s browser.'

const CANDIDATE = Object.freeze({
  name: 'dsh-turn-fold-customize-icons',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: 'dsh-turn-fold',
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
})

const provider = {
  name: 'dsh-turn-fold',
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate) {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════
// Turn 指标 projection：Turn 栏 TTFT / decode-speed 的 durable 数据来源
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要它（官方源码确认的客户端缺口）：
//   ui-chat 的 assistant 节点只在收到 **live chunk**（assistant/live-chunk，
//   客户端瞬态事件、不落盘）时才记录 firstTokenTime
//   （packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:146,154）。
//   settleMessage()（同文件 :160）只写 blocks/final/usage，**不从
//   assistant/message.data.stream 恢复 firstTokenTime**；历史/重载重建走的
//   fallbackState()（同文件 :226）只重放已落盘的 match，其中没有 live-chunk。
//   ⇒ 刷新页面或打开历史会话后 finalNode.timing.firstTokenTime === null，
//     插件原有的 exact TTFT 与 decode 分母同时消失（「首字— / — tok/s」）。
//   官方底部 sessionStats 仍有这两个值，因为它走 durable 折叠：
//   packages/session/session-stats/src/projection.ts:141,148 用官方
//   assistantStreamFirstTokenTime(event.data.stream) 从落盘 stream 恢复首字。
//
// 插件因此注册自己的 projection（官方公开扩展面：ctx.sessionProjections.register，
// 见 session-projection/src/index.ts:199；文档明确 "units registered through
// ctx.inject(['sessionProjections'], …)"），用与官方 sessionStats **逐条相同**的
// 事件语义折叠出 **per-turn** 指标，由 host 经 projection wire 推送给客户端，
// 前端用 useProjection('turnFoldMetrics') 读取。与官方唯一差别是分组粒度
// （官方聚合整个会话；这里按 turn 分，Turn 栏只关心本回合）。
// 只读：不接管 Fold / 分组 / Session state；对同一事件返回同一引用，不产生额外广播。
const TURN_FOLD_METRICS_KEY = 'turnFoldMetrics'
const TURN_FOLD_METRICS_STATE_VERSION = 1
/** 每回合只留 3 个数字；上限仅防御病态超长会话（超出后最旧回合降级为「—」）。 */
const TURN_FOLD_METRICS_MAX_TURNS = 2000

// ── 官方 first-token 谓词（等价实现，逐条对照官方源码） ──
// 官方：packages/llm/llm/src/assistant-stream.ts
//   :250 isTokenDelta  / :294 firstRunMemberTime / :312 runFirstTokenTime
//   :333 assistantStreamFirstTokenTime
// 不 import 的原因：本文件必须零外部依赖（见文件头），且 `link:` 安装的插件在
// 运行时解析不到 @deepseek-ai/dsh-llm（profile 的 junction 指向已失效的旧路径）。
// 等价性由 tests/unit.turn-metrics.test.mjs 用官方 spec 的测试向量逐条锁定。
function isTokenDeltaChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}
function firstRunMemberTime(run, predicate) {
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  if (!Array.isArray(fragments) || !Array.isArray(run.dt)) return undefined
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += run.dt[index - 1]
    if (predicate(fragments[index])) return time
  }
  return undefined
}
function runFirstTokenTime(run) {
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  return firstRunMemberTime(run, fragment => fragment !== '')
}
/**
 * 一个已落盘 attempt 流里第一个 token 的时间（官方 assistantStreamFirstTokenTime 同义）。
 * @param {readonly object[]} stream - assistant/attempt 或 assistant/message 的 compact stream。
 * @returns {number|undefined} 首个 token 的时间戳；流里没有 token 时为 undefined。
 */
export function assistantStreamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const time = record.type === 'chunk'
      ? (isTokenDeltaChunk(record.chunk) ? record.time : undefined)
      : runFirstTokenTime(record)
    if (time !== undefined) return time
  }
  return undefined
}

/** 提供商上报的 completion tokens（官方 usageOutputTokens 同款守卫：有限且 ≥0）。 */
function usageOutputTokens(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 空日志的 fold 状态。 */
export function turnFoldInit() {
  return { open: null, turns: {} }
}

/** 非负有限数或 0（wire 出口只允许有限非负数）。 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 一回合的累计：首字延迟只由该回合**第一个**有证据的 step 决定（事件顺序即 step 顺序），
 * decode 由所有「首字 + 完成时间 + outputTokens」齐备的 step 求和。
 * @param {object} turns - 现有 per-turn 表。
 * @param {number} turn - 回合号。
 * @param {{ttftMs?: number, decodeMs?: number, decodeTokens?: number}} patch - 本 step 的增量。
 * @returns {object} 新的 per-turn 表（无变化时返回原引用）。
 */
function turnFoldMerge(turns, turn, patch) {
  const key = String(turn)
  const previous = Object.hasOwn(turns, key) ? turns[key] : undefined
  const next = {
    ttftMs: previous !== undefined && previous.ttftMs !== undefined ? previous.ttftMs : patch.ttftMs,
    decodeMs: nonNegative(previous?.decodeMs) + nonNegative(patch.decodeMs),
    decodeTokens: nonNegative(previous?.decodeTokens) + nonNegative(patch.decodeTokens),
  }
  if (next.ttftMs === undefined) delete next.ttftMs
  const merged = { ...turns, [key]: next }
  const keys = Object.keys(merged)
  if (keys.length <= TURN_FOLD_METRICS_MAX_TURNS) return merged
  // 上限保护：丢掉最小的回合号（正常会话远达不到；降级 = 该回合回落到「—」）
  const oldest = keys.map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b)
    .slice(0, keys.length - TURN_FOLD_METRICS_MAX_TURNS)
  for (const turnToDrop of oldest) delete merged[String(turnToDrop)]
  return merged
}

/**
 * 折叠一个已提交的 Session 事件（与官方 sessionStats 逐条对齐：
 * step/start 开边界、assistant/attempt 取首字且 retry 不覆盖、
 * assistant/message 用 open.firstTokenTime ?? stream 首字并结算 decode、
 * step/end 关边界；其余事件原样返回）。
 * @param {object} state - 上一状态。
 * @param {{type: string, time: number, data: object}} event - 下一个已提交事件。
 * @returns {object} 下一状态（无关事件返回同一引用）。
 */
export function turnFoldApply(state, event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return state
  const data = event.data
  switch (event.type) {
    case 'step/start': {
      if (data === null || typeof data !== 'object') return state
      if (typeof data.turn !== 'number' || typeof data.step !== 'number') return state
      if (typeof event.time !== 'number' || !Number.isFinite(event.time)) return state
      return {
        ...state,
        open: { turn: data.turn, step: data.step, startTime: event.time, firstTokenTime: null },
      }
    }
    case 'assistant/attempt': {
      const open = state.open
      if (open === null || data === null || typeof data !== 'object') return state
      if (open.turn !== data.turn || open.step !== data.step) return state
      const first = assistantStreamFirstTokenTime(data.stream)
      // retry 语义：同一 step 内首个 attempt 决定首字，后续 attempt 不覆盖
      if (open.firstTokenTime !== null || first === undefined) return state
      return { ...state, open: { ...open, firstTokenTime: first } }
    }
    case 'assistant/message': {
      const open = state.open
      if (open === null || data === null || typeof data !== 'object') return state
      if (open.turn !== data.turn || open.step !== data.step) return state
      const first = open.firstTokenTime ?? assistantStreamFirstTokenTime(data.stream) ?? null
      if (first === null || typeof event.time !== 'number' || !Number.isFinite(event.time)) {
        // 无首字证据：关边界、不计入（与官方一致：该 step 的流时间在时间图里不计数）
        return { ...state, open: null }
      }
      const patch = { ttftMs: Math.max(0, first - open.startTime) }
      const outputTokens = usageOutputTokens(data.usage)
      if (outputTokens !== null) {
        patch.decodeMs = Math.max(0, event.time - first)
        patch.decodeTokens = outputTokens
      }
      return { ...state, open: null, turns: turnFoldMerge(state.turns, open.turn, patch) }
    }
    case 'step/end': {
      const open = state.open
      if (open === null || data === null || typeof data !== 'object') return state
      if (open.turn !== data.turn || open.step !== data.step) return state
      return { ...state, open: null }
    }
    default:
      return state
  }
}

/** 视图缓存：同一 turns 引用 → 同一视图对象（Object.is 稳定，避免无关事件触发广播）。 */
const turnFoldViews = new WeakMap()

/** fold 状态 → 客户端 wire 值（整个值按 key 推送，保持引用稳定）。 */
export function turnFoldView(state) {
  const turns = state.turns
  let view = turnFoldViews.get(turns)
  if (view === undefined) {
    view = { turns }
    turnFoldViews.set(turns, view)
  }
  return view
}

/** 一个 turn 记录：只保留有限非负数字（越界字段直接丢弃）。 */
function parseTurnRecord(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('turnFoldMetrics turn record must be an object')
  const record = { decodeMs: nonNegative(value.decodeMs), decodeTokens: nonNegative(value.decodeTokens) }
  if (typeof value.ttftMs === 'number') record.ttftMs = nonNegative(value.ttftMs)
  return record
}

/** 持久化缓存行进入 fold 之前的校验（官方 stateSchema.parse 契约）。 */
const turnFoldStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new TypeError('turnFoldMetrics state must be an object')
    if (value.turns === null || typeof value.turns !== 'object') throw new TypeError('turnFoldMetrics state.turns must be an object')
    const turns = {}
    for (const key of Object.keys(value.turns)) {
      const turn = Number(key)
      if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError(`turnFoldMetrics turn key must be a non-negative integer: ${key}`)
      turns[key] = parseTurnRecord(value.turns[key])
    }
    let open = null
    if (value.open !== null && value.open !== undefined) {
      const candidate = value.open
      if (typeof candidate.turn !== 'number' || typeof candidate.step !== 'number' || typeof candidate.startTime !== 'number') {
        throw new TypeError('turnFoldMetrics state.open is malformed')
      }
      open = {
        turn: candidate.turn,
        step: candidate.step,
        startTime: nonNegative(candidate.startTime),
        firstTokenTime: typeof candidate.firstTokenTime === 'number' ? candidate.firstTokenTime : null,
      }
    }
    return { open, turns }
  },
}

/** 离开 host 之前的 wire 校验（官方 viewSchema.parse 契约）。 */
const turnFoldViewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') throw new TypeError('turnFoldMetrics view must be an object')
    if (value.turns === null || typeof value.turns !== 'object') throw new TypeError('turnFoldMetrics view.turns must be an object')
    const turns = {}
    for (const key of Object.keys(value.turns)) turns[key] = parseTurnRecord(value.turns[key])
    return { turns }
  },
}

/** 插件注册在 ctx.sessionProjections 上的 unit（key 归本插件所有）。 */
export const turnFoldMetricsProjection = {
  key: TURN_FOLD_METRICS_KEY,
  stateVersion: TURN_FOLD_METRICS_STATE_VERSION,
  stateSchema: turnFoldStateSchema,
  init: turnFoldInit,
  apply: turnFoldApply,
  wire: { viewSchema: turnFoldViewSchema, view: turnFoldView },
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // 用 ctx.inject 延迟注册：`skills` 服务就绪后回调执行。旧版 DSH（无 skills
  // 服务）不阻塞、不报错——折叠功能仍在前端正常工作，仅自定义图标 skill 不可用。
  // 两层守卫各管一段：外层包 inject 本身同步抛，内层包延迟回调体内抛——回调是
  // 延迟执行的，外层 try/catch 包不住它的栈。
  const tryRegisterProvider = (scope) => {
    try {
      scope.skills.registerProvider(() => provider)
    } catch (error) {
      console.warn('[dsh-turn-fold] skill provider registration skipped:', error)
    }
  }
  try {
    ctx.inject(['skills'], tryRegisterProvider)
  } catch (error) {
    console.warn('[dsh-turn-fold] skill provider registration skipped:', error)
  }

  // Turn 指标 projection（TTFT / decode-speed 的 durable 来源，见文件上方说明）。
  // 同一个两层守卫：旧版 DSH 没有 sessionProjections 服务时整个注册跳过，
  // 前端自动回落到客户端 step 数据（退化 = 重载后这两个指标为「—」）。
  const tryRegisterProjection = (scope) => {
    try {
      const registry = scope.sessionProjections
      if (registry === undefined || typeof registry.register !== 'function') {
        console.warn('[dsh-turn-fold] sessionProjections.register unavailable; turn metrics stay client-only')
        return
      }
      registry.register(turnFoldMetricsProjection)
    } catch (error) {
      console.warn('[dsh-turn-fold] turn metrics projection registration skipped:', error)
    }
  }
  try {
    ctx.inject(['sessionProjections'], tryRegisterProjection)
  } catch (error) {
    console.warn('[dsh-turn-fold] turn metrics projection registration skipped:', error)
  }
}