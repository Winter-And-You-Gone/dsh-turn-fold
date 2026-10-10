// README 中英对齐守卫（docs pairing guard）
//
// 为什么需要：`README.md`（简体中文，主文档）与 `README.en.md`（英文，精简版）是**两份手写**
// 文档，靠人比对。2026-10-09 就发生过一次真实漂移：EN 侧写「injects two minimal `<style>`
// elements」，而代码里实际是**六处**注入（zh 侧按代码列全了）——靠人工发现，两次提交才补齐
// （9f9a165 改 EN、a7def33 补 zh）。本守卫把"两侧都讲了的同一件事"钉住：只改一侧就红。
//
// 边界（如实记录，别当漏测）：EN 是**精简**文档，整章缺失（Compatibility Architecture、
// 0.1.1~0.1.6 历史验收、诊断两行制等）是设计选择，**不在**本守卫范围内。本守卫只管：
//   1) 语言中立的事实字面量（数字 / 标识符 / 区间 / commit / 存储键 / 选择器）——两侧必须原样出现；
//   2) 平行章节里同一事实的两种语言写法（PAIRED）——各自必须出现，任一侧被删或改口径就红；
//   3) 与代码耦合的数量不变量（样式注入处数）——文档清单条数必须等于 client.js 的实际处数。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const zh = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
const en = readFileSync(fileURLToPath(new URL('../README.en.md', import.meta.url)), 'utf8')
const client = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

/** 语言中立字面量：中英两侧都必须**原样**出现（改了一侧忘了另一侧 → 这里红）。 */
const SHARED_LITERALS = [
  // 宿主契约与兼容区间
  ['>=0.1.7-rc.1 <=0.2.0-rc.2', 'engines.dsh 支持区间（闭区间，两侧同款）'],
  ['engines.dsh', '宿主要求字段名'],
  ['TurnProcessOwnerProps', '官方 owner state 契约名'],
  ['turnProcessAlwaysOpen', '官方"运行中不可折叠"语义'],
  ['turnProcess.setOpen(!open)', '唯一折叠通道'],
  ['data-turn-process-hidden', '官方成员隐藏属性'],
  ['foldable && hasContent', 'canCollapse 判定'],
  ['conversation.chat.node', '被 shadow 的唯一官方 key'],
  ['priority: -1', 'shadow 优先级'],
  ['ctx.slots.entries', 'priority 冲突探测面'],
  ['data-text-shimmer', 'DSH 0.1.7 官方 shimmer 契约'],
  ['data-shimmer', 'DSH 0.2.0+ 官方 shimmer 契约'],
  ['787b746b807df83776957875683b8853c862ca2c', '0.1.7-rc.2 release commit（逐包 diff 审计用）'],
  ['c1b47e41fc', '0.2.0-rc.2 release commit'],
  ['21638c5631', '审计过的官方 master commit（样式注册面）'],
  ['dsh-client-ui-chat', '官方契约包名'],
  ['dsh-client-ui-conversation', '官方契约包名'],
  ['useTurnData', '官方 reactive hook'],
  ['turnDataSource(turn, \'assistant-step\')', 'step usage 订阅切片'],
  ['useTurnData(\'turn-tail\')', 'turn 聚合订阅切片'],
  ['deriveTurnTokenUsage', '官方 token 聚合折叠函数'],
  ['finalNode.timing', '官方 TTFT/tok-s 证据源'],
  ['firstTokenTime - stepStartTime', 'TTFT 语义（与官方统计同款）'],
  ['turnFoldMetrics', '插件 durable projection（重载/历史会话后仍在）'],
  ['SessionStandardProps', 'useChat 合并成员契约'],
  ['transcriptView', '插件不读不写的官方设置（守卫锁死）'],
  // 步骤皮 / 运行中轮换
  ['data-step-process-icon', 'Step 皮软依赖钩子'],
  ['data-process-activity', '官方活动类型钩子'],
  ['<body data-tf-step-skin="poker">', 'Step 皮总闸'],
  ['ACTIVITY_SUIT', '活动→花色单一映射源'],
  ['tf-step-flat-rotation', 'Step 运行中平面旋转组类名'],
  ['ccg-axis-rest-rotation', 'Turn 栏轴旋转组类名（刻意分开）'],
  ['<g class="tf-step-flat-rotation" transform="rotate(35.5377 8 8)">', '运行中轮换的旋转包装（角来自数据源）'],
  ['atan(w/h)', '轴角/旋转角的几何出处'],
  ['const target = toward35 ? 35.5 : 0', '参考稿第五行的 35.5 设计字面量'],
  ['const ANIM_SVG', '参考稿第三行的动画本体'],
  ['svg3dRotated()', '参考稿的旋转包装函数'],
  ['rotate(\' + angle + \' 8 8)', '参考稿旋转属性写法'],
  ['ANIM_ANGLES = [0, 30, 45, 60, 90]', '参考稿第三行自己的预览角（不含 35.5）'],
  ['── 第三行：五牌面轮换动画 ──', '设计出处：动画本体所在行'],
  ['── 第五行：两个"点击切换型"动画 ──', '设计出处：35.5° 目标值所在行'],
  ['docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html', '设计参考稿路径'],
  ['>>> step-running-poker-svg', '生成块标记'],
  ['npm run sync:step-anim', '运行中 SVG 生成脚本'],
  ['icons/default.json → pokerSpin.restAngle', '运行中旋转角与轴角同一数据源'],
  ['scaleX = cos(2πk/frames)', '关键帧公式（数据源不再存表）'],
  ['frames: 72', '一圈步数'],
  ['pokerAnimSVG', '已删的 54KB 死数据（两侧都记为删除）'],
  ['scaleKeys', '已删的死字段'],
  ['scaleKeyTimes', '已删的死字段'],
  ['npm run sync:icons', '图标数据源注入脚本'],
  ['npm run icons:check', '图标数据源防漂移校验'],
  // 回合栏 / 步骤栏几何
  ['.ccg-poker-icon', 'Turn 栏前导图标盒子（16×16 = 官方 .leading）'],
  ['.leading', '官方前导盒子'],
  ['calc(16px + var(--dsh-content-font-delta, 0px))', '官方 .leading 会随内容字号放大（已记录边界）'],
  ['--dsw-alias-line-secondary', '回合栏下常驻分隔线 token 链'],
  ['(count, topFace)', '逐组牌面资产变体键'],
  ['style-step-cards', '牌数桥/牌面资产逐组样式表 id'],
  ['style-step-files', '步骤文件清单独立样式表 id'],
  // 步骤文件清单
  ['GroupSnapshot.members', '文件清单只读的官方数据面'],
  ['ChatNodeStore.get(key)', '成员 key → 工具节点'],
  ['ToolChatData.root', '工具节点 payload 形状'],
  ['JSON.parse(argsRaw)', '工具参数解析'],
  ['file_path/filePath/file/target/path', '路径键优先级'],
  ['glob/grep/find/ls', '目录型工具（path 是搜索根，不当文件名）'],
  ['button[data-process-activity]::after{content:"…"}', '文件清单唯一出口（不写官方 DOM）'],
  ['[data-chat-group-key]', '内容列宽度量锚点（官方 group 根）'],
  ['--dsh-chat-content-width', '官方内容宽 token（计算值是 var()/clamp() 文本，不能当数值源）'],
  ['window.innerWidth − 312', '量不到时的视口估算'],
  ['STEP_FILES_BUDGET', '已删的固定预算常量（两侧都记为删除）'],
  ['STEP_FILES_MIN_PX', '预算下限'],
  ['stepFilesBudgetPx()', '预算函数'],
  ['ToolCallBlock.subCalls', '已知边界：PTC 子调用里的文件不进清单'],
  ['+N', '超预算整名折叠'],
  // 设置（统一 iconStyle + 旧字段迁移）
  ['foldIcon', '旧设置字段（读取层迁移来源）'],
  ['stepSkin', '旧设置字段（读取层迁移来源）'],
  ['IconChevronDownOutlineRegular', 'native 前导图标对齐的官方几何'],
  // Step completed 双态（张数按组内工具数、几何按 3/5 各自的表）
  ['summary.counts[].count', 'Step 牌数的官方来源'],
  ['stack3/stack5 · fan3/fan5', 'Step completed 双态几何：3/5 张各自的变换表'],
  ['progress = E(u)', '展开的几何进度 = E(u)'],
  ['progress = 1 - E(u)', '收起的几何进度 = 1 - E(u)（镜像，不是时间反转）'],
  ['[ +N -M ]', '已删的旧行数统计（两侧都记为删除）'],
  ['2000', 'durable projection 的回合上限'],
  // 零滚动权限（用户 2026-10-09 定调：不打补丁）
  ['.scrollTop', '插件零滚动写入'],
  ['scrollIntoView', '禁用标识符'],
  ['scrollTo', '禁用标识符'],
  ['overflow-anchor', '禁用标识符'],
  ['data-chat-following-tail', '不读官方跟随状态'],
  ['data-conversation-scroll', '不扫官方滚动容器'],
  ['use-chat-viewport', '官方跟随策略来源（只做归因，不依赖）'],
  ['use-chat-reading', '官方采样窗口来源'],
  ['nearBottom', '官方 25px 贴底判据'],
  ['movedByReader', '官方"归因给读者"标记'],
  ['onResize', 'pending 窗口内官方不跟随'],
  // 设置 / 数据源 / 安装
  ["localStorage['dsh-turn-fold:settings']", '插件设置存储键'],
  ["localStorage['dsh-turn-fold:icons']", '图标包存储键'],
  ["localStorage.removeItem('dsh-turn-fold:icons')", '图标包重置方式'],
  ['iconStyle = native', '切回官方 chevron 的取值'],
  ['--test-isolation=none', '沙箱环境必须的测试参数'],
  ['__ModuleLoader__', '测试加载真实 bundle 的通道'],
  ['install.ps1', '手工安装脚本'],
  ['~/.dsh/profiles/node_modules/@winteries/dsh-turn-fold', 'install.ps1 建的 junction 路径'],
  ['~/.dsh/profiles/web/cordis.patch.yml', 'install.ps1 追加 insert 的文件'],
  ['dsh.profile.bundles', 'dsh plugin 自动登记的 bundle 层'],
  ['require.resolve', 'install.ps1 的验证手段'],
  ['npm pack --dry-run', '打包预检（CI 与 Release 都跑）'],
  ['assets/dsh-turn-fold-customize-icons.md', '随包发布的 agent skill 正文'],
  ['dsh-turn-fold-customize-icons', 'skill 名'],
  ['document.documentElement.lang', '插件文案跟随的语言来源'],
  ['dsh-client-locale', '官方语言设置来源'],
]

/** 平行章节里同一事实的两种语言写法：[zh 侧表述, en 侧表述, 说明]。 */
const PAIRED_CLAIMS = [
  // ── 样式注入清单：代码里恰有六处注入，两侧必须列全同样六类 ──
  ['基础样式', 'base styles', '注入 1/6：基础样式'],
  ['Step 皮', 'the step skin', '注入 2/6：Step 皮'],
  ['牌数桥逐组规则', 'step-count overlay rules', '注入 3/6：牌数桥逐组覆盖表'],
  ['逐组牌面资产', 'completed-face assets', '注入 4/6：逐组牌面资产表'],
  ['步骤文件清单逐组规则', 'step file-list rules', '注入 5/6：文件清单表（独立，不受 iconStyle 开关）'],
  ['Legacy Step 表', 'legacy Step layer', '注入 6/6：Legacy Step 表'],
  // ── 运行中指标口径（展示层 / provisional / decode / durable projection）──
  ['presentation-only', 'presentation-only', '运行中 token 是展示层计数，不是统计值'],
  ['provisional', 'provisional', '运行中首字是 provisional 可见首字延迟'],
  ['blockIsVisible', 'blockIsVisible', '只有 running + 可见 block 才启动视觉计数'],
  ['200ms', '200ms', '视觉计数固定 UI tick 节奏'],
  ['+1, +1, +10', '+1, +1, +10', '确定性步长序列（无随机 jitter）'],
  ['min(500, max(20, canonicalTokens × 5%))', 'min(500, max(20, canonicalTokens × 5%))', 'canonical 视觉偏移上限'],
  ['decode-speed', 'decode-speed', 'tok/s 与官方 StatsPills 同一定义'],
  ['durable 优先', 'durable first', 'TTFT / decode 证据都 durable 优先'],
  // ── 运行栏跟随释放：两侧都必须如实记录（根因未定、插件不打补丁）──
  ['已知问题', 'Known issue', '同一节标题（根因未定、不打补丁）'],
  // ── 测试文件索引：本守卫自身必须在中英两张测试表里都登记 ──
  ['unit.docs.test.mjs', 'unit.docs.test.mjs', '本守卫自身的索引行'],
]

/** 一次性收集**全部**缺失项再断言：失败输出直接给出要补的清单，不用一条条试。 */
function missingInBoth(literals) {
  const missing = []
  for (const [literal, why] of literals) {
    if (!zh.includes(literal)) missing.push('README.md（zh）缺：' + literal + '  ← ' + why)
    if (!en.includes(literal)) missing.push('README.en.md（en）缺：' + literal + '  ← ' + why)
  }
  return missing
}

describe('README 中英对齐守卫（zh 主文档 ↔ en 精简版）', () => {
  it('两份文档互相链接（语言切换入口必须在两侧都在）', () => {
    assert.ok(zh.includes('README.en.md'), 'zh 文档缺少指向英文版的链接')
    assert.ok(en.includes('README.md'), 'en 文档缺少指向中文版的链接')
  })

  it('语言中立事实：数字 / 标识符 / 区间 / commit / 选择器两侧原样一致', () => {
    const missing = missingInBoth(SHARED_LITERALS)
    assert.deepEqual(missing, [], '\n缺 ' + missing.length + ' 项：\n' + missing.join('\n'))
  })

  it('样式注入清单：中英各自列全六类，且条数与 client.js 的实际注入处数相等', () => {
    // 与 tests/unit.compat.test.mjs 的「head 注入恰为六处」同源：那边锁代码，这边锁文档。
    // 代码新增一处注入而文档没补 → 这条红（反向也成立：文档多写一类而代码没有 → 也红）。
    const injects = (client.match(/document\.head\.appendChild\(/g) || []).length
    assert.equal(injects, 6, 'client.js 的 head 样式注入应为六处，实际 ' + injects)
    assert.equal(
      PAIRED_CLAIMS.filter(([, , why]) => why.startsWith('注入 ')).length,
      injects,
      '文档里的注入清单条数必须等于代码的实际注入处数',
    )
  })

  it('平行事实：同一件事在中英两侧各自有对应表述', () => {
    const missing = []
    for (const [zhPhrase, enPhrase, why] of PAIRED_CLAIMS) {
      if (!zh.includes(zhPhrase)) missing.push('README.md（zh）缺表述：' + zhPhrase + '  ← ' + why)
      if (!en.includes(enPhrase)) missing.push('README.en.md（en）缺表述：' + enPhrase + '  ← ' + why)
    }
    assert.deepEqual(missing, [], '\n缺 ' + missing.length + ' 项：\n' + missing.join('\n'))
  })
})
