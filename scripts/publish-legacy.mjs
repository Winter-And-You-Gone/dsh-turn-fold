#!/usr/bin/env node
/**
 * 以旧包名 `dsh-turn-fold` 发布同一份源码。
 *
 * 包名更名为 `@winteries/dsh-turn-fold` 后，已安装旧包的用户其更新仍通过旧包名
 * 解析，因此每次发版需要同时发布两个名字。加载器按安装时的包名导入模块
 * （`cordis.patch.yml` 的 `name:` 必须是模块标识），所以 legacy 构建要同步替换：
 *   - package.json    name:  @winteries/dsh-turn-fold → dsh-turn-fold
 *   - cordis.patch.yml name: '@winteries/dsh-turn-fold' → 'dsh-turn-fold'
 *   - client.js       __ModuleLoader__.load 的注册 id（client-modules 校验注册 id
 *                     必须等于加载器 entry name，即安装时的包名）
 *
 * 本脚本会就地修改这三个文件（面向 CI 一次性工作区，紧接着执行 `npm publish`）。
 * 本地试用后可用 `git checkout -- package.json cordis.patch.yml client.js` 恢复。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const LEGACY = 'dsh-turn-fold'
const CANONICAL = '@winteries/dsh-turn-fold'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== CANONICAL) {
  console.error(`expected canonical name ${CANONICAL}, got ${pkg.name}`)
  process.exit(1)
}
if (!existsSync('cordis.patch.yml')) {
  console.error('cordis.patch.yml not found')
  process.exit(1)
}

pkg.name = LEGACY
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

const patch = readFileSync('cordis.patch.yml', 'utf8')
const swapped = patch.replace(`name: '${CANONICAL}'`, `name: '${LEGACY}'`)
if (swapped === patch) {
  console.error(`cordis.patch.yml does not reference ${CANONICAL} — nothing to swap`)
  process.exit(1)
}
writeFileSync('cordis.patch.yml', swapped)

// client-modules 加载器校验注册 id 必须等于加载器 entry name（即安装时的包名），
// 否则 bundle 执行后抛 "loaded without registering"。legacy 包名不带 scope，
// client.js 里硬编码的注册 id 必须同步替换，否则旧名包加载同样失败。
const client = readFileSync('client.js', 'utf8')
const clientSwapped = client.replace(
  `id: "${CANONICAL}"`,
  `id: "${LEGACY}"`,
)
if (clientSwapped === client) {
  console.error(`client.js does not reference the canonical registration id — nothing to swap`)
  process.exit(1)
}
writeFileSync('client.js', clientSwapped)

console.log(`swapped ${CANONICAL} → ${LEGACY}; run \`npm publish\` next`)
