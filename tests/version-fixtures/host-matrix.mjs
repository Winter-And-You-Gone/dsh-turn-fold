// 官方版本契约快照（HOST CAPABILITY MATRIX 的可执行副本）。
//
// 来源：`X:\DSH\deepseek-harness` 官方仓库的 release tag（只读审计，逐版本
// `git grep` / `git show <tag>:<path>` 取得），**不是**按版本号猜的：
//   · turn-process 节点 + TurnProcessOwnerProps  → ui-chat/src/client/contract/slots.ts
//   · turnDataSource / useTurnData              → ui-chat/src/client/（会话级数据面）
//   · Step 分组（ChatGroupSeat / ProcessGroupHeader / groupSource /
//     data-step-process / data-chat-group-key） → ui-chat / ui-conversation
//   · 会话锚点 data-conversation-session         → ui-conversation ConversationContent
//     （官方 commit b7ac0ade10 引入，位于 0.1.7-rc.1 与 rc.2 之间）
//   · shimmer 契约（旧 data-text-shimmer / 新 data-shimmer）→ ProcessGroupHeader
//   · transcriptView                             → settings 侧
//
// 每个版本的 `probe` 是**注册期能力探针的输入**（官方 slot 注册表里有什么），
// `expect` 是插件应当落入的 feature-level 模式。

/** 版本契约快照表（按版本升序）。 */
export const HOST_VERSION_FIXTURES = [
  {
    version: '0.1.1-rc.2',
    tag: 'dsh-v0.1.1-rc.2',
    probe: { officialTurnProcess: false, officialStandardKit: false, stepGroups: false, sessionDomScope: false, oldShimmer: false, newShimmer: false, transcriptView: false },
    expect: { turnFold: 'legacy', stepFold: 'legacy', metrics: 'legacy', mode: 'legacy' },
    note: '无 turn-process 节点、无 useChat/useConversation、无 Step 分组 —— 纯旧宿主',
  },
  {
    version: '0.1.2-rc.1',
    tag: 'dsh-v0.1.2-rc.1',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: false, sessionDomScope: false, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'modern', mode: 'mixed' },
    note: '有 turn-process + TurnProcessOwnerProps（官方 Turn Fold）；无 turnDataSource、无 Step 分组、无 hasContent',
  },
  {
    version: '0.1.5-rc.3',
    tag: 'dsh-v0.1.5-rc.3',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: false, sessionDomScope: false, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'modern', mode: 'mixed' },
    note: '同 0.1.2 代：Turn modern / Step legacy',
  },
  {
    version: '0.1.6-alpha.2',
    tag: 'dsh-v0.1.6-alpha.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: false, sessionDomScope: false, oldShimmer: false, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'legacy', metrics: 'modern', mode: 'mixed' },
    note: '同 0.1.2 代；侧栏子代理会话已出现（sidebar.chat.conversation）但会话锚点仍未出现',
  },
  {
    version: '0.1.7-rc.1',
    tag: 'dsh-v0.1.7-rc.1',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: true, sessionDomScope: false, oldShimmer: true, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'modern', mode: 'modern' },
    note: 'Turn/Step 全现代；会话内容根有 data-conversation-content 但还没有 data-conversation-session → 会话作用域走 CSS 回退',
  },
  {
    version: '0.1.7-rc.2',
    tag: 'dsh-v0.1.7-rc.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: true, sessionDomScope: true, oldShimmer: true, newShimmer: false, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'modern', mode: 'modern' },
    note: '官方首次带 data-conversation-session（commit b7ac0ade10）',
  },
  {
    version: '0.2.0-rc.2',
    tag: 'dsh-v0.2.0-rc.2',
    probe: { officialTurnProcess: true, officialStandardKit: true, stepGroups: true, sessionDomScope: true, oldShimmer: false, newShimmer: true, transcriptView: true },
    expect: { turnFold: 'modern', stepFold: 'modern', metrics: 'modern', mode: 'modern' },
    note: 'shimmer 契约从 data-text-shimmer 切到 data-shimmer（插件双契约同时兼容）',
  },
]

/** 由 fixture 的 probe 生成插件注册期探针的输入。 */
export function capabilitiesFromFixture(fixture) {
  const p = fixture.probe
  const nativeTurnFold = p.officialTurnProcess === true
  return {
    nativeTurnFold,
    reactiveTurnData: nativeTurnFold && p.officialStandardKit === true,
    nativeStepGroups: nativeTurnFold && p.officialStandardKit === true && p.stepGroups === true,
    durableProjection: false,
  }
}
