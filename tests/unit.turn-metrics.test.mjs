// Turn 指标 projection（宿主半边）测试。
//
// 核心命题：TTFT / decode-speed 的 **durable** 数据来源。
// 客户端 assistant 节点只在 live chunk 到达时记录 firstTokenTime
// （官方 assistant.ts:146/154），settleMessage 与 fallbackState 都不从
// assistant/message.data.stream 恢复它 ⇒ reload / 历史会话后该字段为 null。
// 本插件因此注册自己的 projection（官方 ctx.sessionProjections.register 扩展面），
// 用与官方 sessionStats 逐条相同的事件语义折叠 per-turn 指标。
//
// 本文件锁定三件事：
//   ① 首 token 谓词与官方 assistantStreamFirstTokenTime 完全等价（官方 spec 的测试向量）；
//   ② live 路径（有 assistant/attempt）与 history 路径（只有 assistant/message + stream）
//      折叠出**完全相同**的指标；
//   ③ TPS = Σ outputTokens / Σ(messageTime − firstTokenTime)，TTFT / 工具等待 / step 间
//      等待都不进分母；没有真实证据时绝不产出数值。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assistantStreamFirstTokenTime as firstTokenOf,
  turnFoldApply,
  turnFoldInit,
  turnFoldView,
  turnFoldMetricsProjection,
} from '../index.js'

// ── 官方 spec 的夹具构造器（packages/llm/llm/tests/assistant-stream.spec.ts 同款） ──
const raw = (time, chunk) => ({ type: 'chunk', time, chunk })
const textRun = (time0, dt, texts, index = 0) => ({ type: 'text-chunks', time0, index, dt, texts })
const reasoningRun = (time0, dt, texts, index = 0) => ({ type: 'reasoning-chunks', time0, index, dt, texts })
const toolRun = (time0, dt, args, name, index = 0) => ({ type: 'tool-call-chunks', time0, index, dt, id: 'call-1', args, ...(name === undefined ? {} : { name }) })
const unreachableRecord = new Proxy({}, { get() { throw new Error('scan continued past the first qualifying record') } })

/** 按官方事件形状走一遍 fold。 */
function fold(events, init = turnFoldInit()) {
  let state = init
  for (const event of events) state = turnFoldApply(state, event)
  return state
}
const at = (time, type, data) => ({ type, time, data })

describe('first-token 谓词：与官方 assistantStreamFirstTokenTime 等价（官方 spec 向量）', () => {
  it('官方向量 ①：多记录流 → 103（reasoning run 的第 2 个成员，dt 重建时间）', () => {
    const stream = [
      raw(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
      reasoningRun(101, [2, 2], ['', ' ', 'think']),
      raw(106, { type: 'block-end', index: 0, block: { type: 'reasoning', text: ' think' } }),
      raw(107, { type: 'block-start', index: 1, blockType: 'text' }),
      textRun(108, [1, 1], ['\n', 'ans', 'wer'], 1),
      raw(111, { type: 'block-end', index: 1, block: { type: 'text', text: '\nanswer' } }),
      raw(112, { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }),
      raw(114, { type: 'finish', reason: { kind: 'stop' } }),
    ]
    assert.equal(firstTokenOf(stream), 103)
  })
  it('官方向量 ②：空流 → undefined；只有工具/空白内容 → 工具 run 的 time0', () => {
    const silent = [
      raw(1, { type: 'block-start', index: 0, blockType: 'tool-call' }),
      toolRun(2, [1], ['', ''], 'read'),
      raw(4, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call', name: 'read', arguments: '' } }),
      textRun(5, [1], [' ', '\t'], 1),
      reasoningRun(7, [], ['  '], 2),
      raw(8, { type: 'block-end', index: 1, block: { type: 'text', text: ' \t' } }),
    ]
    assert.equal(firstTokenOf([]), undefined)
    assert.equal(firstTokenOf(silent), 2)
  })
  it('官方向量 ③：未打包的退化记录 → 2（name 为空串也算 token delta）', () => {
    const degenerate = [
      raw(1, { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' }),
      raw(2, { type: 'tool-call-delta', index: 0, id: 'call', name: '', argumentsDelta: '' }),
      raw(3, { type: 'text-delta', index: 1, text: ' ' }),
      raw(4, { type: 'text-delta', index: 1, text: 'raw' }),
    ]
    assert.equal(firstTokenOf(degenerate), 2)
  })
  it('官方向量 ④：命中首条即停（后续记录不得被读取）', () => {
    assert.equal(firstTokenOf([textRun(5, [], ['x']), unreachableRecord]), 5)
    assert.equal(firstTokenOf([
      raw(6, { type: 'tool-call-delta', index: 0, id: 'call', name: '', argumentsDelta: '' }),
      unreachableRecord,
    ]), 6)
  })
  it('无 name 的工具 run 不算首字（只有实参非空才算）', () => {
    assert.equal(firstTokenOf([toolRun(2, [1], ['', 'arg'], undefined)]), 3)
    assert.equal(firstTokenOf([toolRun(2, [1], ['', ''], undefined)]), undefined)
  })
  it('形状异常（非数组 / 空记录）不抛错、不产值', () => {
    for (const bad of [undefined, null, 'x', 42, [null, 7, {}]]) assert.equal(firstTokenOf(bad), undefined)
  })
})

// ── 事件夹具 ──
/** 一个在 `time` 到达的真实 token（text delta 非空）。 */
const tokenAt = (time) => raw(time, { type: 'text-delta', index: 0, text: 'x' })
/** 一个在 `time` 到达的 tool-call token（带 name ⇒ 官方 isTokenDelta 视为 token）。 */
const toolTokenAt = (time) => raw(time, { type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: '' })
const USAGE = { inputTokens: 100, outputTokens: 100 }

describe('turnFoldMetrics projection：live 与 history 折叠出相同指标', () => {
  // 落盘 stream = 该 attempt 的全部 chunk（tool-call token 在前、text token 在后）
  const DURABLE_STREAM = [toolTokenAt(1050), tokenAt(1100)]
  const liveEvents = [
    at(1000, 'step/start', { turn: 3, step: 1 }),
    at(1050, 'assistant/attempt', { turn: 3, step: 1, stream: [toolTokenAt(1050)] }),
    at(1100, 'assistant/message', { turn: 3, step: 1, message: {}, stream: DURABLE_STREAM, usage: USAGE }),
    at(2000, 'step/end', { turn: 3, step: 1 }),
  ]
  const historyEvents = [
    at(1000, 'step/start', { turn: 3, step: 1 }),
    // 历史重建：没有 assistant/attempt，只有落盘的 assistant/message（含 stream）
    at(1100, 'assistant/message', { turn: 3, step: 1, message: {}, stream: DURABLE_STREAM, usage: USAGE }),
    at(2000, 'step/end', { turn: 3, step: 1 }),
  ]

  it('live 路径：attempt 提供首字（1050−1000=50ms），decode = 1100−1050 与 outputTokens', () => {
    const state = fold(liveEvents)
    assert.deepEqual(state.turns['3'], { ttftMs: 50, decodeMs: 50, decodeTokens: 100 })
    assert.deepEqual(turnFoldView(state).turns['3'], { ttftMs: 50, decodeMs: 50, decodeTokens: 100 })
  })
  it('history 路径：只有 assistant/message + stream 时得到**同样**的指标（durable 恢复）', () => {
    const live = fold(liveEvents).turns['3']
    const history = fold(historyEvents).turns['3']
    assert.deepEqual(history, live, 'history 折叠必须与 live 一致')
    assert.equal(history.ttftMs, 50)
  })
  it('TPS（decode-speed）= ΣoutputTokens / Σ(messageTime − firstTokenTime)：100 tok / 50ms = 2000 tok/s', () => {
    for (const events of [liveEvents, historyEvents]) {
      const row = fold(events).turns['3']
      assert.equal(row.decodeTokens / (row.decodeMs / 1000), 2000)
    }
  })
  it('step/end 关边界：其后再来同 step 的事件不再改变任何数值', () => {
    const base = fold(liveEvents)
    const after = fold([...liveEvents,
      at(2100, 'assistant/attempt', { turn: 3, step: 1, stream: [tokenAt(2100)] }),
      at(2200, 'assistant/message', { turn: 3, step: 1, message: {}, stream: [tokenAt(2100)], usage: USAGE }),
    ])
    assert.deepEqual(after.turns, base.turns)
  })
  it('无关事件返回同一状态引用（Object.is 稳定，不触发无谓广播）', () => {
    const state = fold(liveEvents)
    for (const event of [
      at(3000, 'tool/call', { turn: 9, step: 1, callId: 'x', name: 'read', arguments: '{}' }),
      at(3001, 'tool/result', { turn: 9, step: 1 }),
      at(3002, 'user/message', {}),
      at(3003, 'turn/end', { turn: 9, reason: { kind: 'completed' } }),
    ]) {
      assert.equal(turnFoldApply(state, event), state)
    }
    assert.equal(turnFoldView(state), turnFoldView(state), '同一 turns 引用 → 同一视图对象')
  })
})

describe('turnFoldMetrics：多 step / 分母语义', () => {
  it('两个 step 加权聚合：100 tok / 500ms（step1）+ 300 tok / 500ms（step2）→ 400 tok / 1s = 400 tok/s', () => {
    const state = fold([
      at(0, 'step/start', { turn: 1, step: 1 }),
      at(600, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [tokenAt(100)], usage: { outputTokens: 100 } }),
      at(700, 'step/end', { turn: 1, step: 1 }),
      at(5000, 'step/start', { turn: 1, step: 2 }),
      at(5600, 'assistant/message', { turn: 1, step: 2, message: {}, stream: [tokenAt(5100)], usage: { outputTokens: 300 } }),
      at(5700, 'step/end', { turn: 1, step: 2 }),
    ])
    const row = state.turns['1']
    assert.equal(row.decodeTokens, 400)
    assert.equal(row.decodeMs, 1000, '两个 step 各 500ms decode')
    assert.equal(row.decodeTokens / (row.decodeMs / 1000), 400)
    assert.equal(row.ttftMs, 100, '首字取第一个有证据的 step')
  })
  it('TTFT 不进分母：首字延迟 500ms，decode 仍只算 message−firstToken', () => {
    const state = fold([
      at(0, 'step/start', { turn: 2, step: 1 }),
      at(600, 'assistant/message', { turn: 2, step: 1, message: {}, stream: [tokenAt(500)], usage: { outputTokens: 100 } }),
      at(700, 'step/end', { turn: 2, step: 1 }),
    ])
    const row = state.turns['2']
    assert.equal(row.ttftMs, 500)
    assert.equal(row.decodeMs, 100, 'decode 只算 message 时间 − 首字时间')
  })
  it('工具执行与 step 间等待不进分母：step 之间隔 60s 也不影响 decode', () => {
    const state = fold([
      at(0, 'step/start', { turn: 4, step: 1 }),
      at(100, 'assistant/message', { turn: 4, step: 1, message: {}, stream: [tokenAt(50)], usage: { outputTokens: 50 } }),
      at(150, 'step/end', { turn: 4, step: 1 }),
      at(60150, 'step/start', { turn: 4, step: 2 }),
      at(60250, 'assistant/message', { turn: 4, step: 2, message: {}, stream: [tokenAt(60200)], usage: { outputTokens: 50 } }),
      at(60300, 'step/end', { turn: 4, step: 2 }),
    ])
    assert.equal(state.turns['4'].decodeMs, 100)
    assert.equal(state.turns['4'].decodeTokens / (state.turns['4'].decodeMs / 1000), 1000)
  })
  it('未完成的 step（无 assistant/message）不计入', () => {
    const state = fold([
      at(0, 'step/start', { turn: 5, step: 1 }),
      at(200, 'assistant/message', { turn: 5, step: 1, message: {}, stream: [tokenAt(100)], usage: { outputTokens: 10 } }),
      at(300, 'step/end', { turn: 5, step: 1 }),
      at(400, 'step/start', { turn: 5, step: 2 }),
      at(500, 'assistant/attempt', { turn: 5, step: 2, stream: [tokenAt(500)] }),
    ])
    assert.deepEqual(state.turns['5'], { ttftMs: 100, decodeMs: 100, decodeTokens: 10 })
  })
  it('retry：同一 step 内首个 attempt 的首字不被后续 attempt 覆盖', () => {
    const state = fold([
      at(0, 'step/start', { turn: 6, step: 1 }),
      at(100, 'assistant/attempt', { turn: 6, step: 1, stream: [tokenAt(100)] }),
      at(200, 'llm/retry', { turn: 6, step: 1 }),
      at(900, 'assistant/attempt', { turn: 6, step: 1, stream: [tokenAt(900)] }),
      at(1000, 'assistant/message', { turn: 6, step: 1, message: {}, stream: [tokenAt(950)], usage: { outputTokens: 20 } }),
      at(1100, 'step/end', { turn: 6, step: 1 }),
    ])
    const row = state.turns['6']
    assert.equal(row.ttftMs, 100, '首字 = 第一次 attempt 的 100ms（retry 不重置）')
    assert.equal(row.decodeMs, 900, 'decode = message 时间 − 首个首字（跨 attempt，官方同款）')
    assert.equal(row.decodeTokens, 20)
  })
  it('异常回合：interrupted 的 assistant/message 仍按真实证据计入', () => {
    const state = fold([
      at(0, 'step/start', { turn: 7, step: 1 }),
      at(300, 'assistant/message', { turn: 7, step: 1, message: {}, stream: [tokenAt(200)], usage: { outputTokens: 5 }, interrupted: true }),
      at(400, 'turn/end', { turn: 7, reason: { kind: 'aborted' } }),
    ])
    assert.deepEqual(state.turns['7'], { ttftMs: 200, decodeMs: 100, decodeTokens: 5 })
  })
})

describe('turnFoldMetrics：没有真实证据就不产出（NO FAKE TIMING）', () => {
  it('stream 无 token → 不产生 ttft（也不产生 decode）', () => {
    const state = fold([
      at(0, 'step/start', { turn: 8, step: 1 }),
      at(100, 'assistant/message', { turn: 8, step: 1, message: {}, stream: [raw(50, { type: 'text-delta', index: 0, text: '' })], usage: { outputTokens: 10 } }),
    ])
    assert.equal(state.turns['8'], undefined)
  })
  it('有首字但缺 usage → 只记 ttft，不记 decode', () => {
    const state = fold([
      at(100, 'step/start', { turn: 9, step: 1 }),
      at(300, 'assistant/message', { turn: 9, step: 1, message: {}, stream: [tokenAt(200)] }),
    ])
    assert.deepEqual(state.turns['9'], { ttftMs: 100, decodeMs: 0, decodeTokens: 0 })
  })
  it('usage 形状异常（负 / NaN / 字符串）视为缺报', () => {
    for (const usage of [{ outputTokens: -1 }, { outputTokens: Number.NaN }, { outputTokens: '10' }, null, 42]) {
      const state = fold([
        at(100, 'step/start', { turn: 10, step: 1 }),
        at(300, 'assistant/message', { turn: 10, step: 1, message: {}, stream: [tokenAt(200)], usage }),
      ])
      assert.deepEqual(state.turns['10'], { ttftMs: 100, decodeMs: 0, decodeTokens: 0 }, JSON.stringify(usage))
    }
  })
  it('同 step 的第二次 assistant/message 不重复累计（边界只结算一次）', () => {
    const events = [
      at(0, 'step/start', { turn: 11, step: 1 }),
      at(300, 'assistant/message', { turn: 11, step: 1, message: {}, stream: [tokenAt(200)], usage: { outputTokens: 10 } }),
    ]
    const once = fold(events)
    const twice = fold([...events, at(400, 'assistant/message', { turn: 11, step: 1, message: {}, stream: [tokenAt(200)], usage: { outputTokens: 10 } })])
    assert.deepEqual(twice.turns, once.turns)
  })
})

describe('turnFoldMetrics：状态/视图契约与边界', () => {
  it('视图与状态同构（只暴露 per-turn 数值），schema 校验通过', () => {
    const state = fold([
      at(0, 'step/start', { turn: 12, step: 1 }),
      at(300, 'assistant/message', { turn: 12, step: 1, message: {}, stream: [tokenAt(100)], usage: { outputTokens: 7 } }),
    ])
    const view = turnFoldView(state)
    assert.deepEqual(turnFoldMetricsProjection.wire.viewSchema.parse(view), view)
    assert.deepEqual(turnFoldMetricsProjection.stateSchema.parse(state), state)
  })
  it('状态 schema 拒绝损坏的持久化行（缓存命中脏数据时抛错而非静默污染）', () => {
    const schema = turnFoldMetricsProjection.stateSchema
    for (const bad of [null, 42, {}, { turns: null }, { turns: { x: {} } }, { turns: { 1: null } }, { open: 'x' }]) {
      assert.throws(() => schema.parse(bad), /turnFoldMetrics/, JSON.stringify(bad))
    }
  })
  it('视图 schema 只放行规范形状', () => {
    const schema = turnFoldMetricsProjection.wire.viewSchema
    assert.deepEqual(schema.parse({ turns: { 1: { decodeMs: 4, decodeTokens: 2 } } }), { turns: { 1: { decodeMs: 4, decodeTokens: 2 } } })
    for (const bad of [null, {}, { turns: 5 }]) assert.throws(() => schema.parse(bad), /turnFoldMetrics/)
  })
  it('上限保护：超过 MAX_TURNS 时丢最旧回合（内存有界，明确降级）', () => {
    let state = turnFoldInit()
    const total = 2005
    for (let turn = 1; turn <= total; turn += 1) {
      state = turnFoldApply(state, at(turn * 10, 'step/start', { turn, step: 1 }))
      state = turnFoldApply(state, at(turn * 10 + 1, 'assistant/message', { turn, step: 1, message: {}, stream: [tokenAt(turn * 10 + 1)], usage: { outputTokens: 1 } }))
    }
    const keys = Object.keys(state.turns)
    assert.equal(keys.length, 2000)
    assert.equal(state.turns['1'], undefined, '最旧的回合被丢弃（降级为 —）')
    assert.ok(state.turns['2005'] !== undefined, '最新回合保留')
  })
  it('key 与 stateVersion 归插件所有（不与官方 sessionStats 冲突）', () => {
    assert.equal(turnFoldMetricsProjection.key, 'turnFoldMetrics')
    assert.equal(turnFoldMetricsProjection.stateVersion, 1)
    assert.ok(typeof turnFoldMetricsProjection.init === 'function')
    assert.ok(typeof turnFoldMetricsProjection.apply === 'function')
  })
})

// ══════════════════════════════════════════════════════════════════════
// 真实数据夹具：一段真实会话回合并入后的落盘事件（文本已脱敏，时间戳/结构原样）
// ══════════════════════════════════════════════════════════════════════
// 来源：用户本机 ~/.dsh/sessions 里的真实会话（v0 日志 → 官方迁移链 → v4），
// 取其中一个带工具调用的 step（step/start … assistant/message(stream+usage) … step/end）。
// 期望值由官方 assistantStreamFirstTokenTime 独立核算（验收脚本对 38 个真实会话
// × 532 个 turn 做了同款对拍，零差异）。
import { readFileSync } from 'node:fs'
const REAL_TURN = JSON.parse(readFileSync(new URL('./fixtures/real-turn-slice.json', import.meta.url), 'utf8'))

describe('真实会话回合（落盘事件）上的 durable 指标', () => {
  it('首字谓词在真实 packed stream 上给出真实首字时间', () => {
    const message = REAL_TURN.events.find((event) => event.type === 'assistant/message')
    const start = REAL_TURN.events.find((event) => event.type === 'step/start')
    assert.equal(firstTokenOf(message.data.stream), 1786630332531)
    assert.ok(message.data.stream.some((record) => record.type === 'tool-call-chunks' || record.type === 'reasoning-chunks'), '真实流里含打包 run')
    void start
  })
  it('折叠出真实 TTFT / decode / outputTokens，并换算成 decode-speed', () => {
    const state = fold(REAL_TURN.events)
    const start = REAL_TURN.events.find((event) => event.type === 'step/start')
    const row = state.turns[String(start.data.turn)]
    assert.deepEqual(row, { ttftMs: 1508, decodeMs: 2219, decodeTokens: 313 })
    assert.equal(Number((row.decodeTokens / (row.decodeMs / 1000)).toFixed(2)), 141.05)
  })
  it('真实回合的 turn 行可通过 wire 校验并进入客户端视图形状', () => {
    const view = turnFoldMetricsProjection.wire.viewSchema.parse(turnFoldView(fold(REAL_TURN.events)))
    const start = REAL_TURN.events.find((event) => event.type === 'step/start')
    assert.equal(view.turns[String(start.data.turn)].ttftMs, 1508)
  })
  it('同一回合的 live 形态（含 assistant/attempt）与 history 形态折叠一致', () => {
    const start = REAL_TURN.events.find((event) => event.type === 'step/start')
    const message = REAL_TURN.events.find((event) => event.type === 'assistant/message')
    // 历史形态：只有落盘的 assistant/message（stream 不完整于 attempt 时也够用）
    const history = fold([start, message, ...REAL_TURN.events.filter((event) => event.type === 'step/end')])
    const live = fold([start, { type: 'assistant/attempt', time: message.time - 1200, data: { turn: message.data.turn, step: message.data.step, stream: message.data.stream } }, message, ...REAL_TURN.events.filter((event) => event.type === 'step/end')])
    const turn = String(start.data.turn)
    assert.equal(live.turns[turn].ttftMs, history.turns[turn].ttftMs)
    assert.equal(live.turns[turn].decodeMs, history.turns[turn].decodeMs)
    assert.equal(live.turns[turn].decodeTokens, history.turns[turn].decodeTokens)
  })
})
