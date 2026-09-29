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
  T.setFoldIconStyle('poker')
  T.setStepSkin('poker')
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
    assert.ok(selectors.includes('回合栏图标') && selectors.includes('步骤栏皮肤'))
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

describe('图标风格 / Step 皮选择器', () => {
  it('点击选项行切换 foldIcon 并持久化', () => {
    openPopup()
    const options = container.querySelectorAll('.ccg-gear-icon-option')
    assert.ok(options.length >= 4, '两个选择器各两项')
    act(() => { options[1].dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
    assert.equal(T.getFoldIconStyle(), 'native')
    const saved = JSON.parse(sharedWindow.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.foldIcon, 'native')
    act(() => { T.setFoldIconStyle('poker') })
  })

  it('点击 Step 皮选项切换 stepSkin 并同步皮肤元素 disabled', () => {
    const skinEl = document.querySelector('style[data-plugin-css="' + T.SKIN_CSS_ID + '"]')
    openPopup()
    const selectors = container.querySelectorAll('.ccg-gear-icon-selector')
    const stepSelector = selectors[selectors.length - 1]
    const options = stepSelector.querySelectorAll('.ccg-gear-icon-option')
    act(() => { options[1].dispatchEvent(new sharedWindow.MouseEvent('click', { bubbles: true })) })
    assert.equal(T.getStepSkin(), 'native')
    assert.equal(skinEl.disabled, true, '皮肤元素被禁用（总闸）')
    assert.equal(container.querySelector('[data-tf-step-skin]'), null, '不再使用 body 属性总闸')
    act(() => { T.setStepSkin('poker') })
    assert.equal(skinEl.disabled, false)
  })

  it('非法值被忽略（不抛错、不改状态）', () => {
    T.setFoldIconStyle('fancy')
    T.setStepSkin('neon')
    assert.equal(T.getFoldIconStyle(), 'poker')
    assert.equal(T.getStepSkin(), 'poker')
  })
})
