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
// 官方 decode-speed TPS 的手工核算（turn-metrics.assistantStepReading 语义）：
// 每步 decodeMs = completedTime - firstTokenTime；TPS = ΣoutputTokens / Σ(decodeMs/1000)。
// 5 步每步 decode 265.1s（firstToken = stepStart+4900、completed = 下一 stepStart）：
// Σ decodeMs = 1325500ms、Σ decodeTokens = 3273 → tps = 3273/1325.5 ≈ 2.4693 → '2.5'。
export const TURN13_STEP_TIMINGS = TURN13_USAGE_STEPS.map((usage, i) => ({
  stepStartTime: T0 + i * 270000,
  firstTokenTime: T0 + i * 270000 + 4900,
  completedTime: T0 + (i + 1) * 270000,
}))
export const TURN13_EXPECT_TPS = '2.5'

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

/** 一个已 settle 的 assistant-step 数据（usage + finalNode{usage,timing}，官方形状：
 *  finalNode.usage = assistant/message 事件的 usage、finalNode.timing = AssistantTiming
 *  { stepStartTime, firstTokenTime, completedTime }——completedTime 缺省给 T1）。 */
export function makeStepData(step, { usage, timing } = {}) {
  return {
    turn: 13,
    step,
    status: 'settled',
    usage,
    finalNode: timing
      ? {
          step,
          usage,
          timing: {
            stepStartTime: timing.stepStartTime,
            firstTokenTime: timing.firstTokenTime,
            completedTime: timing.completedTime ?? T1,
          },
        }
      : undefined,
  }
}

/** 一个 running 的 assistant-step 数据（官方 projectAssistant：status='running'、
 *  blocks = 当前已流出的官方 AssistantBlock 列表、time = firstVisibleTime（第一个可见
 *  text/reasoning block 的事件时间）、无 finalNode）。
 *  @param {number} [opts.time] - 第一个可见内容的事件时间（epoch ms）。
 *  @param {Array} [opts.blocks] - 官方 AssistantBlock[]（默认 []——刚发起、尚无可见输出）。 */
export function makeRunningStepData(step, { time, usage, blocks } = {}) {
  return { turn: 13, step, status: 'running', blocks: blocks ?? [], time, usage }
}

/** StepLocation 最小形状（start = step/start 事件，与官方 AssistantTiming.stepStartTime
 *  同一时间戳）。 */
export function makeStep(step, data, startTime) {
  return { turn: 13, step, start: startTime === undefined ? undefined : { time: startTime }, data: stepDataStore(data) }
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

/** 官方聚合 tokenUsage（turn-tail 携带，deriveTurnTokenUsage 形状）。 */
export const OFFICIAL_TOKEN_USAGE = {
  uncachedInputTokens: 22065,
  outputTokens: 3273,
  totalTokens: 370202,
  cacheReadTokens: 344864,
}

// ── 订阅最小切片的测试 mocks（对齐官方 hook 形状） ──

/** useTurnData mock：官方 slot 注入面 hook（uSES over turn.data.source(key)）。
 *  测试只需要按 key 直读——tail 在挂载前给定。 */
export function makeUseTurnData({ tail } = {}) {
  return (key) => (key === 'turn-tail' ? tail : undefined)
}

const EMPTY_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }

/** assistant-step 数组的可变源（对齐官方 turnDataSource 的 ObservableSnapshot 形状：
 *  identity-stable source + 订阅通知）。set(list) 模拟官方增量发布（成员/成员数据
 *  变化 → 新数组）。 */
export function makeStepsSource(initial = []) {
  const holder = { value: initial, listeners: new Set() }
  return {
    holder,
    source: {
      getSnapshot: () => holder.value,
      subscribe(fn) { holder.listeners.add(fn); return () => holder.listeners.delete(fn) },
    },
    set(list) {
      holder.value = list
      for (const fn of [...holder.listeners]) fn()
    },
  }
}

/** useChat mock：selector 只被用于取 (turn, kind) 的数据源——返回 identity-stable
 *  source（快照发布不触发重渲染，数据变化由 source 自己的订阅驱动）。 */
export function makeUseChat(stepsHolder, turnNumber = 13) {
  return (selector) => selector({
    nodes: {
      turnDataSource: (turn, kind) => (turn === turnNumber && kind === 'assistant-step' && stepsHolder
        ? stepsHolder.source
        : EMPTY_SOURCE),
    },
  })
}
