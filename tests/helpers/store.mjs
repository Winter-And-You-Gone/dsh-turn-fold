// 测试辅助：模拟 DSH 会话快照 store（useSession 的数据源）。
// 与 dsh-client-runtime 的会话快照同构：{ chat: { order, nodes, locations }, turnEnds, turnTimings }，
// nodes 是带 .get() 的 Map（模拟 MutableChatNodeStore），locations 带 getTurn()。
import { useSyncExternalStore } from 'react'

/**
 * 构造一个节点。
 * @param {string} key
 * @param {string} kind  user | assistant-step | tool-call | context | turn-tail | turn-error | steering
 * @param {number} anchorSeq
 * @param {object} [extra] 附加字段（data / visibility 等）
 */
export function makeNode(key, kind, anchorSeq, extra = {}) {
  const turn = extra.turn ?? 13
  const step = extra.step ?? 1
  const node = {
    key,
    kind,
    id: key,
    target: 'chat',
    anchorSeq,
    visibility: 'visible',
    location: {
      kind: 'step',
      turn: { turn, status: 'closed', end: { seq: anchorSeq + 100 }, steps: [] },
      step: { step, status: 'closed', end: { seq: anchorSeq + 50 } },
    },
    data: {},
    ...extra,
  }
  if (extra.location !== undefined) node.location = extra.location
  return node
}

/** 工具调用节点（root 已结算） */
export function toolNode(key, anchorSeq, { isError = false, running = false, step = 1 } = {}) {
  const root = running
    ? { callId: key, name: 'pwsh' }
    : { kind: 'tool-result', callId: key, name: 'pwsh', isError }
  return makeNode(key, 'tool-call', anchorSeq, { data: { root }, step })
}

/** assistant-step 节点（含 reasoning 块；可选 usage） */
export function asNode(key, anchorSeq, { blocks = null, usage = null, step = 1, status = 'settled' } = {}) {
  const b = blocks ?? [
    { kind: 'reasoning', text: '思考过程' },
    { kind: 'text', text: '正文' },
  ]
  const data = { status, turn: 13, step, blocks: b }
  if (usage) data.usage = usage
  return makeNode(key, 'assistant-step', anchorSeq, { data, step })
}

/** user 节点 */
export function userNode(key, anchorSeq) {
  return makeNode(key, 'user', anchorSeq, { data: { seq: anchorSeq, content: [] } })
}

/** context 节点（上下文注入） */
export function contextNode(key, anchorSeq) {
  return makeNode(key, 'context', anchorSeq, { data: { seq: anchorSeq, source: { kind: 'plugin' } } })
}

/** turn-tail 节点 */
export function tailNode(key, anchorSeq, { tokensPerSecond } = {}) {
  return makeNode(key, 'turn-tail', anchorSeq, {
    data: { turn: 13, seq: anchorSeq, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) },
  })
}

/**
 * 从节点数组构建快照（order 按 anchorSeq 排序 = DSH orderedVisible 语义）。
 * @param {object} [options]
 * @param {Map} [options.turnEnds]
 * @param {Map} [options.turnTimings]
 * @param {object} [options.timeline] 可选：{ turns: Map<turn, { turn, start, end, status }> }，
 *   end 为完整 turn/end 事件（data.reason.kind 用于回合状态检测）。
 * @returns {{ chat: { order, nodes, locations, timeline? }, turnEnds: Map, turnTimings: Map }}
 */
export function buildSnapshot(nodes, { turnEnds = new Map(), turnTimings = new Map(), timeline = undefined } = {}) {
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const visible = nodes.filter((n) => n.visibility !== 'hidden')
  visible.sort((a, b) => a.anchorSeq - b.anchorSeq || (a.key < b.key ? -1 : 1))
  const order = visible.map((n) => n.key)
  const locations = {
    getTurn(turn) {
      return order.filter((k) => {
        const n = byKey.get(k)
        if (!n || !n.location) return false
        const loc = n.location
        return (loc.kind === 'step' || loc.kind === 'turn') && loc.turn.turn === turn
      })
    },
    getStep(turn, step) {
      return order.filter((k) => {
        const n = byKey.get(k)
        if (!n || !n.location) return false
        const loc = n.location
        return loc.kind === 'step' && loc.turn.turn === turn && loc.step.step === step
      })
    },
  }
  return {
    chat: { order, nodes: byKey, locations, ...(timeline !== undefined ? { timeline } : {}) },
    turnEnds,
    turnTimings,
  }
}

/** useSession mock：uSES 兼容的可变快照源 */
export function createSessionStore(initialSnapshot) {
  let snapshot = initialSnapshot
  const listeners = new Set()
  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot() {
      return snapshot
    },
    setSnapshot(next) {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** 把 store 包装成插件期望的 useSession(s => ...) hook */
export function makeUseSession(store) {
  return function useSessionMock(selector) {
    return useSyncExternalStore(
      (fn) => store.subscribe(fn),
      () => selector(store.getSnapshot()),
    )
  }
}
