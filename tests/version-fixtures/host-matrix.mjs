// 官方版本契约快照（HOST CAPABILITY MATRIX 的可执行副本）。
//
// 来源：`X:\DSH\deepseek-harness` 官方仓库的 release tag（只读审计，逐版本
// `git grep` / `git show <tag>:<path>` 取得），**不是**按版本号猜的：
//   · turn-process 节点 + TurnProcessOwnerProps  → ui-chat/src/client/contract/slots.ts
//   · turnDataSource / useTurnData              → ui-chat/src/client/contract/snapshot.ts
//     （ChatNodeStore.turnDataSource：0.1.7-rc.1 起才有 —— 0.1.2~0.1.6 有 turn-process
//      但没有 reactive metrics 数据面，两者**绝不互相推导**）
//   · Step 分组（ChatGroupSeat / ProcessGroupHeader / grouped / groupSource /
//     data-step-process / data-chat-group-key） → ui-chat / ui-conversation
//     （ConversationSnapshot.views.grouped 契约 0.1.7-rc.1 起才有）
//   · 会话锚点 data-conversation-session         → ui-conversation ConversationContent
//     （官方 commit b7ac0ade10 引入，位于 0.1.7-rc.1 与 rc.2 之间；rc.1 只有
//      data-conversation-content。0.1.6-alpha.2 起才有 content 锚点）
//   · shimmer 契约（旧 data-text-shimmer / 新 data-shimmer）→ ProcessGroupHeader
//   · transcriptView                             → settings 侧
//
// 每个版本的 `probe` 是**注册期能力探针的输入**（官方 slot 注册表里有什么），
// `expect` 是插件应当落入的 feature-level 模式。metrics 取值是三态
// "reactive" | "fallback" | "unknown"，sessionScope 取值是四态
// "official" | "tree-only" | "none" | "unknown"。

/** 版本契约快照表（按版本升序）。 */
export const HOST_VERSION_FIXTURES = [
  {
    version: '0.1.1-rc.2',
    tag: 'dsh-v0.1.1-rc.2',
    probe: { officialTurnProcess: false, officialStandardKit: false, turnDataSource: false, stepGroups: false, sessionDomScope: false, conversationContentAnchor: false, oldShimmer: false, newShimmer: false, transcriptView: false },
    expect: { turnFold: 'legacy', stepFold: 'legacy', metrics: 'fallback', sessionScope: 'none', mode: 'legacy' },
    note: '无 turn-process 节点、无 useChat/useConversation、无 Step 分组 —— 纯旧宿主',
  },
  {
    version: '0.1.2-rc.1',
    tag: 'dsh-v0.1.2-rc.1',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: false, stepGroups: false, sessionDomScope: false, conversationContentAnchor: false, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'fallback', sessionScope: 'none', mode: 'mixed' },
    note: '有 turn-process + TurnProcessOwnerProps（官方 Turn Fold）；无 turnDataSource、无 Process Group 契约 → metrics 走逐 step fallback，不是 reactive',
  },
  {
    version: '0.1.5-rc.3',
    tag: 'dsh-v0.1.5-rc.3',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: false, stepGroups: false, sessionDomScope: false, conversationContentAnchor: false, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'fallback', sessionScope: 'none', mode: 'mixed' },
    note: '同 0.1.2 代：Turn modern / Step legacy / metrics fallback',
  },
  {
    version: '0.1.6-alpha.2',
    tag: 'dsh-v0.1.6-alpha.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: false, stepGroups: false, sessionDomScope: false, conversationContentAnchor: true, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'fallback', sessionScope: 'tree-only', mode: 'mixed' },
    note: '同 0.1.2 代；侧栏子代理会话已出现（sidebar.chat.conversation），ConversationContent 首次渲染 data-conversation-content（仍无 session 锚点）',
  },
  {
    version: '0.1.7-rc.1',
    tag: 'dsh-v0.1.7-rc.1',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: true, stepGroups: true, sessionDomScope: false, conversationContentAnchor: true, oldShimmer: true, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'reactive', sessionScope: 'tree-only', mode: 'modern' },
    note: 'Turn/Step/metrics 全现代（turnDataSource 首次出现）；会话内容根有 data-conversation-content 但还没有 data-conversation-session → tree-only 作用域',
  },
  {
    version: '0.1.7-rc.2',
    tag: 'dsh-v0.1.7-rc.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: true, stepGroups: true, sessionDomScope: true, conversationContentAnchor: true, oldShimmer: true, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'reactive', sessionScope: 'official', mode: 'modern' },
    note: '官方首次带 data-conversation-session（commit b7ac0ade10）',
  },
  {
    version: '0.2.0-rc.2',
    tag: 'dsh-v0.2.0-rc.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, turnDataSource: true, stepGroups: true, sessionDomScope: true, conversationContentAnchor: true, oldShimmer: false, newShimmer: true, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'reactive', sessionScope: 'official', mode: 'modern' },
    note: 'shimmer 契约从 data-text-shimmer 切到 data-shimmer（插件双契约同时兼容）',
  },
]

/** 由 fixture 的 probe 生成能力矩阵的输入（每个探针独立审计、绝不互相推导）。 */
export function capabilitiesFromFixture(fixture) {
  const p = fixture.probe
  return {
    nativeTurnFold: p.officialTurnProcess === true,
    // metrics 数据面独立审计：turnDataSource 0.1.7-rc.1 起才有（0.1.2~0.1.6 没有）
    turnDataSource: p.turnDataSource === true,
    nativeStepGroups: p.stepGroups === true ? true : (p.stepGroups === false ? false : undefined),
    sessionDomScope: p.sessionDomScope === true,
    conversationContentAnchor: p.conversationContentAnchor === true,
    durableProjection: false,
  }
}
