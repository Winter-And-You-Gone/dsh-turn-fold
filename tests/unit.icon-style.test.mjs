// 统一图标模式（settings.iconStyle）测试。
//
// 旧模型是两套独立状态（settings.foldIcon 管 Turn / settings.stepSkin 管 Step），
// "官方图标"不是真正的统一模式：Turn native 时前导图标直接消失，Step 仍是扑克。
// 新模型只有一个 iconStyle = poker | native：
//   poker  → Turn 牌堆/扇形/翻牌 + Step 扑克皮
//   native → Turn 官方风格 chevron（保留全部增强字段）+ Step 完全恢复官方图标
// 旧 foldIcon/stepSkin 只在 load 层做一次性迁移，运行时不再维护两套状态。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './helpers/loader.mjs'
import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })

beforeEach(() => {
  sharedWindow.localStorage.clear()
  T.settings.iconStyle = 'poker'
  T.applyIconStyle()
})

function skinEl() {
  return sharedDocument.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
}
function cardEl() {
  return sharedDocument.querySelector('style[data-plugin-css="' + T.STEP_CARD_CSS_ID + '"]')
}

// ══════════════════════════════════════════════════════════════════════
// A. 旧设置迁移（load 层一次性）
// ══════════════════════════════════════════════════════════════════════
describe('iconStyle A：旧设置迁移', () => {
  function loadWith(stored) {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify(stored))
    try { return loadPlugin({ window: sharedWindow }).test } finally { sharedWindow.localStorage.removeItem(T.SETTINGS_KEY) }
  }

  it('新设置 iconStyle=poker → poker', () => {
    assert.equal(loadWith({ iconStyle: 'poker' }).settings.iconStyle, 'poker')
  })
  it('新设置 iconStyle=native → native', () => {
    assert.equal(loadWith({ iconStyle: 'native' }).settings.iconStyle, 'native')
  })
  it('旧 foldIcon=native（stepSkin=poker）→ native（老用户不突然重现 Poker）', () => {
    assert.equal(loadWith({ foldIcon: 'native', stepSkin: 'poker' }).settings.iconStyle, 'native')
  })
  it('旧 stepSkin=native（foldIcon=poker）→ native', () => {
    assert.equal(loadWith({ foldIcon: 'poker', stepSkin: 'native' }).settings.iconStyle, 'native')
  })
  it('旧 foldIcon=poker + stepSkin=poker → poker', () => {
    assert.equal(loadWith({ foldIcon: 'poker', stepSkin: 'poker' }).settings.iconStyle, 'poker')
  })
  it('新 iconStyle 存在时优先于旧字段（不做二次迁移）', () => {
    assert.equal(loadWith({ iconStyle: 'poker', foldIcon: 'native', stepSkin: 'native' }).settings.iconStyle, 'poker')
  })
  it('旧字段缺失/非法 → 默认 poker', () => {
    assert.equal(loadWith({}).settings.iconStyle, 'poker')
    assert.equal(loadWith({ foldIcon: 'fancy', stepSkin: 'neon' }).settings.iconStyle, 'poker')
  })
  it('损坏 JSON → 默认 poker，不抛错', () => {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, '{broken')
    try { assert.equal(loadPlugin({ window: sharedWindow }).test.settings.iconStyle, 'poker') } finally { sharedWindow.localStorage.removeItem(T.SETTINGS_KEY) }
  })
})

// ══════════════════════════════════════════════════════════════════════
// B. 统一状态：一个设置同时驱动 Turn 与 Step，不可能出现不同步组合
// ══════════════════════════════════════════════════════════════════════
describe('iconStyle B：统一状态（单一来源）', () => {
  it('setIconStyle("native") → Turn native 且 Step 两张样式表同时禁用', () => {
    T.setIconStyle('native')
    assert.equal(T.getIconStyle(), 'native')
    assert.equal(skinEl().disabled, true, 'Step 皮肤样式表禁用（官方图标恢复）')
    assert.equal(cardEl().disabled, true, '牌数桥样式表禁用')
  })
  it('setIconStyle("poker") → Turn poker 且 Step 两张样式表同时启用', () => {
    T.setIconStyle('native')
    T.setIconStyle('poker')
    assert.equal(T.getIconStyle(), 'poker')
    assert.equal(skinEl().disabled, false)
    assert.equal(cardEl().disabled, false)
  })
  it('应用函数幂等：native 下重复 apply 不翻转状态', () => {
    T.setIconStyle('native')
    T.applyIconStyle()
    T.applyIconStyle()
    assert.equal(skinEl().disabled, true)
    assert.equal(cardEl().disabled, true)
    T.setIconStyle('poker')
  })
  it('运行时状态对象里不再存在 foldIcon / stepSkin（双状态已删除）', () => {
    assert.equal('foldIcon' in T.settings, false, 'settings.foldIcon 必须删除')
    assert.equal('stepSkin' in T.settings, false, 'settings.stepSkin 必须删除')
    assert.equal(typeof T.setFoldIconStyle, 'undefined', '旧 setter 必须删除')
    assert.equal(typeof T.setStepSkin, 'undefined', '旧 setter 必须删除')
  })
  it('持久化：只写 iconStyle，不再写 foldIcon / stepSkin；未知字段保留', () => {
    // 预置一条带未知字段的旧记录，保存后未知字段不能被清掉
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify({ iconStyle: 'poker', futureField: { a: 1 } }))
    T.setIconStyle('native')
    const saved = JSON.parse(sharedWindow.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.iconStyle, 'native')
    assert.equal(saved.foldIcon, undefined, '不再写旧键 foldIcon')
    assert.equal(saved.stepSkin, undefined, '不再写旧键 stepSkin')
    assert.deepEqual(saved.futureField, { a: 1 }, '用户其它未知字段保留')
    assert.equal(saved.fields.duration, true, 'fields 照常保存')
  })
  it('fields 配置不被 iconStyle 切换改写', () => {
    T.setFieldVisible('tokens', false)
    T.setIconStyle('native')
    T.setIconStyle('poker')
    assert.equal(T.settings.fields.tokens, false, '字段显隐与图标模式互不影响')
    T.setFieldVisible('tokens', true)
  })
})

// ══════════════════════════════════════════════════════════════════════
// C. native 语义：官方 presentation 恢复，插件不碰官方 DOM
// ══════════════════════════════════════════════════════════════════════
describe('iconStyle C：native = 官方图标原样（Step）', () => {
  it('native 下两张样式表 disabled ⇒ Poker CSS 不再命中 data-step-process-icon / chevron', () => {
    // 官方形状 DOM（ChatGroupSeat 真实钩子），内置官方 activity icon 子元素
    const host = sharedDocument.createElement('div')
    host.setAttribute('data-step-process', '')
    const button = sharedDocument.createElement('button')
    button.setAttribute('data-process-activity', 'read')
    button.setAttribute('aria-expanded', 'false')
    const icon = sharedDocument.createElement('span')
    icon.setAttribute('data-step-process-icon', '')
    const officialSvg = sharedDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')
    officialSvg.setAttribute('data-official-activity-icon', 'true')
    icon.appendChild(officialSvg)
    const chevron = sharedDocument.createElement('span')
    chevron.setAttribute('data-step-process-chevron', '')
    button.appendChild(icon)
    button.appendChild(chevron)
    host.appendChild(button)
    sharedDocument.body.appendChild(host)
    try {
      T.setIconStyle('native')
      // 官方 SVG 原样存在（插件从不删除/替换官方 DOM——只用自己的样式表盖）
      assert.ok(host.querySelector('[data-official-activity-icon]'), '官方 activity icon SVG 未被删除')
      // 两张样式表都禁用 ⇒ display:none / mask 覆盖规则全部失效
      assert.equal(skinEl().disabled, true)
      assert.equal(cardEl().disabled, true)
      // 样式表内容原样保留（只是被禁用，切回 poker 立即恢复）
      assert.ok(skinEl().textContent.includes('[data-step-process-icon]'), '皮肤规则仍在（禁用而非删除）')
    } finally {
      host.remove()
      T.setIconStyle('poker')
    }
  })
  it('poker 恢复：两张样式表重新启用，aria-expanded / 官方结构不受任何影响', () => {
    T.setIconStyle('native')
    T.setIconStyle('poker')
    assert.equal(skinEl().disabled, false)
    assert.equal(cardEl().disabled, false)
  })
})
