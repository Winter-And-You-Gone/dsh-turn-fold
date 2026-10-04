// StepCardRulesBridge 生命周期测试（本轮修复）：
//   A. leader 卸载后 follower 必须立即接棒（不依赖"下次新组件 mount"）
//   B. session 完全卸载后清掉该 session 的展示层缓存（topFaces / bag），全局变体资产保留
//
// 不变量（核心验收）：
//   mounted bridge count > 0  ⇒  恰好 1 个 leader（per session）
//   leader 卸载               ⇒  已挂载的 follower 自动晋升（无需新 mount）
//   最后一个 bridge 卸载      ⇒  清该 session 的规则块（其它 session 不受影响）
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

let container = null
let root = null
beforeEach(() => {
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  T.writeStepCardRules(null)
  T.completedStepTopFaces.clear()
  T.completedStepTopBags.clear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  container = null
  root = null
  T.writeStepCardRules(null)
})

const cardRulesCss = () => (sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]') || { textContent: '' }).textContent
/** 微任务（session 缓存清理是延迟到微任务执行的——见 client.js 的注释）。 */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 一个 session 的假 conversation 面（官方 grouped/entries/groupSource 形状）。 */
function makeSession(groupKeys) {
  const sources = new Map()
  for (const key of groupKeys) {
    let value = { key, members: [], data: { turn: 1, closed: true, summary: { counts: [{ kind: 'read', count: 2 }] } } }
    const listeners = new Set()
    sources.set(key, {
      getSnapshot: () => value,
      subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
      set(next) { value = next; for (const l of [...listeners]) l() },
    })
  }
  const grouped = {
    entries: groupKeys.map((key) => ({ kind: 'group', key })),
    groupSource: (key) => sources.get(key),
  }
  const snapshot = { views: { grouped: () => grouped } }
  return {
    grouped,
    useConversation: (selector) => react.useSyncExternalStore(
      () => () => {},
      () => selector(snapshot),
    ),
  }
}

/** 重新渲染任意子树（用于卸载其中一个 bridge）。 */
function renderSubtree(node) { act(() => { root.render(node) }) }
const bridgeNode = (session, sessionId, key) => react.createElement(T.StepCardRulesBridge, {
  key, useConversation: session.useConversation, sessionId,
});

// ══════════════════════════════════════════════════════════════════════
// A/B/C. leader 接力
// ══════════════════════════════════════════════════════════════════════
describe('Bridge leader A/B/C：接力与幂等', () => {
  const SESSION = 'leader-session-A'
  it('A：leader 卸载 → 已挂载的 follower 立即晋升（不 mount 新实例），规则不断档', async () => {
    const session = makeSession(['["process","a1",null]', '["process","a2",null]'])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(session, SESSION, 'A'), bridgeNode(session, SESSION, 'B'),
    ]))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 2, '两个实例已注册')
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, '恰好一个 leader')
    const rulesBefore = cardRulesCss()
    assert.ok(rulesBefore.includes('[data-chat-group-key='), 'leader 已写出规则')
    // 卸载 leader（A），保留 B —— 不 mount 任何新实例
    renderSubtree(bridgeNode(session, SESSION, 'B'))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 1, '只剩 B')
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, 'B 必须已晋升为 leader')
    assert.equal(cardRulesCss(), rulesBefore, '接棒过程不得清空/重写规则（无闪回 fallback）')
    // B 作为新 leader 必须真的重新订阅：改一个组的官方数据 → 规则随之更新
    // （旧 leader 已卸载，只有"新 leader 重新 useConversation/建 probe"才可能产生新规则）
    const key = '["process","a1",null]'
    const before = cardRulesCss()
    assert.ok(!before.includes('--tf-face-' + T.completedFaceSetFor(3, T.completedStepTopFace(SESSION, key)).id + '-stack') ||
      before.includes(T.cssAttrValue(key)), '规则已包含该组')
    session.grouped.groupSource(key).set({ key, members: [], data: { turn: 1, closed: true, summary: { counts: [{ kind: 'read', count: 9 }] } } })
    await act(async () => {})
    await flushMicrotasks()
    const after = cardRulesCss()
    assert.ok(after.includes(T.cssAttrValue(key)), '新 leader 仍在写规则')
    const set5 = T.completedFaceSetFor(5, T.completedStepTopFace(SESSION, key))
    assert.ok(after.includes('--tf-face-' + set5.id + '-stack'), '新 leader 反映了 4+ 张的新状态（证明它真的在订阅）：' + after.slice(0, 200))
  })
  it('B：三实例连续接力 A→B→C→0，全程恰好一个 leader，最后一个卸载才清规则', () => {
    const session = makeSession(['["process","b1",null]'])
    const three = () => react.createElement(react.Fragment, null, [
      bridgeNode(session, SESSION, 'A'), bridgeNode(session, SESSION, 'B'), bridgeNode(session, SESSION, 'C'),
    ])
    renderSubtree(three())
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1)
    const threeRules = cardRulesCss()
    renderSubtree(react.createElement(react.Fragment, null, [bridgeNode(session, SESSION, 'B'), bridgeNode(session, SESSION, 'C')]))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 2)
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, 'B 接棒')
    assert.equal(cardRulesCss(), threeRules, '接棒不清规则')
    renderSubtree(bridgeNode(session, SESSION, 'C'))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 1)
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, 'C 接棒')
    assert.equal(cardRulesCss(), threeRules, '接棒不清规则')
    renderSubtree(null)
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 0)
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 0, '全部卸载 → 0 leader')
    assert.equal(cardRulesCss(), '', '最后一个卸载才清规则')
  })
  it('C：follower 卸载不影响 leader，也不清规则', () => {
    const session = makeSession(['["process","c1",null]'])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(session, SESSION, 'A'), bridgeNode(session, SESSION, 'B'), bridgeNode(session, SESSION, 'C'),
    ]))
    const rules = cardRulesCss()
    // 卸载中间的 follower（B）
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(session, SESSION, 'A'), bridgeNode(session, SESSION, 'C'),
    ]))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 2, 'A/C 仍在')
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, 'A 仍是 leader')
    assert.equal(cardRulesCss(), rules, 'follower 卸载不得清规则')
  })
  it('D：StrictMode 下 registry 无重复注册、leader 恰好 1、全部卸载后归零', () => {
    const session = makeSession(['["process","d1",null]'])
    const strict = react.createElement(react.StrictMode, null,
      react.createElement(react.Fragment, null, [
        bridgeNode(session, SESSION, 'A'), bridgeNode(session, SESSION, 'B'),
      ]))
    renderSubtree(strict)
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 2, 'StrictMode replay 不得重复注册：' + T.getStepCardBridgeInstanceCount(SESSION))
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1, 'StrictMode 下仍恰好 1 个 leader')
    assert.ok(cardRulesCss().includes('[data-chat-group-key='), 'StrictMode 下规则照常写出')
    renderSubtree(react.createElement(react.StrictMode, null, bridgeNode(session, SESSION, 'B')))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 1)
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1)
    renderSubtree(react.createElement(react.StrictMode, null, null))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 0)
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 0)
    assert.equal(cardRulesCss(), '')
  })
  it('没有 useConversation 的旧宿主不注册 leader（不挡住同 session 的其它实例）', () => {
    const session = makeSession(['["process","e1",null]'])
    renderSubtree(react.createElement(react.Fragment, null, [
      react.createElement(T.StepCardRulesBridge, { key: 'noConv' }),
      bridgeNode(session, SESSION, 'A'),
    ]))
    assert.equal(T.getStepCardBridgeInstanceCount(SESSION), 1, '只有能工作的实例注册')
    assert.equal(T.getStepCardBridgeLeaderCount(SESSION), 1)
    assert.ok(cardRulesCss().includes('[data-chat-group-key='), '能工作的实例拿到 leader 并写规则')
  })
})

// ══════════════════════════════════════════════════════════════════════
// E/F/G. session 缓存清理与隔离
// ══════════════════════════════════════════════════════════════════════
describe('Bridge session cache E/F/G：清理与隔离', () => {
  it('E：session 全部卸载 → topFaces/bag 清掉；全局变体资产与样式元素保留', async () => {
    const sessionA = 'cache-session-A'
    const keys = Array.from({ length: 20 }, (_, i) => '["process","e' + i + '",null]')
    const conv = makeSession(keys)
    renderSubtree(bridgeNode(conv, sessionA, 'A'))
    assert.equal(T.getCompletedStepFaceCount(sessionA), 20, '20 个组已分配：' + T.getCompletedStepFaceCount(sessionA))
    assert.equal(T.hasCompletedStepBag(sessionA), true, 'bag 已建立')
    const setsBefore = T.completedFaceSets.size
    const faceStyleTags = () => sharedDocument.querySelectorAll('style[data-plugin-css^="dsh-turn-fold/style-step-faces"]').length
    const tagsBefore = faceStyleTags()
    assert.ok(tagsBefore > 0, '变体样式资产已注入')
    // 卸载最后一个 bridge
    renderSubtree(null)
    await flushMicrotasks()
    assert.equal(T.getCompletedStepFaceCount(sessionA), 0, 'session 卸载后 topFaces 必须清空')
    assert.equal(T.hasCompletedStepBag(sessionA), false, 'session 卸载后 bag 必须删除')
    assert.equal(T.completedFaceSets.size, setsBefore, '全局变体缓存不得被清')
    assert.equal(faceStyleTags(), tagsBefore, '已注入的变体样式元素不得被删/重复注入')
    assert.equal(cardRulesCss(), '', 'session 规则块已撤下')
  })
  it('F：清 A 不影响 B（face 状态、bag、leader、规则都保持）', async () => {
    const a = makeSession(['["process","f-a1",null]'])
    const b = makeSession(['["process","f-b1",null]'])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'sess-A', 'A'), bridgeNode(b, 'sess-B', 'B'),
    ]))
    assert.equal(T.getCompletedStepFaceCount('sess-A'), 1)
    assert.equal(T.getCompletedStepFaceCount('sess-B'), 1)
    const topB = T.completedStepTopFaces.get('sess-B').get('["process","f-b1",null]')
    const rulesWithB = cardRulesCss()
    assert.ok(rulesWithB.includes(T.cssAttrValue('["process","f-b1",null]')), 'B 的规则在场')
    // 卸载 A 的全部 bridge
    renderSubtree(bridgeNode(b, 'sess-B', 'B'))
    await flushMicrotasks()
    assert.equal(T.getCompletedStepFaceCount('sess-A'), 0, 'A 已清')
    assert.equal(T.hasCompletedStepBag('sess-A'), false)
    assert.equal(T.getCompletedStepFaceCount('sess-B'), 1, 'B 的分配不受影响')
    assert.equal(T.hasCompletedStepBag('sess-B'), true, 'B 的 bag 不受影响')
    assert.equal(T.getStepCardBridgeLeaderCount('sess-B'), 1, 'B 仍有 leader')
    assert.equal(T.completedStepTopFaces.get('sess-B').get('["process","f-b1",null]'), topB, 'B 的 top face 不因清 A 而变')
    assert.ok(cardRulesCss().includes(T.cssAttrValue('["process","f-b1",null]')), 'B 的规则仍在')
  })
  it('G：session 重开重新分配（不复用被清掉的旧值），且变体资产不重复注入', async () => {
    const session = 'reopen-session'
    const key = '["process","g1",null]'
    const conv = makeSession([key])
    renderSubtree(bridgeNode(conv, session, 'A'))
    const first = T.completedStepTopFaces.get(session).get(key)
    renderSubtree(null)
    await flushMicrotasks()
    assert.equal(T.getCompletedStepFaceCount(session), 0, '重开前已清')
    const tagsBefore = sharedDocument.querySelectorAll('style[data-plugin-css^="dsh-turn-fold/style-step-faces"]').length
    const setsBefore = T.completedFaceSets.size
    renderSubtree(bridgeNode(conv, session, 'A2'))
    const second = T.completedStepTopFaces.get(session).get(key)
    assert.ok(T.pokerFacePool().includes(second), '重开后重新分配到池内牌面：' + second)
    assert.equal(T.getCompletedStepFaceCount(session), 1)
    assert.equal(sharedDocument.querySelectorAll('style[data-plugin-css^="dsh-turn-fold/style-step-faces"]').length, tagsBefore, '同一变体资产不重复注入')
    assert.equal(T.completedFaceSets.size, setsBefore, '变体缓存复用')
    assert.ok(first !== undefined && second !== undefined)
    // 允许 first === second（随机可能相同），但必须是"重新分配"出来的（旧 bucket 已被清）
  })
  it('H：running 组零回归——不分配 topFace、不消耗 bag、不写 completed 规则', () => {
    const session = 'running-session'
    const runningConv = {
      grouped: null,
      useConversation: null,
    }
    const key = '["process","run",null]'
    let value = { key, members: [], data: { turn: 1, closed: false, summary: { counts: [{ kind: 'read', count: 2 }] } } }
    const listeners = new Set()
    const source = { getSnapshot: () => value, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } } }
    const grouped = { entries: [{ kind: 'group', key }], groupSource: () => source }
    const snapshot = { views: { grouped: () => grouped } }
    runningConv.useConversation = (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot))
    runningConv.grouped = grouped
    renderSubtree(bridgeNode(runningConv, session, 'R'))
    assert.equal(T.getCompletedStepFaceCount(session), 0, 'running 组不得分配 topFace')
    assert.equal(T.hasCompletedStepBag(session), false, 'running 组不得建 bag')
    assert.equal(cardRulesCss(), '', 'running 组不得写 completed 规则')
    // 之后该组 settle → 才分配（且仍是完整一批的第一张）
    value = { key, members: [], data: { turn: 1, closed: true, summary: { counts: [{ kind: 'read', count: 2 }] } } }
    act(() => { for (const l of [...listeners]) l(); })
    act(() => {})   // probe → report → version → 写规则（链式 effect 分两拍 flush）
    assert.equal(T.getCompletedStepFaceCount(session), 1, 'settle 后才分配')
    const tops = [T.completedStepTopFaces.get(session).get(key)]
    for (let n = 2; n <= 5; n += 1) tops.push(T.completedStepTopFace(session, 'run' + n))
    assert.equal(new Set(tops).size, 5, 'running 不消耗 bag：settle 后 5 个组仍是完整一批：' + tops.join(','))
  })
})

// ══════════════════════════════════════════════════════════════════════
// I. 多 session 共存：规则分块合并，不互相覆盖
// ══════════════════════════════════════════════════════════════════════
describe('Bridge 多 session：规则分块合并', () => {
  it('两个 session 同时挂载 → 两个 session 的规则块都在，互不覆盖；各自 leader 恰好 1', () => {
    const a = makeSession(['["process","m-a",null]'])
    const b = makeSession(['["process","m-b",null]'])
    renderSubtree(react.createElement(react.Fragment, null, [
      bridgeNode(a, 'multi-A', 'A'), bridgeNode(b, 'multi-B', 'B2'),
    ]))
    assert.equal(T.getStepCardBridgeSessionCount() >= 2, true, '两个 session 都有 bridge')
    assert.equal(T.getStepCardBridgeLeaderCount('multi-A'), 1)
    assert.equal(T.getStepCardBridgeLeaderCount('multi-B'), 1)
    const css = cardRulesCss()
    assert.ok(css.includes(T.cssAttrValue('["process","m-a",null]')), 'A 的规则块在场')
    assert.ok(css.includes(T.cssAttrValue('["process","m-b",null]')), 'B 的规则块在场（不被 A 覆盖）')
    // A 卸载 → 只撤下 A 的块
    renderSubtree(bridgeNode(b, 'multi-B', 'B2'))
    const after = cardRulesCss()
    assert.ok(!after.includes(T.cssAttrValue('["process","m-a",null]')), 'A 的块已撤下')
    assert.ok(after.includes(T.cssAttrValue('["process","m-b",null]')), 'B 的块保持')
  })
})
