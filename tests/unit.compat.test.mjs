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
function makeSlotsService(opts) {
  const calls = []
  const modern = !opts || opts.officialTurnProcess !== false
  return {
    calls,
    inject(name, factory) {
      calls.push({ slot: name, entry: factory() })
    },
    register(options, component) {
      return { options, component }
    },
    // 现代宿主：官方在 conversation.chat.node 自带 turn-process 条目（能力探针依赖它）
    entries(name) { return modern && name === 'conversation.chat.node' ? [{ options: { key: 'turn-process', priority: 0 } }] : [] },
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
    //（注：entriesOfSlot 曾属本列表——旧 main 用它自建 keyed 分发。现在的唯一合法
    //  用途是 Legacy Step **安装事务**的一次性 occupant 原子校验（见下方专属守卫：
    //  只允许出现在 legacyShadowsOwned 函数体内），render 路径仍被本列表与
    //  「renderer 不得触碰 slots 注册表」守卫双重禁止。）
    'builtinComponent',
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
    // Step 运行态禁止 JS 判定（运行状态完全由官方 DOM 的 shimmer 属性呈现，
    // 插件只决定该状态长什么样——翻牌动画全在 CSS keyframes 里）
    'MutationObserver',
    'replaceChild',
  ]
  for (const name of FORBIDDEN) {
    it('源码不包含 ' + name, () => {
      assert.ok(!src.includes(name), '禁用标识符残留：' + name)
    })
  }

  it('shimmer 双契约：production source 同时包含两个官方运行态属性（缺一不可）', () => {
    // data-text-shimmer = DSH 0.1.7 正式契约（release 787b746b80）；
    // data-shimmer      = DSH 0.2.0+ 当前契约（master 639ed01539）。
    // 上一轮曾把 data-text-shimmer 列为禁用标识符——那是错误约束：两个都是
    // 官方真实历史契约，必须共存于 production skin。
    assert.ok(src.includes('data-text-shimmer'), '缺少 DSH 0.1.7 官方契约 data-text-shimmer')
    assert.ok(src.includes('data-shimmer'), '缺少 DSH 0.2.0+ 官方契约 data-shimmer')
  })

  it('无 document.body 成员访问 / appendChild（head 的样式注入是已记录的软依赖，放行）', () => {
    assert.ok(!/document\.body\s*\./.test(src), '不得访问 document.body 成员')
    assert.ok(!src.includes('body.appendChild'), '不得向 body 追加节点')
    // head 注入恰为六处（base + skin + 牌数桥逐组覆盖表 + 逐组牌面资产表 + Legacy Step 表
    // + 步骤文件清单表）——软依赖面收敛到最小。牌数桥表只承载"官方 group snapshot →
    // [data-chat-group-key] 视觉选择器"，牌面资产表只承载逐组 faces 的 mask/keyframes，
    // 步骤文件清单表只承载逐组组头 ::after{content}（追加式：只增不改，不写官方 DOM、
    // 不加官方属性）。文件清单独立成表的原因：它是"信息"不是"皮肤"，iconStyle = native
    // 时也必须显示，因此不能挂在随皮肤启停的那两张表上。
    const headInjects = src.match(/document\.head\.appendChild\(/g) || []
    assert.equal(headInjects.length, 6, '样式注入共六处（含 Legacy Step 表与步骤文件清单表）')
  })

  it('插件不写 transcriptView（写入调用 / 声明 / 注入面一律禁止）', () => {
    assert.ok(!/set\((['"])transcriptView\1/.test(src), '不得调用 set("transcriptView", ...)')
    assert.ok(!/transcriptView\s*[:=]/.test(src), '不得出现 transcriptView 赋值/声明')
    assert.ok(!/['"]transcriptView['"]/.test(src), '不得以字符串字面量引用 transcriptView')
  })

  it('样式表只经 textContent 写盘（绝不 innerHTML / insertAdjacentHTML）', () => {
    // 逐组规则里的 content 串来自工具参数（文件名）——只有"永不经过 HTML 解析"才让
    // 任意字符（含 </style>、引号）保持无害。这条守卫把该前提钉住：
    assert.ok(!/\.innerHTML\s*=/.test(src), '不得给任何元素写 innerHTML')
    assert.ok(!src.includes('insertAdjacentHTML'), '不得使用 insertAdjacentHTML')
    assert.ok(!/\.outerHTML\s*=/.test(src), '不得写 outerHTML')
    // 唯一允许的 innerHTML 用途是 React 的 dangerouslySetInnerHTML（插件自有 SVG 图标：
    // 运行中翻牌 + 牌堆/扇形两处，内容是自己的字面量，不含外部输入）——处数与用途必须
    // 显式列出，防悄悄新增：
    const danger = src.match(/dangerouslySetInnerHTML/g) || []
    assert.equal(danger.length, 2, 'dangerouslySetInnerHTML 只允许图标那两处（翻牌 / 牌堆扇形）')
    const styleWrites = src.match(/\.textContent = /g) || []
    assert.ok(styleWrites.length >= 6, '样式表写盘必须走 textContent（当前 ' + styleWrites.length + ' 处）')
  })

  it('插件完全不碰官方滚动位置与跟随策略（滚动是官方的事，插件不打补丁）', () => {
    // 用户 2026-10-09 定调：运行栏自身那点布局影响**不做贴底自愈补丁**——补丁与官方跟随
    // 策略打架（跨会话误拽、把已释放的读者重新锁进跟随），根因查清前宁可不修。
    // 守卫把"零滚动权限"钉死（将来谁再加滚动补丁，这里先红）：
    const writers = src.match(/\.scrollTop\s*=/g) || []
    assert.equal(writers.length, 0, '插件不得写官方滚动位置，实际 ' + writers.length + ' 处')
    assert.ok(!src.includes('scrollIntoView'), '不得用 scrollIntoView 移动官方视图')
    assert.ok(!src.includes('.scrollTo('), '不得调用 scrollTo')
    assert.ok(!src.includes('overflow-anchor'), '不得改官方滚动锚定')
    assert.ok(!src.includes('data-chat-following-tail'), '不得读官方跟随状态（官方内部策略，插件零依赖）')
    assert.ok(!src.includes('data-conversation-scroll'), '不得锚定或扫描官方滚动容器')
    // 观察面：不得有任何 DOM 观察器（连自有行也不需要观察）
    assert.equal((src.match(/new ResizeObserver\(/g) || []).length, 0, '不得使用 ResizeObserver')
    assert.ok(!src.includes('MutationObserver'), '不得做 DOM 观察（架构红线）')
    assert.ok(!src.includes('IntersectionObserver'), '不得用 IntersectionObserver 观察官方视图')
  })

  it('订阅最小切片：useChat 一律传具名 selector，禁止整快照/内联 selector', () => {
    assert.ok(!src.includes('useChat(s => s)'), 'useChat(s => s) 必须消失')
    // 任何内联函数/箭头作为 useChat 参数都被禁止（等价"返回整个 snapshot"的
    // selector 由该模式统一拦截）；只允许具名 selector。现有四处订阅：
    // selectTurnNodeSource（本 Turn 的 assistant-step 数据源）、
    // selectChatNodeShape（store 形状探针，metrics capability 运行时定论用）、
    // selectChatNodeStore（步骤文件清单的节点读端，只取 s.nodes 身份稳定原语）、
    // 以及 legacy 快照。
    assert.ok(!/useChat\(\s*(function|\()/.test(src), 'useChat 只能传具名 selector')
    const calls = src.match(/useChat\(/g) || []
    assert.equal(calls.length, 4, 'useChat 恰好四处具名订阅（数据源 + 形状探针 + 节点读端 + legacy 快照）')
    assert.ok(src.includes('selectTurnNodeSource(number, "assistant-step")'), '订阅面 = 本 Turn 的 assistant-step 源')
    assert.ok(src.includes('useChat(selectChatNodeShape)'), 'store 形状探针也是具名 selector')
    assert.ok(src.includes('useChat(selectChatNodeStore)'), '步骤文件清单的节点读端也是具名 selector')
    assert.ok(src.includes('useChat(selectLegacyChatSnapshot)'), 'legacy 快照也是具名 selector（能力门控：Modern 宿主从不执行）')
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
