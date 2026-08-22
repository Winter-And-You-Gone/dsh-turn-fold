// 纯函数单元测试：computeGroup / computeTurnFold / computeTurnMetrics /
// turnHeaderLabel / formatTurnDuration / formatTokPerSec / turnNumber。
// 直接测试 client.js 的真实实现（经 loader 注入 __test 导出，无复制漂移）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'
import { makeNode, toolNode, asNode, userNode, contextNode, tailNode, buildSnapshot } from './helpers/store.mjs'
import { TURN13, TURN13_NODES, TURN13_METRICS, TURN13_LABEL, OUTSIDE_SCOPE, TWO_USERS } from './helpers/fixtures.mjs'

const { test: T } = loadPlugin()

// ─────────────────────────── computeGroup ───────────────────────────
describe('computeGroup（段级分组）', () => {
  it('单条工具调用：count=1，自身为 leader', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
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
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc1', 300),
      toolNode('tc2', 301),
      toolNode('tc3', 302),
      asNode('as2', 400),
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

  it('Think 打断：两侧工具调用不合并', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as1', 200),
      toolNode('tc1', 300),
      asNode('as2', 310),
      toolNode('tc2', 400),
      asNode('final', 500),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g1 = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc1'))
    const g2 = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc2'))
    assert.equal(g1.count, 1)
    assert.equal(g2.count, 1)
    assert.notEqual(g1.leaderKey, g2.leaderKey)
  })

  it('失败计数：isError=true 计入，运行中不计入', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('ok', 300),
      toolNode('err', 301, { isError: true }),
      toolNode('run', 302, { running: true }),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('ok'))
    assert.equal(g.failures, 1)
    assert.equal(g.anyRunning, true)
  })

  it('autoCollapsed：组尾之后有 Think 且无运行中调用 → true', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
    ]
    const s = buildSnapshot(nodes, { turnEnds: new Map([[13, 500]]) })
    const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('tc'))
    assert.equal(g.hasLaterThink, true)
    assert.equal(g.autoCollapsed, true)
  })

  it('回归 Bug1：store 节点对象被替换后，按 key 仍能定位（不依赖对象身份）', () => {
    const nodes = [
      userNode('u', 100),
      asNode('as', 200),
      toolNode('tc', 300),
      asNode('as2', 400),
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

// ─────────────────────────── computeTurnFold ───────────────────────────
describe('computeTurnFold（整回合折叠）', () => {
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
      contextNode('ctx-approval', 15),
      userNode('user-main', 16),
      asNode('as-step1', 130),
      toolNode('tool-1', 131),
      contextNode('ctx-skills', 135),
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
      contextNode('ctx-vision', 4460),
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
      contextNode('ctx-a', 100),
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
      contextNode('ctx-mid', 201),
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
