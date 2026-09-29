// 共享单例 jsdom：全量测试（--test-isolation=none 单进程）只驻留一个 JSDOM 实例。
// 旧模式（每个测试文件各建一个 JSDOM 并覆盖 globalThis）在 7 份 factory 并存时
// 会撞环境进程内存上限（FATAL: Committing semi space failed）——jsdom 的 C++ 层
// 不受 V8 堆参数控制。共享单例后内存恒定；各文件的容器/设置在共享 document 里，
// 由各文件自己的 beforeEach/afterEach 清理，互不污染。
import { createRequire } from 'node:module'

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

export const sharedWindow = dom.window
export const sharedDocument = dom.window.document
export default dom
