// 纯函数单元测试：computeGroup / computeTurnFold / computeTurnMetrics /
// turnHeaderLabel / formatTurnDuration / formatTokPerSec / turnNumber。
// 直接测试 client.js 的真实实现（经 loader 注入 __test 导出，无复制漂移）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'
import { makeNode, toolNode, asNode, userNode, contextNode, tailNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13, TURN13_NODES, TURN13_METRICS, TURN13_LABEL, OUTSIDE_SCOPE, TWO_USERS } from './helpers/fixtures.mjs'

// 固定界面语言为简体中文（client.js 按 navigator.language(s) 检测；文案断言按中文）。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })

const { test: T } = loadPlugin()

// ─────────────────────────── computeGroup ───────────────────────────
describe('computeGroup（段级分组）', () => {
  it('单条工具调用：count=1，自身为 leader', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc', 300),
      textNode('as2', 400, 'text'),
      asNode('final', 500),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.ok(g)
    assert.equal(g.count, 1)
    assert.equal(g.leaderKey, 'tc')
    assert.equal(g.isLeader, true)
    assert.equal(g.failures, 0)
  })

  it('连续多条工具调用组成一组：count=3，中间成员 isLeader=false', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc1', 300),
      toolNode('tc2', 301),
      toolNode('tc3', 302),
      textNode('as2', 400, 'text'),
      asNode('final', 500),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc2'))
    assert.ok(g)
    assert.equal(g.count, 3)
    assert.equal(g.leaderKey, 'tc1')
    assert.equal(g.isLeader, false)
    assert.deepEqual(g.keys, ['tc1', 'tc2', 'tc3'])
  })

  it('纯 think 入段：think 与工具调用混排成一段（think 不打断段）', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc1', 300),
      // 纯 think（只有 reasoning 块、无 text 块）→ 段成员
      asNode('as-think', 310, { blocks: [{ kind: 'reasoning', text: '思考中' }] }),
      toolNode('tc2', 400),
      textNode('as3', 500, 'text'),
      asNode('final', 600),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 600]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc1'))
    assert.equal(g.count, 3)
    assert.deepEqual(g.keys, ['tc1', 'as-think', 'tc2'])
    assert.equal(g.toolCount, 2, 'think 不算命令数')
    // think 节点自己也能定位到同一段
    const g2 = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('as-think'))
    assert.equal(g2.leaderKey, 'tc1')
    assert.equal(g2.isLeader, false)
  })

  it('text 打断：纯 text 节点（无 reasoning）是段边界，两侧工具调用不合并', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as1', 200, 'text'),
      toolNode('tc1', 300),
      textNode('as2', 310, 'text'),
      toolNode('tc2', 400),
      textNode('final', 500, 'text'),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g1 = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc1'))
    const g2 = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc2'))
    assert.equal(g1.count, 1)
    assert.equal(g2.count, 1)
    assert.notEqual(g1.leaderKey, g2.leaderKey)
  })

  it('失败计数：isError=true 计入，运行中不计入', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('ok', 300),
      toolNode('err', 301, { isError: true }),
      toolNode('run', 302, { running: true }),
      textNode('as2', 400, 'text'),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('ok'))
    assert.equal(g.failures, 1)
    assert.equal(g.anyRunning, true)
  })

  it('autoCollapsed 恒 true（段级折叠始终默认收起，运行中也不例外）', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300, { running: true }),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.equal(g.autoCollapsed, true, '运行中也要默认折叠')
    assert.equal(g.textAfter, false, '段尾之后无 text → 段未闭合')
    assert.equal(g.lastActiveKey, 'tc')
  })

  it('textAfter：段尾之后出现含 text 的节点 → true（段闭合）', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.equal(g.textAfter, true)
    assert.equal(g.toolCount, 1)
  })

  it('回归 Bug1：store 节点对象被替换后，按 key 仍能定位（不依赖对象身份）', () => {
    const textNode = (k, s, t) => makeNode(k, 'assistant-step', s, { data: { blocks: [{ kind: 'text', text: t || '' }] } })
    const nodes = [
      userNode('u', 100),
      textNode('as', 200, 'text'),
      toolNode('tc', 300),
      textNode('as2', 400, 'text'),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const staleProp = s.chat.nodes.get('tc') // ChatNodeSeat 持有的旧对象
    // 模拟运行时替换 store 中的节点对象（同 key 新对象）
    s.chat.nodes.set('tc', toolNode('tc', 300))
    const g = T.computeGroup(s.chat.order, s.chat.nodes, staleProp)
    assert.ok(g, '节点对象替换后 computeGroup 不得返回 null（否则短路渲染内置组件并触发 abdicate）')
    assert.equal(g.leaderKey, 'tc')
    assert.equal(g.count, 1)
  })

  it('order 中找不到节点 key → null', () => {
    const nodes = [userNode('u', 100), asNode('as', 200), toolNode('tc', 300)]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const ghost = toolNode('ghost', 999)
    assert.equal(T.computeGroup(s.chat.order, s.chat.nodes, ghost), null)
  })
})

// ─────────────────────────── segmentLabel / summarizeArgs（段组头标题） ───────────────────────────
describe('segmentLabel / summarizeArgs（段级折叠组头标题）', () => {
  const toolWithArgs = (key, seq, { running = false, name = 'Pwsh', argsRaw } = {}) =>
    makeNode(key, 'tool-call', seq, {
      data: { root: running ? { callId: key, name, argsRaw } : { kind: 'tool-result', callId: key, name, argsRaw, isError: false } },
    })
  const thinkOnly = (key, seq, text) =>
    asNode(key, seq, { blocks: [{ kind: 'reasoning', text }] })

  it('summarizeArgs：取 argsRaw 中最长字符串值（-m 正文 / 路径），截断到上限', () => {
    assert.equal(T.summarizeArgs(JSON.stringify({ args: ['commit', '-m', 'Commit 1: core +tests'] })), 'Commit 1: core +tests')
    assert.equal(T.summarizeArgs(JSON.stringify({ path: 'X:\\DeepSeek Harness\\dsh-plugins\\dsh-turn-fold' })), 'X:\\DeepSeek Harness\\dsh-plugins\\dsh-turn-fold')
    assert.equal(T.summarizeArgs('not-json'), 'not-json')
    assert.equal(T.summarizeArgs(JSON.stringify({ a: 'x'.repeat(100) }), 20), 'x'.repeat(20) + '…')
    assert.equal(T.summarizeArgs(''), '')
    assert.equal(T.summarizeArgs(null), '')
  })

  it('运行中（段未闭合）：标题 = 正在运行 <工具名> · <参数摘要>', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithArgs('tc', 300, { running: true, argsRaw: JSON.stringify({ args: ['commit', '-m', 'Commit 1: core +tests'] }) }),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.equal(g.textAfter, false)
    assert.equal(T.segmentLabel(g, s.chat.nodes), '正在运行Pwsh · Commit 1: core +tests')
  })

  it('运行中（段未闭合）：最后一个节点是 think → 标题 = 正在思考 · 最新一行（流式跟随）', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithArgs('tc', 300, { running: false, argsRaw: JSON.stringify({ args: ['x'] }) }),
      thinkOnly('th', 310, '第一行思考\n第二行思考\n正在分析仓库结构'),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    // 多行 think：运行中摘要取最新一行（官方 ReasoningRow 同款 latestLine）
    assert.equal(T.segmentLabel(g, s.chat.nodes), '正在思考正在分析仓库结构')
    // think 内容只有一行时完整显示（溢出交给 CSS ellipsis / 横向滚动跟随）
    const nodes2 = [
      userNode('u', 100),
      thinkOnly('th2', 200, '长'.repeat(80)),
    ]
    const s2 = buildSnapshot(nodes2, { turnEnds: new Map() })
    const g2 = T.computeGroup(s2.chat.order, s2.chat.nodes, s2.chat.nodes.get('th2'))
    assert.equal(T.segmentLabel(g2, s2.chat.nodes), '正在思考' + '长'.repeat(80))
  })

  it('段闭合（出现下一个 text）：标题 = 运行了 N 条命令（think 不算命令数）', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      thinkOnly('th', 300, '思考'),
      toolWithArgs('tc1', 301, { running: false, argsRaw: '{}' }),
      toolWithArgs('tc2', 302, { running: false, argsRaw: '{}' }),
      asNode('as2', 400), // 含 text → 段闭合
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc1'))
    assert.equal(g.textAfter, true)
    assert.equal(g.toolCount, 2)
    assert.equal(T.segmentLabel(g, s.chat.nodes), '运行了2条命令')
  })

  it('段闭合且组内有失败命令：标题追加失败数', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('ok', 300),
      toolNode('err', 301, { isError: true }),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('ok'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '运行了2条命令——执行失败', '1 条失败显示"——执行失败"（不带条数）')
  })

  it('段闭合：多条失败追加"——y条执行失败"', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('ok', 300),
      toolNode('err1', 301, { isError: true }),
      toolNode('err2', 302, { isError: true }),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('ok'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '运行了3条命令——2条执行失败')
  })

  it('段闭合：单次命令显示工具名，多次显示次数+单位', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '运行了pwsh', '单次命令显示工具名')
  })

  it('段闭合：仅读取工具——同一文件显示文件名，多个文件显示数量', () => {
    const toolWithPath = (key, seq, name, path) =>
      makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: JSON.stringify({ path }), isError: false } } })
    // 同一文件读取两次
    let nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('r1', 300, 'read', 'C:\\proj\\client.js'),
      toolWithPath('r2', 301, 'read', 'C:\\proj\\client.js'),
      asNode('as2', 400),
    ]
    let s = buildSnapshot(nodes, { turnEnds: new Map() })
    let g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('r1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '读取了client.js', '同一文件显示文件名')
    // 两个不同文件
    nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('r1', 300, 'read', 'C:\\proj\\a.js'),
      toolWithPath('r2', 301, 'read', 'C:\\proj\\b.js'),
      asNode('as2', 400),
    ]
    s = buildSnapshot(nodes, { turnEnds: new Map() })
    g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('r1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '读取了2份文件', '多个文件显示数量+份')
  })

  it('段闭合：混合 读取+命令 —— 读取在前、命令在最后；单命令显示工具名', () => {
    const toolWithPath = (key, seq, name, path) =>
      makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: path ? JSON.stringify({ path }) : '{}', isError: false } } })
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('r1', 300, 'read', 'C:\\proj\\client.js'),
      toolWithPath('c1', 301, 'pwsh', null),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('r1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '读取了client.js 运行了pwsh', '读取在前、命令在最后')
  })

  it('段闭合：混合 读取+编辑+命令 —— 读取、编辑按序，命令始终最后', () => {
    const toolWithPath = (key, seq, name, path) =>
      makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: path ? JSON.stringify({ path }) : '{}', isError: false } } })
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('r1', 300, 'read', 'C:\\proj\\a.js'),
      toolWithPath('e1', 301, 'edit', 'C:\\proj\\b.js'),
      toolWithPath('c1', 302, 'pwsh', null),
      toolWithPath('c2', 303, 'pwsh', null),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('r1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '读取了a.js 编辑了b.js 运行了2条命令')
  })

  it('段闭合：仅编辑工具——同一文件显示文件名，单文件时附加行数变更（+xx —xx）', () => {
    const toolWithPath = (key, seq, name, path, extra) =>
      makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: JSON.stringify(Object.assign({ path }, extra)), isError: false } } })
    // 单文件编辑：附加 +12 —3
    let nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('e1', 300, 'edit', 'C:\\proj\\index.js', { insertions: 12, deletions: 3 }),
      asNode('as2', 400),
    ]
    let s = buildSnapshot(nodes, { turnEnds: new Map() })
    let g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('e1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '编辑了index.js +12 —3', '单文件编辑附加行数变更')
    // 多个文件编辑：只显示数量+份，不附加行数
    nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('e1', 300, 'edit', 'C:\\proj\\a.js', { insertions: 12, deletions: 3 }),
      toolWithPath('e2', 301, 'edit', 'C:\\proj\\b.js', { insertions: 1, deletions: 0 }),
      asNode('as2', 400),
    ]
    s = buildSnapshot(nodes, { turnEnds: new Map() })
    g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('e1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '编辑了2份文件')
  })

  it('段闭合：仅搜索工具——显示搜索次数', () => {
    const toolWithPath = (key, seq, name) =>
      makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: '{}', isError: false } } })
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolWithPath('g1', 300, 'grep'),
      toolWithPath('g2', 301, 'grep'),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('g1'))
    assert.equal(T.segmentLabel(g, s.chat.nodes), '搜索了2次')
  })

  it('纯 think 段闭合：标题 = 思考（不显示"运行了 0 条命令"）', () => {
    const nodes = [
      userNode('u', 100),
      thinkOnly('th', 200, '思考'),
      asNode('as2', 300),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('th'))
    assert.equal(g.toolCount, 0)
    assert.equal(T.segmentLabel(g, s.chat.nodes), '思考')
  })
})

// ─────────────────────────── computeTurnFold ───────────────────────────
describe('computeTurnFold（整回合折叠）', () => {
  it('运行中：finalAssistantKey 为 null，第一条中间节点即组头，foldable=true', () => {
    // 回合进行中（turnEnds 为空）：大组头应从回复开始就出现——
    // 当前流式 assistant-step 不作为"最终总结"豁免，第一条中间节点就是组头。
    const nodes = [
      userNode('u-run', 100),
      asNode('as-run-1', 200, { status: 'running' }),
      toolNode('tc-run', 300, { running: true }),
      asNode('as-run-2', 400, { status: 'running' }),
    ]
    const s = buildSnapshot(nodes, {
      turnEnds: new Map(),
      turnTimings: new Map([[13, { startTime: 100000 }]]),
    })
    const h = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as-run-1'))
    assert.equal(h.closed, false)
    assert.equal(h.finalAssistantKey, null, '运行中没有最终总结')
    assert.equal(h.headerKey, 'as-run-1')
    assert.equal(h.isTurnHeader, true)
    assert.equal(h.foldable, true, '运行中只要存在作用域内中间节点即可折叠')
    // 其余节点都是成员（非组头、非最终）
    for (const key of ['tc-run', 'as-run-2']) {
      const f = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get(key))
      assert.equal(f.isTurnHeader, false, `${key} 不是组头`)
      assert.equal(f.isFinalAssistant, false, `${key} 不是最终消息`)
      assert.equal(f.foldable, true, `${key} 参与折叠`)
    }
  })

  it('运行中单条消息：该消息自身即组头（回复开始即出现大组头）', () => {
    const nodes = [userNode('u-solo', 100), asNode('as-solo', 200, { status: 'running' })]
    const s = buildSnapshot(nodes, { turnEnds: new Map() })
    const f = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as-solo'))
    assert.equal(f.closed, false)
    assert.equal(f.isTurnHeader, true)
    assert.equal(f.foldable, true)
  })

  it('回合结束后：finalAssistantKey 恢复为最后一条 assistant-step（单条消息回合不再折叠）', () => {
    const nodes = [userNode('u-solo', 100), asNode('as-solo', 200)]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 300]]) })
    const f = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as-solo'))
    assert.equal(f.closed, true)
    assert.equal(f.finalAssistantKey, 'as-solo')
    assert.equal(f.isFinalAssistant, true)
    assert.equal(f.foldable, false, '单条消息回合没有中间节点可折叠')
  })


  it('turnNumber：step/turn 定位返回回合号；unresolved/session 返回 undefined', () => {
    const s = buildSnapshot([userNode('u', 1)], { turnEnds: new Map([[13, 2]]) })
    assert.equal(T.turnNumber(s.chat.nodes.get('u')), 13)
    const unresolved = makeNode('x', 'tool-call', 1, { location: { kind: 'unresolved' } })
    assert.equal(T.turnNumber(unresolved), undefined)
    const sessionLoc = makeNode('y', 'tool-call', 1, { location: { kind: 'session' } })
    assert.equal(T.turnNumber(sessionLoc), undefined)
  })

  it('closed：turnEnds 有该回合 → true；无 → false', () => {
    const s = buildSnapshot([userNode('u', 1), asNode('as', 2)], { turnEnds: new Map() })
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as'))
    assert.equal(fold.closed, false)
    s.turnEnds.set(13, 10)
    const fold2 = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as'))
    assert.equal(fold2.closed, true)
  })

  it('回归 verify-fix 场景 1：新会话上下文注入在用户消息之前 → headerKey 取用户消息之后第一条', () => {
    const nodes = [
      contextNode('ctx-approval', 15, 'text'),
      userNode('user-main', 16),
      asNode('as-step1', 130),
      toolNode('tool-1', 131),
      contextNode('ctx-skills', 135, 'text'),
      asNode('as-step2', 383),
      asNode('as-final', 4444),
      tailNode('turn-tail', 4445),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 4445]]) })
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as-step1'))
    assert.equal(fold.headerKey, 'as-step1')
    assert.equal(fold.outsideScope, false)
    // ctx-approval 在作用域外：绝不作组头
    const ctxFold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('ctx-approval'))
    assert.equal(ctxFold.outsideScope, true)
    assert.equal(ctxFold.isTurnHeader, false)
  })

  it('回归 verify-fix 场景 2：上下文注入在用户消息之后 → 作为 headerKey', () => {
    const nodes = [
      userNode('user-cont', 4458),
      contextNode('ctx-vision', 4460, 'text'),
      asNode('as-t3s1', 4461),
      toolNode('tool-3-1', 4465),
      asNode('as-t3-final', 14497),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 14498]]) })
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('ctx-vision'))
    assert.equal(fold.headerKey, 'ctx-vision')
    assert.equal(fold.isTurnHeader, true)
  })

  it('回归 verify-fix 场景 3：无 user 节点的回合 → 回退到第一条中间节点', () => {
    const nodes = [
      contextNode('ctx-a', 100, 'text'),
      asNode('as-1', 101),
      toolNode('tool-a', 102),
      asNode('as-final', 103),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 104]]) })
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('ctx-a'))
    assert.equal(fold.headerKey, 'ctx-a')
    assert.equal(fold.isTurnHeader, true)
  })

  it('回归 verify-fix 场景 4：两个用户消息 + 中间上下文 → headerKey 取最后一个 user 之后', () => {
    const nodes = [
      userNode('user-a', 200),
      contextNode('ctx-mid', 201, 'text'),
      userNode('user-b', 202),
      asNode('as-1', 203),
      toolNode('tool-a', 204),
      asNode('as-final', 205),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 206]]) })
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('as-1'))
    assert.equal(fold.headerKey, 'as-1')
    // ctx-mid 锚定在最后一个 user 之前 → 作用域外
    const mid = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('ctx-mid'))
    assert.equal(mid.outsideScope, true)
  })

  it('真实数据 TURN13：as-1 为组头、as-5 为最终消息、其余全部成员且 foldable', () => {
    for (const n of TURN13_NODES) {
      if (n.kind === 'user' || n.kind === 'turn-tail') continue
      const fold = T.computeTurnFold(TURN13.chat.order, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnEnds, n)
      assert.ok(fold, `${n.key} 应有 fold`)
      assert.equal(fold.closed, true, `${n.key} closed`)
      assert.equal(fold.foldable, true, `${n.key} foldable`)
      assert.equal(fold.outsideScope, false, `${n.key} 应在折叠作用域内`)
      assert.equal(fold.turn, 13)
    }
    const header = T.computeTurnFold(TURN13.chat.order, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnEnds, TURN13.chat.nodes.get('as-1'))
    assert.equal(header.isTurnHeader, true)
    const final = T.computeTurnFold(TURN13.chat.order, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnEnds, TURN13.chat.nodes.get('as-5'))
    assert.equal(final.isFinalAssistant, true)
    for (const key of ['tc-revert', 'tc-check', 'tc-restore', 'tc-verify', 'as-2', 'as-3', 'as-4']) {
      const f = T.computeTurnFold(TURN13.chat.order, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnEnds, TURN13.chat.nodes.get(key))
      assert.equal(f.isTurnHeader, false, `${key} 不是组头`)
      assert.equal(f.isFinalAssistant, false, `${key} 不是最终消息`)
    }
  })

  it('回归 Bug1（fold 侧）：store 节点对象替换后 ourKey 仍能按 key 定位', () => {
    const s = buildSnapshot(
      [userNode('u', 100), asNode('as', 200), toolNode('tc', 300), asNode('final', 400)],
      { turnEnds: new Map([[13, 500]]) },
    )
    const staleProp = s.chat.nodes.get('tc')
    s.chat.nodes.set('tc', toolNode('tc', 300)) // 替换对象
    const fold = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, staleProp)
    assert.equal(fold.ourKey, 'tc')
    assert.equal(fold.foldable, true)
  })

  it('OUTSIDE_SCOPE fixture：作用域外节点不参与折叠', () => {
    const ctx = T.computeTurnFold(OUTSIDE_SCOPE.chat.order, OUTSIDE_SCOPE.chat.nodes, OUTSIDE_SCOPE.chat.locations, OUTSIDE_SCOPE.turnEnds, OUTSIDE_SCOPE.chat.nodes.get('ctx-approval'))
    assert.equal(ctx.outsideScope, true)
    assert.equal(ctx.isTurnHeader, false)
    const as = T.computeTurnFold(OUTSIDE_SCOPE.chat.order, OUTSIDE_SCOPE.chat.nodes, OUTSIDE_SCOPE.chat.locations, OUTSIDE_SCOPE.turnEnds, OUTSIDE_SCOPE.chat.nodes.get('as-o-1'))
    assert.equal(as.headerKey, 'as-o-1')
  })

  it('TWO_USERS fixture：ctx-mid 在作用域外，as-1 是组头', () => {
    const mid = T.computeTurnFold(TWO_USERS.chat.order, TWO_USERS.chat.nodes, TWO_USERS.chat.locations, TWO_USERS.turnEnds, TWO_USERS.chat.nodes.get('ctx-mid'))
    assert.equal(mid.outsideScope, true)
    const as = T.computeTurnFold(TWO_USERS.chat.order, TWO_USERS.chat.nodes, TWO_USERS.chat.locations, TWO_USERS.turnEnds, TWO_USERS.chat.nodes.get('as-2u-1'))
    assert.equal(as.isTurnHeader, true)
    assert.equal(as.headerKey, 'as-2u-1')
  })
})

// ─────────────────────────── 指标与文案 ───────────────────────────
describe('computeTurnMetrics / turnHeaderLabel / 格式化', () => {
  it('TURN13 指标核算与真实会话一致', () => {
    const m = T.computeTurnMetrics(13, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnTimings)
    assert.deepEqual(m, TURN13_METRICS)
  })

  it('TURN13 大组头文案与真实会话一致', () => {
    const m = T.computeTurnMetrics(13, TURN13.chat.nodes, TURN13.chat.locations, TURN13.turnTimings)
    assert.equal(T.turnHeaderLabel(m), TURN13_LABEL)
  })

  it('无任何指标 → 返回空字符串（回退"运行了 N 条命令"由调用方决定）', () => {
    assert.equal(T.turnHeaderLabel(null), '')
    assert.equal(T.turnHeaderLabel(undefined), '')
    const empty = T.computeTurnMetrics(99, new Map(), { getTurn: () => [] }, new Map())
    assert.equal(empty, null)
  })

  it('运行中（liveNow）：耗时按 now-startTime 实时计算、token 累计、tok/s 实时估算、缓存命中实时', () => {
    // 回合进行中：turnTimings 只有 startTime（无 endTime），liveNow 由每秒秒表提供。
    const nodes = [
      userNode('u-live', 100),
      asNode('as-live-1', 200, { status: 'running', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 } }),
      toolNode('tc-live', 300, { running: true }),
      asNode('as-live-2', 400, { status: 'running', usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 60 } }),
    ]
    const s = buildSnapshot(nodes, {
      turnEnds: new Map(),
      turnTimings: new Map([[13, { startTime: 100000 }]]),
    })
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, 105000)
    // 耗时 = 105000 - 100000 = 5000ms；token = (100+30) + (200+60) + (50+10) = 450
    // tok/s = 60 / 5 = 12；缓存命中 = round(260 / 390 * 100) = 67
    assert.equal(m.durationMs, 5000)
    assert.equal(m.tokens, 450)
    assert.equal(m.tokensPerSecond, 12)
    assert.equal(m.cacheHitPercent, 67)
    assert.equal(T.turnHeaderLabel(m), '耗时5秒，消耗450token，12tok/s，缓存命中67%')
  })

  it('运行中：无 liveNow（回合已结束）时耗时取 endTime，不产生实时 tok/s', () => {
    const nodes = [
      userNode('u-settled', 100),
      asNode('as-s-1', 200, { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 } }),
      asNode('as-s-2', 400, { usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 60 } }),
    ]
    const s = buildSnapshot(nodes, {
      turnEnds: new Map([[13, 500]]),
      turnTimings: new Map([[13, { startTime: 100000, endTime: 105000 }]]),
    })
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, undefined)
    assert.equal(m.durationMs, 5000)
    assert.equal(m.tokens, 450)
    // 无 turn-tail 且未传 liveNow → 不估算 tok/s（保持既有行为）
    assert.equal(m.tokensPerSecond, undefined)
  })

  it('运行中：耗时不足 1 秒或尚无输出时不显示实时 tok/s（避免瞬时巨大速率）', () => {
    const nodes = [userNode('u-fast', 100), asNode('as-fast', 200, { status: 'running', usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 } })]
    const s = buildSnapshot(nodes, { turnEnds: new Map(), turnTimings: new Map([[13, { startTime: 100000 }]]) })
    const m = T.computeTurnMetrics(13, s.chat.nodes, s.chat.locations, s.turnTimings, 100500)
    assert.equal(m.durationMs, 500)
    assert.equal(m.tokens, 10)
    assert.equal(m.tokensPerSecond, undefined)
    assert.equal(T.turnHeaderLabel(m), '耗时0秒，消耗10token，缓存命中0%')
  })

  it('缺耗时但有 token → 文案省略耗时项', () => {
    assert.equal(T.turnHeaderLabel({ tokens: 100 }), '消耗100token')
  })

  it('formatTurnDuration：秒 / 分秒 / 时分秒', () => {
    assert.equal(T.formatTurnDuration(45000), '45秒')
    assert.equal(T.formatTurnDuration(90000), '1分30秒')
    assert.equal(T.formatTurnDuration(1354551), '22分34秒')
    assert.equal(T.formatTurnDuration(3661000), '1时1分1秒')
    assert.equal(T.formatTurnDuration(0), '0秒')
  })

  it('formatTokPerSec：>=10 取整，<10 保留一位小数', () => {
    assert.equal(T.formatTokPerSec(144), '144')
    assert.equal(T.formatTokPerSec(9.5), '9.5')
    assert.equal(T.formatTokPerSec(0), '0')
    assert.equal(T.formatTokPerSec(-5), '0')
  })

  it('CONFIG 兜底文案与失败追加', () => {
    assert.equal(`${T.CONFIG.headerPrefix} 4 ${T.CONFIG.headerSuffix}`, '运行了 4 条命令')
    assert.equal(`${T.CONFIG.headerPrefix} 6 ${T.CONFIG.headerSuffix}——2${T.CONFIG.failureSuffix}`, '运行了 6 条命令——2条执行失败')
  })
})

// ─────────────────────────── 回合结束状态（timeline reason） ───────────────────────────
// DSH 快照的 s.chat.timeline.turns 里，turn.end 是完整 turn/end 事件，
// 其 data.reason.kind 由 agent-loop 写入（completed / aborted / error / max-tokens / blocked）。
describe('回合结束状态（timeline reason）', () => {
  function turnWithReason(kind) {
    const nodes = [userNode('u', 100), asNode('as', 200), asNode('final', 500)]
    const s = buildSnapshot(nodes, {
      turnEnds: new Map([[13, 600]]),
      timeline: {
        turns: new Map([[13, {
          turn: 13,
          start: { seq: 100 },
          end: { seq: 600, data: { turn: 13, reason: { kind } } },
          status: 'closed',
        }]]),
      },
    })
    return T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('final'), s.chat.timeline)
  }

  it('正常完成 reason.kind=completed → 无状态标签（completed）', () => {
    assert.equal(turnWithReason('completed').turnStatus, 'completed')
  })

  it('用户停止 reason.kind=aborted → stopped', () => {
    assert.equal(turnWithReason('aborted').turnStatus, 'stopped')
  })

  it('出错 reason.kind=error → interrupted', () => {
    assert.equal(turnWithReason('error').turnStatus, 'interrupted')
  })

  it('max-tokens → interrupted', () => {
    assert.equal(turnWithReason('max-tokens').turnStatus, 'interrupted')
  })

  it('blocked（输入被拒绝）→ 按正常完成处理，不误报', () => {
    assert.equal(turnWithReason('blocked').turnStatus, 'completed')
  })

  it('无 timeline → 默认 completed（不误报）', () => {
    const nodes = [userNode('u', 100), asNode('as', 200), asNode('final', 500)]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 600]]) })
    const f = T.computeTurnFold(s.chat.order, s.chat.nodes, s.chat.locations, s.turnEnds, s.chat.nodes.get('final'))
    assert.equal(f.turnStatus, 'completed')
  })
})

// ─────────────────────────── 英文界面（en） ───────────────────────────
// 重新加载一个 factory 实例（LOCALE 在 factory 顶层按 navigator 计算），
// 验证英语适配：耗时/token/tok/s/缓存命中的英文格式。
describe('英文界面（en）', () => {
  it('formatTurnDuration / turnHeaderLabel 输出英文格式', () => {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'] }, configurable: true })
    const { test: T2 } = loadPlugin()
    assert.equal(T2.formatTurnDuration(45000), '45s')
    assert.equal(T2.formatTurnDuration(90000), '1m 30s')
    assert.equal(T2.formatTurnDuration(1354551), '22m 34s')
    assert.equal(T2.formatTurnDuration(3661000), '1h 1m 1s')
    assert.equal(T2.turnHeaderLabel(TURN13_METRICS), '22m 34s, 370202 tokens, 144 tok/s, cache hit 94%')
    assert.equal(T2.turnHeaderLabel({ tokens: 100 }), '100 tokens')
  })
})

// ─────────────────────────── projectLiveTokens / turnDisplayMetrics ───────────────────────────
// 运行中"消耗token"动画增长：真实 usage 只在请求完成时到达，两次之间在真实基线之上
// 叠加动画偏移——偏移按实际 tick 次数推进（+1/+11 交替：个位每 tick +1、十位每 2
// tick +1；tick 间隔 = liveTickMs × 随机数 0.5~1，节奏不规律）；新数据到达只校正
// 基线、偏移继续累计（数字只增不减）。缓存按 turn 记忆，测试间需清理。
describe('projectLiveTokens / turnDisplayMetrics（消耗token 动画增长）', () => {
  // 缓存按 key（sessionId::turn）记忆，测试间需清理
  const k = (n) => `sess::${n}`
  // 动画偏移 = tickCount%10 + floor(tickCount/2)*10（+1/+11 交替）
  const offset = (t) => (t % 10) + Math.floor(t / 2) * 10

  it('首次调用：初始化缓存并返回真实值（动画偏移从 0 起算，且不推进 tick）', () => {
    T.liveTokenCache.clear()
    const base = T.liveTickState.index
    assert.equal(T.projectLiveTokens(k(21), 450, 60, 100000, 12), 450)
    assert.equal(T.liveTickState.index, base, '纯调用不应推进 tick')
  })

  it('无新数据：按 +1/+11 交替节奏持续增长（个位每 tick +1、十位每 2 tick +1）', () => {
    T.liveTokenCache.clear()
    const base = T.liveTickState.index
    T.projectLiveTokens(k(22), 450, 60, 100000, undefined) // 初始化：动画偏移从 0 起
    // 1 个 tick → +1；5 个 tick → +25（十位已动 2 次）
    T.liveTickState.index = base + 1
    assert.equal(T.projectLiveTokens(k(22), 450, 60, 100000, undefined), 450 + offset(1))
    T.liveTickState.index = base + 5
    assert.equal(T.projectLiveTokens(k(22), 450, 60, 100000, undefined), 450 + offset(5))
    // 10 个 tick → +50（十位动了 5 次、个位回到 0）
    T.liveTickState.index = base + 10
    assert.equal(T.projectLiveTokens(k(22), 450, 60, 100000, undefined), 450 + offset(10))
  })

  it('新数据到达：校正基线为真实值，动画偏移继续累计不回退', () => {
    T.liveTokenCache.clear()
    const base = T.liveTickState.index
    T.projectLiveTokens(k(24), 450, 60, 100000, 30) // 初始化：animBaseTick = base
    // 5 个 tick 后真实值到达：基线校正为 1000，偏移照常累计 → 1000 + 25
    T.liveTickState.index = base + 5
    assert.equal(T.projectLiveTokens(k(24), 1000, 110, 100000, 30), 1000 + offset(5))
    // 再 2 个 tick（无新数据）：1000 + 37
    T.liveTickState.index = base + 7
    assert.equal(T.projectLiveTokens(k(24), 1000, 110, 100000, 30), 1000 + offset(7))
  })

  it('缓存 key 含 sessionId：不同会话同 turn 号互不串扰', () => {
    T.liveTokenCache.clear()
    const base = T.liveTickState.index
    T.projectLiveTokens('sA::13', 450, 60, 100000, 30)
    T.projectLiveTokens('sB::13', 100, 10, 100000, 30)
    // 各按自己的基线 + 偏移增长
    T.liveTickState.index = base + 3
    assert.equal(T.projectLiveTokens('sA::13', 450, 60, 100000, 30), 450 + offset(3))
    assert.equal(T.projectLiveTokens('sB::13', 100, 10, 100000, 30), 100 + offset(3))
  })

  it('turnDisplayMetrics：运行中且 liveNow 存在才增长；closed / 无 liveNow / 无 tokens 原样返回', () => {
    T.liveTokenCache.clear()
    const base = T.liveTickState.index
    const m = { durationMs: 5000, tokens: 450, outputTokens: 60, tokensPerSecond: 12, cacheHitPercent: 67 }
    // 首次调用：初始化缓存，返回原对象
    assert.equal(T.turnDisplayMetrics('sess', 26, m, false, 100000), m)
    // 3 个 tick 后无新数据：tokens 增长为 450 + 13 = 463，其余字段不变
    T.liveTickState.index = base + 3
    const second = T.turnDisplayMetrics('sess', 26, m, false, 100000)
    assert.notEqual(second, m)
    assert.equal(second.tokens, 450 + offset(3))
    assert.equal(second.durationMs, 5000)
    assert.equal(second.outputTokens, 60)
    assert.equal(second.tokensPerSecond, 12)
    assert.equal(second.cacheHitPercent, 67)
    // closed：原样返回（不再增长）
    assert.equal(T.turnDisplayMetrics('sess', 26, m, true, 100000), m)
    // liveNow undefined：原样返回
    assert.equal(T.turnDisplayMetrics('sess', 26, m, false, undefined), m)
    // 无 tokens：原样返回
    const noTokens = { durationMs: 1000 }
    assert.equal(T.turnDisplayMetrics('sess', 26, noTokens, false, 100000), noTokens)
    // metrics 为空：原样返回
    assert.equal(T.turnDisplayMetrics('sess', 26, null, false, 100000), null)
  })
})
