// dsh-turn-fold 图标配置同步脚本。
// icons/default.json 是图标数据唯一源（独立文件夹，改图标改这里），client.js 通过
// ICON_DEFAULTS 内联块承载默认值（DSH client bundle 单文件限制，无法运行时读包内文件）。
//
// 用法：
//   node scripts/sync-icons.mjs            # 检查 client.js 内联块是否与 default.json 一致
//   node scripts/sync-icons.mjs --inject   # 把 icons/default.json 注入 client.js 的 ICON_DEFAULTS
//
// 注：ICON_DEFAULTS 是"内置默认"；运行时 localStorage 的 dsh-turn-fold:icons 优先于它，
// 未来联网下载的图标包也写入同一 key。compat 字段用于校验兼容性。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const JSON_FILE = fileURLToPath(new URL('../icons/default.json', import.meta.url))

const MARKER = '/*__ICON_DEFAULTS__*/'

/** 从 src 的 startIdx 起，找到匹配的 JSON 对象字面量范围 [startIdx, endIdx]。
 *  用括号配对（跳过字符串内容），返回 { start, end }。 */
function findJsonObject(src, startIdx) {
  let depth = 0
  let inStr = false
  let i = startIdx
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { start: startIdx, end: i }
    }
  }
  throw new Error('[sync-icons] 未找到 JSON 对象闭合')
}

const config = JSON.parse(readFileSync(JSON_FILE, 'utf8'))
const wantJson = JSON.stringify(config, null, 2)

const action = process.argv.includes('--inject') ? 'inject' : 'check'

/** 从 client.js 取当前 ICON_DEFAULTS 的 JSON 字符串（marker 后对象到配对闭合），
 *  未注入（null）时返回 null。 */
function currentJson(src) {
  const idx = src.indexOf(MARKER)
  if (idx === -1) throw new Error('[sync-icons] client.js 缺少注入标记 ' + MARKER)
  const after = src.slice(idx + MARKER.length)
  if (/^\s*null\s*;/.test(after)) return null
  const objStart = src.indexOf('{', idx)
  if (objStart === -1) return null
  const { start, end } = findJsonObject(src, objStart)
  return src.slice(start, end + 1)
}

/** 取 marker 后需要替换的值范围（{ start, end }，不含 marker 本身）。
 *  若 marker 后是 `null;`，替换 null；若是 JSON 对象，用括号配对替换整个对象（幂等）。 */
function replaceRange(src) {
  const idx = src.indexOf(MARKER)
  if (idx === -1) throw new Error('[sync-icons] client.js 缺少注入标记 ' + MARKER)
  const after = src.slice(idx + MARKER.length)
  // null 情况
  const m = /^\s*null\s*;/.exec(after)
  if (m) return { start: idx + MARKER.length + m[0].indexOf('null'), end: idx + MARKER.length + m[0].indexOf('null') + 4 }
  // JSON 对象情况（幂等重注入）
  const objStart = src.indexOf('{', idx)
  if (objStart === -1) throw new Error('[sync-icons] marker 后既不是 null 也不是 JSON 对象')
  const { start, end } = findJsonObject(src, objStart)
  return { start, end: end + 1 }
}

if (action === 'inject') {
  const src = readFileSync(CLIENT, 'utf8')
  const { start, end } = replaceRange(src)
  const next = src.slice(0, start) + '\n' + wantJson + src.slice(end)
  writeFileSync(CLIENT, next, 'utf8')
  console.log(`[sync-icons] 已注入 ICON_DEFAULTS（${(wantJson.length / 1024).toFixed(1)} KB）`)
} else {
  const src = readFileSync(CLIENT, 'utf8')
  const current = currentJson(src)
  // 行尾归一：Windows 下 core.autocrlf=true 会把工作区 client.js 物化成 CRLF，
  // 内嵌 JSON 区域随之带 \r；而 default.json 走 JSON.stringify 恒为 \n。比较必须
  // 忽略行尾，否则语义完全一致也会误报"不一致"（真正的更新差异不受影响）。
  const normalize = (s) => s.replace(/\r\n/g, '\n')
  if (normalize(current) === normalize(wantJson)) {
    console.log('[sync-icons] ICON_DEFAULTS 与 icons/default.json 一致')
  } else {
    console.log('[sync-icons] 不一致：icons/default.json 有更新（node scripts/sync-icons.mjs --inject 应用）')
  }
}
