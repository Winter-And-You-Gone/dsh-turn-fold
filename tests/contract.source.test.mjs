// 官方源码契约测试（双版本，条件式）。
//
// 直接读取本地 DSH checkout，用 git show 对 0.1.7-rc.2 与 0.2.0-rc.2 两个正式
// release commit 分别核对插件真正依赖的源码契约——不止 shimmer：
//   slot 注册 / TurnProcessOwnerProps / turn-process 投影生命周期 /
//   turnDataSource / useTurnData / TurnTokenUsage / Step DOM hooks。
// CI 无 checkout（或无 git）时跳过；插件自己的 fixture 契约测试
// （unit.css / unit.version-matrix 等）不依赖 checkout，始终执行。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'

const CHECKOUT = process.env.DSH_CHECKOUT || 'X:/DSH/deepseek-harness'
// 两个正式 release 基线（git tag：dsh-v0.1.7-rc.2 / dsh-v0.2.0-rc.2）
const BASELINES = [
  { label: '0.1.7-rc.2', commit: '787b746b807df83776957875683b8853c862ca2c' },
  { label: '0.2.0-rc.2', commit: 'c1b47e41fcd54d20a0f061df28683bfc29ee24e5' },
]
const UI_CHAT = 'packages/client/ui-chat/src/client'

async function haveCheckout() {
  if (process.env.DSH_CONTRACT_SKIP === '1') return false
  try {
    await access(CHECKOUT + '/packages/client/ui-chat/src/client/contract/slots.ts')
    await new Promise((resolve, reject) => execFile('git', ['-C', CHECKOUT, '--version'], (e) => (e ? reject(e) : resolve())))
    return true
  } catch {
    return false
  }
}

describe('官方源码契约（双 release commit，条件式）', { skip: !(await haveCheckout()) ? 'no DSH checkout' : false }, () => {
  const show = (rev, path) => new Promise((resolve, reject) => {
    execFile('git', ['-C', CHECKOUT, 'show', rev + ':' + path], (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

  for (const b of BASELINES) {
    it(b.label + '（' + b.commit.slice(0, 10) + '）：conversation.chat.node keyed slot 契约', async () => {
      const slots = await show(b.commit, UI_CHAT + '/contract/slots.ts')
      assert.ok(slots.includes("'conversation.chat.node'") || slots.includes('"conversation.chat.node"'), 'slot 名变更')
      assert.ok(slots.includes('interface TurnProcessOwnerProps'), 'owner props 类型变更')
      for (const field of ['readonly hasContent', 'readonly spec', 'readonly foldable', 'readonly open', 'setOpen(open: boolean): void']) {
        assert.ok(slots.includes(field), 'TurnProcessOwnerProps 字段变更：' + field)
      }
      assert.ok(slots.includes('turnProcess?: TurnProcessOwnerProps | undefined'), 'renderer 不再接收可选 turnProcess owner state')
      assert.ok(slots.includes('UseChatNodeTurnData'), 'renderer 不再接收 turn-scoped data hook')
      assert.ok(slots.includes('useChat'), 'renderer 不再接收 useChat')
    })

    it(b.label + '：TurnProcessOwnerProps 五字段 + alwaysOpen 语义', async () => {
      const tp = await show(b.commit, UI_CHAT + '/contract/turn-process.ts')
      assert.ok(tp.includes('interface TurnProcessSpec'), 'TurnProcessSpec 变更')
      assert.ok(tp.includes('turnProcessAlwaysOpen'), 'alwaysOpen 助手变更')
      assert.ok(tp.includes("'aborted'") && tp.includes("'error'"), 'aborted/error 不可折叠语义变更')
    })

    it(b.label + '：turn-process 以 key 注册、running 阶段投影存在', async () => {
      const reg = await show(b.commit, UI_CHAT + '/chat/register-node-renderers.ts')
      assert.ok(reg.includes("'turn-process'"), 'turn-process 注册 key 变更')
      const projection = await show(b.commit, UI_CHAT + '/conversation-nodes/turn-process.ts')
      assert.ok(projection.includes("'turn/start'"), 'turn-process 不再在 turn/start 投影（Running Turn Bar blocker）')
      assert.ok(projection.includes('registerTurnProcess'), '投影注册入口变更')
    })

    it(b.label + '：turnDataSource identity-stable 最小切片', async () => {
      const snapshot = await show(b.commit, UI_CHAT + '/contract/snapshot.ts')
      assert.ok(
        snapshot.includes('turnDataSource<Kind extends ChatNodeKind>(turn: number, kind: Kind): ObservableSnapshot<readonly ChatNodeDataMap[Kind][]>'),
        'turnDataSource 签名变更',
      )
    })

    it(b.label + '：useTurnData hook 语义（use-turn-data.ts 实现 + apply.ts standard-kit 接线）', async () => {
      const hook = await show(b.commit, UI_CHAT + '/chat/use-turn-data.ts')
      assert.ok(hook.includes('useTurnDataValue'), 'useTurnData 实现变更')
      assert.ok(hook.includes('ConversationTurnDataMap'), 'useTurnData 泛型约束变更')
      const apply = await show(b.commit, UI_CHAT + '/apply.ts')
      assert.ok(
        apply.includes('function useTurnData(key)'),
        b.label + ' standard-kit 不再向 keyed renderer 提供 useTurnData',
      )
    })

    it(b.label + '：TurnTokenUsage 字段 + assistant-step data（usage/finalNode/timing）', async () => {
      const nodes = await show(b.commit, UI_CHAT + '/contract/chat-nodes.ts')
      for (const field of ['totalTokens', 'outputTokens', 'cacheReadTokens?', 'cacheWriteTokens?', 'uncachedInputTokens']) {
        assert.ok(nodes.includes(field), 'TurnTokenUsage 字段变更：' + field)
      }
      assert.ok(nodes.includes('AssistantChatData'), 'assistant-step 数据类型变更')
      assert.ok(nodes.includes('FinalAssistantChatData'), 'settled assistant 数据类型变更')
    })

    it(b.label + '：Step DOM hooks（data-step-process / -icon / activity）', async () => {
      const seat = await show(b.commit, UI_CHAT + '/chat/ChatGroupSeat.tsx')
      assert.ok(seat.includes('data-step-process '), 'data-step-process 钩子变更')
      assert.ok(seat.includes('data-step-process-icon'), 'data-step-process-icon 钩子变更')
      assert.ok(seat.includes('data-process-activity='), 'data-process-activity 钩子变更')
    })
  }

  it('0.1.7-rc.2 的 TextShimmer 渲染 data-text-shimmer（flat 单层）', async () => {
    const shimmer = await show(BASELINES[0].commit, 'packages/client/ui-primitives/src/TextShimmer.tsx')
    assert.ok(shimmer.includes('data-text-shimmer={active || undefined}'), '0.1.7 契约变更')
  })

  it('0.2.0-rc.2 的 TextShimmer 渲染 data-shimmer（master 契约）', async () => {
    const shimmer = await show(BASELINES[1].commit, 'packages/client/ui-primitives/src/TextShimmer.tsx')
    assert.ok(shimmer.includes('data-shimmer={active || undefined}'), '0.2.0 契约变更')
  })

  it('0.2.0-rc.2 ChatGroupSeat：TextShimmer 嵌套（属性在外层 span，:has() 仍命中）', async () => {
    const seat = await readFile(CHECKOUT + '/' + UI_CHAT + '/chat/ChatGroupSeat.tsx', 'utf8').catch(() =>
      show(BASELINES[1].commit, UI_CHAT + '/chat/ChatGroupSeat.tsx'))
    assert.ok(
      seat.includes('<TextShimmer active={!data.closed}>') && seat.includes('<TextShimmer className={css.label}>'),
      '0.2.0 嵌套 TextShimmer 结构变更：需复核 running 选择器',
    )
  })
})
