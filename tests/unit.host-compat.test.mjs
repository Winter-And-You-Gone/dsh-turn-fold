// 跨版本兼容架构测试：能力探测 → feature-level 模式 → 注册门控。
//
// 目标不变量：
//   · Modern 宿主（0.1.7-rc.1 / rc.2 / 0.2.0-rc.2）：官方是唯一 Fold owner，
//     legacy 引擎激活数恒为 0，且现代渲染器照常注册；
//   · Hybrid 宿主（0.1.2 ~ 0.1.6）：Turn modern（官方 owner state）+ Step legacy
//     （官方没有 Process Group 契约）——不注册任何影子渲染器，也不假装 Step 可用；
//   · Legacy 宿主（0.1.1-rc.2）：识别为 legacy、不注册现代渲染器、插件不崩。
// 版本号只出现在 fixtures / 断言的可读标签里，生产判定全部走能力探针。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { HOST_VERSION_FIXTURES, capabilitiesFromFixture } from './version-fixtures/host-matrix.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

/** 假 slot 服务：只暴露插件实际用到的只读面（entries / inject / register）。 */
function makeSlots(probe) {
  const registered = []
  const entriesFor = (slotName) => {
    if (slotName !== 'conversation.chat.node') return []
    const list = []
    if (probe.officialTurnProcess) list.push({ options: { key: 'turn-process', priority: 0 } })
    return list
  }
  const entriesOfView = (slotName) => (slotName === 'conversation.view' && probe.officialStandardKit ? [{ options: { priority: 0 } }] : [])
  return {
    registered,
    entries: (slotName) => (slotName === 'conversation.view' ? entriesOfView(slotName) : entriesFor(slotName)),
    inject: (_slot, fn) => { fn(); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {}; },
  }
}
function applyPlugin(slots) {
  const ctx = { inject: (deps, fn) => { fn({ slots }); return () => {}; } }
  T.exports.apply(ctx)
}

describe('兼容架构 A：能力探测与模式', () => {
  for (const fixture of HOST_VERSION_FIXTURES) {
    it(fixture.version + ' → ' + fixture.expect.mode + '（' + fixture.note + '）', () => {
      const caps = T.hostCapabilitiesOf(capabilitiesFromFixture(fixture))
      assert.equal(caps.turnFold, fixture.expect.turnFold, 'turn 模式')
      assert.equal(caps.stepFold, fixture.expect.stepFold, 'step 模式')
      assert.equal(caps.metrics, fixture.expect.metrics, 'metrics 模式')
      const mode = caps.turnFold === 'modern' && caps.stepFold === 'modern' ? 'modern'
        : (caps.turnFold === 'legacy' && caps.stepFold === 'legacy' ? 'legacy' : 'mixed')
      assert.equal(mode, fixture.expect.mode, '总模式')
    })
  }
  it('注册期探针与 fixtures 的官方 slot 注册表形状一致（探测逻辑不依赖版本号）', () => {
    for (const fixture of HOST_VERSION_FIXTURES) {
      const slots = makeSlots(fixture.probe)
      const caps = T.detectHostCapabilitiesAtRegistration(slots)
      assert.equal(caps.turnFold, fixture.expect.turnFold, fixture.version + ' turn')
      // Process Group 契约在注册期不可探（没有独立 slot/服务）→ 一律 unknown，渲染期定论
      assert.equal(caps.stepFold, 'unknown', fixture.version + ' step 注册期未知')
      const runtime = T.hostCapabilitiesOf(capabilitiesFromFixture(fixture))
      assert.equal(runtime.stepFold, fixture.expect.stepFold, fixture.version + ' step（渲染期探针）')
    }
  })
})

describe('兼容架构 B：注册门控（Modern 宿主 legacy 恒为 0）', () => {
  for (const fixture of HOST_VERSION_FIXTURES) {
    it(fixture.version + ' 的注册结果符合模式（' + fixture.expect.mode + '）', () => {
      const before = T.getLegacyEngineActivations()
      const slots = makeSlots(fixture.probe)
      applyPlugin(slots)
      const after = T.getLegacyEngineActivations()
      const delta = { turn: after.turn - before.turn, step: after.step - before.step }
      const modernRegistered = slots.registered.some((r) => r.options.key === 'turn-process')
      if (fixture.expect.mode === 'modern') {
        assert.ok(modernRegistered, '现代宿主必须注册 turn-process 渲染器')
        assert.deepEqual(delta, { turn: 0, step: 0 }, '现代宿主 legacy 引擎激活数必须为 0')
      } else if (fixture.expect.mode === 'mixed') {
        assert.ok(modernRegistered, 'hybrid 宿主仍注册现代 Turn 渲染器')
        assert.deepEqual(delta, { turn: 0, step: 0 }, 'hybrid：Step 模式由渲染期定论（注册期不记账）')
      } else {
        assert.ok(!modernRegistered, 'legacy 宿主不得注册现代渲染器')
        assert.deepEqual(delta, { turn: 1, step: 1 }, 'legacy：Turn/Step 各记一次')
      }
      // 任何模式下都不得注册影子渲染器（本轮不注册 legacy shadow）
      for (const r of slots.registered) {
        assert.equal(r.options.name, 'conversation.chat.node')
        assert.equal(r.options.key, 'turn-process', '只允许 turn-process 一个 key：' + r.options.key)
      }
    })
  }
  it('现代宿主连续 apply 多次：legacy 仍为 0（幂等、无隐藏 legacy 路径）', () => {
    const modern = HOST_VERSION_FIXTURES.find((f) => f.expect.mode === 'modern')
    const before = T.getLegacyEngineActivations()
    for (let i = 0; i < 5; i += 1) applyPlugin(makeSlots(modern.probe))
    assert.deepEqual(T.getLegacyEngineActivations(), before, '重复 apply 不得激活 legacy')
  })
})

describe('兼容架构 C：会话作用域跨版本', () => {
  const RULES_MAP = { '["process","same",null]': { count: 3, closed: true } }
  it('0.1.7-rc.2+（有官方属性）→ 规则带会话作用域，且回退分支不会命中带属性的树', () => {
    T.completedStepTopBags.set('sess-A', { remaining: ['spade'], previous: undefined, pool: T.pokerFacePool().join(',') })
    const css = T.buildStepCardRulesCss(RULES_MAP, 'sess-A')
    // 作用域是选择器列表前缀：[官方会话属性] 与 [rc.1 回退] 两条并列，各自接同一个组选择器
    assert.ok(css.includes('[data-conversation-session="sess-A"], '), '官方作用域分支')
    assert.ok(css.includes('[data-conversation-content]:not([data-conversation-session]) [data-step-process]'), 'rc.1 回退分支（带属性宿主上永不命中）')
    assert.ok(css.includes('[data-step-process][data-chat-group-key='), '两条分支都指向同一条组规则')
  })
  it('回退分支在新版 DOM 上确实不命中（属性存在 → :not() 失败）', () => {
    const host = sharedDocument.createElement('div')
    host.setAttribute('data-conversation-content', '')
    host.setAttribute('data-conversation-session', 'sess-B')   // 新版：有属性
    const group = sharedDocument.createElement('div')
    group.setAttribute('data-step-process', '')
    group.setAttribute('data-chat-group-key', '["process","same",null]')
    host.appendChild(group)
    sharedDocument.body.appendChild(host)
    try {
      assert.equal(group.matches('[data-conversation-content]:not([data-conversation-session]) [data-step-process]'), false, '新版宿主不得命中回退分支')
      assert.equal(group.matches('[data-conversation-session="sess-B"] [data-step-process]'), true, '应命中自己的会话作用域')
      assert.equal(group.matches('[data-conversation-session="sess-A"] [data-step-process]'), false, '不得命中别的会话')
      host.removeAttribute('data-conversation-session')       // rc.1：没有属性
      assert.equal(group.matches('[data-conversation-content]:not([data-conversation-session]) [data-step-process]'), true, 'rc.1 应命中回退分支（该代无法在 CSS 层区分会话）')
    } finally { host.remove() }
  })
})

describe('兼容架构 D：hybrid 宿主的 Step legacy 由渲染期定论', () => {
  it('会话快照没有 grouped view（0.1.2 ~ 0.1.6）→ 记一次 Step legacy，且不写任何规则', () => {
    const before = T.getLegacyEngineActivations()
    const snapshot = { views: { grouped: undefined } }   // 官方 Process Group 契约缺失
    const useConversation = (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot))
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => { root.render(react.createElement(T.StepCardRulesBridge, { useConversation, sessionId: 'hybrid-sess' })) })
      const after = T.getLegacyEngineActivations()
      assert.equal(after.step - before.step, 1, 'hybrid：Step legacy 记一次')
      assert.equal(after.turn - before.turn, 0, 'hybrid：Turn 仍由官方 owner state 拥有')
      const rules = (sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]') || { textContent: '' }).textContent
      assert.equal(rules, '', '拿不到官方分组就不写任何视觉规则（不猜、不假装）')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
