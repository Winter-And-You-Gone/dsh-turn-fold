// 兼容与架构保护测试（收尾版）：
//   - 注册审计：插件只替换官方 conversation.chat.node 的 "turn-process" 渲染器
//   - 架构守卫（源码扫描）：旧 Fold Engine、官方 renderer 代理层、transcriptView 写入、
//     宿主包运行时 require、body portal / 独立 root、整快照订阅 —— 必须全部不存在
//   - 注册管道：priority 冲突让位、register/inject 异常软降级（console.warn）
//   - 官方 transcript 四模式（Compact/Standard/Detailed/Verbose）下渲染器都不崩溃，
//     Verbose（foldable=false）→ 静态栏 + Poker 扇形
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin, CLIENT_JS } from './helpers/loader.mjs'
import {
  makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T, exports: pluginExports, window: pluginWindow } = loadPlugin({ window: sharedWindow })
const react = require('react')
const src = readFileSync(CLIENT_JS, 'utf8')

// ── mock slots service（记录全部注册） ──
function makeSlotsService() {
  const calls = []
  return {
    calls,
    inject(name, factory) {
      calls.push({ slot: name, entry: factory() })
    },
    register(options, component) {
      return { options, component }
    },
    entries() { return [] },
  }
}

beforeEach(() => {
  pluginWindow.localStorage.clear()
})

describe('注册审计（唯一允许替换的 Chat Node renderer = turn-process）', () => {
  it('apply 只注册 conversation.chat.node key="turn-process"（priority -1）且不再使用 ctx.effect / body portal', () => {
    const slots = makeSlotsService()
    const effects = []
    pluginExports.apply({
      inject(deps, cb) {
        assert.deepEqual(deps, ['slots'])
        cb({ slots })
      },
      effect(fn) { effects.push(fn) },
    })
    assert.equal(slots.calls.length, 1, '恰好一条 slot 注册')
    const { slot, entry } = slots.calls[0]
    assert.equal(slot, 'conversation.chat.node')
    assert.equal(entry.options.key, 'turn-process')
    assert.equal(entry.options.priority, -1)
    assert.equal(entry.options.locale, 'chat')
    assert.equal(typeof entry.component, 'function')
    assert.deepEqual(effects, [], 'apply 不再注册任何 ctx.effect（无 body React root）')
    assert.ok(!slots.calls.some((c) => c.slot === 'settings.general.item'))
    const keys = slots.calls.filter((c) => c.slot === 'conversation.chat.node').map((c) => c.entry.options.key)
    assert.deepEqual(keys, ['turn-process'])
  })

  it('exports.inject = ["slots"]（不声明 settings/configForms/connection 等服务）', () => {
    assert.deepEqual(pluginExports.inject, ['slots'])
  })

  it('priority -1 被占用时自动让位（不撞车启动失败）', () => {
    const slots = makeSlotsService()
    slots.entries = () => [
      { options: { key: 'turn-process', priority: -1 } },
      { options: { key: 'turn-process', priority: 1 } },
    ]
    const p = T.resolveSlotPriority(slots, 'conversation.chat.node', (o) => o.key === 'turn-process', 'test')
    assert.equal(p, 2)
    const slots2 = makeSlotsService()
    assert.equal(T.resolveSlotPriority(slots2, 'conversation.chat.node', () => true, 'test'), -1)
  })

  it('safeRegisterSlot：register/inject 抛错均软降级（console.warn、不外泄）', () => {
    const warnings = []
    const origWarn = console.warn
    console.warn = (...a) => warnings.push(a.join(' '))
    try {
      const boom = makeSlotsService()
      boom.register = () => { throw new Error('register boom') }
      assert.doesNotThrow(() => {
        T.safeRegisterSlot(boom, { name: 'conversation.chat.node', key: 'turn-process' }, function () {})
      })
      assert.ok(warnings.some((w) => w.includes('register boom')), '降级 warn 已记录')

      const boom2 = {
        inject() { throw new Error('inject boom') },
        register() { return {} },
      }
      assert.doesNotThrow(() => {
        T.safeRegisterSlot(boom2, { name: 'conversation.chat.node', key: 'turn-process' }, function () {})
      })
    } finally {
      console.warn = origWarn
    }
  })
})

describe('架构守卫（源码扫描）', () => {
  const FORBIDDEN = [
    // 插件自研 Fold Engine
    'computeGroup',
    'computeTurnFold',
    'turnOverrides',
    'setTurnOpen',
    'setGroupOpen',
    'useTurnOverride',
    'useGroupOverride',
    'groupOverrides',
    'hiddenMarker',
    'FoldClip',
    'trackSession',
    'liveTokenCache',
    'projectLiveTokens',
    'turnDisplayMetrics',
    'foldActive',
    'FOLD_MODE_KEY',
    // 官方 renderer 代理 / slot 扫描 plumbing
    'builtinComponent',
    'entriesOfSlot',
    'specDynamic',
    'bindChildSlotHooks',
    'renderToolview',
    'renderToolImages',
    'renderBuiltinToolCall',
    'renderBuiltinAssistant',
    'renderBuiltinContext',
    'chatNodeEntryInject',
    'resolveUserCellPriority',
    'renderUserContent',
    // 旧 shadow 视图（tool-call / assistant-step / context / user）
    'GroupedToolCallView',
    'GroupedAssistantView',
    'GroupedContextView',
    'GroupedUserView',
    'renderSegment',
    'segmentLabel',
    'segmentTitle',
    'segmentCacheKey',
    'ThinkSummary',
    'renderTitleFileLinks',
    // transcriptView 设置行 shadow
    'SettingsTranscriptViewRow',
    'resolveTranscriptScope',
    'TRANSCRIPT_MODE_VOCAB',
    'readTranscriptModes',
    'classifyTranscriptVocab',
    'settingsScope',
    'configForms',
    // 官方内部 hook 名（不允许动态复制）
    'toolCallArgumentsPartial',
    'hostInfo',
    // 收尾新增：宿主包运行时依赖 / body portal / 独立 root
    'dsh-client-ui-primitives',
    'react-dom',
    'createRoot',
    '__dsh-turn-fold-gear',
    'data-tf-step-skin',
  ]
  for (const name of FORBIDDEN) {
    it('源码不包含 ' + name, () => {
      assert.ok(!src.includes(name), '禁用标识符残留：' + name)
    })
  }

  it('无 document.body 成员访问 / appendChild（head 的样式注入是已记录的软依赖，放行）', () => {
    assert.ok(!/document\.body\s*\./.test(src), '不得访问 document.body 成员')
    assert.ok(!src.includes('body.appendChild'), '不得向 body 追加节点')
    // head 注入恰为两处（base + skin）——软依赖面收敛到最小
    const headInjects = src.match(/document\.head\.appendChild\(/g) || []
    assert.equal(headInjects.length, 2, '样式注入只有 base + skin 两处')
  })

  it('插件不写 transcriptView（写入调用 / 声明 / 注入面一律禁止）', () => {
    assert.ok(!/set\((['"])transcriptView\1/.test(src), '不得调用 set("transcriptView", ...)')
    assert.ok(!/transcriptView\s*[:=]/.test(src), '不得出现 transcriptView 赋值/声明')
    assert.ok(!/['"]transcriptView['"]/.test(src), '不得以字符串字面量引用 transcriptView')
  })

  it('订阅最小切片：useChat 一律传具名 selector，禁止整快照/内联 selector', () => {
    assert.ok(!src.includes('useChat(s => s)'), 'useChat(s => s) 必须消失')
    // 任何内联函数/箭头作为 useChat 参数都被禁止（等价"返回整个 snapshot"的
    // selector 由该模式统一拦截）；只允许具名 selector（selectTurnNodeSource）。
    assert.ok(!/useChat\(\s*(function|\()/.test(src), 'useChat 只能传具名 selector')
    const calls = src.match(/useChat\(/g) || []
    assert.equal(calls.length, 1, 'useChat 只在订阅 assistant-step 数据源处调用一次')
    assert.ok(src.includes('selectTurnNodeSource(number, "assistant-step")'), '订阅面 = 本 Turn 的 assistant-step 源')
  })

  it('插件不再 shadow tool-call / assistant-step / context / user（仅 turn-process）', () => {
    assert.ok(!src.includes('key: "tool-call"'), 'tool-call shadow 残留')
    assert.ok(!src.includes('key: "assistant-step"'), 'assistant-step shadow 残留')
    assert.ok(!src.includes('key: "context"'), 'context shadow 残留')
    assert.ok(!src.includes('key: "user"'), 'user shadow 残留')
    assert.equal((src.match(/key: "turn-process"/g) || []).length, 1)
    assert.ok(src.includes('name: "conversation.chat.node"'))
  })

  it('运行中秒表：固定 1000ms、无随机抖动', () => {
    assert.equal(T.liveTickMs, 1000)
    assert.ok(!/Math\.random\(\) \* liveTickMs/.test(src), '随机抖动必须删除')
  })
})

describe('官方 transcript 四模式兼容（Compact / Standard / Detailed / Verbose）', () => {
  const usageStep = {
    turn: 13, step: 1, status: 'settled',
    usage: { inputTokens: 1000, outputTokens: 3214, cacheReadTokens: 2000 },
  }
  // 模式差异完全由官方 seat 消化：插件拿到的只有 turnProcess owner state。
  //   Compact/Standard/Detailed：foldable=true；Verbose：foldable=false
  //   深历史分页（turn/start 未加载）：turnProcess undefined
  const cases = [
    { mode: 'compact', owner: { foldable: true, hasContent: true, open: false } },
    { mode: 'standard', owner: { foldable: true, hasContent: true, open: true } },
    { mode: 'detailed', owner: { foldable: true, hasContent: true, open: false } },
    { mode: 'verbose', owner: { foldable: false, hasContent: true, open: true } },
    { mode: 'paginated-history', owner: undefined },
  ]
  /** 经 React 渲染一遍（组件含 hooks，不允许裸函数调用）。 */
  function renderOnce(props) {
    const container = sharedDocument.createElement('div')
    sharedDocument.body.appendChild(container)
    const root = createRoot(container)
    assert.doesNotThrow(() => {
      act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
    })
    const staticBar = container.querySelector('[data-tf-static="true"]')
    const button = container.querySelector('button.ccg-turn-bar-main')
    const fan = [...container.querySelectorAll('.ccg-poker-motion')]
      .some((m) => (m.getAttribute('transform') || '').includes('rotate'))
    act(() => { root.unmount() })
    container.remove()
    return { staticBar, button, fan }
  }
  for (const c of cases) {
    it('mode=' + c.mode + ' → 渲染器不崩溃' + (c.owner ? (c.owner.foldable ? '，可折叠' : '，静态栏 + 扇形') : '，降级栏'), () => {
      const { staticBar, button, fan } = renderOnce({
        node: makeTurnNode({ status: 'closed' }),
        turnProcess: c.owner === undefined ? undefined : makeTurnProcessOwner(c.owner),
        useTurnData: makeUseTurnData({}),
        useChat: makeUseChat(makeStepsSource([usageStep])),
      })
      assert.ok(button || staticBar, '渲染出 Turn 栏')
      if (c.owner && c.owner.foldable) {
        assert.ok(button && !staticBar, '可折叠：button 呈现')
        assert.equal(button.getAttribute('aria-expanded'), c.owner.open ? 'true' : 'false')
      } else {
        // Verbose / 降级：静态栏；官方 open = !foldable || open → Poker 必须呈扇形
        assert.ok(staticBar, '不可折叠：静态栏呈现')
        assert.ok(fan, 'Poker 呈扇形/展开态（open=!foldable||open 官方语义）')
      }
    })
  }
})
