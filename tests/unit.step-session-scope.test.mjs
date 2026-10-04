// session 级样式隔离测试（本轮修复）：
//   最终 CSS selector 原来只有 [data-step-process][data-chat-group-key="…"]，而官方 GroupKey
//   是"one Session 内的 identity"（跨会话会重复），官方 UI 又允许两棵会话树并存
//   （主会话 + 子代理右侧栏会话）——同名 groupKey 会互相串样式。
//   修法：用官方 DOM 的会话锚点做作用域 —— ui-conversation 的 ConversationContent 在会话
//   内容根上渲染 `data-conversation-session={sessionId}`（官方 stop-shortcut 自己就是
//   `closest('[data-conversation-session]')` 解析会话），它包含该会话的全部 chat 节点。
//
// 本文件锁死：
//   · 规则带上 [data-conversation-session] 作用域前缀（且 sessionId / groupKey 都正确转义）
//   · same groupKey 的两个 session 各自拿到自己的 topFace，规则各自只命中自己的会话树
//   · 无 sessionId（旧宿主）→ 不加前缀、且输出层只在唯一时输出（不串样式）
//   · 旧 session 卸载 / leader / 缓存清理 / StrictMode / running 零回归
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

const SAME_KEY = '["process","same",null]'

let container = null
let root = null
beforeEach(() => {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  T.writeStepCardRules(null)
  T.completedStepTopFaces.clear()
  T.completedStepTopBags.clear()
  T.resetOfficialSessionScopeProbe()
  T.hostCapabilityState.sessionScope = 'unknown'
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
  T.writeStepCardRules(null)
  T.resetOfficialSessionScopeProbe()
})

const cardRulesCss = () => (sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]') || { textContent: '' }).textContent
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))
const ruleCountOf = (css, key) => (css.match(new RegExp('data-chat-group-key='.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length

/** 一个 session 的假 conversation 面（官方 grouped/entries/groupSource 形状）。 */
function makeSession(groupKeys) {
  const sources = new Map()
  for (const key of groupKeys) {
    const value = { key, members: [], data: { turn: 1, closed: true, summary: { counts: [{ kind: 'read', count: 2 }] } } }
    sources.set(key, { getSnapshot: () => value, subscribe: () => () => {} })
  }
  const grouped = { entries: groupKeys.map((key) => ({ kind: 'group', key })), groupSource: (key) => sources.get(key) }
  const snapshot = { views: { grouped: () => grouped } }
  return { grouped, useConversation: (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot)) }
}

const bridgeNode = (session, sessionId, key) => react.createElement(T.StepCardRulesBridge, {
  key, sessionId, useConversation: session.useConversation,
});
const renderSubtree = (node) => { act(() => { root.render(node) }) }

/** 预设 bag，让两个 session 的同名 groupKey 必然拿到不同 topFace（确定性；不改生产随机逻辑）。
 *  pool 签名必须与当前牌面池一致，否则 nextTurnPokerFace 会按"池变化"重洗。 */
function seedBag(sessionId, faces) {
  T.completedStepTopBags.set(sessionId, { remaining: faces.slice(), previous: undefined, pool: T.pokerFacePool().join(',') })
}

/** 在 document 里搭一棵官方形状的会话树：内容根带 data-conversation-session + 组根。 */
function buildTree(sessionId, groupKey) {
  const body = sharedDocument.createElement('div')
  body.setAttribute('data-conversation-session', sessionId)
  body.setAttribute('data-conversation-content', '')
  const group = sharedDocument.createElement('div')
  group.setAttribute('data-step-process', '')
  group.setAttribute('data-chat-group-key', groupKey)
  const button = sharedDocument.createElement('button')
  button.setAttribute('data-process-activity', 'read')
  button.setAttribute('aria-expanded', 'false')
  const icon = sharedDocument.createElement('span')
  icon.setAttribute('data-step-process-icon', '')
  button.appendChild(icon)
  group.appendChild(button)
  body.appendChild(group)
  sharedDocument.body.appendChild(body)
  return { body, group, button };
}

// ══════════════════════════════════════════════════════════════════════
// A. 规则带会话作用域前缀（含转义；selector 以完整 host 逐支生成）
// ══════════════════════════════════════════════════════════════════════
/** 把一条规则的 selector（{ 之前）按分支拆开（逗号只在分支起点前，
 *  groupKey JSON 内部逗号在引号里、后随字符不是 "[data-"）。 */
const splitBranches = (ruleSelector) =>
  ruleSelector.split(/,(?=\[data-(?:conversation-content|conversation-session|step-process)\])/)

describe('Session 作用域 A：选择器前缀', () => {
  it('buildStepCardRulesCss：有 sessionId → 每条规则两支完整 selector，各自带会话前缀 + 组条件', () => {
    seedBag('sess-A', ['spade'])
    const css = T.buildStepCardRulesCss({ [SAME_KEY]: { count: 3, closed: true } }, 'sess-A')
    const lines = css.split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    for (const line of lines) {
      const selector = line.slice(0, line.indexOf('{'))
      const branches = splitBranches(selector)
      assert.equal(branches.length, 2, '两支：官方锚点 + rc.1 回退：' + selector.slice(0, 90))
      assert.ok(branches[0].startsWith('[data-conversation-session="sess-A"] [data-step-process][data-chat-group-key="'), '支 1 = 会话作用域 + 完整组条件：' + branches[0])
      assert.ok(branches[1].startsWith('[data-conversation-content]:not([data-conversation-session]) [data-step-process][data-chat-group-key="'), '支 2 = rc.1 回退 + 完整组条件：' + branches[1])
    }
  })
  it('回归锁定：绝不允许"scope = A, B 再统一追加 suffix"的拼接（裸会话分支）', () => {
    seedBag('sess-A', ['spade'])
    const css = T.buildStepCardRulesCss({ [SAME_KEY]: { count: 3, closed: true } }, 'sess-A')
    for (const line of css.split('\n').filter(Boolean)) {
      for (const branch of splitBranches(line.slice(0, line.indexOf('{')))) {
        // 旧 bug 的第一支是裸 [data-conversation-session="sess-A"]（组条件只拼到第二支）
        assert.ok(branch.includes('[data-chat-group-key='), '每个分支都必须携带组条件：' + branch)
        assert.ok(!/^\[data-conversation-session="[^"]+"\]$/.test(branch.trim()), '禁止裸会话分支：' + branch)
      }
    }
  })
  it('sessionId / groupKey 都走 cssAttrValue 转义（引号、反斜杠）', () => {
    const weirdSession = 'sess-"A"\\x'
    const weirdKey = '["process","q\\"uote",null]'
    seedBag(weirdSession, ['spade'])
    const css = T.buildStepCardRulesCss({ [weirdKey]: { count: 3, closed: true } }, weirdSession)
    assert.ok(css.includes('[data-conversation-session="' + T.cssAttrValue(weirdSession) + '"]'), 'sessionId 必须转义')
    assert.ok(css.includes('data-chat-group-key="' + T.cssAttrValue(weirdKey) + '"'), 'groupKey 必须转义')
    assert.ok(!css.includes('sess-"A"'), '不得残留未转义引号')
  })
  it('没有 sessionId（旧宿主）→ 不加前缀（回落历史选择器），且输出层不与其他会话并存', () => {
    const css = T.buildStepCardRulesCss({ [SAME_KEY]: { count: 3, closed: true } }, undefined)
    assert.ok(css.includes('[data-step-process][data-chat-group-key="'), '无 sessionId → 历史选择器')
    assert.ok(!css.includes('data-conversation-session'), '无 sessionId 不得凭空加作用域')
  })
})

// ══════════════════════════════════════════════════════════════════════
// B/C. same groupKey 双树：各自命中自己的 set
// ══════════════════════════════════════════════════════════════════════
describe('Session 作用域 B/C：same groupKey 双树隔离', () => {
  it('两个 session 同名 groupKey：各自分配（topFace 不同），两条规则各自只作用于自己的树', () => {
    seedBag('sess-A', ['spade'])
    seedBag('sess-B', ['heart'])
    const treeA = buildTree('sess-A', SAME_KEY)
    const treeB = buildTree('sess-B', SAME_KEY)
    try {
      const a = makeSession([SAME_KEY])
      const b = makeSession([SAME_KEY])
      renderSubtree(react.createElement(react.Fragment, null, [
        bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
      ]))
      assert.equal(T.completedStepTopFace('sess-A', SAME_KEY), 'spade', 'A 拿到自己的 topFace')
      assert.equal(T.completedStepTopFace('sess-B', SAME_KEY), 'heart', 'B 拿到自己的 topFace（与 A 不同）')
      const setA = T.completedFaceSetFor(3, 'spade')
      const setB = T.completedFaceSetFor(3, 'heart')
      const css = cardRulesCss()
      assert.ok(css.includes('--tf-face-' + setA.id + '-stack'), 'A 的 set 在场')
      assert.ok(css.includes('--tf-face-' + setB.id + '-stack'), 'B 的 set 也在场（作用域不同，互不冲突）')
      // 关键：两条同 key 规则各自绑定自己的会话锚点，DOM 层面能区分
      const linesA = css.split('\n').filter((l) => l.includes('data-conversation-session="sess-A"'))
      const linesB = css.split('\n').filter((l) => l.includes('data-conversation-session="sess-B"'))
      assert.equal(linesA.length, 2, 'A 的两条规则（收起 + 展开）')
      assert.equal(linesB.length, 2, 'B 的两条规则')
      for (const line of linesA) assert.ok(line.includes(T.cssAttrValue(SAME_KEY)), 'A 的规则带同名 groupKey')
      for (const line of linesB) assert.ok(line.includes(T.cssAttrValue(SAME_KEY)), 'B 的规则带同名 groupKey')
      // 选择器级隔离：每棵树只命中自己会话的作用域，且带会话属性的树不命中 rc.1 回退分支
      assert.ok(treeA.group.matches('[data-conversation-session="sess-A"] [data-step-process][data-chat-group-key]'), 'A 树命中 A 的作用域')
      assert.ok(!treeA.group.matches('[data-conversation-session="sess-B"] [data-step-process]'), 'A 树不得命中 B 的作用域')
      assert.ok(treeB.group.matches('[data-conversation-session="sess-B"] [data-step-process]'), 'B 树命中 B 的作用域')
      assert.ok(!treeA.group.matches('[data-conversation-content]:not([data-conversation-session]) [data-step-process]'), '带会话属性的树不得命中 rc.1 回退分支')
      void treeB
    } finally {
      treeA.body.remove()
      treeB.body.remove()
    }
  })

  it('C/D/E：A 卸载后 B 仍在场、仍是自己的 set；A 的块被撤下', async () => {
    seedBag('sess-A', ['spade'])
    seedBag('sess-B', ['heart'])
    // rc.2+ 形状：official 会话锚点在场 → 双作用域块全部输出（tree-only 降级由 K 组专测）
    const treeA = buildTree('sess-A', SAME_KEY)
    const treeB = buildTree('sess-B', SAME_KEY)
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    try {
      renderSubtree(react.createElement(react.Fragment, null, [
        bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
      ]))
      const setA = T.completedFaceSetFor(3, 'spade')
      const setB = T.completedFaceSetFor(3, 'heart')
      assert.ok(cardRulesCss().includes('--tf-face-' + setA.id + '-stack') && cardRulesCss().includes('--tf-face-' + setB.id + '-stack'))
      renderSubtree(bridgeNode(b, 'sess-B', 'B'))
      await flushMicrotasks()
      assert.equal(T.getCompletedStepFaceCount('sess-A'), 0, 'A 的分配已清')
      assert.equal(T.hasCompletedStepBag('sess-A'), false, 'A 的 bag 已清')
      assert.equal(T.completedStepTopFace('sess-B', SAME_KEY), 'heart', 'B 保持自己的牌面')
      const css = cardRulesCss()
      assert.ok(!css.includes('data-conversation-session="sess-A"'), 'A 的块已撤下')
      assert.ok(css.includes('data-conversation-session="sess-B"'), 'B 的块仍在')
      assert.ok(css.includes('--tf-face-' + setB.id + '-stack') && !css.includes('--tf-face-' + setA.id + '-stack'), '只留 B 的 set')
    } finally {
      treeA.body.remove()
      treeB.body.remove()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════
// F/G/H. leader / 清理 / pending Set 零回归
// ══════════════════════════════════════════════════════════════════════
describe('Session 作用域 F/G/H：零回归', () => {
  it('F：两个 session 各自恰好一个 leader（跨 session 不互相顶掉）', () => {
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'sess-A', 'A'), bridgeNode(a, 'sess-A', 'A2'), bridgeNode(b, 'sess-B', 'B'),
    ]))
    assert.equal(T.getStepCardBridgeInstanceCount('sess-A'), 2)
    assert.equal(T.getStepCardBridgeInstanceCount('sess-B'), 1)
    assert.equal(T.getStepCardBridgeLeaderCount('sess-A'), 1)
    assert.equal(T.getStepCardBridgeLeaderCount('sess-B'), 1)
  })
  it('G：清 A 不影响 B 的缓存与 bag（同名 key）', async () => {
    seedBag('sess-A', ['spade'])
    seedBag('sess-B', ['club'])
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
    ]))
    const topB = T.completedStepTopFace('sess-B', SAME_KEY)
    renderSubtree(bridgeNode(b, 'sess-B', 'B'))
    await flushMicrotasks()
    assert.equal(T.hasCompletedStepBag('sess-A'), false, 'A 的 bag 已清')
    assert.equal(T.hasCompletedStepBag('sess-B'), true, 'B 的 bag 保留')
    assert.equal(T.completedStepTopFace('sess-B', SAME_KEY), topB, 'B 的牌面不变')
  })
  it('H：pending cleanup 是 Set（特殊 key 不会打到原型上）', () => {
    const src = require('node:fs').readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.ok(src.includes('var stepCardPendingCleanup = new Set()'), 'pending cleanup 必须是 Set')
    assert.ok(!/stepCardPendingCleanup\[/.test(src), '不得再用对象下标访问')
    assert.equal(typeof T.stepCardPendingCleanup.add, 'function', '导出的是 Set 实例')
    T.scheduleCompletedStepSessionCleanup('__proto__')
    assert.equal(T.stepCardPendingCleanup.has('__proto__'), true)
  })
  it('I：StrictMode 下同名 key 双 session 的作用域规则与 leader 都正常', () => {
    seedBag('sess-A', ['spade'])
    seedBag('sess-B', ['heart'])
    // official 锚点在场（rc.2+）→ 双作用域块正常输出
    const treeA = buildTree('sess-A', SAME_KEY)
    const treeB = buildTree('sess-B', SAME_KEY)
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    try {
      renderSubtree(react.createElement(react.StrictMode, null, react.createElement(react.Fragment, null, [
        bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
      ])))
      assert.equal(T.getStepCardBridgeInstanceCount('sess-A'), 1, 'StrictMode 无重复注册')
      assert.equal(T.getStepCardBridgeInstanceCount('sess-B'), 1)
      assert.equal(T.getStepCardBridgeLeaderCount('sess-A'), 1)
      assert.equal(T.getStepCardBridgeLeaderCount('sess-B'), 1)
      const css = cardRulesCss()
      assert.ok(css.includes('data-conversation-session="sess-A"') && css.includes('data-conversation-session="sess-B"'), '两个作用域都在')
      assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'))
      assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'heart').id + '-stack'))
    } finally {
      treeA.body.remove()
      treeB.body.remove()
    }
  })
  it('J：running 组零回归（同名 key、双 session 场景下也不分配/不写规则）', () => {
    const key = SAME_KEY
    const value = { key, members: [], data: { turn: 1, closed: false, summary: { counts: [{ kind: 'read', count: 2 }] } } }
    const grouped = { entries: [{ kind: 'group', key }], groupSource: () => ({ getSnapshot: () => value, subscribe: () => () => {} }) }
    const snapshot = { views: { grouped: () => grouped } }
    const conv = { useConversation: (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot)) }
    renderSubtree(bridgeNode(conv, 'sess-A', 'R'))
    assert.equal(T.getCompletedStepFaceCount('sess-A'), 0, 'running 不分配')
    assert.equal(T.hasCompletedStepBag('sess-A'), false, 'running 不建袋')
    assert.equal(cardRulesCss(), '', 'running 不写规则')
  })
})

// ══════════════════════════════════════════════════════════════════════
// K. 会话作用域输出策略（0.1.7-rc.1 tree-only 安全降级；§41/§42/§43）
//    official 锚点在场 → 作用域块全部输出（0.1.7-rc.2+ 双树完全隔离）；
//    无 official 锚点 → 单会话可输出，多会话撤下 session-specific 覆盖，
//    回落基础 Step Poker（running 五牌面轮换在皮肤表，不受影响）。
// ══════════════════════════════════════════════════════════════════════
describe('Session 作用域 K：tree-only 多会话安全降级', () => {
  it('K0 合并策略单元语义：安全判据是 active session count，不是 chunk 数', () => {
    // 零活跃会话：即使有 chunk 候选（陈旧块）也不输出
    seedBag('', ['club'])
    T.stepCardRulesBySession.set('', 'PLAIN-CHUNK')
    T.stepCardRulesBySession.set('sess-A', 'SCOPED-CHUNK')
    T.writeStepCardRulesMerged()
    assert.equal(cardRulesCss(), '', '零活跃会话：陈旧块不输出')
    T.stepCardRulesBySession.clear()
    T.writeStepCardRulesMerged()
    // 单一活跃会话 + 单块 → 输出
    const instA = { id: 900001, onLeader() {} }
    T.registerStepCardBridge('sess-A', instA)
    T.stepCardRulesBySession.set('sess-A', 'SCOPED-CHUNK')
    T.writeStepCardRulesMerged()
    assert.equal(cardRulesCss(), 'SCOPED-CHUNK', '单活跃会话照常输出')
    // 第二个会话一进 registry（哪怕还没有任何 chunk）→ 立即撤下
    const instB = { id: 900002, onLeader() {} }
    T.registerStepCardBridge('sess-B', instB)
    assert.equal(cardRulesCss(), '', 'active=2 > 1：立即撤下（不等 B 自己生成 chunk）')
    // B 卸载 → 立即恢复（无需 A 重渲染/新事件）
    T.unregisterStepCardBridge('sess-B', instB)
    assert.equal(cardRulesCss(), 'SCOPED-CHUNK', 'B 卸载立即恢复')
    T.unregisterStepCardBridge('sess-A', instA)
    T.stepCardRulesBySession.clear()
    T.writeStepCardRulesMerged()
  })
  it('K1 official 锚点在场（rc.2+）→ 双 session 同名 groupKey 全部输出、互不影响', () => {
    seedBag('sess-A', ['spade'])
    seedBag('sess-B', ['heart'])
    const treeA = buildTree('sess-A', SAME_KEY)   // 带 data-conversation-session
    const treeB = buildTree('sess-B', SAME_KEY)
    try {
      const a = makeSession([SAME_KEY])
      const b = makeSession([SAME_KEY])
      renderSubtree(react.createElement(react.Fragment, null, [
        bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
      ]))
      assert.equal(T.probeOfficialSessionScope(), 'official', '官方锚点在场 → official 定论（单一事实源）')
      assert.equal(T.hostCapabilityState.sessionScope, 'official', 'sessionScope 运行时定论')
      const css = cardRulesCss()
      assert.ok(css.includes('data-conversation-session="sess-A"') && css.includes('data-conversation-session="sess-B"'), '双作用域块同时在场')
      assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'), 'A 的 set 在场')
      assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'heart').id + '-stack'), 'B 的 set 也在场')
    } finally {
      treeA.body.remove()
      treeB.body.remove()
    }
  })
  it('K2 tree-only（无 official 锚点）：单 session 输出 group-specific 覆盖', async () => {
    seedBag('solo', ['spade'])
    const a = makeSession([SAME_KEY])
    renderSubtree(bridgeNode(a, 'solo', 'A'))
    // 无任何 official 树在 DOM → tree-only / 未定论；单候选 → 照常输出
    const css = cardRulesCss()
    assert.ok(css.includes('data-chat-group-key='), '单会话 tree-only 允许 group override')
    assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'))
  })
  it('K3 tree-only：第二 session mount → 覆盖撤下；unmount → 恢复，无需刷新', async () => {
    seedBag('solo-A', ['spade'])
    seedBag('solo-B', ['heart'])
    const setA = T.completedFaceSetFor(3, 'spade')
    const a = makeSession([SAME_KEY])
    renderSubtree(bridgeNode(a, 'solo-A', 'A'))
    assert.ok(cardRulesCss().includes('--tf-face-' + setA.id + '-stack'), '单会话：A 的覆盖在场')
    // 第二 session mount（带自己的 completed 组）→ 全部撤下
    const b = makeSession([SAME_KEY])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'solo-A', 'A'), bridgeNode(b, 'solo-B', 'B'),
    ]))
    assert.equal(T.getStepCardBridgeSessionCount(), 2)
    assert.equal(cardRulesCss(), '', '双会话 tree-only：session-specific 覆盖全部撤下（不串牌）')
    // unmount 一个 → 回到单会话 → 剩余会话恢复输出（不需要刷新）
    renderSubtree(bridgeNode(a, 'solo-A', 'A'))
    await flushMicrotasks()
    assert.equal(T.getStepCardBridgeSessionCount(), 1)
    const css = cardRulesCss()
    assert.ok(css.includes('data-chat-group-key='), '恢复单会话后重新输出')
    assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'), 'A 保持自己的牌面分配')
    assert.ok(!css.includes('--tf-face-' + T.completedFaceSetFor(3, 'heart').id + '-stack'), 'B 的块已撤下')
  })
  it('K4 降级只撤输出：completedFaceSets / 变体资产 / 分配全部保留（不清理）', async () => {
    seedBag('solo-A', ['spade'])
    seedBag('solo-B', ['heart'])
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'solo-A', 'A'), bridgeNode(b, 'solo-B', 'B'),
    ]))
    const setA = T.completedFaceSetFor(3, 'spade')
    assert.equal(cardRulesCss(), '', '降级在场')
    assert.equal(T.getCompletedStepFaceCount('solo-A'), 1, '分配保留')
    assert.ok(T.completedFaceSets.has('3:spade'), 'completedFaceSets 保留')
    const assetEl = sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_FACE_CSS_ID + '-' + setA.id + '"]')
    assert.ok(assetEl, '变体样式元素保留（不重复注入、不清除）')
  })
  it('K5 降级时 running 五牌面轮换不受影响（基础皮肤表原样）', async () => {
    seedBag('solo-A', ['spade'])
    seedBag('solo-B', ['heart'])
    const a = makeSession([SAME_KEY])
    const b = makeSession([SAME_KEY])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'solo-A', 'A'), bridgeNode(b, 'solo-B', 'B'),
    ]))
    assert.equal(cardRulesCss(), '', 'completed 覆盖撤下')
    const skin = sharedDocument.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]').textContent
    assert.ok(skin.includes(':has([data-shimmer="true"]) [data-step-process-icon]::before'), 'running 轮换规则仍在皮肤表')
    assert.ok(skin.includes(':has([data-text-shimmer="true"]) [data-step-process-icon]::before'), '双契约 running 规则仍在')
    assert.ok(skin.includes('@keyframes tf-step-open'), 'completed 通用双态（默认 5 张）仍在')
  })
  it('K6 会话作用域定论进统一 controller：official / tree-only / unknown 三态', () => {
    // 无会话 DOM → unknown（绝不因"当前没查到"定论 none）
    T.resetOfficialSessionScopeProbe()
    assert.equal(T.probeOfficialSessionScope(), 'unknown')
    assert.equal(T.hostCapabilityState.sessionScope, 'unknown')
    // content 锚点在场、无 session 锚点 → 真正 resolve 成 tree-only（不是 CSS 子系统私有状态）
    const rc1Tree = sharedDocument.createElement('div')
    rc1Tree.setAttribute('data-conversation-content', '')
    sharedDocument.body.appendChild(rc1Tree)
    try {
      assert.equal(T.probeOfficialSessionScope(), 'tree-only')
      assert.equal(T.hostCapabilityState.sessionScope, 'tree-only', '单一事实源：hostCapabilityState 即结论（无第二份 denied 布尔）')
      assert.equal(T.probeOfficialSessionScope(), 'tree-only', '已定论后重复读取一致（不再触碰 DOM）')
      // official 树 → 定论 official
      T.resetOfficialSessionScopeProbe()
      const rc2Tree = buildTree('rc2-sess', SAME_KEY)
      try {
        assert.equal(T.probeOfficialSessionScope(), 'official')
        assert.equal(T.hostCapabilityState.sessionScope, 'official')
      } finally { rc2Tree.body.remove() }
    } finally { rc1Tree.remove() }
  })
  it('K7 official 作用域不受 active session count 限制：B mount（无 chunk）也不撤 A', () => {
    seedBag('off-A', ['spade'])
    const treeA = buildTree('off-A', SAME_KEY)
    const treeB = buildTree('off-B', SAME_KEY)
    try {
      const a = makeSession([SAME_KEY])
      renderSubtree(bridgeNode(a, 'off-A', 'A'))
      // B 只进 registry（模拟刚 mount、尚未生成 chunk）
      const instB = { id: 900003, onLeader() {} }
      T.registerStepCardBridge('off-B', instB)
      assert.equal(T.getStepCardBridgeSessionCount(), 2)
      assert.equal(T.probeOfficialSessionScope(), 'official')
      const css = cardRulesCss()
      assert.ok(css.includes('data-conversation-session="off-A"'), 'A 的 chunk 继续输出（official 已按会话限定，多会话安全）')
      assert.ok(css.includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'), 'A 的 set 在场')
      T.unregisterStepCardBridge('off-B', instB)
      assert.ok(cardRulesCss().includes('data-conversation-session="off-A"'), 'B 卸载后 A 仍输出')
    } finally {
      treeA.body.remove()
      treeB.body.remove()
    }
  })
  it('K8 tree-only mount window：B 刚 mount（无 chunk）→ A 规则立即撤下；B unmount → 立即恢复', () => {
    seedBag('win-A', ['spade'])
    const a = makeSession([SAME_KEY])
    renderSubtree(bridgeNode(a, 'win-A', 'A'))
    assert.ok(cardRulesCss().includes('data-chat-group-key='), 'A 规则在场（单会话）')
    // 关键窗口：B 进 registry 的瞬间（尚无任何 chunk）→ 必须立即撤下
    const instB = { id: 900004, onLeader() {} }
    T.registerStepCardBridge('win-B', instB)
    assert.equal(T.getStepCardBridgeSessionCount(), 2)
    assert.equal(cardRulesCss(), '', 'mount 瞬间立即撤下——不能等 B 的 writer effect')
    // B unmount（它从未有过 chunk）→ 立即恢复
    T.unregisterStepCardBridge('win-B', instB)
    assert.ok(cardRulesCss().includes('--tf-face-' + T.completedFaceSetFor(3, 'spade').id + '-stack'), '立即恢复，无需 A 重渲染/新组事件/刷新')
  })
})
