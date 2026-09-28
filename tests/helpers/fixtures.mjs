// turn-process 渲染器测试 fixtures：按 DSH 官方契约（ui-chat contract/slots.ts、
// contract/chat-nodes.ts、contract/turn-process.ts、ui-conversation conversation.ts）
// 构造最小 props——EnhancedTurnProcessView 只消费 node / turnProcess / useChat。
//
// 官方数据面：
//   node: ChatNode<'turn-process'> = { key, kind:'turn-process', data: TurnProcessChatData,
//                                       location: { kind:'turn', turn: TurnLocation } }
//   TurnLocation = { turn, start:{time}, end:{time, data:{reason:{kind}}}, status,
//                    steps: StepLocation[]（每步 data.get('assistant-step')）,
//                    data: ConversationLocationDataStore（get('turn-process'/'turn-tail')） }
//   turnProcess: TurnProcessOwnerProps = { spec, foldable, hasContent, open, setOpen }
//   useChat: SessionStandardProps 合并成员 —— (selector) => selector(snapshot)

/** 数值参照（沿用旧版 TURN13 的手工核算：4+1 步 · 22m34s · 370,202 token）。 */
export const T0 = 1787394826374
export const T1 = 1787396180925
export const TURN13_USAGE_STEPS = [
  { inputTokens: 10970, outputTokens: 904, cacheReadTokens: 76544 },
  { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 50000 },
  { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 60000 },
  { inputTokens: 4000, outputTokens: 700, cacheReadTokens: 70000 },
  { inputTokens: 2095, outputTokens: 569, cacheReadTokens: 88320 },
]
// 手工核算：input=22065 · cacheRead=344864 · billedInput=366929 · output=3273
// tokens=370202 · cacheHit=344864/366929=93.99 · duration=1354551ms
export const TURN13_EXPECT = {
  durationMs: 1354551,
  tokens: 370202,
  outputTokens: 3273,
  cacheHitPercent: '93.99',
}

/** step data store：官方 ConversationLocationDataStore 的最小形状。 */
export function stepDataStore(value) {
  return { get: (key) => (key === 'assistant-step' ? value : undefined) }
}

/** turn data store：官方 ConversationLocationDataStore 的最小形状。 */
export function turnDataStore({ spec, tail } = {}) {
  return {
    get: (key) => {
      if (key === 'turn-process') return spec
      if (key === 'turn-tail') return tail
      return undefined
    },
  }
}

/** 一个已 settle 的 assistant-step 数据（usage + finalNode.timing，官方形状）。 */
export function makeStepData(step, { usage, timing } = {}) {
  return {
    turn: 13,
    step,
    status: 'settled',
    usage,
    finalNode: timing
      ? { step, timing: { stepStartTime: timing.stepStartTime, firstTokenTime: timing.firstTokenTime, completedTime: timing.completedTime ?? T1 } }
      : undefined,
  }
}

/** StepLocation 最小形状。 */
export function makeStep(step, data) {
  return { turn: 13, step, data: stepDataStore(data) }
}

/**
 * 构造 turn-process 节点（含完整 TurnLocation）。
 * @param {object} opts
 * @param {'open'|'closed'|'unknown'} [opts.status]
 * @param {number} [opts.startTime] - turn/start 墙钟
 * @param {number} [opts.endTime] - turn/end 墙钟
 * @param {string} [opts.reason] - turn/end reason.kind
 * @param {Array} [opts.steps] - StepLocation[]
 * @param {object} [opts.spec] - TurnProcessSpec（turn data store）
 * @param {object} [opts.tail] - TurnTailChatData（turn data store）
 * @param {object} [opts.data] - 直接覆盖 TurnProcessChatData
 */
export function makeTurnNode(opts = {}) {
  const {
    status = 'closed',
    startTime = T0,
    endTime = T1,
    reason = 'completed',
    steps = [],
    spec,
    tail,
    data,
  } = opts
  const turn = {
    turn: 13,
    status,
    start: startTime === null ? undefined : { time: startTime },
    end: status === 'closed' && endTime !== null
      ? { time: endTime, data: { reason: { kind: reason } } }
      : undefined,
    steps,
    data: turnDataStore({ spec, tail }),
  }
  return {
    key: 'turn-process:13',
    kind: 'turn-process',
    data: data ?? {
      turn: 13,
      controlAnchorSeq: 100,
      processStartSeq: 100,
      answerAnchorSeq: 200,
      answerStep: 5,
      inlineReasoning: false,
      messageCount: 1,
      toolCallCount: 4,
      subagentCount: 0,
    },
    location: { kind: 'turn', turn },
  }
}

/** TurnProcessOwnerProps mock（官方 ChatNodeSeat 构建的 owner state）。 */
export function makeTurnProcessOwner(overrides = {}) {
  const setOpen = overrides.setOpen ?? (() => {})
  return {
    spec: overrides.spec ?? {
      turn: 13, controlAnchorSeq: 100, processStartSeq: 100,
      answerAnchorSeq: 200, answerStep: 5, inlineReasoning: false,
      messageCount: 1, toolCallCount: 4, subagentCount: 0,
    },
    foldable: overrides.foldable ?? true,
    hasContent: overrides.hasContent ?? true,
    open: overrides.open ?? false,
    setOpen,
  }
}

/** useChat mock：SessionStandardProps 的 useChat（selector 直读快照）。 */
export function makeUseChat(snapshot = {}) {
  return (selector) => selector(snapshot)
}

/** 官方聚合 tokenUsage（turn-tail 携带，deriveTurnTokenUsage 形状）。 */
export const OFFICIAL_TOKEN_USAGE = {
  uncachedInputTokens: 22065,
  outputTokens: 3273,
  totalTokens: 370202,
  cacheReadTokens: 344864,
}
