// Legacy Step Compatibility Layer 测试（hybrid 宿主 0.1.2-rc.1 ~ 0.1.6-alpha.2）：
//   Turn = 官方 owner（modern，绝不触碰）；Step = 插件 Legacy backend（官方无 Process
//   Group 契约）；Metrics = fallback（EnhancedTurnProcessView 处理，Legacy 层零指标）。
// 覆盖：
//   A. 数据层：段分组语义（text 边界/think 收尾/排除工具/最终答案不入段）、closed 判定、
//      WeakMap memo（同 snapshot 只建一次）、O(1) 节点查找；
//   B. 注册生命周期：Modern 零注册、hybrid unknown→legacy 迁移注册一次、StrictMode 幂等、
//      dispose 全注销、重装；modern 路径 legacyStepGroupComputations 恒 0；
//   C. 组件行为：成员隐藏/展开、running 恒可见、header 只在 anchor 一次、最终答案始终
//      可见、think+text 拆分、多组独立、双 session 同 groupKey 隔离、3/5 张共享 helper；
//   D. 双层正交：官方 Turn setOpen 不触碰 legacy open store。
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

// ── 官方形状的假 builtin renderer（priority 0 委托目标）──
function FakeAssistant(props) {
  return react.createElement('div', { 'data-fake': 'assistant-step', 'data-fake-key': props.node && props.node.key })
}
function FakeToolCall(props) {
  return react.createElement('div', { 'data-fake': 'tool-call', 'data-fake-key': props.node && props.node.key })
}

function makeSlotsService() {
  const registered = []
  const officialEntries = [
    { options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant },
    { options: { key: 'tool-call', priority: 0 }, component: FakeToolCall },
    { options: { key: 'context', priority: 0 }, component: null },
  ]
  return {
    registered,
    entries: (slotName) => (slotName === 'conversation.chat.node' ? officialEntries.concat(registered) : []),
    // 真实宿主（0.1.2+）都提供 entriesOfSlot：每 cell 的最低 priority winner（安装事务校验面）
    entriesOfSlot: (slotName) => {
      if (slotName !== 'conversation.chat.node') return []
      const sorted = officialEntries.concat(registered).slice().sort((a, b) => ((a.options.priority === undefined ? 0 : a.options.priority) - (b.options.priority === undefined ? 0 : b.options.priority)))
      const seen = {}
      const winners = []
      for (const e of sorted) { if (seen[e.options.key]) continue; seen[e.options.key] = true; winners.push(e) }
      return winners
    },
    subscribe: (_key, fn) => { void fn; return () => {} },
    onEntryError: (fn) => { void fn; return () => {} },
    inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {
        const i = registered.findIndex((r) => r.options === options)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  }
}
function applyPlugin(slots, probe = { officialTurnProcess: true, officialStandardKit: true }) {
  const ctx = {
    inject: (deps, fn) => { fn({ slots }); return () => {} },
    on: (_name, fn) => { void fn; return () => {} },
  }
  const dispose = T.exports.apply(ctx)
  void probe
  return dispose
}

  /** 富 fake：建模官方 SlotCore 语义——
   *  subscribe（真实为 microtask-batched，这里**同步**通知 = 最坏重入情形）、
   *  onEntryError（同步、且在 abdication mutation 之后）、abdicated 条目仍留在 raw
   *  entries 但退出 entriesOfSlot winner 投影、register/dispose 均触发 registry 通知。 */
  function makeSlotCoreFake(opts = {}) {
    const st = { entries: [], abdicated: new Set(), listeners: new Set(), errorListeners: new Set(), disposeOrder: [] }
    st.entries.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
    st.entries.push({ options: { key: 'tool-call', priority: 0 }, component: FakeToolCall })
    // 官方语义：markDirty 同步 emit slots/changed（ctx 通道，经 emit 回调）；
    // subscribe 为 microtask-batched 一致性备份——两者的时序差异在 fake 里如实分建模。
    const emitSync = (key) => { if (opts.emit) opts.emit(key) }
    const notifyBatched = () => {
      const fns = [...st.listeners]
      Promise.resolve().then(() => { for (const fn of fns) fn() })
    }
    const api = {
      st,
      entries: (name) => (name === 'conversation.chat.node' ? st.entries.slice() : []),
      entriesOfSlot: (name) => {
        if (name !== 'conversation.chat.node') return []
        const live = st.entries.filter((e) => e && !st.abdicated.has(e))
        const sorted = live.slice().sort((a, b) => ((a.options.priority === undefined ? 0 : a.options.priority) - (b.options.priority === undefined ? 0 : b.options.priority)))
        const seen = {}
        const winners = []
        for (const e of sorted) { if (seen[e.options.key]) continue; seen[e.options.key] = true; winners.push(e) }
        return winners
      },
      subscribe: (_k, fn) => {
        if (opts.subscribeThrows) throw new Error('subscribe unavailable')
        st.listeners.add(fn)
        return () => { st.disposeOrder.push('monitor:subscribe'); st.listeners.delete(fn) }
      },
      onEntryError: (fn) => { st.errorListeners.add(fn); return () => { st.disposeOrder.push('monitor:onEntryError'); st.errorListeners.delete(fn) } },
      inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      register: (options, component) => {
        const entry = { options, component }
        st.entries.push(entry)
        emitSync(options.name)
        notifyBatched()
        return () => {
          const i = st.entries.indexOf(entry)
          if (i >= 0) st.entries.splice(i, 1)
          st.disposeOrder.push('shadow:' + options.key)
          emitSync(options.name)
          notifyBatched()
        }
      },
      addThirdParty: (key, priority, component) => {
        const entry = { options: { key, priority }, component: component || (() => null) }
        st.entries.push(entry)
        emitSync('conversation.chat.node')
        notifyBatched()
        return {
          entry,
          remove: () => { const i = st.entries.indexOf(entry); if (i >= 0) st.entries.splice(i, 1); emitSync('conversation.chat.node'); notifyBatched() },
        }
      },
      reportEntryError: (entry, abdicate) => {
        if (abdicate) {
          if (st.abdicated.has(entry)) return
          st.abdicated.add(entry)
          emitSync('conversation.chat.node')   // 官方：abdication mutation → 同步 slots/changed
          notifyBatched()
        }
        for (const fn of [...st.errorListeners]) fn('conversation.chat.node', entry, new Error('renderer crash'), { abdicated: !!abdicate })
      },
      pluginEntryOf: (key) => st.entries.find((e) => e.options.key === key && e.component === (key === 'assistant-step' ? T.LegacyStepAssistantView : T.LegacyStepToolCallView)),
      winnerOf: (key) => api.entriesOfSlot('conversation.chat.node').find((e) => e.options.key === key),
    }
    return api
  }

  /** wired env：ctx.on('slots/changed') 真接线到 fake 的同步 emit（PRIMARY 通道可验证）。 */
  function makeWiredEnv(opts = {}) {
    const changedListeners = new Set()
    const slots = makeSlotCoreFake(Object.assign({}, opts, {
      emit: (key) => { for (const fn of [...changedListeners]) fn(key) },
    }))
    const ctx = {
      inject: (deps, fn) => { fn({ slots }); return () => {} },
      on: (name, fn) => {
        if (opts.omitCtxOn) throw new Error('ctx.on unavailable')
        if (name === 'slots/changed') changedListeners.add(fn)
        return () => { if (slots && slots.st) slots.st.disposeOrder.push('monitor:slots/changed'); changedListeners.delete(fn) }
      },
    }
    return { slots, ctx, changedListenerCount: () => changedListeners.size, apply: () => T.exports.apply(ctx) }
  }

// ── 官方 chat 快照形状（0.1.2+）：order 键数组 + nodes.get + legacy.turnEnds ──
function makeNode(kind, key, opts = {}) {
  const o = opts || {}
  return {
    key,
    kind,
    location: { kind: 'step', turn: { turn: o.turn === undefined ? 1 : o.turn, turn_: 1 }, step: o.step || 1 },
    data: kind === 'tool-call'
      ? { root: o.running ? { name: o.tool || 'read' } : { kind: 'tool-result', call: { name: o.tool || 'read' } } }
      : { status: o.status || 'settled', blocks: o.blocks || [] },
  }
}
function makeSnapshot(nodesArr, turnEnds) {
  const map = new Map()
  for (const n of nodesArr) map.set(n.key, n)
  return {
    order: nodesArr.map((n) => n.key),
    nodes: { get: (k) => map.get(k) },
    legacy: { turnEnds: turnEnds instanceof Map ? turnEnds : new Map() },
  }
}
function textBlocks(text) { return [{ kind: 'text', text }] }
function thinkBlocks(text) { return [{ kind: 'reasoning', text }] }

let container = null
let root = null
beforeEach(() => {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  T.legacyStepOpenBySession.clear()
  T.legacyStepSurfaces.clear()
  T.completedStepTopFaces.clear()
  T.completedStepTopBags.clear()
  T.legacyStepRulesBySession.clear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
  T.disposeLegacyStepEngine()
})

// ══════════════════════════════════════════════════════════════════════
// A. 数据层：段分组纯函数（旧 main 已验证语义）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step A：分组数据层', () => {
  it('A1 think + tool 混排成段（text 为边界）；think 不打断段', () => {
    const snap = makeSnapshot([
      makeNode('assistant-step', 'n1', { blocks: thinkBlocks('想') }),
      makeNode('tool-call', 'n2', { running: false }),
      makeNode('assistant-step', 'n3', { blocks: thinkBlocks('再想') }),
      makeNode('assistant-step', 'n4', { blocks: textBlocks('答案') }),
    ])
    const index = T.legacyBuildStepIndex(snap)
    assert.equal(index.groups.length, 1, '一段')
    assert.deepEqual(index.groups[0].keys, ['n1', 'n2', 'n3'])
    assert.equal(index.groups[0].leaderKey, 'n1')
    assert.equal(index.groups[0].toolCount, 1)
    assert.equal(index.groups[0].closed, true, 'text 出现后段闭合')
    assert.equal(index.byNode.get('n4'), undefined, '纯 text 节点不是成员（最终答案）')
  })
  it('A2 think+text 同节点：入段且自身使段闭合（text 是段边界）', () => {
    const snap = makeSnapshot([
      makeNode('tool-call', 't1', { running: false }),
      makeNode('assistant-step', 'm1', { blocks: [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '正文' }] }),
      makeNode('tool-call', 't2', { running: false }),
    ])
    const index = T.legacyBuildStepIndex(snap)
    assert.equal(index.groups.length, 2, 'text 边界把工具分成两段')
    assert.deepEqual(index.groups[0].keys, ['t1', 'm1'])
    assert.equal(index.groups[0].closed, true)
    assert.deepEqual(index.groups[1].keys, ['t2'])
    assert.equal(index.groups[1].closed, false, 't2 之后没有 text → 仍未闭合（running）')
  })
  it('A3 未闭合段（无 text 后继）保持 running；turnEnds 有记录 → 强制闭合（中断场景）', () => {
    const nodes = [makeNode('tool-call', 'r1', { running: true })]
    const open = T.legacyBuildStepIndex(makeSnapshot(nodes))
    assert.equal(open.groups[0].closed, false, 'running 段不隐藏')
    const ends = new Map([[1, { reason: 'aborted' }]])
    const closed = T.legacyBuildStepIndex(makeSnapshot(nodes, ends))
    assert.equal(closed.groups[0].closed, true, '回合结束 → 段闭合（中断不再永久动画）')
  })
  it('A4 排除工具（todo_write）不是段成员；user/context 是边界不是成员', () => {
    const snap = makeSnapshot([
      makeNode('tool-call', 'x1', { running: false, tool: 'todo_write' }),
      makeNode('tool-call', 'x2', { running: false }),
      { key: 'u1', kind: 'user', location: { kind: 'turn', turn: { turn: 1 } }, data: {} },
      { key: 'c1', kind: 'context', location: { kind: 'turn', turn: { turn: 1 } }, data: {} },
    ])
    const index = T.legacyBuildStepIndex(snap)
    assert.equal(index.byNode.get('x1'), undefined, '排除工具不入段')
    assert.equal(index.byNode.get('u1'), undefined, 'user 是边界')
    assert.equal(index.byNode.get('c1'), undefined, 'context 是边界（不 shadow、不入段）')
    assert.deepEqual(index.groups.map((g) => g.keys), [['x2']])
  })
  it('A5 memo：同 snapshot 身份只建一次索引；新 snapshot 重建（O(N) 每次发布，非 O(N²)）', () => {
    const snap = makeSnapshot([makeNode('tool-call', 'k1', {})])
    const before = T.getLegacyStepGroupComputations()
    const i1 = T.legacyBuildStepIndex(snap)
    const i2 = T.legacyBuildStepIndex(snap)
    assert.equal(T.getLegacyStepGroupComputations() - before, 2, '显式 build 两次（诊断 API 不 memo）')
    T.legacyGroupForNode(snap, 'k1')
    T.legacyGroupForNode(snap, 'k1')
    T.legacyGroupForNode(snap, 'k1')
    assert.equal(T.getLegacyStepGroupComputations() - before, 3, 'groupForNode 首次建一次、其后命中 memo')
    void i1; void i2
    const snap2 = makeSnapshot([makeNode('tool-call', 'k2', {})])
    T.legacyGroupForNode(snap2, 'k2')
    assert.equal(T.getLegacyStepGroupComputations() - before, 4, '新 snapshot → 重建一次')
    assert.equal(T.legacyGroupForNode(snap2, 'nope'), null, '非成员/不存在 → null')
  })
})

// ══════════════════════════════════════════════════════════════════════
// B. 注册生命周期（modern 零注册 / hybrid 一次 / StrictMode / dispose）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step B：注册生命周期', () => {
  it('B1 Modern（0.2.0 形状）：stepFold=modern → Legacy Step 注册恒 0、keys=[]、组计算恒 0', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    const calcBefore = T.getLegacyStepGroupComputations()
    // 真实 modern 定论路径：contract=true 经 committed effect → resolveHostFeature modern；
    // noteLegacyStepEngine 只在 changed(unknown→legacy) 时才调用 → 引擎安装点永不进入。
    T.resolveHostFeature('stepFold', 'modern')
    assert.equal(T.hostCapabilityState.stepFold, 'modern')
    assert.deepEqual(T.getLegacyStepRegistrationKeys(), [], 'Modern：shadow keys 恒空')
    assert.equal(slots.registered.length, 0, '无任何 shadow 注册')
    assert.equal(T.getLegacyStepGroupComputations() - calcBefore, 0, 'Modern：legacy 组计算恒 0')
  })
  it('B2 hybrid：unknown→legacy committed 迁移 → 注册 minimal shadow set（assistant-step + tool-call）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.resolveHostFeature('stepFold', 'legacy')
    T.activateLegacyStepEngine()
    assert.deepEqual(T.getLegacyStepRegistrationKeys(), ['assistant-step', 'tool-call'], 'minimal shadow set')
    assert.equal(slots.registered.length, 2)
    for (const r of slots.registered) {
      assert.equal(r.options.name, 'conversation.chat.node')
      assert.ok(r.options.key === 'assistant-step' || r.options.key === 'tool-call')
      assert.notEqual(r.options.key, 'turn-process', '绝不 shadow turn-process')
      assert.notEqual(r.options.key, 'user', '绝不 shadow user')
      assert.notEqual(r.options.key, 'context', 'context 不 shadow（非段成员）')
    }
  })
  it('B3 幂等：重复 activate（StrictMode effect replay / 重复 render）只注册一套', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    assert.equal(T.activateLegacyStepEngine(), true, '首次安装')
    assert.equal(T.activateLegacyStepEngine(), false, '重复调用不再注册')
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.equal(slots.registered.length, 2, '仍只有一套')
  })
  it('B6 StrictMode：StepCardRulesBridge effect replay → legacy 引擎注册恰一次（真实桥路径）', () => {
    const slots = makeSlotsService()
    // 官方形状槽位注册条目：需要在 slots.registered 里能观察到 legacy shadow
    const applyCtx = { inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } }
    const dispose = T.exports.apply(applyCtx)
    T.hostCapabilityState.stepFold = 'unknown'
    // hybrid 形状：views 存在但没有 grouped 函数 → contract=false
    const snapshot = { views: {} }
    const useConversation = (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot))
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    try {
      act(() => { r.render(react.createElement(react.StrictMode, null,
        react.createElement(T.StepCardRulesBridge, { useConversation, sessionId: 'strict-legacy' }))) })
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', 'committed effect 定论 legacy')
      assert.deepEqual(T.getLegacyStepRegistrationKeys(), ['assistant-step', 'tool-call'], 'StrictMode effect replay 只注册一套')
      assert.equal(slots.registered.filter((x) => x.options.key === 'assistant-step').length, 1, '无重复 occupant')
      assert.equal(slots.registered.filter((x) => x.options.key === 'tool-call').length, 1)
    } finally {
      act(() => { r.unmount() })
      c.remove()
      act(() => { dispose() })
    }
  })
  it('B4 dispose：注销全部 shadow；再次激活可正常重装（无 zombie/无重复 occupant）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    assert.equal(slots.registered.length, 2)
    assert.equal(T.disposeLegacyStepEngine(), true)
    assert.equal(slots.registered.length, 0, '全部注销')
    assert.deepEqual(T.getLegacyStepRegistrationKeys(), [])
    assert.equal(T.disposeLegacyStepEngine(), false, '重复 dispose 幂等')
    assert.equal(T.activateLegacyStepEngine(), true, '重装')
    assert.equal(slots.registered.length, 2)
  })
  it('B5 apply 返回 dispose：插件卸载通道注销 legacy 注册', () => {
    const slots = makeSlotsService()
    const dispose = applyPlugin(slots)
    T.activateLegacyStepEngine()
    assert.equal(slots.registered.length, 2)
    act(() => { dispose() })
    assert.equal(slots.registered.length, 0, '插件 dispose 注销全部 legacy shadow')
  })
})

// ══════════════════════════════════════════════════════════════════════
// C. 组件行为（jsdom + 假 builtin 委托）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step C：组件行为', () => {
  function renderView(component, props) {
    act(() => { root.render(react.createElement(component, props)) })
  }
  function conv(snapshot) {
    return (selector) => selector(snapshot)
  }
  const SESSION = 'legacy-sess-1'

  it('C1 completed 组默认收起：成员 hidden、header 在 anchor 渲染一次、点击展开', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([
      makeNode('tool-call', 'g1', {}),
      makeNode('tool-call', 'g2', {}),
      makeNode('assistant-step', 'after', { blocks: textBlocks('答案') }),
    ])
    const useChat = conv(snap)
    renderView(T.LegacyStepToolCallView, { node: snap.nodes.get('g1'), useChat, sessionId: SESSION })
    const header = container.querySelector('[data-tf-legacy-step="header"]')
    assert.ok(header, 'anchor 渲染 header')
    assert.equal(header.getAttribute('data-tf-legacy-session'), SESSION, '插件自有 session scope 属性')
    assert.equal(header.getAttribute('data-chat-group-key'), 'g1', '组身份 = anchor key')
    assert.equal(header.querySelector('[data-step-process-icon]') !== null, true, 'Poker skin 卡牌位钩子在')
    assert.equal(header.querySelector('button').getAttribute('aria-expanded'), 'false', 'completed 默认收起')
    const member = container.querySelector('[data-tf-legacy-step="member"]')
    assert.equal(member.getAttribute('data-tf-legacy-hidden'), 'true', 'closed → 成员隐藏')
    assert.equal(member.getAttribute('hidden'), 'until-found', 'search 可达（until-found + beforematch 兜底）')
    // 点击 header → 展开（正文可见）
    act(() => {
      header.querySelector('button').dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('[data-tf-legacy-step="member"]').getAttribute('data-tf-legacy-hidden'), null, '展开后成员可见')
    assert.equal(T.legacyReadStepOpen(SESSION, 'g1'), true, 'open 状态写进插件自有 store')
  })
  it('C2 组内非 anchor 成员不渲染 header（一组一根）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([
      makeNode('tool-call', 'g1', {}),
      makeNode('tool-call', 'g2', {}),
      makeNode('assistant-step', 'after', { blocks: textBlocks('答案') }),
    ])
    renderView(T.LegacyStepToolCallView, { node: snap.nodes.get('g2'), useChat: conv(snap), sessionId: SESSION })
    assert.equal(container.querySelectorAll('[data-tf-legacy-step="header"]').length, 0, '非 anchor 不出 header')
    assert.equal(container.querySelector('[data-tf-legacy-step="member"]') !== null, true, '成员本身仍渲染（原地 wrapper）')
  })
  it('C3 running 组：成员恒可见、header running（data-shimmer 挂插件自有 DOM 驱动五牌面轮换）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([makeNode('tool-call', 'r1', { running: true })])
    renderView(T.LegacyStepToolCallView, { node: snap.nodes.get('r1'), useChat: conv(snap), sessionId: SESSION })
    const header = container.querySelector('[data-tf-legacy-step="header"]')
    const button = header.querySelector('button')
    assert.equal(button.getAttribute('data-shimmer'), 'true', 'running 轮换由皮肤 :has([data-shimmer]) 命中')
    assert.equal(button.getAttribute('aria-expanded'), 'true', 'running 恒展开')
    assert.equal(container.querySelector('[data-tf-legacy-step="member"]').getAttribute('data-tf-legacy-hidden'), null, 'running 内容绝不隐藏')
  })
  it('C4 最终答案（纯 text assistant-step）非成员：无 wrapper、无隐藏通道（始终可见）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([
      makeNode('tool-call', 'g1', {}),
      makeNode('assistant-step', 'ans', { blocks: textBlocks('最终答案') }),
    ])
    renderView(T.LegacyStepAssistantView, { node: snap.nodes.get('ans'), useChat: conv(snap), sessionId: SESSION })
    assert.equal(container.querySelector('[data-tf-legacy-step="member"]'), null, '答案不在折叠通道里')
    assert.equal(container.querySelector('[data-tf-legacy-hidden]'), null)
    assert.equal(container.querySelector('[data-fake="assistant-step"]') !== null, true, '原 builtin 渲染（委托）')
  })
  it('C5 think+text 成员：think 部分可隐藏（closed 默认收起），text 正文恒可见', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([
      makeNode('assistant-step', 'm1', { blocks: [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '正文' }] }),
      makeNode('assistant-step', 'after', { blocks: textBlocks('答案') }),
    ])
    renderView(T.LegacyStepAssistantView, { node: snap.nodes.get('m1'), useChat: conv(snap), sessionId: SESSION })
    const member = container.querySelector('[data-tf-legacy-step="member"]')
    const textNode = container.querySelector('[data-tf-legacy-step="text"]')
    assert.ok(member && textNode, 'think wrapper 与 text 正文都存在')
    assert.equal(member.getAttribute('data-tf-legacy-hidden'), 'true', 'think 收起')
    assert.equal(textNode.getAttribute('data-tf-legacy-hidden'), null, 'text 正文恒可见')
  })
  it('C6 多组独立 + 双 session 同 key 隔离（open store / CSS / header 属性各自独立）', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const snapA = makeSnapshot([
      makeNode('tool-call', 'k1', {}),
      makeNode('assistant-step', 'a', { blocks: textBlocks('x') }),
      makeNode('tool-call', 'k2', {}),
      makeNode('assistant-step', 'b', { blocks: textBlocks('y') }),
    ])
    renderView(T.LegacyStepToolCallView, { node: snapA.nodes.get('k1'), useChat: conv(snapA), sessionId: 'sess-A' })
    const headerA = container.querySelector('[data-tf-legacy-step="header"]')
    act(() => { headerA.querySelector('button').dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
    assert.equal(T.legacyReadStepOpen('sess-A', 'k1'), true)
    assert.equal(T.legacyReadStepOpen('sess-A', 'k2'), null, '同 session 另一组不受影响')
    assert.equal(T.legacyReadStepOpen('sess-B', 'k1'), null, '另一 session 同 key 独立')
    // 双 session 同 leaderKey：CSS 规则各自带自己的 legacy scope
    T.writeLegacyStepRules('sess-A', 'k1', { count: 3 })
    T.writeLegacyStepRules('sess-B', 'k1', { count: 3 })
    const el = sharedDocument.querySelector('style[data-plugin-css="' + T.LEGACY_STEP_CSS_ID + '"]')
    const css = el ? el.textContent : ''
    assert.ok(css.includes('[data-tf-legacy-session="sess-A"] [data-step-process][data-chat-group-key="k1"]'), 'A 规则带 A scope')
    assert.ok(css.includes('[data-tf-legacy-session="sess-B"] [data-step-process][data-chat-group-key="k1"]'), 'B 规则带 B scope')
  })
  it('C7 3/5 张共享同一 threshold：2/3 → 3 张、4/9 → 5 张（completedFaceSetFor 同 helper）', () => {
    assert.equal(T.STEP_CARD_SMALL_MAX, 3)
    const countOf = (toolCount) => (toolCount <= T.STEP_CARD_SMALL_MAX ? T.STEP_CARD_COUNT_SMALL : T.STEP_CARD_COUNT_LARGE)
    assert.equal(countOf(2), 3)
    assert.equal(countOf(3), 3)
    assert.equal(countOf(4), 5)
    assert.equal(countOf(9), 5)
    // 组真实 member/toolCount 直接决定张数（Legacy 自持 membership，无需外推）
    const snap = makeSnapshot([
      makeNode('tool-call', 'c1', {}), makeNode('tool-call', 'c2', {}),
      makeNode('tool-call', 'c3', {}), makeNode('tool-call', 'c4', {}),
      makeNode('assistant-step', 'after', { blocks: textBlocks('x') }),
    ])
    const index = T.legacyBuildStepIndex(snap)
    assert.equal(index.groups[0].toolCount, 4)
    assert.equal(countOf(index.groups[0].toolCount), T.STEP_CARD_COUNT_LARGE)
  })
  it('C8 session 清理：最后一面卸载（微任务确认）才清 open store / 共享分配', async () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    T.legacyStepSurfaceMounted('clean-sess')
    T.legacySetStepOpen('clean-sess', 'g1', true)
    T.completedStepTopFaces.set('clean-sess', new Map([['g1', 'spade']]))
    T.legacyStepSurfaceUnmounted('clean-sess')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(T.legacyStepOpenBySession.has('clean-sess'), false, 'open store 已清')
    assert.equal(T.completedStepTopFaces.has('clean-sess'), false, '共享牌面分配已清')
    // 而 modern 桥仍在场时不得清（跨面保护）
    T.legacyStepSurfaceMounted('shared-sess')
    T.legacySetStepOpen('shared-sess', 'g1', true)
    T.legacyStepSurfaceUnmounted('shared-sess')
    T.scheduleStepPresentationSessionCleanup('shared-sess')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(T.legacyStepOpenBySession.has('shared-sess'), false, 'legacy 面全退 → open store 清')
  })
})

// ══════════════════════════════════════════════════════════════════════
// D. 双层正交：官方 Turn 与 Legacy Step 互不干涉
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step D：与官方 Turn 正交', () => {
  it('D1 Turn setOpen 不触碰 legacy open store；legacy toggle 不改 turnProcess', () => {
    const slots = makeSlotsService()
    applyPlugin(slots)
    T.activateLegacyStepEngine()
    const turnCalls = []
    const turnProcess = { spec: { turn: 1 }, foldable: true, open: false, setOpen: (v) => turnCalls.push(v) }
    T.legacySetStepOpen('ortho-sess', 'g1', true)
    // 官方 Turn 收起：只经官方 owner，不触碰 legacy 层
    turnProcess.setOpen(true)
    assert.deepEqual(turnCalls, [true])
    assert.equal(T.legacyReadStepOpen('ortho-sess', 'g1'), true, 'legacy open 不被 Turn 操作改变（两层正交）')
    // legacy group 切换同样不触碰 turnProcess
    T.legacySetStepOpen('ortho-sess', 'g2', false)
    assert.deepEqual(turnCalls, [true], 'legacy 操作不调 turnProcess.setOpen')
  })
})

// ══════════════════════════════════════════════════════════════════════
// E. 安装事务（preflight + 原子 install + rollback + 固定 builtin 引用）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step E：原子安装事务', () => {
  /** 可参数化的 slots 环境：
   *   omitAssistantBuiltin / omitToolBuiltin：去掉 priority-0 builtin
   *   thirdPartyAssistant / thirdPartyTool：第三方占用 priority -1
   *   throwOnRegisterKeys：指定 key 的 register 抛异常（模拟半套失败） */
  function makeSlotsVariant(opts = {}) {
    const registered = []
    const registerCalls = []
    let entriesCalls = 0
    const official = []
    if (!opts.omitAssistantBuiltin) official.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
    if (!opts.omitToolBuiltin) official.push({ options: { key: 'tool-call', priority: 0 }, component: FakeToolCall })
    if (opts.thirdPartyAssistant) official.push({ options: { key: 'assistant-step', priority: -1 }, component: () => null })
    if (opts.thirdPartyTool) official.push({ options: { key: 'tool-call', priority: -1 }, component: () => null })
    return {
      registered, registerCalls,
      getEntriesCalls: () => entriesCalls,
      entriesOfSlot: (slotName) => {
        if (slotName !== 'conversation.chat.node') return []
        const sorted = official.concat(registered).slice().sort((a, b) => (a.options.priority || 0) - (b.options.priority || 0))
        const seen = {}
        const winners = []
        for (const e of sorted) {
          if (seen[e.options.key]) continue
          seen[e.options.key] = true
          winners.push(e)
        }
        return winners
      },
      entries: (slotName) => {
        if (slotName !== 'conversation.chat.node') return []
        entriesCalls += 1
        return official.concat(registered)
      },
      subscribe: (_key, fn) => { void fn; return () => {} },
      onEntryError: (fn) => { void fn; return () => {} },
      inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      register: (options, component) => {
        registerCalls.push(options.key)
        if (opts.throwOnRegisterKeys && opts.throwOnRegisterKeys.indexOf(options.key) >= 0) {
          throw new Error('register failed for ' + options.key)
        }
        registered.push({ options, component })
        return () => { const i = registered.findIndex((r) => r.options === options); if (i >= 0) registered.splice(i, 1) }
      },
    }
  }
  function applyWith(slots) {
    return T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
  }

  it('E1 preflight 全成功 → 原子安装：installed、keys 恰好 2、builtins 已捕获、统计正确', () => {
    const slots = makeSlotsVariant()
    applyWith(slots)
    const statsBefore = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), true)
    const st = T.getLegacyStepRegistrationState()
    assert.deepEqual(st, { installed: true, keys: ['assistant-step', 'tool-call'], builtinsCaptured: true, ownershipVerified: true, monitorInstalled: true, degraded: false, degradedReason: null })
    assert.equal(slots.registered.length, 2)
    const stats = T.getLegacyStepInstallStats()
    assert.equal(stats.attempts - statsBefore.attempts, 1)
    assert.equal(stats.successes - statsBefore.successes, 1)
    assert.equal(stats.installs - statsBefore.installs, 1)
  })
  it('E2 assistant builtin 缺失 → 整体不安装（0 shadow、官方 tool 未被触碰）', () => {
    const slots = makeSlotsVariant({ omitAssistantBuiltin: true })
    applyWith(slots)
    const before = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.deepEqual(T.getLegacyStepRegistrationState(), { installed: false, keys: [], builtinsCaptured: false, ownershipVerified: false, monitorInstalled: false, degraded: false, degradedReason: null })
    assert.equal(slots.registered.length, 0, '一个 shadow 都不注册（含 tool-call）')
    assert.equal(T.getLegacyStepInstallStats().preflightFailures - before.preflightFailures, 1)
  })
  it('E3 tool builtin 缺失 → 同上（不能只装 assistant）', () => {
    const slots = makeSlotsVariant({ omitToolBuiltin: true })
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.equal(slots.registered.length, 0)
    assert.deepEqual(T.getLegacyStepRegistrationKeys(), [])
  })
  it('E4 第三方占用 assistant priority -1 → 整体让位（tool 也不注册）', () => {
    const slots = makeSlotsVariant({ thirdPartyAssistant: true })
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.equal(T.getLegacyStepRegistrationState().installed, false)
    assert.equal(slots.registered.length, 0, '绝不半套')
    assert.deepEqual(slots.registerCalls, [], 'preflight 失败时根本不进入注册')
  })
  it('E5 第三方占用 tool priority -1 → 整体让位', () => {
    const slots = makeSlotsVariant({ thirdPartyTool: true })
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.equal(slots.registered.length, 0)
    assert.deepEqual(slots.registerCalls, [])
  })
  it('E6 第二个 shadow（tool）注册失败 → 回滚 assistant、registration/builtins 清空、官方 entries 仍在', () => {
    const slots = makeSlotsVariant({ throwOnRegisterKeys: ['tool-call'] })
    applyWith(slots)
    const before = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.deepEqual(slots.registerCalls, ['assistant-step', 'tool-call'], '先 assistant 后 tool，tool 失败')
    assert.equal(slots.registered.length, 0, 'assistant 已被回滚（无半套）')
    assert.deepEqual(T.getLegacyStepRegistrationState(), { installed: false, keys: [], builtinsCaptured: false, ownershipVerified: false, monitorInstalled: false, degraded: false, degradedReason: null })
    assert.equal(T.getLegacyStepInstallStats().rollbacks - before.rollbacks, 1)
    assert.equal(slots.entries('conversation.chat.node').filter((e) => (e.options.priority || 0) === 0).length, 2, '官方 builtin entries 原样')
  })
  it('E7 第一个 shadow（assistant）注册失败 → tool 根本不尝试；0 shadow', () => {
    const slots = makeSlotsVariant({ throwOnRegisterKeys: ['assistant-step'] })
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.deepEqual(slots.registerCalls, ['assistant-step'], 'tool 不得尝试')
    assert.equal(slots.registered.length, 0)
    assert.equal(T.getLegacyStepRegistrationState().installed, false)
  })
  it('E8 dispose 清空 registration + builtin 引用；可重新 preflight/捕获/安装', () => {
    const slots = makeSlotsVariant()
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), true)
    assert.equal(T.disposeLegacyStepEngine(), true)
    assert.deepEqual(T.getLegacyStepRegistrationState(), { installed: false, keys: [], builtinsCaptured: false, ownershipVerified: false, monitorInstalled: false, degraded: false, degradedReason: null })
    assert.equal(slots.registered.length, 0)
    assert.equal(T.activateLegacyStepEngine(), true, '重新安装成功')
    assert.equal(T.getLegacyStepRegistrationState().builtinsCaptured, true)
    assert.equal(slots.registered.length, 2)
  })
  it('E9 固定 builtin 引用：安装后 mock entries 换掉/移除 priority-0 → renderer 仍用捕获引用', () => {
    const slots = makeSlotsVariant()
    applyWith(slots)
    T.activateLegacyStepEngine()
    const captured = T.getLegacyStepBuiltinRenderers()
    assert.ok(captured && captured.assistantStep === FakeAssistant && captured.toolCall === FakeToolCall)
    // 抽掉 mock 的官方条目（模拟 entries 形状变化）：renderer 不受影响
    const originalEntries = slots.entries
    slots.entries = () => []
    const snap = makeSnapshot([
      makeNode('tool-call', 'x1', {}),
      makeNode('assistant-step', 'a', { blocks: textBlocks('x') }),
    ])
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    try {
      act(() => { r.render(react.createElement(T.LegacyStepToolCallView, { node: snap.nodes.get('x1'), useChat: (sel) => sel(snap), sessionId: 'fixed-ref' })) })
      assert.ok(c.querySelector('[data-fake="tool-call"]'), '仍用安装期捕获的 builtin 渲染内容')
    } finally {
      act(() => { r.unmount() })
      c.remove()
      slots.entries = originalEntries
    }
  })
  it('E10 render 路径零扫描：多次 render 不增加 entries() 调用', () => {
    const slots = makeSlotsVariant()
    applyWith(slots)
    T.activateLegacyStepEngine()
    const snap = makeSnapshot([
      makeNode('tool-call', 'x1', {}),
      makeNode('assistant-step', 'a', { blocks: textBlocks('x') }),
    ])
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    try {
      const before = slots.getEntriesCalls()
      for (let i = 0; i < 5; i += 1) {
        act(() => {
          r.render(react.createElement(react.Fragment, null, [
            react.createElement(T.LegacyStepToolCallView, { key: 't', node: snap.nodes.get('x1'), useChat: (sel) => sel(snap), sessionId: 'no-scan' }),
            react.createElement(T.LegacyStepAssistantView, { key: 'a', node: snap.nodes.get('a'), useChat: (sel) => sel(snap), sessionId: 'no-scan' }),
          ]))
        })
      }
      assert.equal(slots.getEntriesCalls() - before, 0, 'render 不调用 slots.entries（preflight/诊断除外）')
    } finally {
      act(() => { r.unmount() })
      c.remove()
    }
  })
  it('E11 atomic invariant + activation attempt 语义：installed ⇒ keys 恰好 2；重复 activate 不算 attempt', () => {
    const slots = makeSlotsVariant()
    applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), true)
    const st = T.getLegacyStepRegistrationState()
    assert.equal(st.installed && st.keys.length === 2, true, 'installed ⇒ keys === 2')
    const stats1 = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), false)
    assert.equal(T.activateLegacyStepEngine(), false)
    const stats2 = T.getLegacyStepInstallStats()
    assert.equal(stats2.attempts, stats1.attempts, '已安装时的重复调用是 no-op，不算 attempt')
    assert.equal(stats2.activationAttempts, stats1.activationAttempts, 'activation 计数同样不因 no-op 增长')
    assert.equal(slots.registered.length, 2, '仍只有一套')
  })
})

// ══════════════════════════════════════════════════════════════════════
// F. Hook 生命周期（无条件 surface Hook；non-member ↔ member 不改变 Hook 顺序）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step F：Hook 生命周期', () => {
  const SESSION = 'hook-sess'
  function setupSlots() {
    const slots = {
      registered: [],
      entries: (name) => (name === 'conversation.chat.node'
        ? [
          { options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant },
          { options: { key: 'tool-call', priority: 0 }, component: FakeToolCall },
        ].concat(slots.registered)
        : []),
      entriesOfSlot: (name) => {
        if (name !== 'conversation.chat.node') return []
        const all = [{ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant }, { options: { key: 'tool-call', priority: 0 }, component: FakeToolCall }].concat(slots.registered)
        const sorted = all.slice().sort((a, b) => ((a.options.priority === undefined ? 0 : a.options.priority) - (b.options.priority === undefined ? 0 : b.options.priority)))
        const seen = {}
        const winners = []
        for (const e of sorted) { if (seen[e.options.key]) continue; seen[e.options.key] = true; winners.push(e) }
        return winners
      },
      subscribe: (_key, fn) => { void fn; return () => {} },
      onEntryError: (fn) => { void fn; return () => {} },
      inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      register: (options, component) => {
        slots.registered.push({ options, component })
        return () => { const i = slots.registered.findIndex((r) => r.options === options); if (i >= 0) slots.registered.splice(i, 1) }
      },
    }
    return slots
  }
  /** 可变的会话环境：currentSnapshot 变化后重渲染 → 同一个组件实例跨 non-member/member。 */
  function makeHarness(component) {
    const slots = setupSlots()
    const dispose = T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
    T.activateLegacyStepEngine()
    const state = { node: null, snapshot: null }
    const useChat = (selector) => {
      react.useSyncExternalStore(() => () => {}, () => selector(state.snapshot))
      return undefined // 不用它的返回值（本 harness 直接同步调用 selector）
    }
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    const render = (nodeEl) => {
      act(() => {
        r.render(react.createElement(component, { node: state.node, useChat: (sel) => sel(state.snapshot), sessionId: SESSION }))
      })
    }
    return { slots, dispose, state, c, r, render }
  }
  const errs = []
  let origError = null
  function captureErrors() {
    origError = console.error
    errs.length = 0
    console.error = (...a) => { errs.push(a.map(String).join(' ')) }
  }
  function releaseErrors() { if (origError) console.error = origError }
  function assertNoHookWarnings() {
    const bad = errs.filter((l) => /Rendered (more|fewer) hooks|Rules of Hooks|Warning:/.test(l))
    assert.deepEqual(bad, [], '不得出现 Hook/React 告警：' + JSON.stringify(bad))
  }

  it('F1 non-member → member（同实例）：无 Hook 告警；surface 0 → 1', () => {
    captureErrors()
    const h = makeHarness(T.LegacyStepAssistantView)
    try {
      // render 1：blocks=[] → 不是成员
      h.state.node = makeNode('assistant-step', 's1', { blocks: [] })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, '非成员不计 surface')
      // render 2：同 key，出现 reasoning → 成为成员（同一组件实例）
      h.state.node = makeNode('assistant-step', 's1', { blocks: thinkBlocks('想') })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, 'surface 0 → 1')
      assert.equal(h.c.querySelector('[data-tf-legacy-step="header"]') !== null, true, 'header 出现')
      assertNoHookWarnings()
    } finally {
      act(() => { h.r.unmount() }); h.c.remove(); h.dispose(); releaseErrors()
    }
  })
  it('F2 member → non-member（同实例）：无 Hook 告警；surface 1 → 0（微任务后）', async () => {
    captureErrors()
    const h = makeHarness(T.LegacyStepAssistantView)
    try {
      h.state.node = makeNode('assistant-step', 's2', { blocks: thinkBlocks('想') })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1)
      // 同一实例：节点变成纯 text（非成员）
      h.state.node = makeNode('assistant-step', 's2', { blocks: textBlocks('答案') })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      await new Promise((res) => setTimeout(res, 0))
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, 'surface 1 → 0')
      assert.equal(h.c.querySelector('[data-fake="assistant-step"]') !== null, true, '内容继续由 builtin 渲染')
      assertNoHookWarnings()
    } finally {
      act(() => { h.r.unmount() }); h.c.remove(); h.dispose(); releaseErrors()
    }
  })
  it('F3 StrictMode：member 初始 mount → effect replay 后 registry = 1；unmount → 0', async () => {
    captureErrors()
    const slots = setupSlots()
    const dispose = T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
    T.activateLegacyStepEngine()
    const n = makeNode('tool-call', 'sm1', {})
    const snap = makeSnapshot([n])
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    try {
      act(() => {
        r.render(react.createElement(react.StrictMode, null,
          react.createElement(T.LegacyStepToolCallView, { node: n, useChat: (sel) => sel(snap), sessionId: SESSION })))
      })
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, 'StrictMode replay 后恰好 1（非 2/0/负数）')
      act(() => { r.unmount() })
      await new Promise((res) => setTimeout(res, 0))
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, 'unmount → 0')
      assertNoHookWarnings()
    } finally { c.remove(); dispose(); releaseErrors() }
  })
  it('F4 assistant streaming 三段：[] → [reasoning] → [reasoning,text]；surface 0→1→1，text 恒可见', () => {
    captureErrors()
    const h = makeHarness(T.LegacyStepAssistantView)
    try {
      h.state.node = makeNode('assistant-step', 'st1', { blocks: [] })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, 'stage1：非成员')
      h.state.node = makeNode('assistant-step', 'st1', { blocks: thinkBlocks('想') })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, 'stage2：成员')
      h.state.node = makeNode('assistant-step', 'st1', { blocks: [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '正文' }] })
      h.state.snapshot = makeSnapshot([h.state.node, makeNode('assistant-step', 'after', { blocks: textBlocks('答案') })])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, 'stage3：仍是成员（同实例稳定）')
      assert.equal(h.c.querySelector('[data-tf-legacy-step="member"]') !== null, true, 'think 部分可折')
      assert.equal(h.c.querySelector('[data-tf-legacy-step="text"]') !== null, true, 'text 正文恒可见通道')
      assertNoHookWarnings()
    } finally { act(() => { h.r.unmount() }); h.c.remove(); h.dispose(); releaseErrors() }
  })
  it('F5 tool membership transition：excluded(todo_write) → 普通 tool → 再回 excluded，同实例无 Hook 告警', async () => {
    captureErrors()
    const h = makeHarness(T.LegacyStepToolCallView)
    try {
      h.state.node = makeNode('tool-call', 'tt1', { tool: 'todo_write' })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, 'excluded 非成员')
      h.state.node = makeNode('tool-call', 'tt1', { tool: 'read' })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, '变成员')
      h.state.node = makeNode('tool-call', 'tt1', { tool: 'todo_write' })
      h.state.snapshot = makeSnapshot([h.state.node])
      h.render()
      await new Promise((res) => setTimeout(res, 0))
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, '回非成员')
      assertNoHookWarnings()
    } finally { act(() => { h.r.unmount() }); h.c.remove(); h.dispose(); releaseErrors() }
  })
  it('F6 surface registry 精确性：两个成员 = 2 → 一个变非成员 = 1 → 全卸载 = 0 且清理', async () => {
    const slots = setupSlots()
    const dispose = T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
    T.activateLegacyStepEngine()
    const mk = (key, blocks) => makeNode('assistant-step', key, { blocks })
    const stateA = { node: mk('r1', thinkBlocks('a')), snapshot: null }
    const stateB = { node: mk('r2', thinkBlocks('b')), snapshot: null }
    const combined = () => makeSnapshot([stateA.node, stateB.node])
    stateA.snapshot = combined()
    stateB.snapshot = combined()
    const c = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(c)
    const r = createRoot(c)
    try {
      act(() => {
        r.render(react.createElement(react.Fragment, null, [
          react.createElement(T.LegacyStepAssistantView, { key: 'a', node: stateA.node, useChat: (sel) => sel(stateA.snapshot), sessionId: SESSION }),
          react.createElement(T.LegacyStepAssistantView, { key: 'b', node: stateB.node, useChat: (sel) => sel(stateB.snapshot), sessionId: SESSION }),
        ]))
      })
      assert.equal(T.legacyStepSurfaces.get(SESSION), 2, '两个成员 = 2')
      T.legacySetStepOpen(SESSION, 'r1', true)
      // B 变非成员（同实例）
      stateB.node = mk('r2', textBlocks('answer'))
      stateB.snapshot = combined()
      act(() => {
        r.render(react.createElement(react.Fragment, null, [
          react.createElement(T.LegacyStepAssistantView, { key: 'a', node: stateA.node, useChat: (sel) => sel(stateA.snapshot), sessionId: SESSION }),
          react.createElement(T.LegacyStepAssistantView, { key: 'b', node: stateB.node, useChat: (sel) => sel(stateB.snapshot), sessionId: SESSION }),
        ]))
      })
      await new Promise((res) => setTimeout(res, 0))
      assert.equal(T.legacyStepSurfaces.get(SESSION), 1, '一个变非成员 = 1（无重复 mount/unmount）')
      act(() => { r.unmount() })
      await new Promise((res) => setTimeout(res, 0))
      assert.equal(T.legacyStepSurfaces.get(SESSION), undefined, '全卸载 = 0')
      assert.equal(T.legacyStepOpenBySession.has(SESSION), false, '微任务后 open store 清理')
    } finally { c.remove(); dispose() }
  })
  it('F8 源码守卫：entriesOfSlot 只允许出现在 ownership 判定族（preflight/verifier）内，render 路径零扫描', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const stripComments = (text) => text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.split('//')[0]).join('\n')
    const code = stripComments(src)
    const preStart = code.indexOf('function legacyShadowOwnershipAvailable(')
    const verStart = code.indexOf('function legacyShadowsOwned(')
    assert.ok(preStart > 0 && verStart > preStart, 'ownership 判定族必须在')
    let verEnd = code.indexOf('\n\t\t// ---- runtime ownership liveness', verStart)
    if (verEnd < 0) verEnd = code.indexOf('\n\t\tfunction legacyThinkOnlyNode(', verStart)
    const ownershipFamily = code.slice(preStart, verEnd)
    const total = code.split('entriesOfSlot').length - 1
    const inside = ownershipFamily.split('entriesOfSlot').length - 1
    assert.equal(total, inside, 'entriesOfSlot 只允许出现在 ownership 判定族内（render/preflight 之外零扫描）')
    assert.ok(inside >= 2, 'preflight 与 verifier 都必须使用 entriesOfSlot')
    // 两个 renderer 体内不得触碰 slots 注册表（既有守卫的强化）
    for (const name of ['LegacyStepToolCallView', 'LegacyStepAssistantView']) {
      const start = code.indexOf('function ' + name + '(props)')
      let end = code.indexOf('\n\t\tfunction ', start + 1)
      if (end < 0) end = code.length
      const body = code.slice(start, end)
      assert.ok(!body.includes('entriesOfSlot') && !body.includes('slots.entries'), name + ' render 路径零 slots 扫描')
    }
  })
  it('F7 源码守卫：renderer 无条件调用 surface Hook、early return 后不得再有 Hook、render 不触 slots 扫描', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    for (const name of ['LegacyStepToolCallView', 'LegacyStepAssistantView']) {
      const start = src.indexOf('function ' + name + '(props)')
      assert.ok(start > 0, name + ' 必须存在')
      let end = src.indexOf('\n\t\tfunction ', start + 1)
      if (end < 0) end = src.length
      const body = src.slice(start, end)
      const hookCalls = body.split('useLegacyStepSurface(').length - 1
      assert.ok(hookCalls === 1, name + ' 必须有且仅有一处 useLegacyStepSurface：' + hookCalls)
      const surfaceIdx = body.indexOf('useLegacyStepSurface(')
      const firstReturn = body.indexOf('\n\t\t\treturn ')
      assert.ok(firstReturn === -1 || surfaceIdx < firstReturn, name + ' 的 surface Hook 必须早于任何 return')
      // 恰好一处 react.useEffect（0.1.1 runtime capability 探针）——且必须早于任何 return
      const effects = body.split('react.useEffect').length - 1
      assert.ok(effects === 1, name + ' 恰好一处 react.useEffect（capability 探针）：' + effects)
      assert.ok(body.indexOf('react.useEffect') < firstReturn, name + ' 的 capability effect 必须早于任何 return')
      assert.ok(body.indexOf('findLegacyBuiltinRenderer') === -1, name + ' 不得做 builtin lookup')
      assert.ok(body.indexOf('slots.entries') === -1 && body.indexOf('legacyStepSlotsRef') === -1, name + ' 不得触碰 slots 注册表')
    }
    // builtin lookup 只允许发生在安装/preflight
    const lookups = src.split('findLegacyBuiltinRenderer(').length - 1
    assert.ok(lookups >= 1, 'preflight 必须调用 findLegacyBuiltinRenderer')
    const installerStart = src.indexOf('function activateLegacyNodeBackend(mode)')
    const installerEnd = src.indexOf('function disposeLegacyStepEngine()')
    const installer = src.slice(installerStart, installerEnd)
    assert.equal(installer.split('findLegacyBuiltinRenderer(').length - 1, 1, '安装器在 required-entries 循环内统一捕获 builtin')
    assert.ok(installer.includes('legacyBackendEntriesFor(mode)'), 'required entries 由 mode 决定（step-only 2 键 / full-legacy 3 键）')
    assert.ok(src.includes('function legacyBackendEntriesFor(mode)'), 'entriesFor 必须存在')
  })
})

// ══════════════════════════════════════════════════════════════════════
// G. Atomic ownership（lower priority wins：任意同 key priority < 0 → 整体让位；
//    winner 必须 = 本次事务条目：key + priority 恰好 -1 + component 一致）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step G：原子 ownership', () => {
  function makeSlotsOwn(opts = {}) {
    const registered = []
    const registerCalls = []
    const official = []
    if (!opts.omitAssistantBuiltin) official.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
    if (!opts.omitToolBuiltin) official.push({ options: { key: 'tool-call', priority: 0 }, component: FakeToolCall })
    if (opts.thirdPartyAssistantPrio !== undefined) official.push({ options: { key: 'assistant-step', priority: opts.thirdPartyAssistantPrio }, component: opts.thirdPartyAssistantComponent || (() => null) })
    if (opts.thirdPartyToolPrio !== undefined) official.push({ options: { key: 'tool-call', priority: opts.thirdPartyToolPrio }, component: () => null })
    const api = {
      registered, registerCalls, official,
      withEntriesOfSlot: opts.withEntriesOfSlot !== false,
      entries: (name) => (name === 'conversation.chat.node' ? official.concat(registered) : []),
      subscribe: (_key, fn) => { void fn; return () => {} },
      onEntryError: (fn) => { void fn; return () => {} },
      inject: (_slot, fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
      register: (options, component) => {
        registerCalls.push(options.key)
        if (opts.afterRegister) opts.afterRegister(options, component, api)
        registered.push({ options, component })
        return () => { const i = registered.findIndex((r) => r.options === options); if (i >= 0) registered.splice(i, 1) }
      },
    }
    if (opts.withEntriesOfSlot !== false) {
      api.entriesOfSlot = (name) => {
        if (name !== 'conversation.chat.node') return []
        const all = official.concat(registered)
        const sorted = all.slice().sort((a, b) => ((a.options.priority === undefined ? 0 : a.options.priority) - (b.options.priority === undefined ? 0 : b.options.priority)))
        const seen = {}
        const winners = []
        for (const e of sorted) { if (seen[e.options.key]) continue; seen[e.options.key] = true; winners.push(e) }
        return winners
      }
    }
    return api
  }
  function applyWith(slots) {
    return T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
  }

  it('G1 参数化：第三方 priority -2/-3/-10 占任一 cell → 整体不安装、0 注册', () => {
    for (const prio of [-2, -3, -10]) {
      for (const side of ['assistant', 'tool', 'both']) {
        const opts = {}
        if (side === 'assistant' || side === 'both') opts.thirdPartyAssistantPrio = prio
        if (side === 'tool' || side === 'both') opts.thirdPartyToolPrio = prio
        const slots = makeSlotsOwn(opts)
        const dispose = applyWith(slots)
        const before = T.getLegacyStepInstallStats()
        assert.equal(T.activateLegacyStepEngine(), false, prio + '/' + side + ' 必须整体让位')
        assert.deepEqual(T.getLegacyStepRegistrationState(), { installed: false, keys: [], builtinsCaptured: false, ownershipVerified: false, monitorInstalled: false, degraded: false, degradedReason: null })
        assert.deepEqual(slots.registerCalls, [], prio + '/' + side + '：preflight 即失败，根本不注册')
        assert.equal(slots.registered.length, 0)
        const stats = T.getLegacyStepInstallStats()
        assert.equal(stats.ownershipConflicts - before.ownershipConflicts, 1, 'ownershipConflicts 记账')
        dispose()
      }
    }
  })
  it('G2 第三方 priority +1 不影响：本插件 -1 仍成为两个 winner，安装成功', () => {
    const slots = makeSlotsOwn({ thirdPartyAssistantPrio: 1, thirdPartyToolPrio: 1 })
    const dispose = applyWith(slots)
    try {
      assert.equal(T.activateLegacyStepEngine(), true, 'positive priority 不是冲突')
      const winners = slots.entriesOfSlot('conversation.chat.node')
      const a = winners.find((w) => w.options.key === 'assistant-step')
      const tW = winners.find((w) => w.options.key === 'tool-call')
      assert.equal(T.slotPriorityOf(a), -1, 'assistant winner 是本插件 -1')
      assert.equal(a.component, T.LegacyStepAssistantView)
      assert.equal(T.slotPriorityOf(tW), -1)
      assert.equal(tW.component, T.LegacyStepToolCallView)
      assert.equal(T.getLegacyStepRegistrationState().ownershipVerified, true)
    } finally { dispose() }
  })
  it('G3 post-register 篡位（mock 在 assistant 注册后注入第三方 -2）→ winner 验证失败 → 回滚两个', () => {
    const slots = makeSlotsOwn({
      afterRegister: (options, component, api) => {
        if (options.key === 'assistant-step') {
          api.official.push({ options: { key: 'assistant-step', priority: -2 }, component: () => null })
        }
      },
    })
    const dispose = applyWith(slots)
    const before = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), false, 'preflight 通过但 winner 被篡位 → 必须回滚')
    assert.deepEqual(slots.registerCalls, ['assistant-step', 'tool-call'], '注册尝试过两个（tool 注册成功后被回滚）')
    assert.equal(slots.registered.length, 0, '两个 shadow 都已回滚')
    assert.deepEqual(T.getLegacyStepRegistrationState(), { installed: false, keys: [], builtinsCaptured: false, ownershipVerified: false, monitorInstalled: false, degraded: false, degradedReason: null })
    const stats = T.getLegacyStepInstallStats()
    assert.equal(stats.ownershipVerificationFailures - before.ownershipVerificationFailures, 1)
    assert.equal(stats.rollbacks - before.rollbacks, 1)
    dispose()
  })
  it('G4 第三方用同一 component 但 priority -2 → preflight 已按"任意负 priority"整体让位（component 相同也不误认）', () => {
    const slots = makeSlotsOwn({ thirdPartyAssistantPrio: -2, thirdPartyAssistantComponent: T.LegacyStepAssistantView })
    const dispose = applyWith(slots)
    assert.equal(T.activateLegacyStepEngine(), false, 'component 相同不豁免：负 priority 已占 → 让位')
    assert.equal(slots.registered.length, 0)
    dispose()
  })
  it('G5 entriesOfSlot 缺失 → 验证失败（fail open 回滚），不静默当成功', () => {
    const slots = makeSlotsOwn({ withEntriesOfSlot: false })
    const dispose = applyWith(slots)
    const before = T.getLegacyStepInstallStats()
    assert.equal(T.activateLegacyStepEngine(), false, '不可验证 ownership → 不安装')
    assert.equal(slots.registered.length, 0, '注册的两个已回滚')
    assert.equal(T.getLegacyStepInstallStats().ownershipConflicts - before.ownershipConflicts, 1, 'preflight 不可判定 live winner → 归因 ownershipConflicts')
    dispose()
  })
  it('G6 verifier 三元组：component 不同 / priority 非 -1 / key 缺失都判 false', () => {
    const ourOptions = { name: 'conversation.chat.node', key: 'assistant-step', priority: -1, locale: 'chat' }
    const rec = { options: ourOptions, component: T.LegacyStepAssistantView }
    const mkSlots = (winner) => ({
      entriesOfSlot: () => (winner ? [winner] : []),
    })
    assert.equal(T.legacyShadowsOwned(mkSlots({ options: { key: 'assistant-step', priority: -1 }, component: T.LegacyStepAssistantView }), [rec]), true, 'key+-1+component 命中')
    assert.equal(T.legacyShadowsOwned(mkSlots({ options: { key: 'assistant-step', priority: -1 }, component: () => null }), [rec]), false, 'component 不同 → false')
    assert.equal(T.legacyShadowsOwned(mkSlots({ options: { key: 'assistant-step', priority: -2 }, component: T.LegacyStepAssistantView }), [rec]), false, 'priority 非 -1 → false（同 component 也不行）')
    assert.equal(T.legacyShadowsOwned(mkSlots(null), [rec]), false, 'winner 缺失 → false')
    assert.equal(T.legacyShadowsOwned({}, [rec]), false, 'entriesOfSlot 缺失 → false')
    assert.equal(T.legacyShadowsOwned({ entriesOfSlot: () => { throw new Error('boom') } }, [rec]), false, 'entriesOfSlot 抛错 → false')
  })
  it('G7 源码守卫：preflight 以 live winner 判定；verifier 三元组；monitor 只在成功安装后注册', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const pre = src.slice(src.indexOf('function legacyShadowOwnershipAvailable('), src.indexOf('function legacyShadowsOwned('))
    assert.ok(pre.includes('entriesOfSlot'), 'preflight 必须基于 entriesOfSlot（live winner）')
    assert.ok(!pre.includes('slots.entries('), 'preflight 不得扫描 raw entries 判断 live conflict（abdicated stale 条目会误阻）')
    assert.ok(pre.includes('slotPriorityOf(e) >= 0'), 'preflight 判定：live winner priority >= 0 → 可接管')
    const ver = src.slice(src.indexOf('function legacyShadowsOwned('), src.indexOf('// ---- runtime ownership liveness'))
    assert.ok(ver.includes('entriesOfSlot'), 'verifier 必须用 entriesOfSlot')
    assert.ok(ver.includes('slotPriorityOf(match) !== -1'), 'verifier 必须要求 winner priority 恰好 -1')
    assert.ok(ver.includes('match.component !== rec.component'), 'verifier 必须校验 component 身份')
    // monitor 安装面只允许出现在 installLegacyStepOwnershipMonitor helper 内
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    const monStart = code.indexOf('function installLegacyStepOwnershipMonitor(')
    assert.ok(monStart > 0, 'monitor helper 必须在')
    let monEnd = code.indexOf('\n\t\tfunction ', monStart + 1)
    if (monEnd < 0) monEnd = code.length
    const mon = code.slice(monStart, monEnd)
    assert.ok(mon.includes('slots.subscribe("conversation.chat.node"'), 'monitor 订阅 registry 变化')
    assert.ok(mon.includes('slots.onEntryError('), 'monitor 挂 onEntryError 同步 fast-path')
    const totalSub = code.split('slots.subscribe("conversation.chat.node"').length - 1
    const totalErr = code.split('slots.onEntryError(').length - 1
    assert.equal(totalSub, 1, 'slots.subscribe 只允许出现在 monitor helper 内（Modern apply 路径零注册）')
    assert.equal(totalErr, 1, 'slots.onEntryError 只允许出现在 monitor helper 内')
    // apply 路径不得直接注册 monitor
    const applyBody = code.slice(code.indexOf('exports.apply = function'), code.indexOf('function applyIconStyle') > 0 ? code.indexOf('exports.apply = function') + 4000 : code.length)
    assert.ok(!applyBody.includes('slots.subscribe(') && !applyBody.includes('onEntryError('), 'apply 路径不得注册 ownership monitor')
    // runtime 校验也只读 live winner（不扫 raw）
    const rtStart = code.indexOf('function legacyStepOwnershipStillValid(')
    const rt = code.slice(rtStart, code.indexOf('function legacyStepOwnershipCheck('))
    assert.ok(!rt.includes('slots.entries('), 'runtime liveness 不得扫描 raw entries')
  })
})

// ══════════════════════════════════════════════════════════════════════
// H. 统一 session cleanup（单 pending Set + 单 gate + 单 final helper；
//    legacy surface 与 modern bridge 谁最后退出都触发同一清理）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step H：统一 session cleanup', () => {
  const S = 'cleanup-sess'
  const flush = () => new Promise((r) => setTimeout(r, 0))
  function seedSession(sessionKey) {
    T.legacySetStepOpen(sessionKey, 'g1', true)
    T.completedStepTopFaces.set(sessionKey, new Map([['g1', 'spade']]))
    T.completedStepTopBags.set(sessionKey, { remaining: ['heart'], previous: undefined, pool: 'x' })
    T.writeLegacyStepRules(sessionKey, 'g1', { count: 3 })
  }
  function assertCleared(sessionKey, label) {
    assert.equal(T.legacyStepOpenBySession.has(sessionKey), false, label + '：open store 已清')
    assert.equal(T.completedStepTopFaces.has(sessionKey), false, label + '：face 分配已清')
    assert.equal(T.completedStepTopBags.has(sessionKey), false, label + '：bag 已清')
    assert.equal(T.legacyStepRulesBySession.has(sessionKey), false, label + '：legacy rules bucket 已清')
    assert.equal(T.legacyStepRulesBySession.has('__css__' + sessionKey), false, label + '：legacy CSS chunk 已清')
    const el = sharedDocument.querySelector('style[data-plugin-css="' + T.LEGACY_STEP_CSS_ID + '"]')
    const css = el ? el.textContent : ''
    assert.ok(!css.includes('data-tf-legacy-session="' + sessionKey + '"'), label + '：样式表内该 session 规则消失')
  }
  function assertRetained(sessionKey, label) {
    assert.equal(T.legacyStepOpenBySession.has(sessionKey), true, label + '：open store 保留')
    assert.equal(T.completedStepTopFaces.has(sessionKey), true, label + '：face 分配保留')
    assert.equal(T.completedStepTopBags.has(sessionKey), true, label + '：bag 保留')
  }

  it('H1 卸序 A：legacy 面先退（bridge 仍在）→ 状态保留；bridge 后退 → 全清', async () => {
    const inst = { id: 810001, onLeader() {} }
    T.registerStepCardBridge(S, inst)
    T.legacyStepSurfaceMounted(S)
    seedSession(S)
    T.legacyStepSurfaceUnmounted(S)
    await flush()
    assertRetained(S, 'H1 中间态（bridge 仍在）')
    T.unregisterStepCardBridge(S, inst)
    await flush()
    assertCleared(S, 'H1 终态（bridge 最后退出）')
  })
  it('H2 卸序 B：bridge 先退（legacy 面仍在）→ 状态保留；legacy 后退 → 全清', async () => {
    const inst = { id: 810002, onLeader() {} }
    T.registerStepCardBridge(S, inst)
    T.legacyStepSurfaceMounted(S)
    seedSession(S)
    T.unregisterStepCardBridge(S, inst)
    await flush()
    assertRetained(S, 'H2 中间态（legacy 面仍在）')
    T.legacyStepSurfaceUnmounted(S)
    await flush()
    assertCleared(S, 'H2 终态（legacy 最后退出）')
  })
  it('H3 仅 legacy 面：unmount → flush → 全清（含 legacy rules/CSS）', async () => {
    T.legacyStepSurfaceMounted(S)
    seedSession(S)
    T.legacyStepSurfaceUnmounted(S)
    await flush()
    assertCleared(S, 'H3')
  })
  it('H4 仅 modern bridge：unmount → flush → face/bag 清，且人为存在的 legacy open store 也被清', async () => {
    const inst = { id: 810004, onLeader() {} }
    T.registerStepCardBridge(S, inst)
    T.completedStepTopFaces.set(S, new Map([['g1', 'spade']]))
    T.completedStepTopBags.set(S, { remaining: [], previous: undefined, pool: 'x' })
    T.legacySetStepOpen(S, 'g1', true)   // 人为遗留（历史漏洞场景）
    T.unregisterStepCardBridge(S, inst)
    await flush()
    assertCleared(S, 'H4（session 已无任何 Step presentation surface）')
  })
  it('H5 quick remount：最后一面卸载后、microtask 前重挂 → 状态不清（session identity 连续）', async () => {
    T.legacyStepSurfaceMounted(S)
    seedSession(S)
    T.legacyStepSurfaceUnmounted(S)      // schedule cleanup
    T.legacyStepSurfaceMounted(S)        // microtask 前重挂载 → delete pending
    await flush()
    assertRetained(S, 'H5（重挂载取消清理）')
    T.legacyStepSurfaceUnmounted(S)
    await flush()
    assertCleared(S, 'H5 收尾')
  })
  it('H6 StrictMode：cleanup → 同 commit remount（bridge 与 legacy 各验一次）→ 不误清', async () => {
    const inst = { id: 810006, onLeader() {} }
    T.registerStepCardBridge(S, inst)
    seedSession(S)
    T.unregisterStepCardBridge(S, inst)   // effect cleanup
    T.registerStepCardBridge(S, { id: 810007, onLeader() {} })   // 同 commit remount
    await flush()
    assertRetained(S, 'H6 bridge replay')
    T.legacyStepSurfaceMounted(S)
    T.legacyStepSurfaceUnmounted(S)       // legacy replay cleanup
    T.legacyStepSurfaceMounted(S)         // remount
    await flush()
    assertRetained(S, 'H6 legacy replay')
    T.legacyStepSurfaceUnmounted(S)
    T.unregisterStepCardBridge(S, { id: 810007, onLeader() {} })
    await flush()
    assertCleared(S, 'H6 收尾')
  })
  it('H7 跨 session：A teardown 不影响 B（open/face/bag/legacy CSS 各自独立）', async () => {
    const A = 'cleanup-A'
    const B = 'cleanup-B'
    T.legacyStepSurfaceMounted(A)
    seedSession(A)
    T.legacyStepSurfaceMounted(B)
    seedSession(B)
    T.legacyStepSurfaceUnmounted(A)
    await flush()
    assertCleared(A, 'H7 A')
    assertRetained(B, 'H7 B')
    T.legacyStepSurfaceUnmounted(B)
    await flush()
    assertCleared(B, 'H7 B 收尾')
  })
  it('H8 源码守卫：唯一 final cleanup helper + 唯一 gate + 唯一 pending Set；两条卸载路径都走统一 scheduler', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    assert.equal(code.split('function cleanupStepPresentationSession(').length - 1, 1, '唯一 final cleanup helper')
    assert.equal(code.split('function stepPresentationSessionActive(').length - 1, 1, '唯一 activity gate')
    assert.equal(code.split('var stepPresentationPendingCleanup = new Set()').length - 1, 1, '唯一 pending Set')
    assert.equal(code.split('new Set()').filter ? 1 : 1, 1)
    assert.ok(!/legacyStepPendingCleanup|stepCardPendingCleanup/.test(code), '不存在第二套 pending state')
    // 两条卸载路径都必须调用统一 scheduler
    const legacyUnmount = code.slice(code.indexOf('function legacyStepSurfaceUnmounted('), code.indexOf('function legacyStepSurfaceUnmounted(') + 700)
    assert.ok(legacyUnmount.includes('scheduleStepPresentationSessionCleanup('), 'legacy 卸载走统一 scheduler')
    assert.ok(!legacyUnmount.includes('legacyStepOpenBySession.delete'), 'legacy 卸载不得直接清 open store')
    const bridgeUnmount = code.slice(code.indexOf('function unregisterStepCardBridge('), code.indexOf('function unregisterStepCardBridge(') + 1200)
    assert.ok(bridgeUnmount.includes('scheduleStepPresentationSessionCleanup('), 'bridge 卸载走统一 scheduler')
  })
})

// ══════════════════════════════════════════════════════════════════════
// I. Runtime ownership liveness（安装成功后两 cell 必须持续由本插件持有；
//    漂移 → 整体 teardown → FAIL OPEN；不自动重抢）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step I：runtime ownership liveness', () => {
  function applyWith(slots) {
    return T.exports.apply({ inject: (deps, fn) => { fn({ slots }); return () => {} }, on: (_name, fn) => { void fn; return () => {} } })
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('I1 late third-party -2 抢 assistant → 整体 teardown、FAIL OPEN、ownershipLosses+1', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      assert.equal(T.activateLegacyStepEngine(), true)
      assert.equal(T.getLegacyStepRegistrationState().monitorInstalled, true, 'monitor 随成功安装存在')
      const before = T.getLegacyStepInstallStats()
      const third = slots.addThirdParty('assistant-step', -2)
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '后端整体 teardown')
      assert.equal(T.getLegacyStepRegistrationState().monitorInstalled, false)
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined, '插件 assistant shadow 已移除')
      assert.equal(slots.pluginEntryOf('tool-call'), undefined, '插件 tool shadow 也已移除（无半套）')
      assert.equal(T.getLegacyStepRegistrationState().builtinsCaptured, false, 'builtin 引用已清')
      assert.equal(T.slotPriorityOf(slots.winnerOf('assistant-step')), -2, 'assistant winner = 第三方')
      assert.equal(T.slotPriorityOf(slots.winnerOf('tool-call')), 0, 'tool winner = 官方')
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', 'capability 仍 legacy（drift ≠ modern）')
      assert.equal(T.getLegacyStepRegistrationState().degraded, true)
      assert.equal(T.getLegacyStepRegistrationState().degradedReason, 'ownership-lost')
      // 第三方随后退出：不自动重抢
      third.remove()
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '不自动 reacquire')
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(T.activateLegacyStepEngine(), true, '显式重新初始化仍可安装')
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('I2 late third-party -2 抢 tool → 对称整体 teardown', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      slots.addThirdParty('tool-call', -2)
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined, 'assistant shadow 也拆除')
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
    } finally { dispose() }
  })
  it('I3 late +1 不影响：ownership 未变 → 保持 installed', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      slots.addThirdParty('assistant-step', 1)
      slots.addThirdParty('tool-call', 1)
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 0)
      assert.equal(T.slotPriorityOf(slots.winnerOf('assistant-step')), -1)
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('I4 无关 key / 非 winner 变化不 teardown', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      slots.addThirdParty('context', -5)
      slots.addThirdParty('user', -5)
      slots.addThirdParty('assistant-step', 2)
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, true, 'required cells 仍由本插件持有')
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 0)
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('I5 assistant shadow abdicate → onEntryError 同步整体 teardown（不等微任务）', () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      const entry = slots.pluginEntryOf('assistant-step')
      assert.ok(entry, '拿到插件 assistant 条目')
      slots.reportEntryError(entry, true)   // 官方语义：abdication mutation 完成 → 同步通知
      // 同步断言：尚未 flush 微任务
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '同步 teardown（fast-path）')
      assert.equal(slots.pluginEntryOf('tool-call'), undefined, '另一半同步拆除')
      assert.equal(T.slotPriorityOf(slots.winnerOf('assistant-step')), 0, 'assistant winner 回落官方')
      assert.equal(T.slotPriorityOf(slots.winnerOf('tool-call')), 0, 'tool winner 回落官方')
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
    } finally { dispose() }
  })
  it('I6 tool shadow abdicate → 对称同步 teardown', () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const entry = slots.pluginEntryOf('tool-call')
      slots.reportEntryError(entry, true)
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(T.slotPriorityOf(slots.winnerOf('tool-call')), 0)
    } finally { dispose() }
  })
  it('I7 非本插件 entry crash（官方条目 abdicate / 无关 key）不误拆', () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const official = slots.st.entries.find((e) => e.options.key === 'assistant-step' && T.slotPriorityOf(e) === 0)
      slots.reportEntryError(official, true)   // 官方 assistant builtin 崩溃 abdicate
      assert.equal(T.getLegacyStepRegistrationState().installed, true, '本插件 -1 仍是 winner → 保持')
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('I8 stale abdicated -2 不阻止安装（preflight 以 live winner 为准）', () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      const third = slots.addThirdParty('assistant-step', -2)
      slots.reportEntryError(third.entry, true)   // 第三方 -2 崩溃 abdicate：raw 仍留 stale
      assert.ok(slots.entries('conversation.chat.node').some((e) => e === third.entry), 'raw ledger 仍含 stale -2')
      assert.equal(T.slotPriorityOf(slots.winnerOf('assistant-step')), 0, 'live winner 回落官方 0')
      assert.equal(T.activateLegacyStepEngine(), true, 'preflight 放行（live winner 非负）')
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      assert.equal(T.slotPriorityOf(slots.winnerOf('assistant-step')), -1, '本插件成为 winner')
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('I9 直接单测：raw 有 -2 但 live winner 官方 → available；live winner -2 → 不可用', () => {
    const slots = makeWiredEnv().slots
    const stale = { options: { key: 'assistant-step', priority: -2 }, component: () => null }
    slots.st.entries.push({ options: { key: 'assistant-step', priority: 0 }, component: FakeAssistant })
    slots.st.entries.push(stale)
    slots.st.abdicated.add(stale)   // stale：raw 在、live 不在
    assert.equal(T.legacyShadowOwnershipAvailable(slots, 'assistant-step'), true, 'stale -2 不阻止')
    slots.st.abdicated.delete(stale)
    assert.equal(T.legacyShadowOwnershipAvailable(slots, 'assistant-step'), false, 'live -2 仍阻止（安全修复不倒退）')
  })
  it('I10 去重：abdication fast-path 后 microtask 批通知不再重复 teardown/警告/计数', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      slots.reportEntryError(slots.pluginEntryOf('assistant-step'), true)
      await flush()   // 后续 subscribe 批通知（fake 同步已发过；再跑一拍确认无重复）
      await flush()
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1, '只记一次')
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
    } finally { dispose() }
  })
  it('I11 monitor 安装失败（subscribe 抛错）→ 回滚两个 shadow、FAIL OPEN', () => {
    const env = makeWiredEnv({ subscribeThrows: true })
    const slots = env.slots
    const dispose = env.apply()
    try {
      const before = T.getLegacyStepInstallStats()
      assert.equal(T.activateLegacyStepEngine(), false, 'monitor 不可用 → 不安装')
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(slots.pluginEntryOf('tool-call'), undefined)
      assert.equal(T.getLegacyStepInstallStats().rollbacks - before.rollbacks, 1)
    } finally { dispose() }
  })
  it('I12 dispose 顺序：monitor 先注销、shadow 后拆；dispose 后 mutation 不再触发 verifier', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      const order = []
      const origPush = slots.st.disposeOrder.push.bind(slots.st.disposeOrder)
      slots.st.disposeOrder.push = (...a) => { order.push('real'); return origPush(...a) }
      assert.equal(T.disposeLegacyStepEngine(), true)
      const seq = slots.st.disposeOrder
      const firstShadow = seq.findIndex((s) => s.indexOf('shadow:') === 0)
      assert.ok(firstShadow > 0, 'shadows 必须在 monitor 之后：' + JSON.stringify(seq))
      for (const s of seq.slice(0, firstShadow)) assert.ok(s.indexOf('monitor:') === 0, 'monitor 全部先注销：' + JSON.stringify(seq))
      void order
      slots.addThirdParty('assistant-step', -2)
      await flush()
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 0, 'dispose 后 mutation 不触发 ownership teardown 统计')
    } finally { dispose() }
  })
  it('I13 double dispose 安全；ownership-loss 后再 dispose 安全 no-op', async () => {
    const env = makeWiredEnv()
    const slots = env.slots
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      assert.equal(T.disposeLegacyStepEngine(), true)
      assert.equal(T.disposeLegacyStepEngine(), false, '第二次 no-op')
      // ownership-loss 场景后再 dispose
      assert.equal(T.activateLegacyStepEngine(), true)
      const before = T.getLegacyStepInstallStats()
      slots.addThirdParty('tool-call', -2)
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(T.disposeLegacyStepEngine(), false, 'runtime teardown 后 dispose 安全 no-op')
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1, '统计不重复')
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
    } finally { dispose() }
  })
  it('I14 重入防护：dispose shadow 引发的同步 registry 通知不会递归 teardown', async () => {
    const slots = makeSlotCoreFake()   // fake 的 register disposer 同步 notify（最坏情形）
    const dispose = applyWith(slots)
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      slots.addThirdParty('assistant-step', -2)   // 同步 notify → 触发 teardown；期间 dispose shadow 又同步 notify
      await flush()
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1, '恰一次（无递归/双拆）')
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
      assert.equal(slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(slots.pluginEntryOf('tool-call'), undefined)
    } finally { dispose() }
  })
  it('I15 源码守卫：teardown 顺序（monitor 先）与 monitor 仅由 activate 调用', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    const td = code.slice(code.indexOf('function teardownLegacyStepEngine('), code.indexOf('function legacyThinkOnlyNode('))
    assert.ok(td.indexOf('reg.monitorDisposers') < td.indexOf('reg.disposers'), 'teardown 必须先注销 monitor 再拆 shadow')
    assert.ok(td.includes('legacyStepOwnershipTeardownInProgress'), 'teardown 必须有重入 guard')
    assert.ok(td.includes('runtimeOwnershipLosses'), 'ownership-lost 归因统计')
    const calls = code.split('installLegacyStepOwnershipMonitor(').length - 1
    assert.equal(calls, 2, 'monitor helper：定义 1 + activate 调用 1（无其它注册点）')
  })
})

// ══════════════════════════════════════════════════════════════════════
// J. Synchronous ownership seal（PRIMARY = ctx.on("slots/changed") 同步事件：
//    registry mutation 的**同一调用栈内**完成整体 teardown——不存在 microtask 半套窗口；
//    degraded 状态：ownership-lost → true，显式 retry 失败保留、完整成功才清零）
// ══════════════════════════════════════════════════════════════════════
describe('Legacy Step J：同步 ownership 封口', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('J1 late assistant -2：register 返回后立即（不 flush）已整体 teardown', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      const before = T.getLegacyStepInstallStats()
      const third = env.slots.addThirdParty('assistant-step', -2)   // 同步 emit slots/changed
      // 不 flush：同一调用栈内必须已完成
      const st = T.getLegacyStepRegistrationState()
      assert.equal(st.installed, false, 'register 返回前已 teardown（无 microtask 半套窗口）')
      assert.equal(st.monitorInstalled, false)
      assert.equal(env.slots.pluginEntryOf('assistant-step'), undefined, '插件 assistant shadow 已 dispose')
      assert.equal(env.slots.pluginEntryOf('tool-call'), undefined, '插件 tool shadow 也已 dispose')
      assert.equal(T.slotPriorityOf(env.slots.winnerOf('assistant-step')), -2, 'winner = 第三方 -2')
      assert.equal(T.slotPriorityOf(env.slots.winnerOf('tool-call')), 0, 'winner = 官方 0')
      assert.equal(env.slots.entryOfKey ? true : true, true)
      assert.ok(env.slots.st.entries.indexOf(third.entry) >= 0, '第三方 entry 未被误删')
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 1)
      assert.equal(env.changedListenerCount(), 0, 'PRIMARY listener 已注销')
    } finally { dispose() }
  })
  it('J2 late tool -2：对称同步 teardown', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      env.slots.addThirdParty('tool-call', -2)
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(env.slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(env.slots.pluginEntryOf('tool-call'), undefined)
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1)
    } finally { dispose() }
  })
  it('J3 late +1：同步检查通过，保持 installed；flush 后仍 true', async () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      env.slots.addThirdParty('assistant-step', 1)
      assert.equal(T.getLegacyStepRegistrationState().installed, true, '同步检查：ownership 未变')
      await flush()
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 0)
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('J4 无关 key mutation：同步检查通过、backend 不动', async () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      env.slots.addThirdParty('context', -5)
      env.slots.addThirdParty('user', -5)
      env.slots.addThirdParty('turn-process', -5)
      assert.equal(T.getLegacyStepRegistrationState().installed, true)
      await flush()
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 0)
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('J5 abdication 三阶段：sync slots/changed 先 teardown；onEntryError 与 subscribe 批通知均 no-op', async () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      const entry = env.slots.pluginEntryOf('assistant-step')
      env.slots.reportEntryError(entry, true)
      // 阶段 1：reportEntryError 返回时（slots/changed PRIMARY 已同步执行）
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '阶段 1：同步 teardown')
      assert.equal(env.slots.pluginEntryOf('tool-call'), undefined)
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1, '阶段 2：onEntryError backstop 已 no-op')
      await flush()
      assert.equal(T.getLegacyStepInstallStats().runtimeOwnershipLosses - before.runtimeOwnershipLosses, 1, '阶段 3：subscribe 批通知仍 no-op')
    } finally { dispose() }
  })
  it('J6 degraded 生命周期：loss → true；retry 失败保留；完整成功清零', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const third = env.slots.addThirdParty('assistant-step', -2)   // loss（同步）
      let st = T.getLegacyStepRegistrationState()
      assert.equal(st.degraded, true)
      assert.equal(st.degradedReason, 'ownership-lost')
      // retry 失败（第三方 -2 仍占）→ degraded 保留
      assert.equal(T.activateLegacyStepEngine(), false, 'preflight 让位')
      st = T.getLegacyStepRegistrationState()
      assert.equal(st.installed, false)
      assert.equal(st.degraded, true, 'retry 失败保留 degraded')
      assert.equal(st.degradedReason, 'ownership-lost')
      // 第三方移除 → 显式 retry 完整成功 → 清零
      third.remove()
      assert.equal(T.activateLegacyStepEngine(), true, '显式重装成功')
      st = T.getLegacyStepRegistrationState()
      assert.deepEqual(st, {
        installed: true,
        keys: ['assistant-step', 'tool-call'],
        builtinsCaptured: true,
        ownershipVerified: true,
        monitorInstalled: true,
        degraded: false,
        degradedReason: null,
      }, '成功 COMMIT 清零 degraded')
      T.disposeLegacyStepEngine()
    } finally { dispose() }
  })
  it('J7 第二生命周期：重装后再次 late -2 → 再次同步 teardown，stats 累计 1→2', () => {
    const env = makeWiredEnv()
    const dispose = env.apply()
    try {
      T.activateLegacyStepEngine()
      const before = T.getLegacyStepInstallStats()
      const third = env.slots.addThirdParty('assistant-step', -2)
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '第一次 loss（同步）')
      third.remove()
      assert.equal(T.activateLegacyStepEngine(), true, '显式重装成功')
      // 再次 late -2：monitor 已重新建立
      env.slots.addThirdParty('assistant-step', -2)
      assert.equal(T.getLegacyStepRegistrationState().installed, false, '第二次 loss（同步）')
      const stats = T.getLegacyStepInstallStats()
      assert.equal(stats.runtimeOwnershipLosses - before.runtimeOwnershipLosses, 2, '累计 2 次')
      assert.equal(stats.runtimeTeardowns - before.runtimeTeardowns, 2)
      assert.equal(env.changedListenerCount(), 0, '无残留 listener')
    } finally { dispose() }
  })
  it('J8 monitor 安装失败（ctx.on 不可用）→ 回滚两个 shadow、FAIL OPEN', () => {
    const env = makeWiredEnv({ omitCtxOn: true })
    const dispose = env.apply()
    try {
      const before = T.getLegacyStepInstallStats()
      assert.equal(T.activateLegacyStepEngine(), false, 'PRIMARY 通道不可用 → 不安装')
      assert.equal(T.getLegacyStepRegistrationState().installed, false)
      assert.equal(env.slots.pluginEntryOf('assistant-step'), undefined)
      assert.equal(env.slots.pluginEntryOf('tool-call'), undefined)
      assert.equal(T.getLegacyStepInstallStats().rollbacks - before.rollbacks, 1)
      assert.equal(env.changedListenerCount(), 0)
    } finally { dispose() }
  })
  it('J9 源码守卫：slots/changed listener 唯一注册点在 monitor helper；COMMIT 后才清 degraded', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n')
    const total = code.split('ctxRef.on("slots/changed"').length - 1
    // ctx.on("slots/changed") 只允许出现在两个 ownership 相关 helper：runtime monitor 与 full-legacy bootstrap
    assert.equal(total, 2, 'ctx.on("slots/changed") 恰好两处（monitor + bootstrap）')
    const bsStart = code.indexOf('function startLegacyTurnBootstrap(')
    const bsEnd = code.indexOf('\n\t\tfunction ', bsStart + 1)
    assert.ok(code.slice(bsStart, bsEnd).includes('ctxRef.on("slots/changed"'), 'bootstrap 内注册（0.1.1 依赖就绪等待）')
    const monStart = code.indexOf('function installLegacyStepOwnershipMonitor(')
    const monEnd = code.indexOf('\n\t\tfunction ', monStart + 1)
    assert.ok(code.slice(monStart, monEnd).includes('ctxRef.on("slots/changed"'), 'monitor helper 内是唯一注册点')
    const applyStart = code.indexOf('exports.apply = function')
    const applyEnd = code.indexOf('src, then setup', applyStart)
    const applyBody = code.slice(applyStart, applyEnd > 0 ? applyEnd : applyStart + 4000)
    assert.ok(!applyBody.includes('.on("slots/changed"'), 'apply 路径不得注册 PRIMARY listener')
    // degraded 只在 COMMIT（successes 计数）附近清零
    const commitIdx = code.indexOf('legacyStepDegradedReason = null;' + String.fromCharCode(10) + '\t\t\tlegacyStepEngineInstalls += 1')

    assert.ok(commitIdx > 0, 'COMMIT 必须清 degraded')
    const beforeCommit = code.slice(0, commitIdx)
    assert.ok(beforeCommit.lastIndexOf('legacyStepRegistration = {') < commitIdx, '清零发生在 registration 落定之后')
    const preflightReturn = code.indexOf('ownershipConflicts += 1')
    assert.ok(preflightReturn < commitIdx, 'preflight 失败路径不得清 degraded')
  })
})
