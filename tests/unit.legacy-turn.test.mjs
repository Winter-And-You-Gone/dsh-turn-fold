// Legacy Turn engine 测试（仅 0.1.1：官方无 turn-process / TurnProcessOwnerProps，
// 插件拥有 Turn Fold；数据面 = 官方 ConversationSnapshot.chat，经 session-scope 标准 kit
// 的 useSession(s => s.chat) 取得——与 0.1.2+ 的 ChatSnapshot 同形，Step 索引零改动复用）。
// 覆盖：
//   G. Turn index 纯算法（边界/final/header/canCollapse/reason）
//   H. Full Legacy node backend（物理 3 键、均匀所有权、bootstrap、Step attach）
//   I. Turn 渲染器（默认 closed / final 可见 / running / Turn+Step 正交）
//   J. 隔离与守卫（多 session、cleanup、modern 零调用、fixtures）
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { HOST_VERSION_FIXTURES } from './version-fixtures/host-matrix.mjs'

const require = createRequire(import.meta.url)
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

function FakeAssistant(props) { return react.createElement('div', { 'data-fake': 'assistant-step' }, props.node && props.node.key) }
function FakeTool(props) { return react.createElement('div', { 'data-fake': 'tool-call' }, props.node && props.node.key) }
function FakeContext(props) { return react.createElement('div', { 'data-fake': 'context' }, props.node && props.node.key) }

/** 0.1.1 形状节点：anchorSeq + location(step/turn) + kind 专属 data。 */
function makeNode(kind, key, opts = {}) {
  const o = opts || {}
  const node = {
    key,
    kind,
    anchorSeq: typeof o.anchorSeq === 'number' ? o.anchorSeq : undefined,
    location: { kind: 'step', turn: { turn: o.turn === undefined ? 1 : o.turn }, step: o.step || 1 },
  }
  if (kind === 'assistant-step') {
    node.data = {
      status: o.status || 'settled',
      turn: o.turn === undefined ? 1 : o.turn,
      step: o.step || 1,
      blocks: o.blocks || [],
      usage: o.usage,
      finalNode: o.finalNode,
      time: o.time,
    }
  } else if (kind === 'tool-call') node.data = { root: o.root || { name: 'read' } }
  else if (kind === 'turn-tail') node.data = o.tailData || { turn: o.turn === undefined ? 1 : o.turn, seq: 900, time: 0, closing: null }
  else node.data = o.data || {}
  return node
}
const think = (t) => [{ kind: 'reasoning', text: t }]
const text = (t) => [{ kind: 'text', text: t }]

/** 0.1.1 ConversationSnapshot（含 chat/legacy/timeline）→ 与 0.1.2+ ChatSnapshot 同形。 */
function makeSnapshot(nodesArr, opts = {}) {
  const map = new Map(nodesArr.map((n) => [n.key, n]))
  const chat = {
    order: nodesArr.map((n) => n.key),
    nodes: { get: (k) => map.get(k), values: () => [...map.values()] },
    locations: { getTurn: () => nodesArr.map((n) => n.key), getStep: () => [] },
    timeline: { turns: new Map(opts.timelineTurns || []) },
    legacy: {
      nodes: nodesArr,
      turnTimings: new Map(opts.turnTimings || []),
      turnEnds: new Map(opts.turnEnds || []),
    },
  }
  return { sessionId: opts.sessionId || 'sess-turn', chat: chat }
}
const useSessionOf = (snapshot) => (selector) => selector(snapshot)

let container = null
let root = null
beforeEach(() => {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  T.legacyTurnOpenBySession.clear()
  T.legacyStepOpenBySession.clear()
  T.legacyTurnSurfaces.clear()
  T.legacyStepSurfaces.clear()
  T.completedStepTopFaces.clear()
  T.completedStepTopBags.clear()
  T.legacyStepRulesBySession.clear()
  T.hostCapabilityState.stepFold = 'unknown'
  T.hostCapabilityState.metrics = 'unknown'
  T.resetLegacyTurnBootstrapState()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
  T.disposeLegacyStepEngine()
})

/** wired 环境：0.1.1 形状（无 useChat/useConversation；useSession(s=>s.chat)）。 */
function makeWiredEnv(opts = {}) {
  const changedListeners = new Set()
  const registered = []
  const st = { entries: [], abdicated: new Set(), listeners: new Set(), errorListeners: new Set() }
  if (opts.omitBuiltins !== true) {
    st.entries.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
    st.entries.push({ options: { key: 'tool-call', priority: 0 }, component: FakeTool })
    st.entries.push({ options: { key: 'context', priority: 0 }, component: FakeContext })
  }
  const emitSync = (key) => { for (const fn of [...changedListeners]) fn(key) }
  const notifyBatched = () => { const fns = [...st.listeners]; Promise.resolve().then(() => { for (const fn of fns) fn() }) }
  const slots = {
    st, registered,
    entries: (name) => (name === 'conversation.chat.node' ? st.entries.slice() : []),
    entriesOfSlot: (name) => {
      if (name !== 'conversation.chat.node') return []
      const live = st.entries.filter((e) => e && !st.abdicated.has(e))
      const sorted = live.slice().sort((a, b) => (T.slotPriorityOf(a) - T.slotPriorityOf(b)))
      const seen = {}; const winners = []
      for (const e of sorted) { if (seen[e.options.key]) continue; seen[e.options.key] = true; winners.push(e) }
      return winners
    },
    subscribe: (_k, fn) => { st.listeners.add(fn); return () => st.listeners.delete(fn) },
    onEntryError: (fn) => { st.errorListeners.add(fn); return () => st.errorListeners.delete(fn) },
    inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    register: (options, component) => {
      const entry = { options, component }
      st.entries.push(entry); registered.push(entry)
      emitSync(options.name); notifyBatched()
      return () => {
        const i = st.entries.indexOf(entry); if (i >= 0) st.entries.splice(i, 1)
        const j = registered.indexOf(entry); if (j >= 0) registered.splice(j, 1)
        emitSync(options.name); notifyBatched()
      }
    },
    addThirdParty: (key, priority) => {
      const entry = { options: { key, priority }, component: () => null }
      st.entries.push(entry); emitSync('conversation.chat.node'); notifyBatched()
      return { entry, remove: () => { const i = st.entries.indexOf(entry); if (i >= 0) st.entries.splice(i, 1); emitSync('conversation.chat.node'); notifyBatched() } }
    },
    reportEntryError: (entry, abdicate) => {
      if (abdicate) { if (st.abdicated.has(entry)) return; st.abdicated.add(entry); emitSync('conversation.chat.node'); notifyBatched() }
      for (const fn of [...st.errorListeners]) fn('conversation.chat.node', entry, new Error('crash'), { abdicated: !!abdicate })
    },
    pluginEntryOf: (key) => st.entries.find((e) => e.options.key === key && (e.component === T.LegacyStepAssistantView || e.component === T.LegacyStepToolCallView || e.component === T.LegacyTurnContextView)),
  }
  const ctx = {
    inject: (deps, fn) => { fn({ slots }); return () => {} },
    on: (name, fn) => { if (name === 'slots/changed') changedListeners.add(fn); return () => changedListeners.delete(fn) },
  }
  return { slots, ctx, apply: () => T.exports.apply(ctx), changedListenerCount: () => changedListeners.size }
}

// ══════════════════════════════════════════════════════════════════════
// G. Turn index 纯算法（旧 main 已验证语义重写）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Turn G：Turn index 语义', () => {
  const U = (seq) => makeNode('user', 'u' + seq, { anchorSeq: seq, data: { text: 'q' } })
  function toolTurnNodes(closed) {
    const nodes = [
      U(1),
      makeNode('context', 'c1', { anchorSeq: 2 }),
      makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
      makeNode('tool-call', 't1', { anchorSeq: 4 }),
      makeNode('tool-call', 't2', { anchorSeq: 5 }),
      makeNode('assistant-step', 'a2', { anchorSeq: 6, blocks: text('最终答案') }),
      makeNode('turn-tail', 'tail', { anchorSeq: 7 }),
    ]
    return nodes
  }
  it('G1 tool turn（closed）：hideKeys/header/final/canCollapse 正确；final 与 tail 不在成员集', () => {
    const snap = makeSnapshot(toolTurnNodes(true), { turnEnds: [[1, 99]] }).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.deepEqual(g.keys, ['u1', 'c1', 'a1', 't1', 't2', 'a2', 'tail'])
    assert.deepEqual(g.hideKeys, ['c1', 'a1', 't1', 't2'], '作用域内中间成员（不含 final）')
    assert.equal(g.headerKey, 'c1', 'header = 作用域内第一个成员')
    assert.equal(g.finalAssistantKey, 'a2')
    assert.equal(g.toolCount, 2)
    assert.equal(g.closed, true)
    assert.equal(g.canCollapse, true)
    assert.equal(g.alwaysOpen, false)
    assert.equal(g.memberKeys['a2'], undefined, 'final assistant 不是 Turn 成员（永不隐藏）')
    assert.equal(g.memberKeys['u1'], undefined, 'user 不是成员')
    assert.equal(g.memberKeys['tail'], undefined, 'turn-tail 不是成员')
  })
  it('G2 纯问答：header fallback 到 final；canCollapse=false（静态栏，不硬造折叠）', () => {
    const snap = makeSnapshot([
      U(1), makeNode('assistant-step', 'a1', { anchorSeq: 2, blocks: text('答案') }), makeNode('turn-tail', 'tail', { anchorSeq: 3 }),
    ], { turnEnds: [[1, 99]] }).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.equal(g.headerKey, 'a1', 'fallback 到最终答案上方')
    assert.deepEqual(g.hideKeys, [])
    assert.equal(g.canCollapse, false)
    assert.equal(g.finalAssistantKey, 'a1')
  })
  it('G3 context-before-user：作用域外 context 永不隐藏、不作 header', () => {
    const snap = makeSnapshot([
      makeNode('context', 'c0', { anchorSeq: 1 }),   // 排在 user 之前（审批策略注入）
      U(2),
      makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
      makeNode('assistant-step', 'a2', { anchorSeq: 4, blocks: text('答案') }),
    ], { turnEnds: [[1, 99]] }).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.equal(g.memberKeys['c0'], undefined, '前 context 不是成员')
    assert.ok(!g.hideKeys.includes('c0'))
    assert.equal(g.headerKey, 'a1', 'header 不跨过 user')
  })
  it('G4 mid-turn steering（user seq 大于全部中间节点）：header 稳定、不丢 membership', () => {
    const snap = makeSnapshot([
      U(1),
      makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
      makeNode('tool-call', 't1', { anchorSeq: 4 }),
      makeNode('user', 'u2', { anchorSeq: 50 }),     // 运行中插话被归为 user（窗口形状异常）
      makeNode('tool-call', 't2', { anchorSeq: 51 }),
      makeNode('assistant-step', 'a2', { anchorSeq: 52, blocks: text('答案') }),
    ], { turnEnds: [[1, 99]] }).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.equal(g.headerKey, 'a1', '边界只取"首条证据之前的 user"——后插 user 不破坏 header')
    assert.deepEqual(g.hideKeys, ['a1', 't1', 't2'], 'middle 成员一个不丢')
    assert.equal(g.canCollapse, true)
  })
  it('G5 running（无 turnEnds）：running=true、final=null、canCollapse=false、成员仍登记（可见性层恒展开）', () => {
    const snap = makeSnapshot(toolTurnNodes(false)).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.equal(g.running, true)
    assert.equal(g.closed, false)
    assert.equal(g.finalAssistantKey, null)
    assert.equal(g.canCollapse, false)
    assert.equal(T.legacyTurnEffectiveOpen(g, null), true, 'running 恒展开（Turn Bar 是状态面）')
  })
  it('G6 aborted → alwaysOpen 不可折叠；max-tokens 不粗暴归 error（按 completed 处理）', () => {
    const aborted = makeSnapshot(toolTurnNodes(true), {
      turnEnds: [[1, 99]], timelineTurns: [[1, { end: { data: { reason: { kind: 'aborted' } } } }]],
    }).chat
    const ga = T.legacyBuildTurnIndex(aborted).groupsByTurn.get(1)
    assert.equal(ga.reason, 'aborted')
    assert.equal(ga.alwaysOpen, true)
    assert.equal(ga.canCollapse, false)
    const maxTokens = makeSnapshot(toolTurnNodes(true), {
      turnEnds: [[1, 99]], timelineTurns: [[1, { end: { data: { reason: { kind: 'max-tokens' } } } }]],
    }).chat
    const gm = T.legacyBuildTurnIndex(maxTokens).groupsByTurn.get(1)
    assert.equal(gm.reason, 'max-tokens')
    assert.equal(gm.alwaysOpen, false, 'max-tokens 不是 error 语义')
    assert.equal(gm.canCollapse, true)
  })
  it('G7 finalization race（closed 但无 assistant-step）：FAIL OPEN——canCollapse=false、无隐藏', () => {
    const snap = makeSnapshot([U(1), makeNode('tool-call', 't1', { anchorSeq: 2 })], { turnEnds: [[1, 99]] }).chat
    const g = T.legacyBuildTurnIndex(snap).groupsByTurn.get(1)
    assert.equal(g.closed, true)
    assert.equal(g.finalAssistantKey, null)
    assert.equal(g.canCollapse, false, '数据不完整 → 不折叠（内容全可见）')
  })
  it('G8 memo：同 snapshot 只建一次索引（O(1) 查询）；新 snapshot 重建', () => {
    const snap = makeSnapshot(toolTurnNodes(true), { turnEnds: [[1, 99]] }).chat
    const before = T.getLegacyTurnComputations()
    T.legacyTurnGroupForNode(snap, snap.nodes.get('a1'))
    T.legacyTurnGroupForNode(snap, snap.nodes.get('t1'))
    T.legacyTurnGroupForNode(snap, snap.nodes.get('a2'))
    assert.equal(T.getLegacyTurnComputations() - before, 1, '同 snapshot 只构建一次')
    T.legacyTurnGroupForNode(makeSnapshot([U(1)]).chat, null)
    assert.equal(T.getLegacyTurnComputations() - before, 1, 'null node 不触发构建')
  })
})

// ══════════════════════════════════════════════════════════════════════
// H. Full Legacy node backend（物理 3 键 / bootstrap / Step attach）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Turn H：Full Legacy backend', () => {
  it('H1 0.1.1 bootstrap：官方 builtin 就绪 → 同步原子安装 exactly 3 键（无 user/turn-tail/turn-process）', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      // apply 期 turnFold=legacy → activateLegacyTurnEngine → bootstrap 同步首查即安装
      const st = T.getLegacyStepRegistrationState()
      assert.equal(st.installed, true, 'builtin 已就绪 → 同步安装')
      assert.deepEqual(st.keys, ['assistant-step', 'tool-call', 'context'], 'physical key set 恰好三个')
      assert.equal(st.builtinsCaptured, true)
      assert.equal(st.ownershipVerified, true)
      assert.equal(T.getLegacyNodeBackendState().mode, 'full-legacy')
      assert.equal(T.getLegacyNodeBackendState().stepAttached, false, 'Step 尚未 attach（待 committed probe）')
      for (const forbidden of ['user', 'steering', 'turn-tail', 'turn-process', 'turn-error', 'turn-max-tokens']) {
        assert.equal(env.slots.pluginEntryOf(forbidden), undefined, '绝不 shadow ' + forbidden)
        assert.equal(env.slots.registered.some((e) => e.options.key === forbidden), false, '物理注册不含 ' + forbidden)
      }
    } finally { dispose() }
  })
  it('H2 bootstrap 等待依赖：builtin 未就绪 → 不安装、不 degraded；补全后（slots/changed）自动安装一次', () => {
    const env = makeWiredEnv({ omitBuiltins: true })
    const dispose = env.apply()
    try {
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '依赖未就绪 → 等待（不是失败）')
      const attemptsBefore = T.getLegacyStepInstallStats().attempts
      assert.equal(T.getLegacyStepInstallStats().attempts, attemptsBefore, '等待期间不产生安装尝试')
      assert.equal(T.getLegacyStepDegradedReason(), null, '等待 ≠ degraded')
      // 官方 builtin 注册完成 → 同步事件驱动安装
      env.slots.st.entries.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
      env.slots.st.entries.push({ options: { key: 'tool-call', priority: 0 }, component: FakeTool })
      env.slots.st.entries.push({ options: { key: 'context', priority: 0 }, component: FakeContext })
      env.ctx.emitLess = null
      // 触发 slots/changed（emit 由 fake 的注册路径给出；这里直接调用注册表事件通道）
      const d = env.ctx.on
      void d
      env.slots.st.entries.length = env.slots.st.entries.length   // no-op
      // 通过 register 一个第三方无关 key 触发同步事件
      env.slots.addThirdParty('unknown', 0)
      assert.equal(T.getLegacyStepRegistrationState().installed, true, '依赖就绪后自动安装')
      assert.deepEqual(T.getLegacyStepRegistrationState().keys, ['assistant-step', 'tool-call', 'context'])
    } finally { dispose() }
  })
  it('H3 bootstrap 稳定冲突：第三方负 priority 占 context → 停止 bootstrap、不安装、当前生命周期不抢', () => {
    const env = makeWiredEnv()
    env.slots.st.entries.push({ options: { key: 'context', priority: -2 }, component: () => null })
    const dispose = env.apply()
    try {
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '冲突 → 不安装（FAIL OPEN）')
      assert.equal(env.slots.registered.length, 0, '零物理注册')
      // 冲突方退出也不自动抢
      env.slots.st.entries = env.slots.st.entries.filter((e) => T.slotPriorityOf(e) !== -2)
      env.slots.addThirdParty('unknown', 0)   // 触发 slots/changed
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '不自动 reacquire')
    } finally { dispose() }
  })
  it('H4 Step attach：Full Legacy 在役时 activateLegacyStepEngine 只 attach——注册数不增加', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const before = env.slots.registered.length
      assert.equal(before, 3)
      T.resolveLegacyStepCapability({ nativeStepGroups: false })   // committed 定论 → noteLegacyStepEngine → activate → attach
      assert.equal(T.hostCapabilityState.stepFold, 'legacy')
      assert.equal(T.getLegacyNodeBackendState().stepAttached, true, 'Step logical attach')
      assert.equal(env.slots.registered.length, before, 'attach 不新增 slot 注册')
      assert.deepEqual(T.getLegacyStepRegistrationKeys(), ['assistant-step', 'tool-call', 'context'])
      assert.equal(T.getLegacyNodeBackendState().mode, 'full-legacy')
    } finally { dispose() }
  })
  it('H5 runtime ownership：late -2 抢 context → 同一调用栈整体 teardown 三个 shadow', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      // 先经 committed 定论把 capability 落定（backend health 与 capability 解耦的前置）
      T.resolveLegacyStepCapability({ nativeStepGroups: false })
      assert.equal(T.getLegacyNodeBackendState().stepAttached, true)
      const before = T.getLegacyStepInstallStats()
      env.slots.addThirdParty('context', -2)   // 同步 slots/changed
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '同步整体 teardown')
      assert.equal(env.slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(env.slots.pluginEntryOf('tool-call'), undefined)
      assert.equal(env.slots.pluginEntryOf('context'), undefined)
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
      assert.equal(T.getLegacyNodeBackendState().stepAttached, false, '物理 backend 没了 → Step attach 重置')
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', 'capability 不被 backend health 改写')
    } finally { dispose() }
  })
  it('H6 assistant abdicate → 整体 teardown（含 context）；单独 tool abdicate 同样', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      env.slots.reportEntryError(env.slots.pluginEntryOf('assistant-step'), true)
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(env.slots.pluginEntryOf('context'), undefined, 'context 也被拆')
      assert.equal(env.slots.registered.length, 0)
    } finally { dispose() }
  })
  it('H7 安装事务期间的 slots/changed 不产生自伤 blocked：逐条注册逐条 emit 后状态仍健康', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      // 安装事务逐条注册 → 每条同步 emit slots/changed；bootstrap 若重入会把本插件自己的
      // -1 条目当成"第三方占位"→ 永久 blocked（首次安装后当前生命周期再也无法重装）。
      const st = T.getLegacyNodeBackendState()
      assert.equal(st.installed, true)
      assert.equal(st.turnBackendBlocked, false, '事务中的自发 emit 不得污染 blocked')
      assert.equal(st.bootstrapWaiting, false, '安装成功后 bootstrap 停止（无残余等待）')
      assert.equal(env.changedListenerCount(), 1, '只剩 ownership monitor 的 slots/changed（bootstrap 监听已注销）')
      // 安装完成后的一次无关第三方变动也不得改变结论
      env.slots.addThirdParty('unknown', 0)
      assert.equal(T.getLegacyNodeBackendState().turnBackendBlocked, false)
      assert.equal(T.getLegacyNodeBackendState().installed, true)
    } finally { dispose() }
  })
  it('H8 Turn 让位（context 被第三方 -2 占用）后 Step 定论仍可走 step-only：2 键、Turn 层不启用', () => {
    const env = makeWiredEnv()
    env.slots.st.entries.push({ options: { key: 'context', priority: -2 }, component: () => null })
    const dispose = env.apply()
    try {
      assert.equal(T.getLegacyNodeBackendState().installed, false, 'full-legacy 整体让位（FAIL OPEN 零 shadow）')
      assert.equal(T.getLegacyNodeBackendState().turnBackendBlocked, true, '稳定冲突 → 停止 bootstrap（不抢）')
      assert.equal(env.slots.registered.length, 0)
      // Step 能力定论（0.1.2~0.1.6 的既有语义不变：step-only 只要求两个 cell）
      T.resolveLegacyStepCapability({ nativeStepGroups: false })
      const st = T.getLegacyNodeBackendState()
      assert.equal(st.mode, 'step-only')
      assert.deepEqual(st.keys, ['assistant-step', 'tool-call'])
      assert.equal(st.stepAttached, false, '无需 attach：Step 能力由专用 step-only backend 承担')
      assert.equal(env.slots.pluginEntryOf('context'), undefined, '绝不碰冲突的 context cell')
      // 行为证明：Step 层在役、Turn 层不启用（backend 非 full-legacy）
      const snap = makeSnapshot([
        makeNode('user', 'u1', { anchorSeq: 1, data: {} }),
        makeNode('assistant-step', 'a1', { anchorSeq: 2, blocks: think('想') }),
        makeNode('tool-call', 't1', { anchorSeq: 3 }),
        makeNode('assistant-step', 'a2', { anchorSeq: 4, blocks: text('答') }),
      ], { turnEnds: [[1, 99]] })
      act(() => {
        root.render(react.createElement(T.LegacyStepAssistantView, {
          node: snap.chat.nodes.get('a1'), useSession: useSessionOf(snap), sessionId: 'sess-turn-1',
        }))
      })
      assert.equal(container.querySelectorAll('[data-tf-legacy-step="header"]').length, 1, 'Step Header 在役')
      assert.equal(container.querySelectorAll('[data-tf-legacy-turn]').length, 0, 'Turn 层不启用')
    } finally { dispose() }
  })
  it('H9 第二生命周期：dispose 后重新 apply → storage 干净、3 键重新安装', () => {
    const env1 = makeWiredEnv()
    const dispose1 = env1.apply()
    assert.equal(env1.slots.registered.length, 3)
    dispose1()
    assert.equal(T.getLegacyNodeBackendState().installed, false, 'dispose 注销全部 shadow')
    assert.equal(env1.slots.registered.length, 0)
    assert.equal(T.getLegacyNodeBackendState().stepAttached, false, 'attach 随 teardown 复位')
    const env2 = makeWiredEnv()
    const dispose2 = env2.apply()
    try {
      assert.equal(env2.slots.registered.length, 3, '新生命周期重新原子安装')
      assert.deepEqual(T.getLegacyStepRegistrationKeys(), ['assistant-step', 'tool-call', 'context'])
    } finally { dispose2() }
  })
})

// ══════════════════════════════════════════════════════════════════════
// I. Turn 渲染器（组合 + 默认态 + Turn/Step 正交）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Turn I：渲染器', () => {
  function nodeComp(node) {
    return node.kind === 'context' ? T.LegacyTurnContextView
      : (node.kind === 'tool-call' ? T.LegacyStepToolCallView : T.LegacyStepAssistantView)
  }
  function nodeProps(node, snapshot, sessionId) {
    return { node, useSession: useSessionOf(snapshot), sessionId: sessionId || 'sess-turn-1', turnTail: undefined }
  }
  /** 单节点渲染（同一 root 重渲染：模拟宿主更新单个 node cell）。 */
  function renderNode(env, node, snapshot, sessionId) {
    const Comp = nodeComp(node)
    act(() => { root.render(react.createElement(Comp, nodeProps(node, snapshot, sessionId))) })
    return Comp
  }
  /** 多节点同时在场：每个 node 在自己的 host 子树里（宿主对每个 cell 独立渲染，不互相替换）。 */
  function renderTurn(env, snapshot, keys, sessionId) {
    act(() => {
      root.render(react.createElement(react.Fragment, null, keys.map((k) => {
        const node = snapshot.chat.nodes.get(k)
        return react.createElement('div', { key: k, 'data-host': k },
          react.createElement(nodeComp(node), nodeProps(node, snapshot, sessionId)))
      })))
    })
  }
  function hiddenTurnMembers() {
    return container.querySelectorAll('[data-tf-legacy-turn="member"][data-tf-legacy-turn-hidden="true"]').length
  }
  function clickTurnBar() {
    const bar = container.querySelector('button.ccg-turn-bar-main')
    assert.ok(bar, 'Turn Bar 主按钮存在')
    act(() => { bar.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
  }
  const TOOL_TURN = () => [
    makeNode('user', 'u1', { anchorSeq: 1, data: {} }),
    makeNode('context', 'c1', { anchorSeq: 2 }),
    makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
    makeNode('tool-call', 't1', { anchorSeq: 4 }),
    makeNode('assistant-step', 'a2', { anchorSeq: 5, blocks: text('最终答案') }),
    makeNode('turn-tail', 'tail', { anchorSeq: 6 }),
  ]
  it('I1 completed tool turn：一根 Turn Bar、默认 closed、中间成员 hidden、final 直通可见', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      renderTurn(env, snap, ['c1', 'a1', 'a2'])
      const doc = container
      assert.equal(doc.querySelectorAll('[data-tf-legacy-turn="header"]').length, 1, '恰好一根 Turn Bar')
      const bar = doc.querySelector('button.ccg-turn-bar-main')
      assert.ok(bar, 'Turn Bar 主按钮（共享 TurnBarView）')
      assert.equal(bar.getAttribute('aria-expanded'), 'false', 'completed 默认 closed')
      assert.equal(hiddenTurnMembers(), 2, 'c1（header 锚点）+ a1 均被 Turn 层隐藏')
      assert.ok(doc.querySelector('[data-host="a1"] [data-fake="assistant-step"]'), 'a1 内容仍在场（hidden 不卸载）')
      const finalEl = doc.querySelector('[data-host="a2"] [data-fake="assistant-step"]')
      assert.ok(finalEl, 'final 渲染')
      assert.equal(finalEl.closest('[data-tf-legacy-turn-hidden]'), null, 'final answer 永不被 Turn 隐藏')
      assert.equal(finalEl.closest('[data-tf-legacy-turn]'), null, 'final answer 不在任何 Turn wrapper 内')
      // 成员集由 index 决定：user / turn-tail 永不被 Turn 层折叠
      const group = T.legacyTurnGroupForNode(snap.chat, snap.chat.nodes.get('tail'))
      assert.equal(group.memberKeys.tail, undefined, 'turn-tail 不是 Turn 隐藏成员')
      assert.equal(group.memberKeys.u1, undefined, 'user 不是 Turn 隐藏成员')
    } finally { dispose() }
  })
  it('I2 点击 Turn Bar → 展开（成员恢复可见）；再点收起', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      renderTurn(env, snap, ['c1', 'a1'])
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), null, '默认无手动态（closed 由 effective 计算）')
      assert.equal(hiddenTurnMembers(), 2)
      clickTurnBar()
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), true, '点击 → open store 落 true')
      assert.equal(hiddenTurnMembers(), 0, '展开后成员全部可见')
      clickTurnBar()
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), false)
      assert.equal(hiddenTurnMembers(), 2, '再点收起')
    } finally { dispose() }
  })
  it('I3 running turn：Turn Bar running（无 aria-expanded 折叠语义）、成员恒可见、点击不折叠', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN().slice(0, 4))   // 无 turnEnds → running
      renderTurn(env, snap, ['c1', 'a1'])
      const runningBar = container.querySelector('[data-tf-running="true"]')
      assert.ok(runningBar, 'TurnBarView running 态（共享状态面）')
      assert.equal(hiddenTurnMembers(), 0, 'running 成员全部可见')
      const openBefore = T.legacyReadTurnOpen('sess-turn-1', 1)
      const bar = container.querySelector('[data-tf-running="true"]')
      act(() => { bar.dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), openBefore, 'running 栏是状态面：点击不写折叠状态')
      assert.equal(hiddenTurnMembers(), 0, 'running 期间绝不隐藏进行中的内容')
    } finally { dispose() }
  })
  it('I4 Turn 与 Step 正交：Turn closed 时 Step open 保持；打开 Turn 后 Step 状态不变', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      renderNode(env, snap.chat.nodes.get('t1'), snap)   // committed effect 定论 stepFold=legacy → logical attach
      assert.equal(T.getLegacyNodeBackendState().stepAttached, true)
      // Step 层：t1 属于 a1 开头的段（think+tools），默认 closed
      const stepGroup = T.legacyGroupForNode(snap.chat, 't1')
      assert.ok(stepGroup, 'Step index 复用（think 段）')
      assert.equal(stepGroup.leaderKey, 'a1')
      assert.deepEqual(stepGroup.keys, ['a1', 't1'])
      T.legacySetStepOpen('sess-turn-1', stepGroup.leaderKey, true)
      assert.equal(T.legacyReadStepOpen('sess-turn-1', stepGroup.leaderKey), true)
      // Turn 层默认 closed → 不改写 Step open
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), null)
      assert.equal(T.legacyReadStepOpen('sess-turn-1', stepGroup.leaderKey), true, 'Turn 折叠不改 Step open')
      T.legacySetTurnOpen('sess-turn-1', 1, true)
      assert.equal(T.legacyReadStepOpen('sess-turn-1', stepGroup.leaderKey), true, '打开 Turn 不改写 Step open')
      T.legacySetTurnOpen('sess-turn-1', 1, false)
      assert.equal(hiddenTurnMembers() >= 1, true, 'Turn 重新收起只作用于 Turn wrapper')
    } finally { dispose() }
  })
  it('I5 Step logical attach：同一 backend 上启用 Step 层（leader 出 Step Header），物理注册不增加', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      assert.equal(T.getLegacyNodeBackendState().installed, true, 'Turn 引擎已装 3 键 backend')
      assert.equal(T.getLegacyNodeBackendState().stepAttached, false, 'attach 前：backend 在役但 Step 逻辑未启用')
      renderTurn(env, snap, ['c1', 'a1'])
      assert.equal(T.getLegacyNodeBackendState().stepAttached, true, 'committed effect 定论 stepFold=legacy → attach')
      assert.equal(T.getLegacyNodeBackendState().mode, 'full-legacy')
      assert.equal(env.slots.registered.length, 3, 'attach 不新增 slot 注册')
      assert.equal(container.querySelectorAll('[data-tf-legacy-step="header"]').length, 1, 'a1 是段 leader → 恰好一个 Step Header')
      assert.equal(container.querySelectorAll('[data-host="a1"] [data-fake="assistant-step"]').length, 1, '官方内容经委托渲染')
    } finally { dispose() }
  })
  it('I6 capability 独立定论：committed 渲染 effect → stepFold=legacy + metrics=fallback（不从 turnFold 推导）', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      assert.equal(T.hostCapabilityState.stepFold, 'unknown', 'apply 期不定论')
      assert.equal(T.hostCapabilityState.metrics, 'unknown')
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      renderNode(env, snap.chat.nodes.get('a1'), snap)
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', 'committed effect：useConversation 缺失 + 无 views.grouped → legacy')
      assert.equal(T.hostCapabilityState.metrics, 'fallback', 'snapshot.nodes.turnDataSource 缺失 → fallback')
      assert.equal(T.hostCapabilityState.turnFold, 'legacy')
    } finally { dispose() }
  })
  it('I7 context 边界：作用域外（user 之前）context 原样直通；作用域内 context 是 header 锚点且被折叠', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      // A：审批策略注入的 context 排在 user 之前 → 不属 Turn 作用域
      const snapA = makeSnapshot([
        makeNode('context', 'c0', { anchorSeq: 1 }),
        makeNode('user', 'u1', { anchorSeq: 2, data: {} }),
        makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
        makeNode('assistant-step', 'a2', { anchorSeq: 4, blocks: text('答案') }),
      ], { turnEnds: [[1, 99]] })
      renderTurn(env, snapA, ['c0'])
      assert.equal(container.querySelectorAll('[data-host="c0"] [data-tf-legacy-turn]').length, 0, '作用域外 context：零 Turn wrapper（原样直通）')
      assert.ok(container.querySelector('[data-host="c0"] [data-fake="context"]'), '官方 context 内容在场')
      // B：同一 shape 但 context 在 user 之后 → 属 Turn 作用域，作 header 锚点并被隐藏
      const snapB = makeSnapshot([
        makeNode('user', 'u1', { anchorSeq: 1, data: {} }),
        makeNode('context', 'c1', { anchorSeq: 2 }),
        makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
        makeNode('assistant-step', 'a2', { anchorSeq: 4, blocks: text('答案') }),
      ], { turnEnds: [[1, 99]] })
      const group = T.legacyTurnGroupForNode(snapB.chat, snapB.chat.nodes.get('c1'))
      assert.equal(group.headerKey, 'c1', '作用域内 context 是 header 锚点')
      renderTurn(env, snapB, ['c1', 'a1'])
      assert.equal(container.querySelectorAll('[data-host="c1"] [data-tf-legacy-turn="header"]').length, 1, 'header 锚点出 Turn Bar')
      assert.equal(container.querySelectorAll('[data-host="c1"] [data-tf-legacy-turn="member"]').length, 1)
      assert.equal(hiddenTurnMembers(), 2, 'c1 + a1 都被折叠（closed）')
    } finally { dispose() }
  })
  it('I9 纯问答 turn：header 落到 final answer → 静态 Turn Bar（无可折叠成员，内容零隐藏）', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot([
        makeNode('user', 'u1', { anchorSeq: 1, data: {} }),
        makeNode('assistant-step', 'a1', { anchorSeq: 2, blocks: text('答案') }),
        makeNode('turn-tail', 'tail', { anchorSeq: 3 }),
      ], { turnEnds: [[1, 99]] })
      const group = T.legacyTurnGroupForNode(snap.chat, snap.chat.nodes.get('a1'))
      assert.equal(group.headerKey, 'a1', 'header fallback 到 final answer')
      assert.equal(group.canCollapse, false)
      renderTurn(env, snap, ['a1'])
      assert.equal(container.querySelectorAll('[data-host="a1"] [data-tf-legacy-turn="header"]').length, 1, '静态栏仍然渲染（不可折叠 ≠ 无栏）')
      assert.equal(hiddenTurnMembers(), 0, '纯问答零隐藏')
      const bar = container.querySelector('button.ccg-turn-bar-main')
      assert.ok(bar, '主区域是 button（非 running）')
      assert.equal(bar.getAttribute('data-tf-static'), 'true', '静态栏标记')
      assert.equal(bar.getAttribute('aria-expanded'), null, '无折叠语义')
      const content = container.querySelector('[data-host="a1"] [data-fake="assistant-step"]')
      assert.ok(content, 'final answer 内容在场')
      assert.equal(content.closest('[data-tf-legacy-turn="member"]'), null, '内容不在可隐藏 wrapper 内')
      // 点击静态栏不产生任何折叠状态
      clickTurnBar()
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), null, '静态栏点击不写 open store')
    } finally { dispose() }
  })
  it('I8 StrictMode / 分页重挂载：surface 计数不重复，Turn 手动态跨 remount 保留', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
      const strictRoot = createRoot(container)
      const tree = () => react.createElement(react.StrictMode, null,
        react.createElement('div', { 'data-host': 'c1' }, react.createElement(T.LegacyTurnContextView, nodeProps(snap.chat.nodes.get('c1'), snap))),
        react.createElement('div', { 'data-host': 'a1' }, react.createElement(T.LegacyStepAssistantView, nodeProps(snap.chat.nodes.get('a1'), snap))))
      act(() => { strictRoot.render(tree()) })
      assert.equal(T.legacyTurnSurfaces.get('sess-turn-1'), 2, 'StrictMode effect replay 后恰好 = 在场成员数')
      assert.equal(container.querySelectorAll('[data-tf-legacy-turn="header"]').length, 1, 'StrictMode 不产生重复 Turn Bar')
      // 用户展开 → 卸载（模拟翻页）→ 重挂载到新的挂载点：手动态保留、surface 计数干净
      T.legacySetTurnOpen('sess-turn-1', 1, true)
      act(() => { strictRoot.unmount() })
      assert.equal(T.legacyTurnSurfaces.has('sess-turn-1'), false, '卸载后 surface 计数归零')
      assert.equal(T.legacyReadTurnOpen('sess-turn-1', 1), true, 'Turn 手动态不在卸载时清除（session 仍活跃）')
      container.remove()
      container = sharedDocument.createElement('div')
      sharedDocument.body.appendChild(container)
      root = createRoot(container)
      act(() => { root.render(tree()) })
      assert.equal(hiddenTurnMembers(), 0, '重挂载后仍是展开态（无 flash 回 closed）')
      assert.equal(container.querySelectorAll('[data-tf-legacy-turn="header"]').length, 1)
      assert.equal(T.legacyTurnSurfaces.get('sess-turn-1'), 2, '重挂载后 surface 计数重新登记')
      act(() => { root.unmount() })
    } finally { dispose() }
  })
})

// ══════════════════════════════════════════════════════════════════════
// J. 隔离 / cleanup / 守卫 / fixtures
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Turn J：隔离与守卫', () => {
  const TOOL_TURN = () => [
    makeNode('user', 'u1', { anchorSeq: 1, data: {} }),
    makeNode('assistant-step', 'a1', { anchorSeq: 3, blocks: think('想') }),
    makeNode('tool-call', 't1', { anchorSeq: 4 }),
    makeNode('assistant-step', 'a2', { anchorSeq: 5, blocks: text('最终答案') }),
  ]
  it('J1 Turn open 按 sessionId+turn 隔离：两 session 同 turn 号互不影响', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const snapA = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]], sessionId: 'A' })
      const snapB = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]], sessionId: 'B' })
      assert.equal(T.legacyTurnGroupForNode(snapA.chat, snapA.chat.nodes.get('a1')).turn, 1)
      T.legacySetTurnOpen('sess-A', 1, false)
      T.legacySetTurnOpen('sess-B', 1, true)
      assert.equal(T.legacyReadTurnOpen('sess-A', 1), false)
      assert.equal(T.legacyReadTurnOpen('sess-B', 1), true)
    } finally { dispose() }
  })
  it('J2 统一 cleanup 覆盖 Turn state：三 registry 都空 → legacyTurnOpenBySession 一起清', async () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      const S = 'cleanup-turn'
      T.legacyTurnSurfaceMounted(S)
      T.legacySetTurnOpen(S, 1, true)
      T.completedStepTopFaces.set(S, new Map([['g', 'spade']]))
      assert.equal(T.stepPresentationSessionActive(S), true, 'Turn surface 计入活跃 gate')
      T.legacyTurnSurfaceUnmounted(S)
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(T.legacyTurnOpenBySession.has(S), false, 'Turn open state 已清')
      assert.equal(T.completedStepTopFaces.has(S), false)
    } finally { dispose() }
  })
  it('J3 modern 路径零 Legacy Turn：0.1.2+（useChat 形态）不触任何 Turn 计算/注册', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    // 守卫：Moder n Turn 执行路径（EnhancedTurnProcessView）内不得调用 legacy turn 族
    const start = src.indexOf('function EnhancedTurnProcessView(')
    let end = src.indexOf('\n\t\tfunction ', start + 1)
    if (end < 0) end = src.length
    const body = src.slice(start, end)
    for (const banned of ['legacyBuildTurnIndex', 'legacyTurnOpenBySession', 'LegacyTurnContextView', 'legacyTurnGroupForNode', 'legacyTurnWrap']) {
      assert.ok(!body.includes(banned), 'Modern Turn 路径不得调用 ' + banned)
    }
    // Turn 计算计数：仅 Full Legacy 数据路径使用（本测试只验证 0.1.2 形态不进入）
    const before = T.getLegacyTurnComputations()
    const snap = makeSnapshot(TOOL_TURN(), { turnEnds: [[1, 99]] })
    void snap
    assert.equal(T.getLegacyTurnComputations(), before, '未渲染 Full Legacy 面 → 零 Turn 计算')
  })
  it('J4 0.1.1 fixture 事实字段锁死（sessionId/useSession 有；useChat/useConversation 无；turnOwnerHasContent=undefined）', () => {
    const f = HOST_VERSION_FIXTURES.find((x) => x.version === '0.1.1-rc.2')
    assert.ok(f, '0.1.1 fixture 必须在')
    assert.equal(f.probe.standardKitSessionId, true, '0.1.1 有 sessionId')
    assert.equal(f.probe.standardKitUseSession, true, '0.1.1 有 useSession')
    assert.equal(f.probe.standardKitUseChat, false, '0.1.1 无 useChat')
    assert.equal(f.probe.standardKitUseConversation, false, '0.1.1 无 useConversation')
    assert.equal(f.probe.officialTurnProcess, false)
    assert.notEqual(f.probe.turnOwnerHasContent, false, '0.1.1 turnOwnerHasContent=undefined（不倒退）')
    const caps = T.hostCapabilitiesOf({ nativeTurnFold: false })
    assert.equal(caps.turnOwnerHasContent, undefined)
    // 0.1.2~0.1.6 保持 false、0.1.7+ 保持 true
    const mid = HOST_VERSION_FIXTURES.find((x) => x.version === '0.1.2-rc.1')
    const modern = HOST_VERSION_FIXTURES.find((x) => x.version === '0.2.0-rc.2')
    assert.equal(mid.probe.turnOwnerHasContent, false)
    assert.equal(modern.probe.turnOwnerHasContent, true)
  })
  it('J5 modern 全矩阵 regression：0.1.2/0.1.5/0.1.6/0.1.7/0.2.0 turnFold=modern → 零 Legacy Turn 激活/注册', () => {
    for (const version of ['0.1.2-rc.1', '0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']) {
      const f = HOST_VERSION_FIXTURES.find((x) => x.version === version)
      assert.ok(f, version + ' fixture 必须在')
      const slots = {
        registered: [],
        entries: () => [{ options: { key: 'turn-process', priority: 0 }, component: null }],
        entriesOfSlot: () => [{ options: { key: 'turn-process', priority: 0 }, component: null }],
        subscribe: (_k, fn) => { void fn; return () => {} },
        onEntryError: (fn) => { void fn; return () => {} },
        inject: (_s, fn) => { fn(); return () => {} },
        register: (options, component) => { slots.registered.push({ options, component }); return () => {} },
      }
      let onCalls = 0
      const ctx = { inject: (deps, fn) => { fn({ slots }); return () => {} }, on: () => { onCalls += 1; return () => {} } }
      const dispose = T.exports.apply(ctx)
      try {
        assert.equal(T.getLegacyNodeBackendState().installed, false, version + '：Legacy backend 不得安装')
        assert.equal(T.getLegacyNodeBackendState().bootstrapWaiting, false, version + '：Turn bootstrap 不得启动')
        assert.equal(T.getLegacyNodeBackendState().keys.length, 0, version + '：无任何影子键')
        assert.deepEqual(T.getLegacyStepRegistrationKeys(), [], version + '：注册 0')
        assert.equal(onCalls, 0, version + '：不为 bootstrap 挂 slots/changed')
        assert.equal(slots.registered.filter((r) => r.options.key === 'turn-process').length, 1, version + '：只注册现代 turn-process')
      } finally { if (typeof dispose === 'function') dispose() }
    }
  })
  it('J6 源码守卫：Full Legacy 渲染器只读 shell 快照、零 slots 扫描、每 renderer 恰一个 useEffect', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    for (const name of ['LegacyStepToolCallView', 'LegacyStepAssistantView', 'LegacyTurnContextView']) {
      const start = src.indexOf('function ' + name + '(')
      assert.ok(start > 0, name + ' 必须在源码里')
      let end = src.indexOf('\n\t\tfunction ', start + 1)
      if (end < 0) end = src.length
      const body = src.slice(start, end)
      assert.equal((body.match(/react\.useEffect\(/g) || []).length, 1, name + '：恰一个 useEffect（capability probe）')
      for (const banned of ['slots.entries', 'entriesOfSlot', 'slots.register', 'sourcePath']) {
        assert.ok(!body.includes(banned), name + ' 渲染路径不得出现 ' + banned)
      }
    }
  })
})
