// 齿轮弹窗测试（插件设置 UI：字段显隐 / 图标风格 / Step 皮）：
//   - 弹窗开合 + 字段 checkbox 双向绑定
//   - 设置项即时生效并持久化（localStorage）
//   - hooks 顺序守卫（隐藏态也必须调用全部 hooks —— FieldVisibilityPopup 前车之鉴）
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 官方 UI 原语桩：chevron 图标 / Toast（组件身份稳定即可，渲染为空元素）
const PRIMITIVES_STUB = {
  IconChevronDownOutline14: function IconChevronDownStub() { return null },
  IconChevronRightOutline14: function IconChevronRightStub() { return null },
  Toast: function ToastStub() { return null },
}
const { test: T } = loadPlugin({ window: dom.window, uiPrimitives: PRIMITIVES_STUB })
const react = require('react')

let container = null
let root = null
function mountPopup() {
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(react.createElement(T.FieldVisibilityPopup, null)) })
}

beforeEach(() => {
  dom.window.localStorage.clear()
  for (const key of T.FIELD_KEYS) T.setFieldVisible(key, true)
  T.setFoldIconStyle('poker')
  T.setStepSkin('poker')
})

afterEach(() => {
  T.setPopupVisible(false)
  if (root) {
    act(() => { root.unmount() })
    root = null
  }
  if (container) {
    container.remove()
    container = null
  }
})

describe('字段设置弹窗', () => {
  it('隐藏态渲染 null 但不崩（hooks 顺序守卫）', () => {
    mountPopup()
    assert.equal(container.querySelector('.ccg-gear-overlay'), null)
  })

  it('打开后列出全部字段 checkbox + 两个选择器', () => {
    T.setPopupVisible(true)
    mountPopup()
    const overlay = container.querySelector('.ccg-gear-overlay')
    assert.ok(overlay, '弹窗打开')
    const boxes = container.querySelectorAll('input[type=checkbox]')
    assert.equal(boxes.length, T.FIELD_KEYS.length)
    assert.ok(container.querySelector('.ccg-gear-icon-selector'), '图标风格选择器')
    assert.ok(container.querySelectorAll('.ccg-gear-icon-selector').length >= 2, 'Step 皮选择器也在')
  })

  it('checkbox 切换 → setFieldVisible 即时生效并持久化', () => {
    T.setPopupVisible(true)
    mountPopup()
    const box = container.querySelector('input#ccg-field-tokens')
    assert.equal(box.checked, true)
    act(() => {
      // HTMLElement.click()：同步触发 activation behavior + click 事件，React onChange 跟随
      box.click()
    })
    const saved = JSON.parse(dom.window.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.fields.tokens, false)
    assert.equal(T.settings.fields.tokens, false)
    // 恢复
    T.setFieldVisible('tokens', true)
  })

  it('遮罩点击关闭；Done 按钮关闭', () => {
    T.setPopupVisible(true)
    mountPopup()
    const overlay = container.querySelector('.ccg-gear-overlay')
    act(() => {
      overlay.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null, '遮罩空白处点击关闭')
    T.setPopupVisible(true)
    mountPopup()
    const done = container.querySelector('.ccg-gear-popup-btn')
    act(() => {
      done.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.querySelector('.ccg-gear-overlay'), null, 'Done 关闭')
  })
})

describe('图标风格 / Step 皮选择器', () => {
  it('点击选项行切换 foldIcon 并持久化', () => {
    T.setPopupVisible(true)
    mountPopup()
    const options = container.querySelectorAll('.ccg-gear-icon-option')
    assert.ok(options.length >= 4, '两个选择器各两项')
    // FoldIconSelector 是第一个：第二项 = native
    act(() => {
      options[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(T.getFoldIconStyle(), 'native')
    const saved = JSON.parse(dom.window.localStorage.getItem(T.SETTINGS_KEY))
    assert.equal(saved.foldIcon, 'native')
    T.setFoldIconStyle('poker')
  })

  it('点击 Step 皮选项切换 stepSkin 并同步 body 属性', () => {
    T.setPopupVisible(true)
    mountPopup()
    const selectors = container.querySelectorAll('.ccg-gear-icon-selector')
    const stepSelector = selectors[selectors.length - 1]
    const options = stepSelector.querySelectorAll('.ccg-gear-icon-option')
    act(() => {
      options[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(T.getStepSkin(), 'native')
    assert.equal(dom.window.document.body.getAttribute(T.STEP_SKIN_ATTR), null)
    T.setStepSkin('poker')
    assert.equal(dom.window.document.body.getAttribute(T.STEP_SKIN_ATTR), 'poker')
  })

  it('非法值被忽略（不抛错、不改状态）', () => {
    T.setFoldIconStyle('fancy')
    T.setStepSkin('neon')
    assert.equal(T.getFoldIconStyle(), 'poker')
    assert.equal(T.getStepSkin(), 'poker')
  })
})

describe('Toast（注册降级提示的宿主）', () => {
  it('showToast → 快照更新；clearToast → 清除', () => {
    T.showToast('test-msg')
    assert.equal(T.getToast().text, 'test-msg')
    T.clearToast()
    assert.equal(T.getToast().text, null)
  })
})
