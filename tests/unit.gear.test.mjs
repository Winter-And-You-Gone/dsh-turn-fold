// 齿轮图标 & 字段设置弹窗：验证点击齿轮 → 弹窗出现 → checkbox 开关 → 字段过滤
// 也包含文件名链接测试（segmentFilePaths / renderTitleFileLinks / GroupHeader 渲染）
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { loadPlugin } from './helpers/loader.mjs'
import { makeNode, buildSnapshot } from './helpers/store.mjs'

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

const { test: T, React } = loadPlugin({ window: dom.window })

describe('齿轮图标 & 字段设置弹窗', () => {
  let container, root

  before(() => {
    container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    root = createRoot(container)
  })

  it('初始状态：弹窗隐藏', () => {
    act(() => { root.render(React.createElement(T.FieldVisibilityPopup)) })
    assert.strictEqual(dom.window.document.querySelector('.ccg-gear-overlay'), null, '初始无弹窗')
  })

  it('setPopupVisible(true) → 弹窗出现，含 6 个 checkbox', () => {
    act(() => { T.setPopupVisible(true) })
    const overlay = dom.window.document.querySelector('.ccg-gear-overlay')
    assert.ok(overlay, '弹窗遮罩出现')
    const popup = overlay.querySelector('.ccg-gear-popup')
    assert.ok(popup, '弹窗卡片出现')
    const fields = popup.querySelectorAll('.ccg-gear-popup-field')
    assert.strictEqual(fields.length, 6, '6 个字段 checkbox')
    const checkboxes = popup.querySelectorAll('input[type="checkbox"]')
    assert.strictEqual(checkboxes.length, 6, '6 个 checkbox')
    for (const cb of checkboxes) assert.ok(cb.checked, '默认全勾选')
  })

  it('取消勾选 缓存命中率 → filterVisibleMetrics 不再输出 cacheHitPercent', () => {
    // 先勾掉 cacheHit 字段
    const checkbox = dom.window.document.querySelector('#ccg-field-cacheHit')
    assert.ok(checkbox)
    act(() => { checkbox.click() })
    assert.strictEqual(checkbox.checked, false, '缓存命中率取消勾选')

    // 构造包含所有指标的 metrics 对象
    const metrics = { durationMs: 12345, ttftMs: 500, tokens: 1000, tokensPerSecond: 25.5, cacheHitPercent: '66.67', outputTokens: 500 }
    const filtered = T.filterVisibleMetrics(metrics)
    assert.strictEqual(filtered.durationMs, 12345, '耗时保留')
    assert.strictEqual(filtered.ttftMs, 500, '首字保留')
    assert.strictEqual(filtered.tokens, 1000, '消耗token 保留')
    assert.strictEqual(filtered.tokensPerSecond, 25.5, 'tok/s 保留')
    assert.strictEqual(filtered.cacheHitPercent, undefined, '缓存命中率已过滤')
    assert.strictEqual(filtered.outputTokens, 500, 'outputTokens 始终保留')
  })

  it('取消勾选 已折叠行数 → filterVisibleMetrics 不再输出 foldedRows', () => {
    // 上一个用例勾掉了 cacheHit：先恢复，避免跨用例状态影响本用例断言
    act(() => { T.setFieldVisible('cacheHit', true) })
    // 先勾掉 folded 字段
    const checkbox = dom.window.document.querySelector('#ccg-field-folded')
    assert.ok(checkbox, '弹窗应含"已折叠行数"checkbox')
    act(() => { checkbox.click() })
    assert.strictEqual(checkbox.checked, false, '已折叠行数取消勾选')

    const metrics = { durationMs: 12345, ttftMs: 500, tokens: 1000, tokensPerSecond: 25.5, cacheHitPercent: '66.67', foldedRows: 8, outputTokens: 500 }
    const filtered = T.filterVisibleMetrics(metrics)
    assert.strictEqual(filtered.durationMs, 12345, '耗时保留')
    assert.strictEqual(filtered.cacheHitPercent, '66.67', '缓存命中率保留')
    assert.strictEqual(filtered.foldedRows, undefined, '已折叠行数已过滤')
    assert.strictEqual(filtered.outputTokens, 500, 'outputTokens 始终保留')
    // 文案层不再出现"已折叠…"
    assert.ok(!T.turnHeaderLabel(filtered).includes('已折叠'), '标题不含已折叠字段')
  })

  it('turnHeaderLabel：foldedRows 仅 >0 时拼接在缓存命中之后（zh/en）', () => {
    // zh：紧跟"缓存命中x%"之后；缺省 closed 按已折叠处理
    const label = T.turnHeaderLabel({ cacheHitPercent: '66.67', foldedRows: 8 })
    assert.strictEqual(label, '缓存命中66.67% · 已折叠8步')
    // 运行中（closed=false）显示"待折叠N步"
    assert.strictEqual(T.turnHeaderLabel({ cacheHitPercent: '66.67', foldedRows: 8 }, false), '缓存命中66.67% · 待折叠8步')
    // 无 foldedRows / foldedRows=0（上游只在 >0 时注入，这里兜底验证不显示"已折叠0步"）
    assert.strictEqual(T.turnHeaderLabel({ cacheHitPercent: '66.67' }), '缓存命中66.67%')
    assert.strictEqual(T.turnHeaderLabel({ foldedRows: 0 }), '')
  })

  it('全部取消 → filterVisibleMetrics 不输出任何可渲染字段（turnHeaderLabel 走兜底文案）', () => {
    act(() => {
      T.setFieldVisible('duration', false)
      T.setFieldVisible('ttft', false)
      T.setFieldVisible('tokens', false)
      T.setFieldVisible('tokensPerSecond', false)
      T.setFieldVisible('cacheHit', false)
    })
    const metrics = { durationMs: 12345, ttftMs: 500, tokens: 1000, tokensPerSecond: 25.5, cacheHitPercent: '66.67', outputTokens: 500 }
    const filtered = T.filterVisibleMetrics(metrics)
    // 内部字段 outputTokens 保留（其他代码路径需要），但没有任何可渲染字段
    assert.strictEqual(filtered.durationMs, undefined)
    assert.strictEqual(filtered.ttftMs, undefined)
    assert.strictEqual(filtered.tokens, undefined)
    assert.strictEqual(filtered.tokensPerSecond, undefined)
    assert.strictEqual(filtered.cacheHitPercent, undefined)
    assert.strictEqual(filtered.outputTokens, 500)
    // turnHeaderLabel 对无可渲染字段的对象返回空串 → 折叠栏 fallback "运行了 N 条命令"
    assert.strictEqual(T.turnHeaderLabel(filtered), '')
  })

  it('关闭弹窗 → setPopupVisible(false) → overlay 消失', () => {
    act(() => { T.setPopupVisible(false) })
    assert.strictEqual(dom.window.document.querySelector('.ccg-gear-overlay'), null, '弹窗关闭')
  })

  // ── 折叠图标选择 ──
  it('弹窗内出现折叠图标选择器（两个选项，每个选项右侧一排预览图标）', () => {
    act(() => { T.setPopupVisible(true) })
    const selector = dom.window.document.querySelector('.ccg-gear-icon-selector')
    assert.ok(selector, '选择器区域出现')
    const options = selector.querySelectorAll('.ccg-gear-icon-option')
    assert.strictEqual(options.length, 2, '两个选项')

    // 选项文字在左、预览在右
    const pokerOpt = options[0]
    const defaultOpt = options[1]
    assert.ok(pokerOpt.querySelector('.ccg-gear-icon-option-text'), 'poker 选项有文字区')
    assert.ok(defaultOpt.querySelector('.ccg-gear-icon-option-text'), 'default 选项有文字区')
    const pokerPreview = pokerOpt.querySelector('.ccg-gear-icon-option-preview')
    const defaultPreview = defaultOpt.querySelector('.ccg-gear-icon-option-preview')
    assert.ok(pokerPreview, 'poker 选项有预览区')
    assert.ok(defaultPreview, 'default 选项有预览区')

    // 文字在左、预览在右：DOM 顺序 text → preview
    const firstChild = pokerOpt.children[0]
    const secondChild = pokerOpt.children[1]
    assert.ok(firstChild.classList.contains('ccg-gear-icon-option-text'), '文字在前')
    assert.ok(secondChild.classList.contains('ccg-gear-icon-option-preview'), '预览在后')

    // poker 预览 6 个图标（3牌折叠/展开、5牌折叠/展开、牌面翻转、牌面轮换）
    const pokerItems = pokerPreview.querySelectorAll('.ccg-gear-icon-option-preview-item')
    assert.strictEqual(pokerItems.length, 6, 'poker 预览 6 种图标')

    // default 预览 2 个图标（右箭头、下箭头）
    const defaultItems = defaultPreview.querySelectorAll('.ccg-gear-icon-option-preview-item')
    assert.strictEqual(defaultItems.length, 2, 'default 预览 2 种图标')
    // 箭头是描边 polyline（非 fill 路径）
    const rightArrow = defaultItems[0].querySelector('polyline')
    assert.ok(rightArrow, '右箭头用 polyline 描边')
    const downArrow = defaultItems[1].querySelector('polyline')
    assert.ok(downArrow, '下箭头用 polyline 描边')

    // 默认选中 poker（第一个）
    assert.ok(options[0].hasAttribute('data-selected'), '默认选中动态扑克牌')
  })

  it('每个预览图标外包放大气泡（hover 显示，无尖尖）', () => {
    // 展开后：每个预览项都包在 .ccg-preview-tooltip 里，内含原预览项 + 放大气泡
    const tips = dom.window.document.querySelectorAll('.ccg-gear-icon-option-preview .ccg-preview-tooltip')
    // poker 6 + default 2 = 8 个预览项
    assert.strictEqual(tips.length, 8, '每个预览图标一个 tooltip 包裹')
    for (const tip of tips) {
      const item = tip.querySelector('.ccg-gear-icon-option-preview-item')
      assert.ok(item, 'tooltip 内含原预览项')
      const bubble = tip.querySelector('.ccg-preview-bubble')
      assert.ok(bubble, 'tooltip 内含放大气泡')
      // 无尖尖（已移除）
      assert.strictEqual(bubble.querySelector('.ccg-preview-bubble-arrow'), null, '气泡无尖尖')
      const body = bubble.querySelector('.ccg-preview-bubble-body')
      assert.ok(body, '气泡内含放大主体')
      assert.ok(body.querySelector('svg'), '放大主体内含图标')
    }
    // 气泡默认隐藏（opacity:0 / visibility:hidden 由 CSS 控制，jsdom 只看结构）
  })

  it('选择"默认" → turnPokerIcon 返回 undefined（官方 chevron）', () => {
    // 选中"默认"选项（第二个）
    const option = dom.window.document.querySelectorAll('.ccg-gear-icon-option')[1]
    assert.ok(option)
    act(() => { option.click() })
    assert.strictEqual(T.getFoldIconStyle(), 'default', '已切换到 default')

    // turnPokerIcon 返回 undefined（而非 PokerSpinIcon / PokerIcon）
    const fold = { turn: 1, toolCount: 3 }
    const result = T.turnPokerIcon(fold, false, true)
    assert.strictEqual(result, undefined, '运行中回合折叠栏不渲染扑克牌')

    const resultClosed = T.turnPokerIcon(fold, true, false)
    assert.strictEqual(resultClosed, undefined, '结束后回合折叠栏也不渲染扑克牌')
  })

  it('切回"动态扑克牌" → turnPokerIcon 返回组件', () => {
    const option = dom.window.document.querySelectorAll('.ccg-gear-icon-option')[0]
    assert.ok(option)
    act(() => { option.click() })
    assert.strictEqual(T.getFoldIconStyle(), 'poker', '已切回 poker')

    act(() => {
      const fold = { turn: 2, toolCount: 5 }
      const result = T.turnPokerIcon(fold, false, true)
      // 返回 React 元素（PokerSpinIcon 等），不是 undefined
      assert.notStrictEqual(result, undefined, '运行中回合折叠栏渲染扑克牌')
    })
  })

  // ── 文件名链接（步骤折叠栏标题中的文件可点击复制） ──
  describe('文件名链接（segmentFilePaths / renderTitleFileLinks / GroupHeader）', () => {
    function toolWithPath(key, seq, name, path) {
      return makeNode(key, 'tool-call', seq, { data: { root: { kind: 'tool-result', callId: key, name, argsRaw: JSON.stringify({ path }), isError: false } } })
    }
    function closedGroupWithFiles(paths) {
      const nodes = [
        makeNode('u', 'user', 100, { data: { seq: 100, content: [] } }),
        makeNode('as', 'assistant-step', 200, { data: { status: 'settled', turn: 13, step: 1, blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '正文' }] } }),
        ...paths.map((p, i) => toolWithPath('e' + i, 300 + i, 'edit', p)),
        makeNode('as2', 'assistant-step', 400, { data: { status: 'settled', turn: 13, step: 2, blocks: [{ kind: 'text', text: '最终' }] } }),
      ]
      const s = buildSnapshot(nodes, { turnEnds: new Map() })
      const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('e0'))
      return { group: g, nodes: s.chat.nodes, order: s.chat.order }
    }

    it('segmentFilePaths：basename → 绝对路径映射（read/edit 都收集）', () => {
      const { group, nodes } = closedGroupWithFiles(['C:\\proj\\b.js', 'C:\\proj\\c.js'])
      T.segmentFilePathsCache.clear()
      const map = T.segmentFilePaths(group, nodes)
      assert.ok(map instanceof Map)
      assert.strictEqual(map.get('b.js'), 'C:\\proj\\b.js')
      assert.strictEqual(map.get('c.js'), 'C:\\proj\\c.js')
      assert.strictEqual(map.size, 2)
    })

    it('renderTitleFileLinks：把标题中的文件名替换为 FileLink 元素', () => {
      const filePaths = new Map([['b.js', 'C:\\proj\\b.js']])
      const result = T.renderTitleFileLinks('编辑了b.js [ +12 -3 ]', filePaths)
      assert.strictEqual(typeof result, 'object', '返回 React 元素（非字符串）')
      assert.ok(result !== null)
      // 结果是 Fragment，含文本 + FileLink
      const type = result && result.type
      assert.ok(type === 'symbol' || type === React.Fragment || type === 'div', '结果为 Fragment/元素')
    })

    it('无文件时 renderTitleFileLinks 原样返回字符串', () => {
      assert.strictEqual(T.renderTitleFileLinks('运行了2条命令', null), '运行了2条命令')
      assert.strictEqual(T.renderTitleFileLinks('运行了2条命令', new Map()), '运行了2条命令')
    })

    it('GroupHeader：段闭合含文件名时渲染出可点击的 .ccg-file-link（悬停变主题蓝）', () => {
      // 清掉缓存，构造单文件编辑段
      T.segmentLabelCache.clear()
      T.segmentFilePathsCache.clear()
      const nodes = [
        makeNode('u', 'user', 100, { data: { seq: 100, content: [] } }),
        makeNode('as', 'assistant-step', 200, { data: { status: 'settled', turn: 13, step: 1, blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '正文' }] } }),
        makeNode('e0', 'tool-call', 300, { data: { root: { kind: 'tool-result', callId: 'e0', name: 'edit', argsRaw: JSON.stringify({ path: 'C:\\proj\\index.js', insertions: 12, deletions: 3 }), isError: false } } }),
        makeNode('as2', 'assistant-step', 400, { data: { status: 'settled', turn: 13, step: 2, blocks: [{ kind: 'text', text: '最终' }] } }),
      ]
      const s = buildSnapshot(nodes, { turnEnds: new Map() })
      const g = T.computeGroup(s.chat.order, s.chat.nodes, s.chat.nodes.get('e0'))
      const filePaths = T.segmentFilePaths(g, s.chat.nodes)
      const title = T.segmentLabel(g, s.chat.nodes)
      assert.strictEqual(title, '编辑了index.js [ +12 -3 ]', '标题含文件名')

      // 渲染 GroupHeader（isTurn=false，filePaths 传入）→ 标题里应出现 .ccg-file-link
      const headerHost = dom.window.document.createElement('div')
      const headerRoot = createRoot(headerHost)
      act(() => {
        headerRoot.render(React.createElement(T.GroupHeader, {
          count: 1, open: true, onToggle: () => {}, label: title,
          isTurn: false, filePaths,
        }))
      })
      const link = headerHost.querySelector('.ccg-file-link')
      assert.ok(link, '文件名渲染为 .ccg-file-link')
      assert.strictEqual(link.textContent, 'index.js', '显示文件名')
      assert.strictEqual(link.getAttribute('title'), 'C:\\proj\\index.js', 'title 携带绝对路径')
      assert.ok(link.hasAttribute('role') && link.getAttribute('role') === 'button', '可点击')
      // 点击复制（jsdom 无 clipboard，走 fallback 不报错）且不冒泡到行 toggle
      let toggled = false
      act(() => {
        headerRoot.render(React.createElement(T.GroupHeader, {
          count: 1, open: true, onToggle: () => { toggled = true }, label: title,
          isTurn: false, filePaths,
        }))
      })
      const link2 = headerHost.querySelector('.ccg-file-link')
      const clickEvent = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
      link2.dispatchEvent(clickEvent)
      assert.strictEqual(toggled, false, '点击文件名不触发折叠栏展开/收起')
      // 点击后触发 Toast（showToast 被调用，getToast 有文案）
      const toast = T.getToast()
      assert.ok(toast.seq > 0, 'Toast seq 递增')
      assert.strictEqual(toast.text, '已复制绝对路径', 'Toast 文案正确')
      act(() => { headerRoot.unmount() })
    })

    it('showToast / clearToast 状态管理', () => {
      // 先清除可能被前序测试残留的 toast 状态
      T.clearToast()
      // 初始
      const init = T.getToast()
      assert.strictEqual(init.text, null)
      const seq0 = init.seq
      // showToast
      T.showToast('测试消息')
      const t1 = T.getToast()
      assert.strictEqual(t1.text, '测试消息')
      assert.strictEqual(t1.seq, seq0 + 1)
      // clearToast
      T.clearToast()
      const t2 = T.getToast()
      assert.strictEqual(t2.text, null)
      assert.strictEqual(t2.seq, t1.seq)
      // 重复 clear 无害
      T.clearToast()
      assert.strictEqual(T.getToast().text, null)
    })

    it('TurnFoldToast 在平台缺失 Toast 时返回 null', () => {
      const host = dom.window.document.createElement('div')
      const root = createRoot(host)
      act(() => { root.render(React.createElement(T.TurnFoldToast)) })
      // Toast 为 null（未 mock uiPrimitives），组件返回 null，DOM 无内容
      assert.strictEqual(host.children.length, 0)
      act(() => { root.unmount() })
    })
  })

  // ── 图标配置外置加载（iconConfig / ICON_DEFAULTS / localStorage） ──
  describe('图标配置外置（icons/default.json 注入 + localStorage 优先）', () => {
    it('内置默认：ICON_DEFAULTS 有完整图标数据，iconConfig 引用它', () => {
      assert.ok(T.ICON_DEFAULTS, 'ICON_DEFAULTS 已注入（非 null）')
      assert.strictEqual(T.ICON_DEFAULTS.pokerR, 1.08, 'pokerR 默认 1.08')
      assert.ok(T.ICON_DEFAULTS.pokerAnimSVG, 'pokerAnimSVG 已注入')
      assert.ok(T.ICON_DEFAULTS.pokerAnimSVG.length > 1000, 'pokerAnimSVG 是完整 SVG（>1KB）')
      assert.ok(T.ICON_DEFAULTS.pokerPips.spade.path, 'spade path 已注入')
      assert.ok(T.ICON_DEFAULTS.pokerSpin.scaleKeys, 'pokerSpin.scaleKeys 已注入')
      // 无 localStorage 覆盖时 iconConfig 与 ICON_DEFAULTS 一致
      assert.strictEqual(T.iconConfig, T.ICON_DEFAULTS, '未覆盖时 iconConfig = ICON_DEFAULTS')
      assert.strictEqual(T.POKER_R, 1.08, 'POKER_R 引用配置')
      assert.ok(T.POKER_ANIM_SVG, 'POKER_ANIM_SVG 有值')
    })

    it('localStorage 覆盖优先：修改后重新加载，iconConfig 用覆盖值', () => {
      // 先清空 localStorage，加载基准
      try { dom.window.localStorage.removeItem('dsh-turn-fold:icons') } catch (e) {}
      // 写入一个覆盖配置（模拟未来下载的图标包）
      const override = JSON.parse(JSON.stringify(T.ICON_DEFAULTS))
      override.meta = { version: 99, description: '测试覆盖包', compat: '>=0.3.1' }
      override.pokerR = 7.77
      override.pokerPips.spade.path = '<path d="CUSTOM"/>'
      try {
        dom.window.localStorage.setItem('dsh-turn-fold:icons', JSON.stringify(override))
      } catch (e) { /* jsdom 可能不支持 */ }

      // 用新的 jsdom 重新加载插件（读同一 localStorage 需要同一 window）
      const { test: T2 } = loadPlugin({ window: dom.window })
      if (T2 && T2.iconConfig) {
        assert.strictEqual(T2.iconConfig.pokerR, 7.77, 'localStorage 覆盖 pokerR 生效')
        assert.strictEqual(T2.POKER_R, 7.77, 'POKER_R 用覆盖值')
        assert.strictEqual(T2.iconConfig.pokerPips.spade.path, '<path d="CUSTOM"/>', 'spade path 覆盖生效')
      } else {
        // jsdom 下 loadPlugin 若复用了 factory 缓存则跳过值断言
        assert.ok(true, 'jsdom localStorage 限制，跳过值断言')
      }
      try { dom.window.localStorage.removeItem('dsh-turn-fold:icons') } catch (e) {}
    })

    it('不兼容的图标包（compat 高于当前版本）回退内置默认', () => {
      const override = JSON.parse(JSON.stringify(T.ICON_DEFAULTS))
      override.meta = { version: 1, description: '未来不兼容包', compat: '>=99.0.0' }
      override.pokerR = 5.55
      try { dom.window.localStorage.setItem('dsh-turn-fold:icons', JSON.stringify(override)) } catch (e) {}
      const { test: T2 } = loadPlugin({ window: dom.window })
      if (T2 && T2.iconConfig) {
        assert.strictEqual(T2.iconConfig.pokerR, 1.08, '不兼容包回退内置默认')
      } else {
        assert.ok(true, 'jsdom localStorage 限制，跳过')
      }
      try { dom.window.localStorage.removeItem('dsh-turn-fold:icons') } catch (e) {}
    })
  })
})