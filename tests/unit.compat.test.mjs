// 兼容与架构保护测试：
//   - 注册审计：插件只替换官方 conversation.chat.node 的 "turn-process" 渲染器，
//     不注册任何其他 chat.node key / 设置行；exports.inject = ['slots']
//   - 架构守卫（源码扫描）：旧 Fold Engine 标识符、官方 renderer 代理层、
//     transcriptView 写入 —— 必须全部不存在
//   - 注册管道：priority 冲突让位、register/inject 异常软降级
//   - 官方 transcript 四模式（Compact/Standard/Detailed/Verbose）下渲染器都不崩溃
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin, CLIENT_JS } from './helpers/loader.mjs'
import { makeTurnNode, makeTurnProcessOwner, makeUseChat } from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T, exports: pluginExports, window: pluginWindow } = loadPlugin({ window: dom.window, uiPrimitives: PRIMITIVES_STUB })
const react = require('react')
const src = readFileSync(CLIENT_JS, 'utf8')

/** 经 React 渲染一遍（组件含 hooks，不允许裸函数调用）。 */
function renderOnce(props) {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  assert.doesNotThrow(() => {
    act(() => { root.render(react.createElement(T.EnhancedTurnProcessView, props)) })
  })
  const staticBar = container.querySelector('[data-tf-static="true"]')
  const button = container.querySelector('button.ccg-turn-bar')
  act(() => { root.unmount() })
  container.remove()
  return { staticBar, button }
}

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
  it('apply 只注册 conversation.chat.node key="turn-process"（priority -1）', () => {
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
    // 不再注册设置行 / dock / 其他 key
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
    // 空闲 → -1
    const slots2 = makeSlotsService()
    assert.equal(T.resolveSlotPriority(slots2, 'conversation.chat.node', () => true, 'test'), -1)
  })

  it('safeRegisterSlot：register/inject 抛错均软降级（Toast 提示一次、不外泄）', () => {
    const boom = makeSlotsService()
    boom.register = () => { throw new Error('register boom') }
    T.clearToast()
    assert.doesNotThrow(() => {
      T.safeRegisterSlot(boom, { name: 'conversation.chat.node', key: 'turn-process' }, function () {})
    })
    assert.ok(T.getToast().text, '降级 Toast 已提示')

    const boom2 = {
      inject() { throw new Error('inject boom') },
      register() { return {} },
    }
    assert.doesNotThrow(() => {
      T.safeRegisterSlot(boom2, { name: 'conversation.chat.node', key: 'turn-process' }, function () {})
    })
  })
})

describe('架构守卫（源码扫描）：旧 Fold Engine 与官方 renderer 代理层必须消失', () => {
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
  ]
  for (const name of FORBIDDEN) {
    it('源码不包含 ' + name, () => {
      assert.ok(!src.includes(name), '旧标识符残留：' + name)
    })
  }

  it('插件不写 transcriptView（写入调用 / 声明 / 注入面一律禁止）', () => {
    assert.ok(!/set\((['"])transcriptView\1/.test(src), '不得调用 set("transcriptView", ...)')
    assert.ok(!/transcriptView\s*[:=]/.test(src), '不得出现 transcriptView 赋值/声明')
    assert.ok(!/['"]transcriptView['"]/.test(src), '不得以字符串字面量引用 transcriptView')
  })

  it('插件不再 shadow tool-call / assistant-step / context / user（仅 turn-process）', () => {
    // chat.node 注册对象里的 key 字段：旧四格的注册写法必须完全消失
    assert.ok(!src.includes('key: "tool-call"'), 'tool-call shadow 残留')
    assert.ok(!src.includes('key: "assistant-step"'), 'assistant-step shadow 残留')
    assert.ok(!src.includes('key: "context"'), 'context shadow 残留')
    assert.ok(!src.includes('key: "user"'), 'user shadow 残留')
    // 唯一的 chat.node key 注册 = turn-process（恰好一处）
    assert.equal((src.match(/key: "turn-process"/g) || []).length, 1)
    assert.ok(src.includes('name: "conversation.chat.node"'))
  })
})

describe('官方 transcript 四模式兼容（Compact / Standard / Detailed / Verbose）', () => {
  // 模式差异完全由官方 seat 消化：插件拿到的只有 turnProcess owner state。
  //   Compact/Standard/Detailed（折叠完成回合）：foldable=true（turn/start 已加载）
  //   Verbose：foldCompletedTurns=false → foldable=false（官方永远展开、不可折叠）
  //   深历史分页（turn/start 未加载）：turnProcess undefined
  const cases = [
    { mode: 'compact', owner: { foldable: true, hasContent: true, open: false } },
    { mode: 'standard', owner: { foldable: true, hasContent: true, open: true } },
    { mode: 'detailed', owner: { foldable: true, hasContent: true, open: false } },
    { mode: 'verbose', owner: { foldable: false, hasContent: true, open: true } },
    { mode: 'paginated-history', owner: undefined },
  ]
  for (const c of cases) {
    it('mode=' + c.mode + ' → 渲染器不崩溃' + (c.owner ? (c.owner.foldable ? '，可折叠' : '，静态栏') : '，降级栏'), () => {
      const { staticBar, button } = renderOnce({
        node: makeTurnNode({ status: 'closed' }),
        turnProcess: c.owner === undefined ? undefined : makeTurnProcessOwner(c.owner),
        useChat: makeUseChat(),
      })
      assert.ok(button || staticBar, '渲染出 Turn 栏')
      if (c.owner && c.owner.foldable) {
        assert.ok(button && !staticBar, '可折叠：button 呈现')
        assert.equal(button.getAttribute('aria-expanded'), c.owner.open ? 'true' : 'false')
      } else {
        assert.ok(staticBar, '不可折叠：静态栏呈现')
      }
    })
  }
})
