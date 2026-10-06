// 齿轮弹窗测试（收尾版）：面板由打开者 Turn 栏自身 React 树渲染（无 body portal）。
//   - 字段 checkbox 双向绑定 + 持久化
//   - 图标风格 / Step 皮选择器（含皮肤 disabled 同步）
//   - 打开/关闭与 aria 状态
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import {
  T0, T1, makeTurnNode, makeTurnProcessOwner, makeUseTurnData, makeStepsSource, makeUseChat,
} from './helpers/fixtures.mjs'

const require = createRequire(import.meta.url)

import dom, { sharedWindow, sharedDocument } from './helpers/dom.mjs'

const { test: T } = loadPlugin({ window: sharedWindow })
const react = require('react')

let container = null
let root = null

const usageStep = {
  turn: 13, step: 1, status: 'settled',
  usage: { inputTokens: 1000, outputTokens: 10 },
}

function mountBar() {
  act(() => {
    root.render(react.createElement(T.EnhancedTurnProcessView, {
      node: makeTurnNode({ status: 'closed', startTime: T0, endTime: T1, steps: [usageStep] }),
      turnProcess: makeTurnProcessOwner(),
      useTurnData: makeUseTurnData({}),
      useChat: makeUseChat(makeStepsSource([usageStep])),
    }))
  })
}

function gear() {
  return container.querySelector('button.ccg-gear-button')
}

function openPopup() {
  act(() => { gear().click() })
}

beforeEach(() => {
  sharedWindow.localStorage.clear()
  for (const key of T.FIELD_KEYS) T.setFieldVisible(key, true)
  T.setIconStyle('poker')
  T.setIconStyle('poker')
  act(() => { T.setPopupOpen(false, null) })
  container = sharedDocument.createElement('div')
  sharedDocument.body.appendChild(container)
  root = createRoot(container)
  mountBar()
})

afterEach(() => {
  act(() => { T.setPopupOpen(false, null) })
  if (root) {
    act(() => { root.unmount() })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

describe('设置面板（Turn 栏自身 React 树内）', () => {
  it('默认关闭；gear 点击打开；字段与双选择器齐全', () => {
    assert.equal(container.querySelector('.ccg-gear-overlay'), null, '默认无面板')
    openPopup()
    const overlay = container.querySelector('.ccg-gear-overlay')
    assert.ok(overlay, '面板打开（在组件树内）')
    const boxes = container.querySelectorAll('input[type=checkbox]')
    assert.equal(boxes.length, T.FIELD_KEYS.length)
    const selectors = [...container.querySelectorAll('.ccg-gear-icon-selector-label')].map((l) => l.textContent)
    assert.ok(selectors.includes('折叠栏图标'), '统一图标选择器存在')
    assert.equal(gear().getAttribute('aria-expanded'), 'true')
  })

  it('checkbox 切换 → setFieldVisible 即时生效并持久化', () => {
    openPopup()
    const box = container.querySelector('input#ccg-field-tokens')
    assert.equal(box.checked, true)
    act(() => { box.click() })
    const saved = JSON.parse(sharedWindow.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.fields.tokens, false)
    assert.equal(T.settings.fields.tokens, false)
    act(() => { T.setFieldVisible('tokens', true) })
  })

  it('Escape 关闭并把焦点还给齿轮；aria-expanded 复位', () => {
    openPopup()
    act(() => {
      document.dispatchEvent(new sharedWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
    assert.equal(document.activeElement, gear())
    assert.equal(gear().getAttribute('aria-expanded'), 'false')
  })

  it('遮罩空白处点击 / Done 按钮均可关闭', () => {
    openPopup()
    act(() => {
      container.querySelector('.ccg-gear-overlay')
        .dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
    openPopup()
    act(() => {
      container.querySelector('.ccg-gear-popup-btn')
        .dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
  })

  it('gear 再点一次（toggle）关闭面板', () => {
    openPopup()
    assert.ok(container.querySelector('.ccg-gear-overlay'))
    act(() => { gear().click() })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
  })
})

describe('统一图标模式选择器（iconStyle）', () => {
  it('点击选项行切换 foldIcon 并持久化', () => {
    openPopup()
    const options = container.querySelectorAll('.ccg-gear-icon-option')
    assert.ok(options.length === 2, '统一选择器共两项（poker / native）')
    act(() => { options[1].dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
    assert.equal(T.getIconStyle(), 'native')
    const saved = JSON.parse(sharedWindow.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.iconStyle, 'native')
    act(() => { T.setIconStyle('poker') })
  })

  it('native → 皮肤元素同步禁用；poker → 恢复（同一设置管两处）', () => {
    const skinEl = document.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
    openPopup()
    const selectors = container.querySelectorAll('.ccg-gear-icon-selector')
    const stepSelector = selectors[selectors.length - 1]
    const options = stepSelector.querySelectorAll('.ccg-gear-icon-option')
    act(() => { options[1].dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
    assert.equal(T.getIconStyle(), 'native')
    assert.equal(skinEl.disabled, true, '皮肤元素被禁用（总闸）')
    assert.equal(container.querySelector('[data-tf-step-skin]'), null, '不再使用 body 属性总闸')
    act(() => { T.setIconStyle('poker') })
    assert.equal(skinEl.disabled, false)
  })

  it('非法值被忽略（不抛错、不改状态）', () => {
    T.setIconStyle('fancy')
    T.setIconStyle('neon')
    assert.equal(T.getIconStyle(), 'poker')
    assert.equal(T.getIconStyle(), 'poker')
  })
})

// ══════════════════════════════════════════════════════════════════════
// F. 「动态扑克牌」预览的牌面轮播（每秒按牌面池换牌）
// ══════════════════════════════════════════════════════════════════════
describe('动态扑克牌预览：静态牌面每秒轮换', () => {
  /** 一张静态预览（3/5 张同款牌）的牌面：花色 glyph 或 DeepSeek 鲸鱼 <use>。 */
  function faceOf(el) {
    const pip = el.querySelector('.ccg-poker-pip')
    if (!pip) return null
    if (pip.innerHTML.includes('ccg-poker-logo-')) return 'deepseek'
    for (const s of T.POKER_SUITS) {
      if (pip.innerHTML.includes(T.POKER_PIPS[s].path.slice(0, 30))) return s
    }
    return null
  }
  /** 弹窗里 4 张静态预览的牌面（运行中翻牌项没有 .ccg-poker-card；native 行是 chevron）。 */
  function staticFaces() {
    return [...container.querySelectorAll('.ccg-gear-icon-option-preview-item')]
      .filter((el) => el.querySelector('.ccg-poker-card'))
      .map(faceOf)
  }
  /** 4 张静态预览的位姿签名（换牌不得扰动牌堆/扇形位姿——"只剩一张牌"那类 bug 的守卫）。 */
  function staticPoses() {
    return [...container.querySelectorAll('.ccg-gear-icon-option-preview-item')]
      .filter((el) => el.querySelector('.ccg-poker-card'))
      .map((el) => [...el.querySelectorAll('.ccg-poker-motion')].map((m) => m.getAttribute('transform')).join('|'))
  }
  /** 等一次真实直播 tick（订阅 → 回调内退订，恰好一拍）。 */
  function nextLiveTick() {
    return new Promise((resolve) => {
      const unsub = T.subscribeTicks(() => { unsub(); resolve() })
    })
  }
  const shifted = (faces) => {
    const pool = T.pokerFacePool()
    return faces.map((s) => pool[(pool.indexOf(s) + 1) % pool.length])
  }

  it('pokerPreviews(tick)：4 张静态预览互不同款，每 tick 整体前移一位', () => {
    const pool = T.pokerFacePool()
    const at = (t) => T.pokerPreviews(t).slice(0, 4).map((el) => el.props.suit)
    const a = at(0)
    assert.equal(a.length, 4, '3 牌折叠 / 3 牌展开 / 5 牌折叠 / 5 牌展开')
    assert.equal(new Set(a).size, 4, '同一时刻恰好 4 种不同牌面：' + a.join(','))
    for (const s of a) assert.ok(pool.includes(s), '牌面必须来自牌面池：' + s)
    const b = at(1)
    assert.deepEqual(b, shifted(a), '每 tick 整体前移一位：' + a.join(',') + ' → ' + b.join(','))
    assert.notDeepEqual(b, a, '牌面确实在变（不是冻结的 ♠♥♦♣）')
    assert.deepEqual(at(0), a, '同一 tick 结果稳定（纯函数，无随机副作用）')
    // 一个完整池周期内五种牌面都出现过（含 DeepSeek 鲸鱼）
    const seen = new Set()
    for (let t = 0; t < pool.length; t += 1) at(t).forEach((s) => seen.add(s))
    assert.deepEqual([...seen].sort(), [...pool].sort(), '池内每种牌面都会轮到：' + [...seen].join(','))
  })

  it('pokerPreviews()：缺省 tick 退化为 0，不抛错（4 静态 + 1 运行中翻牌）', () => {
    const items = T.pokerPreviews()
    assert.equal(items.length, 5)
    assert.equal(items[4].type, T.PokerSpinIcon, '第 5 项是运行中翻牌动画（真实组件）')
    assert.deepEqual(
      items.slice(0, 4).map((el) => el.props.suit),
      T.pokerPreviews(0).slice(0, 4).map((el) => el.props.suit),
    )
  })

  it('弹窗挂载期间跟着直播时钟换牌；关闭弹窗即退订（不新开定时器）', async () => {
    const baseline = T.tickListeners.size
    openPopup()
    assert.equal(T.tickListeners.size, baseline + 1, '预览复用全局直播时钟（只 +1 个订阅者）')
    const before = staticFaces()
    assert.equal(before.length, 4, '4 张静态预览都在：' + before.join(','))
    assert.equal(new Set(before).size, 4, '同一时刻互不相同：' + before.join(','))
    assert.ok(before.every((s) => s !== null), '牌面可识别：' + before.join(','))
    const poses = staticPoses()

    await act(async () => { await nextLiveTick() })

    const after = staticFaces()
    assert.deepEqual(after, shifted(before), '一 tick 后整体前移一位：' + before.join(',') + ' → ' + after.join(','))
    assert.deepEqual(staticPoses(), poses, '换牌只换牌面：牌堆/扇形位姿逐值保留（不重播入场动画）')
    for (const el of container.querySelectorAll('.ccg-gear-icon-option-preview-item')) {
      const svg = el.querySelector('svg')
      if (svg && svg.querySelector('.ccg-poker-card')) {
        assert.equal(svg.getAttribute('data-ccg-ready'), '1', '位姿已提交（无过渡的首次应用路径）')
      }
    }

    act(() => { T.setPopupOpen(false, null) })
    assert.equal(T.tickListeners.size, baseline, '弹窗关闭后预览退订（时钟无订阅者即停表）')
  })
})
