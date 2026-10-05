// 跨版本兼容架构测试：能力探测 → feature-level 模式 → 注册门控 → 运行时定论。
//
// 目标不变量：
//   · UNKNOWN ≠ LEGACY：注册期探不到的 feature（Step/metrics）一律 unknown，
//     绝不因 unknown 触发任何 legacy 入口；只有显式证明契约缺失才允许 legacy；
//   · Modern 宿主（0.1.7-rc.1 / rc.2 / 0.2.0-rc.2）：官方是唯一 Fold owner，
//     legacy 引擎激活数恒为 0，且现代渲染器照常注册；
//   · Hybrid 宿主（0.1.2 ~ 0.1.6）：Turn modern（官方 owner state）+ Step legacy
//     （渲染期证明无 Process Group 契约）+ metrics fallback（无 turnDataSource）——
//     三者互相独立，metrics fallback 绝不触发 legacy fold engine；
//   · Legacy 宿主（0.1.1-rc.2）：Turn 在注册期定论 legacy（slot 表可探）；Step 在
//     注册期同样 unknown（要等渲染期快照证据），注册期不记账；
//   · 诊断两行制：注册期 probing 事实行 + 运行时定论行，每个有效变化最多一次。
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

describe('兼容架构 A：能力探测与模式（三态语义）', () => {
  for (const fixture of HOST_VERSION_FIXTURES) {
    it(fixture.version + ' → ' + fixture.expect.mode + '（' + fixture.note + '）', () => {
      const caps = T.hostCapabilitiesOf(capabilitiesFromFixture(fixture))
      assert.equal(caps.turnFold, fixture.expect.turnFold, 'turn 模式')
      assert.equal(caps.stepFold, fixture.expect.stepFold, 'step 模式')
      assert.equal(caps.metrics, fixture.expect.metrics, 'metrics 模式（reactive/fallback/unknown 三态）')
      assert.equal(caps.sessionScope, fixture.expect.sessionScope, '会话作用域（official/tree-only/none/unknown 四态）')
      assert.equal(caps.turnOwnerHasContent, fixture.probe.turnOwnerHasContent === true, fixture.version + ' owner 契约形状（hasContent 是否存在）——与 fold ownership 无关')
      const mode = caps.turnFold === 'modern' && caps.stepFold === 'modern' ? 'modern'
        : (caps.turnFold === 'legacy' && caps.stepFold === 'legacy' ? 'legacy' : 'mixed')
      assert.equal(mode, fixture.expect.mode, '总模式')
    })
  }
  it('注册期探针与 fixtures 的官方 slot 注册表形状一致（探测逻辑不依赖版本号）', () => {
    for (const fixture of HOST_VERSION_FIXTURES) {
      const slots = makeSlots(fixture.probe)
      const caps = T.detectHostCapabilitiesAtRegistration(slots)
      assert.equal(caps.turnFold, fixture.expect.turnFold, fixture.version + ' turn（注册期 slot 表可探、定论）')
      // Process Group 契约在注册期不可探（没有独立 slot/服务）→ 一律 unknown，渲染期定论
      assert.equal(caps.stepFold, 'unknown', fixture.version + ' step 注册期未知')
      // turnDataSource / 会话锚点注册期同样探不到 → metrics 未知、作用域未知
      //（绝不从 nativeTurnFold 推导出 reactiveTurnData —— 0.1.2~0.1.6 审计证伪了该假设）
      assert.equal(caps.metrics, 'unknown', fixture.version + ' metrics 注册期未知')
      assert.equal(caps.sessionScope, 'unknown', fixture.version + ' sessionScope 注册期未知')
      assert.equal(caps.turnDataSource, undefined, fixture.version + ' turnDataSource 未定论')
      const runtime = T.hostCapabilitiesOf(capabilitiesFromFixture(fixture))
      assert.equal(runtime.stepFold, fixture.expect.stepFold, fixture.version + ' step（渲染期探针）')
      assert.equal(runtime.metrics, fixture.expect.metrics, fixture.version + ' metrics（渲染期探针）')
    }
  })
  it('Turn fold 能力 ≠ metrics 能力：nativeTurnFold=true + turnDataSource=false → turn modern + metrics fallback', () => {
    const caps = T.hostCapabilitiesOf({ nativeTurnFold: true, turnDataSource: false, nativeStepGroups: true })
    assert.equal(caps.turnFold, 'modern')
    assert.equal(caps.stepFold, 'modern')
    assert.equal(caps.metrics, 'fallback', 'metrics 与 turn fold 解耦：无 turnDataSource = fallback，不是 legacy fold engine')
    assert.notEqual(caps.metrics, 'reactive')
  })
  it('owner 契约形状 ≠ ownership：nativeTurnFold=true + turnOwnerHasContent=false → turnFold 仍 modern', () => {
    const caps = T.hostCapabilitiesOf({ nativeTurnFold: true, turnOwnerHasContent: false, nativeStepGroups: true })
    assert.equal(caps.turnFold, 'modern', '缺 hasContent 是契约代际差异，绝不是 legacy turn')
    assert.equal(caps.turnOwnerHasContent, false, '形状能力如实记录（raw probe）')
    assert.equal(T.hostCapabilitiesOf({ nativeTurnFold: true, turnOwnerHasContent: true }).turnOwnerHasContent, true)
    assert.equal(T.hostCapabilitiesOf({ nativeTurnFold: true }).turnOwnerHasContent, undefined, '注册期探不到 → undefined')
  })
  it('sessionScope 四态：official / tree-only / none / unknown 由独立探针决定', () => {
    assert.equal(T.hostCapabilitiesOf({ sessionDomScope: true }).sessionScope, 'official')
    assert.equal(T.hostCapabilitiesOf({ sessionDomScope: false, conversationContentAnchor: true }).sessionScope, 'tree-only')
    assert.equal(T.hostCapabilitiesOf({ sessionDomScope: false, conversationContentAnchor: false }).sessionScope, 'none')
    assert.equal(T.hostCapabilitiesOf({}).sessionScope, 'unknown', '探不到 → unknown（不猜）')
  })
})

describe('兼容架构 B：注册门控（unknown 绝不启动 legacy）', () => {
  for (const fixture of HOST_VERSION_FIXTURES) {
    it(fixture.version + ' 的注册结果符合模式（' + fixture.expect.mode + '）', () => {
      // 每个用例从干净 capability 状态出发（前一用例可能已定论；定论不翻转）
      T.hostCapabilityState.turnFold = 'unknown'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
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
        assert.deepEqual(delta, { turn: 0, step: 0 }, 'hybrid：注册期 Step 是 unknown（渲染期定论），不记账')
      } else {
        assert.ok(!modernRegistered, 'legacy 宿主不得注册现代渲染器')
        // Turn legacy 在注册期定论（slot 表证明）；Step 注册期仍 unknown —— 必须等渲染期
        // 快照证据，注册期绝不记账（UNKNOWN ≠ LEGACY）
        assert.deepEqual(delta, { turn: 1, step: 0 }, 'legacy：只记 Turn 一次；Step 等 runtime 定论')
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
  it('legacy activation 计数只能经由显式 legacy 入口产生（unknown 路径恒 0）', () => {
    const before = T.getLegacyEngineActivations()
    // 模拟"注册期什么都探不到"的宿主（slots 服务异常 → turn 也 unknown 边界：
    // 生产里 slotHasEntry 异常按无能力处理 → turn=legacy 定论，这里只锁 unknown Step）
    T.activateLegacyTurnEngine()
    T.activateLegacyStepEngine()
    const after = T.getLegacyEngineActivations()
    assert.equal(after.turn - before.turn, 1, '显式 Turn legacy 入口记账 1')
    assert.equal(after.step - before.step, 1, '显式 Step legacy 入口记账 1（仅此一条路径）')
  })
})

describe('兼容架构 C：会话作用域 selector（完整 host 逐支生成）', () => {
  const RULES_MAP = { '["process","same",null]': { count: 3, closed: true } }
  /** 把一条规则的 selector（{ 之前的部分）按分支拆开：逗号只允许出现在
   *  "[data-conversation-…]" / "[data-step-process]" 这类分支起点之前
   *  （groupKey JSON 内部的逗号在引号里，后随字符永远不是 "[data-"）。 */
  function branchesOf(ruleSelector) {
    return ruleSelector.split(/,(?=\[data-(?:conversation-content|conversation-session|step-process)\])/)
  }
  it('每条规则的每个分支都是完整 selector：都携带组条件，绝无裸会话分支', () => {
    T.completedStepTopBags.set('sess-A', { remaining: ['spade'], previous: undefined, pool: T.pokerFacePool().join(',') })
    const css = T.buildStepCardRulesCss(RULES_MAP, 'sess-A')
    const lines = css.split('\n').filter(Boolean)
    assert.equal(lines.length, 2, '收起 + 扇形两条规则')
    for (const line of lines) {
      const selector = line.slice(0, line.indexOf('{'))
      const branches = branchesOf(selector)
      assert.equal(branches.length, 2, 'selector list 恰好两支：' + selector.slice(0, 100))
      for (const branch of branches) {
        assert.ok(branch.includes('[data-step-process][data-chat-group-key='), '每个分支都必须携带完整组条件：' + branch)
        assert.ok(!/^\[data-conversation-session="[^"]+"\]$/.test(branch.trim()), '禁止裸会话选择器分支：' + branch)
      }
      assert.ok(branches[0].startsWith('[data-conversation-session="sess-A"] '), '支 1 = 官方会话锚点 + 组')
      assert.ok(branches[1].startsWith('[data-conversation-content]:not([data-conversation-session]) '), '支 2 = rc.1 回退 + 组')
    }
  })
  it('sessionId / groupKey 都走 cssAttrValue 转义（引号、反斜杠），且两支独立转义', () => {
    const weirdSession = 'sess-"A"\\x'
    const weirdKey = '["process","q\\"uote",null]'
    T.completedStepTopBags.set(weirdSession, { remaining: ['spade'], previous: undefined, pool: T.pokerFacePool().join(',') })
    const css = T.buildStepCardRulesCss({ [weirdKey]: { count: 3, closed: true } }, weirdSession)
    assert.ok(css.includes('[data-conversation-session="' + T.cssAttrValue(weirdSession) + '"]'), 'sessionId 必须转义')
    assert.equal((css.match(new RegExp('data-chat-group-key="' + T.cssAttrValue(weirdKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 4, 'groupKey 必须转义：收起/扇形两规则 × 两支各一次')
    assert.ok(!css.includes('sess-"A"'), '不得残留未转义引号')
  })
  it('没有 sessionId（旧宿主）→ 不加前缀（回落历史选择器），且输出层不与其他会话并存', () => {
    const css = T.buildStepCardRulesCss({ [RULES_MAP && Object.keys(RULES_MAP)[0]]: { count: 3, closed: true } }, undefined)
    assert.ok(css.includes('[data-step-process][data-chat-group-key="'), '无 sessionId → 历史选择器')
    assert.ok(!css.includes('data-conversation-session'), '无 sessionId 不得凭空加作用域')
  })
  it('DOM 行为：official selector 只命中带属性的 official 树；fallback selector 只命中无属性树', () => {
    T.completedStepTopBags.set('sess-A', { remaining: ['spade'], previous: undefined, pool: T.pokerFacePool().join(',') })
    const css = T.buildStepCardRulesCss(RULES_MAP, 'sess-A')
    const selectorOf = (line) => line.slice(0, line.indexOf('{'))
    const lines = css.split('\n').filter(Boolean)
    const officialSel = selectorOf(lines[0])
    /** 规则挂在 [data-step-process-icon] 上（::before 不可用于 matches）：剥掉伪元素后
     *  按"规则实际挂的元素"匹配（收起态规则 = 组根下图标位）。 */
    const stripPseudo = (sel) => sel.split('::before').join('')
    const buildHost = (parent, withSession) => {
      const group = sharedDocument.createElement('div')
      group.setAttribute('data-step-process', '')
      group.setAttribute('data-chat-group-key', '["process","same",null]')
      const icon = sharedDocument.createElement('span')
      icon.setAttribute('data-step-process-icon', '')
      group.appendChild(icon)
      parent.appendChild(group)
      return icon
    }
    // official 树（rc.2+ 形状：内容根带 data-conversation-session）
    const officialTree = sharedDocument.createElement('div')
    officialTree.setAttribute('data-conversation-content', '')
    officialTree.setAttribute('data-conversation-session', 'sess-A')
    const officialIcon = buildHost(officialTree, true)
    // rc.1 树（只有 data-conversation-content）
    const rc1Tree = sharedDocument.createElement('div')
    rc1Tree.setAttribute('data-conversation-content', '')
    const rc1Icon = buildHost(rc1Tree, false)
    // 别的会话树
    const otherTree = sharedDocument.createElement('div')
    otherTree.setAttribute('data-conversation-session', 'sess-B')
    const otherIcon = buildHost(otherTree, true)
    sharedDocument.body.appendChild(officialTree)
    sharedDocument.body.appendChild(rc1Tree)
    sharedDocument.body.appendChild(otherTree)
    try {
      // 整条 selector list（两支）：official 与 rc.1 的图标位都命中（各自经不同支）
      assert.ok(officialIcon.matches(stripPseudo(officialSel)), 'official 图标命中 selector list（支 1）')
      assert.ok(rc1Icon.matches(stripPseudo(officialSel)), 'rc.1 图标命中 selector list（支 2）')
      assert.ok(!otherIcon.matches(stripPseudo(officialSel)), '别的会话树绝不命中（两支都不命中 sess-B）')
      // 支 1 单独：只命中 official 树
      const branch1 = stripPseudo(branchesOf(officialSel)[0])
      assert.ok(officialIcon.matches(branch1), '支 1 命中 official 树的图标位')
      assert.ok(!rc1Icon.matches(branch1), '支 1 不命中 rc.1 树')
      assert.ok(!otherIcon.matches(branch1), '支 1 不命中别的会话树')
      // 支 2 单独：只命中无属性树（rc.1 / 无会话锚点）
      const branch2 = stripPseudo(branchesOf(officialSel)[1])
      assert.ok(rc1Icon.matches(branch2), '支 2 命中 rc.1 树的图标位')
      assert.ok(!officialIcon.matches(branch2), '支 2 在带属性宿主上永不命中（:not 失败）')
      assert.ok(!otherIcon.matches(branch2), '支 2 不命中带属性的别的会话树')
      // 两支都携带完整后缀（shimmer 排除 + 卡牌位 + ::before）——不存在"只拼到第二支"的裸分支
      assert.ok(branchesOf(officialSel)[0].includes(':not(:has([data-shimmer="true"]))') && branchesOf(officialSel)[0].endsWith('[data-step-process-icon]::before'), '支 1 携带完整 shimmer 排除 + 卡牌位')
      assert.ok(branchesOf(officialSel)[1].includes(':not(:has([data-shimmer="true"]))') && branchesOf(officialSel)[1].endsWith('[data-step-process-icon]::before'), '支 2 携带完整 shimmer 排除 + 卡牌位')
      assert.ok(sharedDocument.querySelector('[data-conversation-session="sess-A"] [data-step-process]'), '支 1 不是裸会话选择器：它能精确命中组')
    } finally {
      officialTree.remove(); rc1Tree.remove(); otherTree.remove()
    }
  })
})

describe('兼容架构 D：运行时 resolution（unknown → modern / legacy / 保持 unknown）', () => {
  const SNAPSHOT_KEY = '["process","same",null]'
  const GROUP_VALUE = { key: SNAPSHOT_KEY, members: [], data: { turn: 1, closed: true, summary: { counts: [{ kind: 'read', count: 2 }] } } }
  function makeConv(snapshot) {
    return (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot))
  }
  function renderBridge(useConversation, sessionId) {
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(react.createElement(T.StepCardRulesBridge, { useConversation, sessionId })) })
    return { root, container }
  }
  function teardown(h) { act(() => { h.root.unmount() }); h.container.remove() }

  it('D1 快照未就绪（undefined）→ step 保持 unknown，legacy 激活为 0', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    const h = renderBridge(makeConv(undefined), 'd1-sess')
    try {
      assert.equal(T.hostCapabilityState.stepFold, 'unknown', '未就绪 ≠ legacy：保持 unknown')
      assert.deepEqual(T.getLegacyEngineActivations(), before, '未就绪绝不激活 legacy')
    } finally { teardown(h) }
  })
  it('D2 契约缺失（快照就绪、views.grouped 不是函数）→ step=legacy，记一次激活', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    const h = renderBridge(makeConv({ views: {} }), 'd2-sess')
    try {
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', '快照就绪 + 契约缺失 → 显式 legacy')
      const after = T.getLegacyEngineActivations()
      assert.equal(after.step - before.step, 1, 'Legacy Step 激活记账 1')
      assert.equal(after.turn - before.turn, 0, 'Turn 与该定论无关')
    } finally { teardown(h) }
  })
  it('D3 契约在（views.grouped 是函数）→ step=modern，legacy 激活恒 0（grouped 读端暂无数据不算缺失）', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    // 契约在但读端 undefined（无活动 Group Definition）→ 是"暂无数据"，不是"没有能力"
    const snapshot = { views: { grouped: () => undefined } }
    const h = renderBridge(makeConv(snapshot), 'd3-sess')
    try {
      assert.equal(T.hostCapabilityState.stepFold, 'modern', '契约在 → modern（读端数据可以后到）')
      assert.deepEqual(T.getLegacyEngineActivations(), before, 'modern 宿主 legacy 激活恒 0')
    } finally { teardown(h) }
  })
  it('D4 现代宿主全链路：contract true → step=modern；不写 legacy；幂等（重渲染不重复定论/翻转）', () => {
    T.hostCapabilityState.turnFold = 'modern'
    T.hostCapabilityState.stepFold = 'unknown'
    T.hostCapabilityState.metrics = 'unknown'
    const before = T.getLegacyEngineActivations()
    const grouped = { entries: [{ kind: 'group', key: SNAPSHOT_KEY }], groupSource: () => ({ getSnapshot: () => GROUP_VALUE, subscribe: () => () => {} }) }
    const h = renderBridge(makeConv({ views: { grouped: () => grouped } }), 'd4-sess')
    const h2 = renderBridge(makeConv({ views: { grouped: () => grouped } }), 'd4-sess')
    try {
      assert.equal(T.hostCapabilityState.stepFold, 'modern', '契约在 → modern')
    } finally {
      teardown(h)
      teardown(h2)
    }
    assert.equal(T.hostCapabilityState.stepFold, 'modern', '重渲染/卸载不翻转')
    assert.deepEqual(T.getLegacyEngineActivations(), before, '全程 0 激活')
    assert.equal(T.getStepCardBridgeSessionCount(), 0, '卸载后 registry 清空')
  })
  it('D5 已定论的 feature 不翻转（resolveHostFeature 单向迁移）', () => {
    T.hostCapabilityState.stepFold = 'modern'
    assert.equal(T.resolveHostFeature('stepFold', 'legacy'), false, 'modern 不得翻转为 legacy')
    assert.equal(T.hostCapabilityState.stepFold, 'modern')
    T.hostCapabilityState.stepFold = 'legacy'
    assert.equal(T.resolveHostFeature('stepFold', 'modern'), false, 'legacy 不得翻转为 modern')
    assert.equal(T.hostCapabilityState.stepFold, 'legacy')
    assert.equal(T.resolveHostFeature('stepFold', undefined), false, '非定论值不写入')
    assert.equal(T.hostCapabilityState.stepFold, 'legacy')
    T.hostCapabilityState.stepFold = 'unknown'
    assert.equal(T.resolveHostFeature('stepFold', 'modern'), true, 'unknown → 定论是合法迁移')
    T.hostCapabilityState.stepFold = 'unknown'
  })
})

describe('兼容架构 E：metrics 与 Turn fold 解耦（渲染期真实探测）', () => {
  function renderTurnBar(props) {
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
    return { root, container, cleanup: () => { act(() => { root.unmount() }); container.remove() } }
  }
  it('E1 nodes.turnDataSource 在 → metrics=reactive（0.1.7+ 形状）', () => {
    T.hostCapabilityState.metrics = 'unknown'
    const useChat = (selector) => selector({ nodes: { turnDataSource: () => ({ getSnapshot: () => [], subscribe: () => () => {} }) } })
    const v = renderTurnBar({
      node: { data: { turn: 1, status: 'open', startTime: 1000, endTime: null } },
      useChat,
    })
    try {
      assert.equal(T.hostCapabilityState.metrics, 'reactive')
    } finally { v.cleanup() }
  })
  it('E2 nodes 在但 turnDataSource 缺失 → metrics=fallback（0.1.2~0.1.6 形状），Turn fold 不受影响', () => {
    T.hostCapabilityState.metrics = 'unknown'
    T.hostCapabilityState.turnFold = 'modern'
    const before = T.getLegacyEngineActivations()
    const useChat = (selector) => selector({ nodes: {} })
    const v = renderTurnBar({
      node: { data: { turn: 1, status: 'open', startTime: 1000, endTime: null } },
      useChat,
    })
    try {
      assert.equal(T.hostCapabilityState.metrics, 'fallback', '无 turnDataSource = fallback 数据面')
      assert.equal(T.hostCapabilityState.turnFold, 'modern', 'Turn fold 能力不被 metrics 改写')
      assert.equal(T.getLegacyEngineActivations().turn - before.turn, 0, 'metrics fallback 绝不触发 legacy fold engine')
      assert.equal(T.getLegacyEngineActivations().step - before.step, 0, 'metrics fallback 也不触碰 Step legacy 计数')
    } finally { v.cleanup() }
  })
  it('E3 快照未就绪（nodes 缺失）→ metrics 保持 unknown（不定论、不猜）', () => {
    T.hostCapabilityState.metrics = 'unknown'
    const useChat = (selector) => selector(undefined)
    const v = renderTurnBar({
      node: { data: { turn: 1, status: 'open', startTime: 1000, endTime: null } },
      useChat,
    })
    try {
      assert.equal(T.hostCapabilityState.metrics, 'unknown', '未就绪 ≠ fallback')
    } finally { v.cleanup() }
  })
  it('E4 已定论不翻转：reactive 之后即使快照短暂未就绪也不回退', () => {
    T.hostCapabilityState.metrics = 'reactive'
    const useChat = (selector) => selector(undefined)
    const v = renderTurnBar({
      node: { data: { turn: 1, status: 'open', startTime: 1000, endTime: null } },
      useChat,
    })
    try {
      assert.equal(T.hostCapabilityState.metrics, 'reactive')
    } finally { v.cleanup() }
    T.hostCapabilityState.metrics = 'unknown'
  })
})

describe('兼容架构 F：诊断两行制（probing → resolved，每有效变化最多一次）', () => {
  const originalInfo = console.info
  let lines = []
  function capture() {
    lines = []
    console.info = (...args) => { lines.push(args.join(' ')) }
  }
  function release() { console.info = originalInfo }
  it('F1 注册期输出 probing 事实行，绝不下 mixed/modern 结论', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'unknown'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
      const caps = T.hostCapabilitiesOf({ nativeTurnFold: true })
      T.adoptRegistrationCapabilities(caps)
      assert.equal(lines.length, 1, '注册期恰好一行')
      assert.ok(lines[0].includes('host capabilities: turn=modern, step=probing, metrics=probing'), 'probing 行：' + lines[0])
      assert.ok(!lines[0].includes('host mode'), '注册期不得输出 host mode 行')
      // 重复 adopt（同一签名）→ 不重复输出
      T.adoptRegistrationCapabilities(caps)
      assert.equal(lines.length, 1, '签名不变不刷屏')
    } finally { release() }
  })
  it('F2 运行时全部定论 → 输出最终 host mode 行（modern），恰一行', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'modern'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
      T.resolveHostFeature('stepFold', 'modern')
      assert.equal(lines.length, 0, 'metrics 未定论 → 还不输出 mode 行（modern+unknown 不是 mixed）')
      T.resolveHostFeature('metrics', 'reactive')
      assert.equal(lines.length, 1, '全部定论 → 恰一行')
      assert.ok(lines[0].includes('host mode: modern (turn: modern, step: modern, metrics: reactive)'), '最终行：' + lines[0])
      T.resolveHostFeature('metrics', 'fallback')
      T.resolveHostFeature('stepFold', 'legacy')
      assert.equal(lines.length, 1, '已定论 feature 不翻转、不重复输出')
    } finally { release() }
  })
  it('F3 hybrid 宿主 → host mode: mixed (turn: modern, step: legacy, metrics: fallback)', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'modern'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
      T.resolveHostFeature('stepFold', 'legacy')
      T.resolveHostFeature('metrics', 'fallback')
      const modeLines = lines.filter((l) => l.includes('host mode:'))
      assert.equal(modeLines.length, 1)
      assert.ok(modeLines[0].includes('host mode: mixed (turn: modern, step: legacy, metrics: fallback)'), modeLines[0])
    } finally { release() }
  })
  it('F4 legacy 宿主：turn=legacy 单独定论 mode（step/metrics 如实显示 unknown）', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'unknown'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
      const caps = T.hostCapabilitiesOf({ nativeTurnFold: false })
      T.adoptRegistrationCapabilities(caps)
      const modeLines = lines.filter((l) => l.includes('host mode:'))
      assert.ok(lines.some((l) => l.includes('host capabilities: turn=legacy, step=probing, metrics=probing')), 'probing 行')
      assert.equal(modeLines.length, 1, 'legacy 宿主现代渲染器不注册 → mode 由 turn 定论')
      assert.ok(modeLines[0].includes('host mode: legacy (turn: legacy, step: unknown, metrics: unknown)'), modeLines[0])
    } finally { release() }
  })
})

describe('兼容架构 G：feature-aware resolver（各 feature 独立合法值域）', () => {
  const MATRIX = [
    ['turnFold', ['modern', 'legacy'], ['reactive', 'fallback', 'official', 'tree-only', 'none', 'unknown', undefined]],
    ['stepFold', ['modern', 'legacy'], ['reactive', 'fallback', 'official', 'tree-only', 'none', 'unknown', undefined]],
    ['metrics', ['reactive', 'fallback'], ['modern', 'legacy', 'official', 'tree-only', 'none', 'unknown', undefined]],
    ['sessionScope', ['official', 'tree-only', 'none'], ['modern', 'legacy', 'reactive', 'fallback', 'unknown', undefined]],
  ]
  for (const [feature, allowed, rejected] of MATRIX) {
    it(feature + '：允许 ' + allowed.join('/') + '；拒绝跨域值', () => {
      for (const bad of rejected) {
        T.hostCapabilityState[feature] = 'unknown'
        assert.equal(T.resolveHostFeature(feature, bad), false, feature + ' 必须拒绝 ' + String(bad))
        assert.equal(T.hostCapabilityState[feature], 'unknown', '拒绝值不得写入状态')
      }
      for (const good of allowed) {
        T.hostCapabilityState[feature] = 'unknown'
        assert.equal(T.resolveHostFeature(feature, good), true, feature + ' 必须接受 ' + good)
        assert.equal(T.hostCapabilityState[feature], good)
      }
      T.hostCapabilityState[feature] = 'unknown'
    })
  }
})

describe('兼容架构 H：PROBE != COMMIT（render 只读，effect 才 resolve）', () => {
  const originalInfo = console.info
  let lines = []
  function capture() {
    lines = []
    console.info = (...args) => { lines.push(args.join(' ')) }
  }
  function release() { console.info = originalInfo }
  function makeConv(snapshot) {
    return (selector) => react.useSyncExternalStore(() => () => {}, () => selector(snapshot))
  }
  function renderBridge(useConversation, sessionId) {
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(react.createElement(T.StepCardRulesBridge, { useConversation, sessionId })) })
    return { root, container }
  }
  function teardown(h) { act(() => { h.root.unmount() }); h.container.remove() }
  function mountView(el) {
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(el) })
    return { root, container }
  }
  const RUNNING_NODE = { data: { turn: 1, status: 'open', startTime: 1000, endTime: null } }

  it('H1 render 未 flush effect → 全局 capability 不变；flush 后才 resolve', async () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = false   // 允许 render 不 flush（仅本用例）
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    try {
      root.render(react.createElement(T.StepCardRulesBridge, {
        useConversation: makeConv({ views: {} }), sessionId: 'h1-sess',
      }))
      assert.equal(T.hostCapabilityState.stepFold, 'unknown', 'render body 不修改全局 capability state')
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv
    }
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })   // flush committed effects
      assert.equal(T.hostCapabilityState.stepFold, 'legacy', 'committed effect 才 resolve')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
  it('H2 StrictMode：contract=false effect replay → step=legacy 且激活恰一次', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    try {
      act(() => { root.render(react.createElement(react.StrictMode, null,
        react.createElement(T.StepCardRulesBridge, { useConversation: makeConv({ views: {} }), sessionId: 'h2-sess' }))) })
      assert.equal(T.hostCapabilityState.stepFold, 'legacy')
      assert.equal(T.getLegacyEngineActivations().step - before.step, 1, 'StrictMode effect replay 不得重复激活（unknown→legacy 只有一次）')
      const h = renderBridge(makeConv({ views: {} }), 'h2-sess')
      teardown(h)
      assert.equal(T.getLegacyEngineActivations().step - before.step, 1, '后续重渲染仍不重复')
    } finally { act(() => { root.unmount() }); container.remove() }
  })
  it('H3 StrictMode：metrics reactive 只定论一次、诊断只输出一次 resolved 行', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'modern'
      T.hostCapabilityState.stepFold = 'modern'
      T.hostCapabilityState.metrics = 'unknown'
      const EMPTY_LIST = []
      const emptySource = { getSnapshot: () => EMPTY_LIST, subscribe: () => () => {} }
      const useChat = (selector) => selector({ nodes: { turnDataSource: () => emptySource } })
      const h = mountView(react.createElement(react.StrictMode, null,
        react.createElement(T.EnhancedTurnProcessView, { node: RUNNING_NODE, useChat })))
      try {
        assert.equal(T.hostCapabilityState.metrics, 'reactive')
        const modeLines = lines.filter((l) => l.includes('host mode:'))
        assert.equal(modeLines.length, 1, 'resolved mode 只输出一次：' + JSON.stringify(modeLines))
        assert.ok(modeLines[0].includes('host mode: modern'), modeLines[0])
      } finally { teardown(h) }
    } finally { release() }
  })
  it('H4 hybrid 不变量（committed effects 后）：turn modern / step legacy / metrics fallback，激活 Turn=0 Step=1', () => {
    T.hostCapabilityState.turnFold = 'modern'
    T.hostCapabilityState.stepFold = 'unknown'
    T.hostCapabilityState.metrics = 'unknown'
    const before = T.getLegacyEngineActivations()
    const useChatLegacy = (selector) => selector({ nodes: {} })   // 无 turnDataSource（0.1.2~0.1.6 形状）
    const h = mountView(react.createElement(react.Fragment, null, [
      react.createElement(T.StepCardRulesBridge, { useConversation: makeConv({ views: {} }), sessionId: 'h4-sess' }),
      react.createElement(T.EnhancedTurnProcessView, { node: RUNNING_NODE, useChat: useChatLegacy }),
    ]))
    try {
      assert.equal(T.hostCapabilityState.turnFold, 'modern')
      assert.equal(T.hostCapabilityState.stepFold, 'legacy')
      assert.equal(T.hostCapabilityState.metrics, 'fallback')
      assert.equal(T.getLegacyEngineActivations().turn - before.turn, 0)
      assert.equal(T.getLegacyEngineActivations().step - before.step, 1)
    } finally { teardown(h) }
  })
  it('H5 unknown 零副作用：快照/nodes 未就绪 → 保持 unknown、无激活、无最终 mode 行', () => {
    capture()
    try {
      T.resetHostCapabilityDiagnostics()
      T.hostCapabilityState.turnFold = 'modern'
      T.hostCapabilityState.stepFold = 'unknown'
      T.hostCapabilityState.metrics = 'unknown'
      const before = T.getLegacyEngineActivations()
      const useChatUnready = (selector) => selector(undefined)
      const h = mountView(react.createElement(react.Fragment, null, [
        react.createElement(T.StepCardRulesBridge, { useConversation: makeConv(undefined), sessionId: 'h5-sess' }),
        react.createElement(T.EnhancedTurnProcessView, { node: RUNNING_NODE, useChat: useChatUnready }),
      ]))
      try {
        assert.equal(T.hostCapabilityState.stepFold, 'unknown')
        assert.equal(T.hostCapabilityState.metrics, 'unknown')
        assert.deepEqual(T.getLegacyEngineActivations(), before, 'unknown 不产生任何 legacy 副作用')
        assert.equal(lines.filter((l) => l.includes('host mode:')).length, 0, '无最终结论行')
      } finally { teardown(h) }
    } finally { release() }
  })
})

describe('兼容架构 I：resolveLegacyStepCapability 契约（0.1.1 下轮接口；本轮不实现引擎）', () => {
  it('I1 未就绪（undefined）→ 返回 false、保持 unknown', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    assert.equal(T.resolveLegacyStepCapability({ nativeStepGroups: undefined }), false)
    assert.equal(T.resolveLegacyStepCapability({}), false)
    assert.equal(T.resolveLegacyStepCapability(), false)
    assert.equal(T.hostCapabilityState.stepFold, 'unknown')
    assert.deepEqual(T.getLegacyEngineActivations(), before)
  })
  it('I2 显式 false → step=legacy 且激活恰一次；重复调用幂等', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    const before = T.getLegacyEngineActivations()
    assert.equal(T.resolveLegacyStepCapability({ nativeStepGroups: false }), true, 'unknown → legacy 迁移返回 true')
    assert.equal(T.hostCapabilityState.stepFold, 'legacy')
    assert.equal(T.getLegacyEngineActivations().step - before.step, 1)
    assert.equal(T.resolveLegacyStepCapability({ nativeStepGroups: false }), false, '已定论 → false')
    assert.equal(T.getLegacyEngineActivations().step - before.step, 1, '不重复激活')
    T.hostCapabilityState.stepFold = 'unknown'
  })
  it('I3 true（理论兜底）→ step=modern；与 Modern 契约探针同一 resolve 通道', () => {
    T.hostCapabilityState.stepFold = 'unknown'
    assert.equal(T.resolveLegacyStepCapability({ nativeStepGroups: true }), true)
    assert.equal(T.hostCapabilityState.stepFold, 'modern')
    T.hostCapabilityState.stepFold = 'unknown'
  })
})
