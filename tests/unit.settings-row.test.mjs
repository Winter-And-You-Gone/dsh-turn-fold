// 设置 → 对话 → 「回合折叠方式」行（shadow 官方 transcript-view 行）
// 验证：
//   - 无 settingsScope / 无 ctx.slots（旧版）→ 静默跳过
//   - 有 settingsScope + ctx.slots → 注册 id='transcript-view'、priority=-1 的条目
//   - foldMode 默认 turn-fold，setFoldMode 切换并持久化到 localStorage
//   - 渲染行：3 个选项 + turn-fold 选中态
import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

// 注意：--test-isolation=none 下不设置 globalThis.window/document，避免污染其他测试。
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 带 ui-primitives mock（含简化 Menu）加载，让设置行走 Menu 分支以测试菜单项事件
function makeMenuMock() {
  const MenuMock = ({ open, anchor, items, onSelect }) => {
    return React.createElement('div', null,
      anchor,
      open ? React.createElement('div', { className: 'menu-list' },
        items.map(item => React.createElement('button', {
          key: item.id,
          className: 'menu-item',
          onClick: () => onSelect(item.id),
        }, item.label)),
      ) : null,
    )
  }
  const Chevron = () => React.createElement('span', { className: 'chevron-mock' }, '∨')
  return { Menu: MenuMock, IconChevronDownOutline14: Chevron }
}

const { test: T, exports: pluginExports, React } = loadPlugin({ window: dom.window })
// 第二个实例：带 Menu mock，用于渲染展开菜单并验证菜单项事件
const menuLoaded = loadPlugin({ window: dom.window, uiPrimitives: makeMenuMock() })
const TM = menuLoaded.test

// 生成一个可复用的 slots mock（记录注册条目）
function makeSlots(extraEntries = []) {
  const regs = []
  return {
    regs,
    svc: {
      entries() { return [...extraEntries] },
      entriesOfSlot() { return [] },
      inject(name, factory) { regs.push(factory()) },
      register(options, component) { return { component, options } },
    },
  }
}

// 生成 settingsScope mock
function makeScope(initial = { transcriptView: 'normal' }) {
  let value = { ...initial }
  const listeners = new Set()
  return {
    set(field, v) { value = { ...value, [field]: v }; for (const l of [...listeners]) l() },
    unset(field) { delete value[field]; for (const l of [...listeners]) l() },
    getSnapshot() { return { status: 'ready', value: { ...value }, writable: true } },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  }
}

describe('回合折叠方式设置行（shadow 官方 transcript-view）', () => {
  it('无 settingsScope（旧版）→ apply 不抛错、不注册设置行', () => {
    const { svc, regs } = makeSlots()
    assert.doesNotThrow(() => {
      pluginExports.apply({
        slots: svc,
        inject(deps, cb) { cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
      })
    }, '无 settingsScope 时 apply 不抛错')
    assert.equal(regs.filter((r) => r.options.name === 'settings.general.item').length, 0, '旧版不注册设置行')
  })

  it('有 settingsScope + ctx.slots → 注册 id=transcript-view、priority=-1 的条目', () => {
    const { svc, regs } = makeSlots()
    const scope = makeScope()
    pluginExports.apply({
      slots: svc,
      settingsScope: { bind(spec) { assert.equal(spec.namespace, 'ui-chat'); return scope } },
      inject(deps, cb) { cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
    })
    const row = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(row, '应注册 settings.general.item / transcript-view 行')
    assert.equal(row.options.priority, -1, 'priority=-1 shadow 官方行')
    assert.equal(row.options.order, 12, '与官方行同 order')
    const injectFace = row.options.inject()
    assert.ok(injectFace.hooks.transcriptView, 'inject 应提供 transcriptView hook')
    assert.equal(typeof injectFace.setTranscriptView, 'function', 'inject 应提供 setTranscriptView')
  })

  it('foldMode 默认 turn-fold；setFoldMode 切换并持久化到 localStorage', () => {
    // loadPlugin 用独立 JSDOM，localStorage 可从 dom.window 读取
    T.setFoldMode('turn-fold')
    assert.equal(T.getFoldMode(), 'turn-fold', '默认 turn-fold（保持历史行为）')
    T.setFoldMode('auto')
    assert.equal(T.getFoldMode(), 'auto', '切到 auto')
    assert.equal(dom.window.localStorage.getItem('dsh-turn-fold:fold-mode'), 'auto', '持久化到 localStorage')
    T.setFoldMode('turn-fold')
    assert.equal(T.getFoldMode(), 'turn-fold', '切回 turn-fold')
    assert.equal(dom.window.localStorage.getItem('dsh-turn-fold:fold-mode'), 'turn-fold')
  })

  it('渲染设置行：3 个选项 + turn-fold 选中态', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const scope = makeScope({ transcriptView: 'normal' })
    // 直接渲染组件：useTranscriptView 从 scope 快照取 transcriptView；foldMode 已为 turn-fold
    T.setFoldMode('turn-fold')
    act(() => {
      root.render(React.createElement(T.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel(scope.getSnapshot()),
        setTranscriptView: (mode) => scope.set('transcriptView', mode),
      }))
    })
    const row = container.querySelector('.ccg-settings-row')
    assert.ok(row, '设置行渲染')
    assert.ok(row.querySelector('.ccg-settings-row-title'), '标题区')
    const selector = row.querySelector('.ccg-settings-selector')
    assert.ok(selector, '选择器按钮')
    assert.ok(selector.textContent.includes('Turn-Fold'), 'turn-fold 模式选中显示英文「Turn-Fold」')
    // 选中按钮不再用原生 title（改用即时 tooltip）
    assert.ok(!selector.hasAttribute('title'), '选中按钮不用原生 title（延迟）')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('自定义 tooltip：showSettingsTip 定位并显示、hideSettingsTip 隐藏', () => {
    assert.equal(T.getSettingsTip(), null, '初始无 tooltip')
    T.showSettingsTip('插件折叠：接管全部折叠并显示指标', { left: 100, top: 200, right: 300, bottom: 236, width: 200, height: 36 })
    const tip = T.getSettingsTip()
    assert.ok(tip, 'showSettingsTip 后出现 tooltip')
    assert.equal(tip.text, '插件折叠：接管全部折叠并显示指标', 'tooltip 文案')
    assert.equal(typeof tip.left, 'number', '定位在选项行右侧')
    assert.equal(typeof tip.top, 'number')
    T.hideSettingsTip()
    assert.equal(T.getSettingsTip(), null, 'hideSettingsTip 后消失')
  })

  it('展开菜单后：悬浮每个选项项即时显示对应中文提示（整行触发）', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const scope = makeScope({ transcriptView: 'normal' })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel(scope.getSnapshot()),
        setTranscriptView: (mode) => scope.set('transcriptView', mode),
      }))
    })
    // 点击选择器展开菜单
    const selector = container.querySelector('.ccg-settings-selector')
    assert.ok(selector, '选择器按钮')
    act(() => { selector.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const menuItems = [...container.querySelectorAll('.menu-item')]
    assert.equal(menuItems.length, 3, '展开后 3 个选项')
    // 悬浮每个选项项 → 立即显示对应中文提示。
    // React onMouseEnter 底层监听 mouseover（合成事件），需在绑定了 handler 的
    // 内层 label span 上派发（menu-item button 只是容器，事件需冒泡自 span）。
    const tipTexts = ['不折叠', '官方紧凑折叠', '插件折叠']
    menuItems.forEach((item, idx) => {
      TM.hideSettingsTip()
      const labelSpan = item.querySelector('span')
      assert.ok(labelSpan, `选项 ${idx} 内层 label span`)
      act(() => { labelSpan.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null })) })
      const tip = TM.getSettingsTip()
      assert.ok(tip, `选项 ${idx} mouseover 后出现 tooltip`)
      assert.ok(tip.text.includes(tipTexts[idx]), `选项 ${idx} 提示文案包含「${tipTexts[idx]}」`)
    })
    // 移出 → 消失
    TM.hideSettingsTip()
    assert.equal(TM.getSettingsTip(), null, 'mouseleave 后消失')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('点击选中一项后 tooltip 立即消失（菜单关闭项卸载，mouseleave 不派发）', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const scope = makeScope({ transcriptView: 'normal' })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel(scope.getSnapshot()),
        setTranscriptView: (mode) => scope.set('transcriptView', mode),
      }))
    })
    act(() => { container.querySelector('.ccg-settings-selector').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const item = container.querySelectorAll('.menu-item')[1]
    const labelSpan = item.querySelector('span')
    act(() => { labelSpan.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null })) })
    assert.ok(TM.getSettingsTip(), '悬浮选项时 tooltip 显示')
    // 点击该项 → onSelect → selectMode → closeMenu（菜单收起，项卸载）
    act(() => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.equal(TM.getSettingsTip(), null, '选中后 tooltip 立即消失（不滞留）')
    assert.equal(scope.getSnapshot().value.transcriptView, 'compact', '选中生效')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('菜单开着悬浮时整行卸载（切设置分区）→ tooltip 兜底清除', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const scope = makeScope({ transcriptView: 'normal' })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel(scope.getSnapshot()),
        setTranscriptView: (mode) => scope.set('transcriptView', mode),
      }))
    })
    act(() => { container.querySelector('.ccg-settings-selector').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const labelSpan = container.querySelector('.menu-item span')
    act(() => { labelSpan.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: null })) })
    assert.ok(TM.getSettingsTip(), '悬浮选项时 tooltip 显示')
    // 不选、不点外部，直接卸载整行（模拟切换设置分区/离开设置页）
    act(() => { root.unmount() })
    assert.equal(TM.getSettingsTip(), null, '行卸载后 tooltip 被兜底清除')
    dom.window.document.body.removeChild(container)
  })
})

// ── 兼容适配：同 slot 同 key/priority 已被其他插件占用时自动让位 ──
// 背景：其它插件（如 easyrewrite）也可能用 priority -1 注册 conversation.chat.node
// 或 settings.general.item 的同一 key/id，若双方同 priority 同时注册，slots 系统抛
// "already has an entry for key ... at priority" 导致启动失败（Failed to load
// plugins）。本插件注册前探测，冲突时自动让位。user 格例外：占位条必须渲染在 user
// 消息正下方，让位即退化为位置错误的 dock 方案——user 格注册在最低占用位之下并与
// 第三方条目链式委托共存（见 regression「0 秒占位回 user 格」）。让位逻辑保护其余
// 三格与设置行。
describe('注册冲突自动让位（兼容适配）', () => {
  function applyWith(slotsSvc) {
    const regs = []
    pluginExports.apply({
      slots: slotsSvc,
      settingsScope: { bind() { return makeScope() } },
      inject(deps, cb) { cb({ slots: slotsSvc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
    })
    return regs
  }

  it('无冲突：context key 保持 priority -1（shadow 内置 0）', () => {
    const { svc } = makeSlots([
      { options: { key: 'context', priority: 0 } }, // 内置官方条目
    ])
    const regs = []
    svc.inject = (name, factory) => regs.push(factory())
    applyWith(svc)
    const context = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'context')
    assert.ok(context, '注册 context 条目')
    assert.equal(context.options.priority, -1, '无占用时仍用 -1')
  })

  it('context key 已被其他插件占 priority -1 → 让位到不冲突的 priority（1，跳过官方 0 保留位）', () => {
    const { svc } = makeSlots([
      { options: { key: 'context', priority: -1 } }, // 其他插件已占 -1
    ])
    const regs = []
    svc.inject = (name, factory) => regs.push(factory())
    applyWith(svc)
    const context = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'context')
    assert.ok(context, '注册 context 条目')
    assert.notEqual(context.options.priority, -1, '不再与占用者同 priority')
    assert.equal(context.options.priority, 1, '让位到 1（官方 0 保留，绝不落回官方档）')
  })

  it('context key 占 -1 且 0 也被占 → 让位到 1', () => {
    const { svc } = makeSlots([
      { options: { key: 'context', priority: -1 } }, // 其他插件占 -1
      { options: { key: 'context', priority: 0 } },  // 内置占 0
    ])
    const regs = []
    svc.inject = (name, factory) => regs.push(factory())
    applyWith(svc)
    const context = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'context')
    assert.equal(context.options.priority, 1, '-1 和 0 都被占时让位到 1')
  })

  it('settings.general.item 的 transcript-view 行被占 priority -1 → 同样让位', () => {
    const { svc } = makeSlots([
      { options: { id: 'transcript-view', priority: -1 } }, // 其他插件占 -1
    ])
    const regs = []
    svc.inject = (name, factory) => regs.push(factory())
    applyWith(svc)
    const row = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(row, '注册设置行')
    assert.equal(row.options.priority, 1, 'transcript-view 行让位到 1（官方 0 保留）')
  })

  it('一个 key 被占只影响自己，其余 key 不受影响', () => {
    const { svc } = makeSlots([
      { options: { key: 'tool-call', priority: -1 } }, // 只有 tool-call 被其他插件占
    ])
    const regs = []
    svc.inject = (name, factory) => regs.push(factory())
    applyWith(svc)
    const toolCall = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'tool-call')
    assert.equal(toolCall.options.priority, 1, 'tool-call 被占，让位到 1')
    for (const key of ['assistant-step', 'context']) {
      const entry = regs.find((r) => r.options.name === 'conversation.chat.node' && r.options.key === key)
      assert.ok(entry, `注册 ${key} 条目`)
      assert.equal(entry.options.priority, -1, `${key} 未被占，保持 -1`)
    }
  })
})

// ── 注册异常软降级（防启动崩溃 + 用户可见提示）──
// 背景：slots.inject 的回调若让异常外泄，延迟执行路径（目标 slot 声明晚于插件加载，
// 回调在官方声明者的 register 栈里跑 / 声明订阅里 queueMicrotask re-throw）会打断
// 官方 UI 激活 → web 整页无法启动（easyrewrite 事故的装机失败形态）。本插件所有
// register 都必须 catch 在回调内：单条目降级 + console.warn + 一次性 Toast，绝不外泄。
describe('注册异常软降级（异常不外泄，防启动崩溃）', () => {
  function makeThrowingSlots({ throwKeys = [], throwInjectNames = [], throwRegisterNames = [] } = {}) {
    const regs = []
    const svc = {
      regs,
      entries() { return [] },
      entriesOfSlot() { return [] },
      inject(name, factory) {
        if (throwInjectNames.includes(name)) {
          throw new Error(`slots.inject("${name}") 同步失败（模拟宿主拒绝）`)
        }
        const entry = factory()
        if (entry) regs.push(entry)
        return entry
      },
      register(options, component) {
        if (throwKeys.includes(options.key) || throwRegisterNames.includes(options.name)) {
          throw new Error(`keyed slot "${options.name}" already has an entry (模拟同位冲突抛错)`)
        }
        return { component, options }
      },
    }
    return { svc, regs }
  }

  function applyWith(slotsSvc) {
    pluginExports.apply({
      slots: slotsSvc,
      settingsScope: { bind() { return makeScope() } },
      inject(deps, cb) { cb({ slots: slotsSvc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
    })
  }

  it('chat.node 同位冲突 register 抛错 → 异常不外泄，其余条目照常 + 弹一次冲突 Toast', () => {
    const { svc, regs } = makeThrowingSlots({ throwKeys: ['assistant-step'] })
    assert.doesNotThrow(() => applyWith(svc), 'register 抛错必须被回调内的 catch 吞掉（外泄会带崩 web 启动）')
    assert.ok(regs.some((r) => r.options.key === 'tool-call'), 'tool-call 照常注册')
    assert.ok(regs.some((r) => r.options.key === 'context'), 'context 照常注册')
    assert.ok(regs.some((r) => r.options.id === 'transcript-view'), '设置行照常注册')
    assert.ok(regs.some((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'user'), 'user 格占位条照常注册')
    assert.ok(!regs.some((r) => r.options.key === 'assistant-step'), '肇事条目已跳过（单条目降级）')
    const toast = T.getToast()
    assert.ok(toast && typeof toast.text === 'string' && toast.text.includes('渲染位注册异常'), '用户可见的降级提示 Toast 已入队')
  })

  it('user 格同位冲突 register 抛错 + 设置行 register 抛错 → 均不外泄，其余三格照常', () => {
    const { svc, regs } = makeThrowingSlots({ throwKeys: ['user'], throwRegisterNames: ['settings.general.item'] })
    assert.doesNotThrow(() => applyWith(svc))
    for (const key of ['tool-call', 'assistant-step', 'context']) {
      assert.ok(regs.some((r) => r.options.key === key), `${key} 照常注册`)
    }
    assert.ok(!regs.some((r) => r.options.id === 'transcript-view'), '设置行条目已降级跳过')
    assert.ok(!regs.some((r) => r.options.name === 'conversation.chat.node' && r.options.key === 'user'), 'user 格条目已降级跳过（占位条缺失，但不影响其余功能）')
  })
})

// ── DSH 0.1.7-rc.1 设置链路适配 ──
// 0.1.7 删除了 ctx.settingsScope（改为 ctx.configForms.get(namespace)，快照形状相同），
// 并把 transcriptView 枚举从 ['normal','compact'] 换成
// ['compact','standard','detailed','verbose']（官方折叠改由 presentation-policy 的
// foldCompletedTurns 开关，只有 verbose 为 false）。
// 因此两件事必须成立：
//   1) settingsScope 绝不进 exports.inject —— 声明不存在的服务会让条目永久 PENDING，
//      0.1.7 的 assertEntriesActive 把 pending 当启动失败（web 打不开）。
//   2) 词表探测正确 → turn-fold 接管写 foldOff（新版 verbose / 旧版 normal），
//      否则与官方折叠双重折叠。
describe('DSH 0.1.7 设置链路适配（configForms + transcriptView 四值枚举）', () => {
  // 0.1.7 官方 ui-chat schema 的序列化 union 形态（schemastery toJSON 实测）
  function v2Schema(uid = 11) {
    return {
      uid,
      refs: {
        2: { type: 'const', meta: { required: true }, value: 'compact' },
        4: { type: 'const', meta: { required: true }, value: 'standard' },
        6: { type: 'const', meta: { required: true }, value: 'detailed' },
        8: { type: 'const', meta: { required: true }, value: 'verbose' },
        10: { type: 'union', meta: { default: 'standard', loose: true }, list: [2, 4, 6, 8] },
        [uid]: { type: 'object', meta: { default: {} }, dict: { transcriptView: 10 } },
      },
    }
  }
  // 0.1.7 的 scope：configForms.get('ui-chat') 返回 ConfigForm；describe() 给镜像
  function makeConfigForm({ transcriptView = 'standard', schema = v2Schema() } = {}) {
    const value = { transcriptView }
    const listeners = new Set()
    const mirror = {
      status: 'ready',
      view: { namespaces: [{ ns: 'ui-chat', schema, value: { ...value }, revision: 1 }], writable: true, hasDocument: true },
      error: null,
    }
    return {
      set(field, v) { value[field] = v; for (const l of [...listeners]) l() },
      unset(field) { delete value[field]; for (const l of [...listeners]) l() },
      getSnapshot() { return { status: 'ready', value: { ...value }, writable: true } },
      subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
      // 忠实 0.1.7：ConfigForm 实例本身**没有** describe（describe 在 configForms 服务上）。
      // 词表必须经服务拿到 —— 见 applyV2With 里 configForms.describe 的 mock。
      _value: value,
    }
  }
  // 0.1.7 的 configForms 服务面：get(ns) + describe()（describe 在这层，不在 form 上）
  function makeConfigFormsService(formsByNs, describeMirror) {
    return {
      get(ns) { return formsByNs[ns] },
      describe() {
        return {
          getSnapshot: () => describeMirror,
          subscribe: () => () => {},
          ensure: () => Promise.resolve(),
        }
      },
    }
  }
  function makeSlotsSvc() {
    const regs = []
    return {
      regs,
      svc: {
        entries: () => [],
        entriesOfSlot: () => [],
        inject(name, factory) { regs.push(factory()) },
        register(options, component) { return { component, options } },
      },
    }
  }
  // 新版宿主：只有 configForms（无 settingsScope）。
  // 注意：每个 loadPlugin 实例是独立闭包（各自的 transcriptScopeRef），所以
  // apply 与渲染必须用同一个实例——pe 传 pluginExports 还是 menuLoaded.exports。
  function applyV2With(pe, ctxExtra = {}) {
    const { svc, regs } = makeSlotsSvc()
    // ctxExtra.form 已是 ConfigForm（旧版词表用例自建 schema）→ 直接使用；
    // 否则按给定字段造一个新版词表的 form。
    const form = ctxExtra.form !== undefined && typeof ctxExtra.form.getSnapshot === 'function'
      ? ctxExtra.form
      : makeConfigForm(ctxExtra.form)
    // describe 镜像：词表探测的唯一来源（form 实例上没有 describe）
    const mirror = {
      status: 'ready',
      view: {
        namespaces: [{ ns: 'ui-chat', schema: ctxExtra.schema ?? v2Schema(), value: { ...form.getSnapshot().value }, revision: 1 }],
        writable: true,
        hasDocument: true,
      },
      error: null,
    }
    pe.apply({
      slots: svc,
      configForms: makeConfigFormsService({ 'ui-chat': form }, mirror),
      inject(deps, cb) { cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
    })
    return { regs, form }
  }
  function applyV2(ctxExtra = {}) { return applyV2With(pluginExports, ctxExtra) }
  function applyV2Menu(ctxExtra = {}) { return applyV2With(menuLoaded.exports, ctxExtra) }

  it('exports.inject 不含 settingsScope（0.1.7 无此服务，声明即 PENDING → 启动失败）', () => {
    assert.ok(Array.isArray(pluginExports.inject), 'exports.inject 是数组')
    assert.ok(!pluginExports.inject.includes('settingsScope'), '不得声明已删除的 settingsScope 服务')
    assert.ok(pluginExports.inject.includes('slots'), 'slots 仍在（shadow 渲染位必需）')
    assert.ok(pluginExports.inject.includes('connection'), 'connection 仍在（generation hook 必需）')
  })

  it('仅 configForms（无 settingsScope）→ 仍注册设置行（不再因缺 settingsScope 整块跳过）', () => {
    const { regs } = applyV2()
    const row = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(row, '0.1.7 下设置行照常注册')
    assert.equal(row.options.priority, -1, 'priority=-1 shadow 官方行')
    const face = row.options.inject()
    assert.ok(face.hooks.transcriptView, 'inject 提供 transcriptView hook')
    assert.equal(typeof face.setTranscriptView, 'function', 'inject 提供 setTranscriptView')
  })

  it('词表探测：新版四值 → 渲染 4 官方档 + Turn-Fold；turn-fold 接管写 verbose', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const { form } = applyV2Menu()
    const written = []
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel({ value: form.getSnapshot().value }),
        setTranscriptView: (mode) => { written.push(mode); form.set('transcriptView', mode) },
      }))
    })
    const selector = container.querySelector('.ccg-settings-selector')
    assert.ok(selector, '选择器渲染')
    assert.ok(selector.textContent.includes('Standard'), '新版默认 standard 选中（显示 Standard）')
    act(() => { selector.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const items = [...container.querySelectorAll('.menu-item')]
    assert.equal(items.length, 5, '新版选项 = 官方 4 档 + Turn-Fold')
    const labels = items.map((i) => i.textContent)
    for (const want of ['Compact', 'Standard', 'Detailed', 'Verbose', 'Turn-Fold']) {
      assert.ok(labels.some((l) => l.includes(want)), `选项含 ${want}`)
    }
    // 选 Turn-Fold → 必须写 foldOff=verbose（新版官方折叠开关；写 standard 会双重折叠）
    const turnFoldItem = items[items.length - 1]
    act(() => { turnFoldItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(written, ['verbose'], 'turn-fold 接管写 verbose（而非 standard/compact）')
    assert.equal(TM.getFoldMode(), 'turn-fold', 'foldMode 标记为 turn-fold')
    // 再选官方 Detailed → foldMode 回 auto + 写 detailed
    act(() => { selector.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const items2 = [...container.querySelectorAll('.menu-item')]
    const detailed = items2.find((i) => i.textContent.includes('Detailed'))
    act(() => { detailed.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    assert.deepEqual(written, ['verbose', 'detailed'], '选官方档写该档值')
    assert.equal(TM.getFoldMode(), 'auto', '选官方档 → 插件退出接管（auto）')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('旧存档值 normal 在新版词表下归一显示为 Standard（官方 legacy 映射）', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const { form } = applyV2Menu({ form: { transcriptView: 'normal' } })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel({ value: form.getSnapshot().value }),
        setTranscriptView: () => {},
      }))
    })
    const selector = container.querySelector('.ccg-settings-selector')
    assert.ok(selector.textContent.includes('Standard'),
      '旧存档 normal 在新版按官方映射显示为 Standard（不是字面量 normal）')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('旧版词表（normal/compact）→ 渲染 2 官方档 + Turn-Fold（历史行为不变）', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    // 旧版 schema：union(normal, compact)
    const legacySchema = {
      uid: 7,
      refs: {
        2: { type: 'const', meta: { required: true }, value: 'normal' },
        4: { type: 'const', meta: { required: true }, value: 'compact' },
        6: { type: 'union', meta: { default: 'compact' }, list: [2, 4] },
        7: { type: 'object', meta: { default: {} }, dict: { transcriptView: 6 } },
      },
    }
    const form = makeConfigForm({ transcriptView: 'normal' })
    // 用 menuLoaded 实例 apply + 渲染（同一闭包，transcriptScopeRef 才可见）。
    // 词表来自 describe 镜像的 schema → 传 legacySchema 模拟旧宿主。
    applyV2Menu({ form, schema: legacySchema })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel({ value: form.getSnapshot().value }),
        setTranscriptView: () => {},
      }))
    })
    const selector = container.querySelector('.ccg-settings-selector')
    assert.ok(selector.textContent.includes('Normal'), '旧版显示 Normal 选中')
    act(() => { selector.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const items = [...container.querySelectorAll('.menu-item')]
    assert.equal(items.length, 3, '旧版选项 = Normal / Compact / Turn-Fold（3 个）')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('未知/未来词表 → 选项由词表驱动（未登记档也能显示，不崩）', () => {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    // 假设官方未来加了第五档 'ultra'
    const futureSchema = {
      uid: 21,
      refs: {
        2: { type: 'const', meta: { required: true }, value: 'compact' },
        4: { type: 'const', meta: { required: true }, value: 'standard' },
        6: { type: 'const', meta: { required: true }, value: 'ultra' },
        8: { type: 'union', meta: { default: 'standard' }, list: [2, 4, 6] },
        21: { type: 'object', meta: { default: {} }, dict: { transcriptView: 8 } },
      },
    }
    const form = makeConfigForm({ transcriptView: 'ultra' })
    applyV2Menu({ form, schema: futureSchema })
    TM.setFoldMode('auto')
    act(() => {
      root.render(React.createElement(TM.SettingsTranscriptViewRow, {
        useTranscriptView: (sel) => sel({ value: form.getSnapshot().value }),
        setTranscriptView: () => {},
      }))
    })
    const selector = container.querySelector('.ccg-settings-selector')
    assert.ok(selector.textContent.includes('ultra'), '未登记档回退显示 id 本身（不崩、不空白）')
    act(() => { selector.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    const items = [...container.querySelectorAll('.menu-item')]
    assert.equal(items.length, 4, '官方 3 档（含未知 ultra）+ Turn-Fold')
    act(() => { root.unmount() })
    dom.window.document.body.removeChild(container)
  })

  it('0.1.7 cordis 属性守卫：属性直读抛错 → 经 ctx.reflect.get 仍注册设置行（regression：真机行消失）', () => {
    // 忠实复刻 0.1.7 真机：未声明 inject 的服务属性直接抛
    // "cannot get property ... without inject"，ctx.reflect.get 是官方无声明读取通道。
    // regression 背景：2d75cf2 的 resolveTranscriptScope 属性直读 ctx.configForms
    // 在真机上必然抛错（被 catch 吞掉）→ 设置行静默消失，mock 测试测不出。
    const { svc, regs } = makeSlotsSvc()
    const form = makeConfigForm({})
    const mirror = {
      status: 'ready',
      view: { namespaces: [{ ns: 'ui-chat', schema: v2Schema(), value: { ...form.getSnapshot().value }, revision: 1 }], writable: true, hasDocument: true },
      error: null,
    }
    const configForms = makeConfigFormsService({ 'ui-chat': form }, mirror)
    const ctx = {
      slots: svc,
      inject(deps, cb) { cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
      reflect: { get(name) { return name === 'configForms' ? configForms : undefined } },
    }
    for (const guarded of ['configForms', 'settingsScope']) {
      Object.defineProperty(ctx, guarded, { get() { throw new Error('cannot get property "' + guarded + '" without inject') } })
    }
    pluginExports.apply(ctx)
    const row = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(row, '属性直读被守卫拦死时，经 reflect.get 仍注册设置行')
    assert.equal(row.options.priority, -1, 'priority=-1 shadow 官方行')
  })

  it('0.1.7 configForms 晚于 apply 激活 → 有界重试后注册设置行（无 reflect 的宿主不留定时器）', async () => {
    const { svc, regs } = makeSlotsSvc()
    const form = makeConfigForm({})
    const mirror = {
      status: 'ready',
      view: { namespaces: [{ ns: 'ui-chat', schema: v2Schema(), value: { ...form.getSnapshot().value }, revision: 1 }], writable: true, hasDocument: true },
      error: null,
    }
    const configForms = makeConfigFormsService({ 'ui-chat': form }, mirror)
    let ready = false
    const ctx = {
      slots: svc,
      inject(deps, cb) { cb({ slots: svc, connection: { generation: { getSnapshot: () => ({ host: { home: 'C:/Users/Test' } }), subscribe: () => () => {} } } }) },
      reflect: { get(name) { return name === 'configForms' && ready ? configForms : undefined } },
    }
    for (const guarded of ['configForms', 'settingsScope']) {
      Object.defineProperty(ctx, guarded, { get() { throw new Error('cannot get property "' + guarded + '" without inject') } })
    }
    pluginExports.apply(ctx)
    const rowAtApply = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(!rowAtApply, '提供方未激活时（reflect.get 为 undefined）apply 同步路径不注册')
    await new Promise((resolve) => setTimeout(resolve, 400))
    ready = true // 设置提供方 fiber 晚于本插件 apply 激活
    await new Promise((resolve) => setTimeout(resolve, 600))
    const row = regs.find((r) => r.options.name === 'settings.general.item' && r.options.id === 'transcript-view')
    assert.ok(row, 'configForms 激活后重试注册成功')
  })

  it('无任何设置服务（极简宿主）→ apply 不抛错、不注册设置行，其余功能照常', () => {
    const { svc, regs } = makeSlotsSvc()
    assert.doesNotThrow(() => {
      pluginExports.apply({
        slots: svc,
        inject(deps, cb) { cb({ slots: svc, connection: {} }) },
      })
    }, '无设置服务时不抛错')
    assert.equal(regs.filter((r) => r.options.name === 'settings.general.item').length, 0, '不注册设置行')
    assert.ok(regs.some((r) => r.options.key === 'tool-call'), 'chat.node 三格照常注册（不因缺设置服务整块降级）')
  })
})
