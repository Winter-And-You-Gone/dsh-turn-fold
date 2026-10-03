// 统一图标模式（settings.iconStyle）测试。
//
// 旧模型是两套独立状态（settings.foldIcon 管 Turn / settings.stepSkin 管 Step），
// "官方图标"不是真正的统一模式：Turn native 时前导图标直接消失，Step 仍是扑克。
// 新模型只有一个 iconStyle = poker | native：
//   poker  → Turn 牌堆/扇形/翻牌 + Step 扑克皮
//   native → Turn 官方风格 chevron（保留全部增强字段）+ Step 完全恢复官方图标
// 旧 foldIcon/stepSkin 只在 load 层做一次性迁移，运行时不再维护两套状态。
import { describe, it, beforeEach } from 'node:test'
import { readFileSync } from 'node:fs'
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

// ══════════════════════════════════════════════════════════════════════
// D. legacy key 真正删除 + 未知字段保留 + 启动不写盘
// ══════════════════════════════════════════════════════════════════════
describe('iconStyle D：legacy key 一次性清理', () => {
  function loadWith(stored) {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify(stored))
    return loadPlugin({ window: sharedWindow }).test
  }
  const stored = () => JSON.parse(sharedWindow.localStorage.getItem(T.SETTINGS_KEY))

  beforeEach(() => { sharedWindow.localStorage.removeItem(T.SETTINGS_KEY) })

  it('load 只读：启动阶段不写 localStorage（legacy key 原样留着，等下一次真实保存）', () => {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify({ foldIcon: 'native', stepSkin: 'poker', foo: 123 }))
    const loaded = loadPlugin({ window: sharedWindow }).test
    assert.equal(loaded.settings.iconStyle, 'native', '迁移在内存里生效')
    const raw = sharedWindow.localStorage.getItem(T.SETTINGS_KEY)
    assert.equal(raw.includes('"foldIcon"'), true, '启动阶段不得改写磁盘（保持只读）')
    sharedWindow.localStorage.removeItem(T.SETTINGS_KEY)
  })

  it('下一次真实保存：删除 foldIcon / stepSkin，重写 iconStyle，保留未知字段与 fields', () => {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify({
      fields: { duration: false, ttft: true }, foldIcon: 'native', stepSkin: 'poker', foo: 123, futureSetting: 'x',
    }))
    const loaded = loadPlugin({ window: sharedWindow }).test
    assert.equal(loaded.settings.iconStyle, 'native')
    assert.equal(loaded.settings.fields.duration, false, '旧 fields 值照常读入')

    loaded.setFieldVisible('tokens', false)         // 触发一次真实保存
    const saved = stored()
    assert.equal('foldIcon' in saved, false, 'foldIcon 必须被删除')
    assert.equal('stepSkin' in saved, false, 'stepSkin 必须被删除')
    assert.equal(saved.iconStyle, 'native', 'iconStyle 已写入')
    assert.equal(saved.foo, 123, '未知字段保留')
    assert.equal(saved.futureSetting, 'x', '未知字段保留')
    assert.equal(saved.fields.duration, false, 'fields 原值保持')
    assert.equal(saved.fields.tokens, false, 'fields 新值写入')
    sharedWindow.localStorage.removeItem(T.SETTINGS_KEY)
  })

  it('四类迁移 + 清理组合', () => {
    const cases = [
      [{ foldIcon: 'native', stepSkin: 'poker' }, 'native'],
      [{ foldIcon: 'poker', stepSkin: 'native' }, 'native'],
      [{ foldIcon: 'poker', stepSkin: 'poker' }, 'poker'],
      [{ iconStyle: 'poker', foldIcon: 'native', stepSkin: 'native' }, 'poker'],
    ]
    for (const [before, expected] of cases) {
      sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify(before))
      const loaded = loadPlugin({ window: sharedWindow }).test
      assert.equal(loaded.settings.iconStyle, expected, JSON.stringify(before))
      loaded.setFieldVisible('cacheHit', false)
      const saved = stored()
      assert.equal('foldIcon' in saved, false, '清理 foldIcon: ' + JSON.stringify(before))
      assert.equal('stepSkin' in saved, false, '清理 stepSkin: ' + JSON.stringify(before))
      assert.equal(saved.iconStyle, expected)
      assert.equal(saved.fields.cacheHit, false)
      loaded.setFieldVisible('cacheHit', true)
      sharedWindow.localStorage.removeItem(T.SETTINGS_KEY)
    }
  })

  it('fields 在 iconStyle 迁移前后逐字段一致（不被迁移改写）', () => {
    sharedWindow.localStorage.setItem(T.SETTINGS_KEY, JSON.stringify({
      fields: { duration: true, ttft: false, tokens: true, tokensPerSecond: false, cacheHit: true }, foldIcon: 'native',
    }))
    const loaded = loadPlugin({ window: sharedWindow }).test
    assert.deepEqual(loaded.settings.fields, { duration: true, ttft: false, tokens: true, tokensPerSecond: false, cacheHit: true })
    loaded.setIconStyle('poker')
    assert.deepEqual(loaded.settings.fields, { duration: true, ttft: false, tokens: true, tokensPerSecond: false, cacheHit: true })
    sharedWindow.localStorage.removeItem(T.SETTINGS_KEY)
  })
})

// ══════════════════════════════════════════════════════════════════════
// E. 源码静态守卫：Hook 调用形状
// ══════════════════════════════════════════════════════════════════════
describe('iconStyle E：源码静态守卫（Hook 调用形状）', () => {
  const source = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  it('禁止任何 "if (... useIconStyle(...))" 形式的条件 Hook', () => {
    const lines = source().split('\n')
    for (const line of lines) {
      const code = line.split('//')[0]
      if (!code.includes('useIconStyle(')) continue
      assert.ok(!/^\s*(if|for|while|switch|\}|\?)\s*[^\n]*useIconStyle\(/.test(code),
        '条件分支里不得调用 useIconStyle：' + line.trim())
      assert.ok(!/\?[^:]*useIconStyle\(|&&[^&]*useIconStyle\(|\|\|[^|]*useIconStyle\(/.test(code),
        '不得在逻辑表达式里调用 useIconStyle：' + line.trim())
    }
  })
  it('TurnBarView 函数体内不得出现 useIconStyle（订阅只在 EnhancedTurnProcessView）', () => {
    const lines = source().split('\n')
    const start = lines.findIndex((l) => /^\s*function TurnBarView\(/.test(l))
    assert.ok(start > 0, 'TurnBarView 必须在')
    let end = -1
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\t\tfunction [A-Za-z_$]/.test(lines[i])) { end = i; break }
    }
    assert.ok(end > start, 'TurnBarView 边界可定位')
    const body = lines.slice(start, end).join('\n')
    assert.ok(!body.includes('useIconStyle'), 'TurnBarView 不得自行订阅图标模式（canToggle 会变 → 条件 Hook 风险）')
    assert.ok(body.includes('props.iconStyle'), 'TurnBarView 必须从 prop 读 iconStyle')
  })
  it('EnhancedTurnProcessView 只有一处 useIconStyle()，且位于全部条件 return 之前', () => {
    const lines = source().split('\n')
    const start = lines.findIndex((l) => /^\s*function EnhancedTurnProcessView\(/.test(l))
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\t\tfunction [A-Za-z_$]/.test(lines[i])) { end = i; break }
    }
    const body = lines.slice(start, end)
    const calls = body.filter((l) => l.split('//')[0].includes('useIconStyle('))
    assert.equal(calls.length, 1, '只允许一处订阅：' + JSON.stringify(calls))
    const callIndex = body.findIndex((l) => l.split('//')[0].includes('useIconStyle('))
    const firstReturn = body.findIndex((l) => /^\s*return react\.createElement/.test(l))
    assert.ok(firstReturn === -1 || callIndex < firstReturn, '订阅必须早于任何条件 return')
  })
  it('turnPokerIcon 为纯函数：签名首参为 iconStyle，函数体内不读全局设置', () => {
    const lines = source().split('\n')
    const start = lines.findIndex((l) => /function turnPokerIcon\(/.test(l))
    assert.ok(start > 0, 'turnPokerIcon 必须在')
    assert.ok(/function turnPokerIcon\(iconStyle,/.test(lines[start]), '首参必须是 iconStyle：' + lines[start].trim())
    let end = -1
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\t\tfunction [A-Za-z_$]/.test(lines[i])) { end = i; break }
    }
    const body = lines.slice(start, end + 1).join('\n')
    assert.ok(!body.includes('getIconStyle()'), '纯函数不得读全局 iconStyle')
  })
})
