// Round 11：bundle 装载时序竞态的回归测试（0.2.0-rc.2 真机定位）。
// 场景：本插件以 bundle 方式装载时，apply 可能先于官方 conversation 层——
// 此刻 conversation.chat.node 未声明，"没有 turn-process 条目"不是 legacy 证据。
// 修复语义：unknown + slots/changed 事件驱动补定论（微任务批后复判）。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'

const { test: T } = loadPlugin({ window: (await import('./helpers/dom.mjs')).sharedWindow })

/** 带 snapshot 检查面的假 slots：可建模"槽位未声明 → 已声明 + 条目落地"的真实时序。 */
function makeScopedSlots(opts = {}) {
  const state = { spec: opts.declared ? { kind: 'keyed', scope: 'session' } : undefined, entries: opts.entries ? opts.entries.slice() : [] }
  const listeners = new Set()
  const changed = (key) => { for (const fn of [...listeners]) fn(key) }
  const slots = {
    state,
    // 官方 service 只读检查面：声明中 → 恰一棵子树；未声明 → []
    snapshot: (root) => (root === 'conversation.chat.node' && state.spec ? [{ name: root, kind: 'keyed', scope: 'session', occupants: [] }] : []),
    entries: (name) => (name === 'conversation.chat.node' ? state.entries.slice() : []),
    // 官方语义：每 cell 最低 priority 的首个 live 条目（winner 投影）
    entriesOfSlot: (name) => {
      if (name !== 'conversation.chat.node') return []
      const sorted = state.entries.slice().sort((a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)))
      const seen = {}
      const winners = []
      for (const e of sorted) { const k = e.options.key; if (seen[k]) continue; seen[k] = true; winners.push(e) }
      return winners
    },
    inject: (_slot, fn) => fn(),
    register: (options, component) => {
      state.entries = state.entries.filter((e) => e.options.key !== options.key || (e.options.priority ?? 0) !== (options.priority ?? 0))
      const entry = { options, component }
      state.entries.push(entry)
      changed(options.name)
      return () => {
        state.entries = state.entries.filter((e) => e !== entry)
        changed(options.name)
      }
    },
    subscribe: (_k, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    onEntryError: () => () => {},
    emit: changed,
    onSlotsChanged: (fn) => { listeners.add(fn) },
    offSlotsChanged: (fn) => { listeners.delete(fn) },
  }
  return slots
}

function makeCtx(slots) {
  // cordis 事件总线是共享单例（isolate 相同 → 全域派发）：ctx.on 与 slots 的
  // markDirty 走同一张 listener 表——fake 里把两者接到同一个集合。
  return {
    inject: (_deps, fn) => fn({ slots }),
    on: (name, fn) => {
      if (name === 'slots/changed') slots.onSlotsChanged(fn)
      return () => slots.offSlotsChanged(fn)
    },
  }
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

describe('Round11：bundle 装载时序的 turnFold 延迟定论', () => {
  beforeEach(() => {
    T.hostCapabilityState.turnFold = 'unknown'
    T.hostCapabilityState.stepFold = 'unknown'
    T.hostCapabilityState.metrics = 'unknown'
    T.resetDeferredTurnFoldResolution()
    T.resetLegacyTurnBootstrapState()
  })

  it('R1 槽位未声明：apply 期不定论（unknown），不激活 legacy、不注册 turn-process', () => {
    const slots = makeScopedSlots({ declared: false, entries: [] })
    T.exports.apply(makeCtx(slots))
    assert.equal(T.hostCapabilityState.turnFold, 'unknown', '未声明 ≠ legacy')
    assert.equal(T.getLegacyEngineActivations().turn, 0, '不激活 Legacy Turn')
    assert.equal(T.getLegacyStepRegistrationKeys().length, 0, '零注册')
    assert.equal(T.getDeferredTurnFoldResolutionState().pending, true, '延迟定论在等待')
  })

  it('R2 官方声明 + turn-process 落地 → 事件驱动补定论 modern 并注册 Turn 渲染器', async () => {
    const slots = makeScopedSlots({ declared: false, entries: [] })
    T.exports.apply(makeCtx(slots))
    assert.equal(T.hostCapabilityState.turnFold, 'unknown')
    // 官方 conversation 层 apply：声明子槽 + 注册条目（含 turn-process），同步完成
    slots.state.spec = { kind: 'keyed', scope: 'session' }
    slots.emit('conversation.chat.node')   // 父槽声明引发的首个突变（此刻条目可能为空）
    slots.state.entries.push({ options: { key: 'user', priority: 0 }, component: () => null })
    slots.state.entries.push({ options: { key: 'turn-process', priority: 0 }, component: () => null })
    slots.emit('conversation.chat.node')   // 官方注册完成
    await flushMicrotasks()
    assert.equal(T.hostCapabilityState.turnFold, 'modern', '补定论 modern')
    assert.equal(T.getDeferredTurnFoldResolutionState().pending, false, '定论后停止等待')
    const registered = slots.state.entries.filter((e) => e.component === T.EnhancedTurnProcessView)
    assert.equal(registered.length, 1, '现代 Turn 渲染器已注册（bundle 装载路径）')
    assert.ok(registered[0].options.priority < 0, 'shadow 优先级低于官方（接管）')
    assert.equal(T.getLegacyEngineActivations().turn, 0, '现代宿主 legacy 激活恒 0')
    assert.equal(T.getLegacyStepRegistrationKeys().length, 0, '零 legacy 注册')
  })

  it('R3 官方声明 + 无 turn-process（0.1.1 形态）→ 补定论 legacy 并激活 Turn 引擎', async () => {
    const slots = makeScopedSlots({ declared: false, entries: [] })
    T.exports.apply(makeCtx(slots))
    slots.state.spec = { kind: 'keyed', scope: 'session' }
    slots.emit('conversation.chat.node')
    // 官方 inject 回调同步注册一批节点渲染器（无 turn-process：0.1.1）
    slots.state.entries.push({ options: { key: 'user', priority: 0 }, component: () => null })
    slots.state.entries.push({ options: { key: 'assistant-step', priority: 0 }, component: () => null })
    slots.state.entries.push({ options: { key: 'tool-call', priority: 0 }, component: () => null })
    slots.state.entries.push({ options: { key: 'context', priority: 0 }, component: () => null })
    slots.emit('conversation.chat.node')
    await flushMicrotasks()
    assert.equal(T.hostCapabilityState.turnFold, 'legacy', '声明后无 turn-process → legacy')
    assert.equal(T.getLegacyEngineActivations().turn, 1, 'Legacy Turn 引擎激活一次')
    // bootstrap 同步首查（三个 builtin 已就绪）→ full-legacy 3 键
    assert.deepEqual(T.getLegacyStepRegistrationKeys(), ['assistant-step', 'tool-call', 'context'])
    assert.equal(T.getLegacyNodeBackendState().mode, 'full-legacy')
    assert.equal(T.getDeferredTurnFoldResolutionState().pending, false)
  })

  it('R4 声明突变先于条目落地（官方 markDirty 顺序）：空条目不定论，继续等下一次突变', async () => {
    const slots = makeScopedSlots({ declared: false, entries: [] })
    T.exports.apply(makeCtx(slots))
    slots.state.spec = { kind: 'keyed', scope: 'session' }
    slots.emit('conversation.chat.node')   // 声明突变：此刻条目为空
    await flushMicrotasks()
    assert.equal(T.hostCapabilityState.turnFold, 'unknown', '零条目不定论（防误判 0.2.0 为 legacy）')
    assert.equal(T.getDeferredTurnFoldResolutionState().pending, true, '继续等待')
    // 官方渲染器随后落地
    slots.state.entries.push({ options: { key: 'turn-process', priority: 0 }, component: () => null })
    slots.emit('conversation.chat.node')
    await flushMicrotasks()
    assert.equal(T.hostCapabilityState.turnFold, 'modern')
    assert.equal(slots.state.entries.filter((e) => e.component === T.EnhancedTurnProcessView).length, 1)
  })

  it('R5 三态映射：nativeTurnFold=undefined → turnFold=unknown（绝不猜 legacy）', () => {
    assert.equal(T.hostCapabilitiesOf({ nativeTurnFold: undefined }).turnFold, 'unknown')
    assert.equal(T.hostCapabilitiesOf({ nativeTurnFold: false }).turnFold, 'legacy')
    assert.equal(T.hostCapabilitiesOf({ nativeTurnFold: true }).turnFold, 'modern')
  })

  it('R6 无 snapshot 的宿主（极简宿主）保持既有语义：absence ⇒ legacy', () => {
    const before = T.getLegacyEngineActivations()
    const slots = {
      entries: (name) => (name === 'conversation.chat.node' ? [] : []),
      inject: (_s, fn) => fn(),
      on: () => () => {},
    }
    T.exports.apply({ inject: (_d, fn) => fn({ slots }), on: () => () => {} })
    void slots
    assert.equal(T.hostCapabilityState.turnFold, 'legacy', '无法区分未声明 → 保持既有判定')
    assert.equal(T.getLegacyEngineActivations().turn - before.turn, 1)
    assert.equal(T.getDeferredTurnFoldResolutionState().pending, false, '不进入延迟定论')
  })
})
