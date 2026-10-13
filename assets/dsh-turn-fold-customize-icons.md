# Customize dsh-turn-fold Icons

The plugin's fold-bar icons are **poker cards** (default style) or the **official chevron** (`native` style, picked in the gear popup). Poker icon data is externalized; edit the data source, not hard-coded strings.

## Icon data source & pipeline

```
dsh-turn-fold/
├── icons/default.json        ← 唯一数据源（meta / pokerR / pokerPips / pokerSVGBase /
│                                pokerTransforms / pokerSpin / pokerSpinDeepseek）
├── scripts/sync-icons.mjs    ← --inject 注入到 client.js；无参运行 = 校验一致性
└── client.js                 ← 内联 `/*__ICON_DEFAULTS__*/` 块承载注入的默认值
```

- **改图标**：编辑 `icons/default.json`，然后 `npm run sync:icons`（把内容注入 client.js 的 `ICON_DEFAULTS` 内联块）。
- **校验**：`npm run icons:check`（比较 default.json 与 client.js 内联块是否逐字节一致）。
- **运行时回退**：`loadIconConfig()` 优先读 `localStorage['dsh-turn-fold:icons']`（校验 `meta.compat`），缺失/损坏/不兼容时回退 `ICON_DEFAULTS`。

## Two customization paths

### Path A — edit the data source (recommended, versioned)
1. Edit `icons/default.json`.
2. Run `npm run sync:icons` to inject, then `npm run icons:check` to confirm (the check exits non-zero when the JSON and the inlined block differ, so CI catches a forgotten inject).
3. Apply it: **let the already-open page hot-reload** (editing `client.js` on disk swaps the bundle in open pages), or **restart the DSH desktop app**.
   ⚠️ Do **not** tell the user to refresh a page that was already open before the edit: the host computes every plugin bundle's `rev` at boot, so a full page load asks for the *stale* rev → 404 → `web boot: 1 entry did not activate` → the page stays stuck on "HARNESS Loading plugins…" (observed on this machine with a junction/link install; refreshing is only safe *after* an app restart). If the fold bars look "gone" with no error, suspect exactly this.

### Path B — runtime localStorage override (no code change, session-local)
Write a complete icon package (same shape as `icons/default.json`, including `meta.compat`) to `localStorage['dsh-turn-fold:icons']`. It wins over the built-in defaults until removed. To reset: `localStorage.removeItem('dsh-turn-fold:icons')`.

**What a pack actually reaches** (asymmetric on purpose — do not promise more).
⚠️ `iconConfig` is read **once at module init** (no storage listener), so **every row below needs
a reload** (hot-reload or app restart, see Path A step 3) — not just the step group-header skin:

| | Pack override? | Why |
| --- | --- | --- |
| Turn-bar running flip + completed stack/fan faces | **yes** | built at runtime by `buildPokerSpinSVG` / the face pool from `iconConfig` |
| Settings-preview faces | **yes** | same face pool |
| **Step** group-header skin (card size/masks/suit mapping) | **yes** | on plugin activation `buildStepSkinCss()` reads the **live** `iconConfig` |
| Card geometry knobs (`restAngle`, `strokeW`, `frames`, `flipMs`, `pokerPips`, stack/fan tables) | **yes** | read per load |
| **Step** running animation (five-face rotation) | **no** | baked into `client.js` at build time by `npm run sync:step-anim` from the design reference (row 3's animation body + row 5's 35.5° label) — an icon-pack change does not reach it |
| Official chevron style (`iconStyle = native`) | n/a | not part of the icon data source at all |

A pack with **missing fields no longer throws**: a suit missing from `pokerPips` falls back per suit
to the built-in default (before 2026-10-13 such a pack threw during render, and the Turn bar has no
error boundary). But a **missing `pokerSpinDeepseek` is meaningful** — it means "no whale face", the
pool degrades to four suits, and it is never filled back in from the defaults.

## Icon package structure (icons/default.json)

```jsonc
{
  "meta": { "version": 1, "compat": ">=0.3.1" },
  "pokerR": 1.08,                     // card corner radius
  "pokerPips": {                      // suit path data (24-unit space, fill currentColor)
    "spade":   { "path": "<path d=.../>", "cx": 12, "cy": 12, "factor": 1 },
    "heart":   { ... }, "diamond": { ... }, "club": { ... }
  },
  "pokerSVGBase":    { ... },          // card face base
  "pokerTransforms": { ... },          // stack/fan geometry（牌身份连续：同一 card id
                                       //  在 stack 与 fan 里是同一张牌、层级不变——
                                       //  stack 的顶牌（最大 id）在 fan 里必须是最右那张，
                                       //  与 fan5 同构：居中那张不旋转、两侧对称）
  "pokerSpin": {                       // running-icon flip — 语义旋钮，运行时真的读
    "restAngle": 35.5377,              //   竖直对角线轴角 ≈ atan(w/h)
    "strokeW": 0.84,                   //   卡牌描边宽度
    "frames": 72,                      //   scaleX(cosθ) 一圈多少步（72 = 5°/步 → 73 个值）
    "flipMs": 1600,                    //   一次 360° 翻牌时长；四花色整轮 = 4 × 它
    "h": 9.6, "pokerRatio": 0.714, "r": 1.296, "pipScale": 0.2348
  },
  "pokerSpinDeepseek":"..."            // DeepSeek face
}
```

> `frames` / `flipMs` replaced the old `scaleKeys` / `scaleKeyTimes` tables (73 values each, no
> runtime reader — editing them did nothing). The keyframes are now a formula
> (`scaleX = cos(2πk/frames)`, `keyTimes = k/frames`), and `pokerAnimSVG` (a 54 KB snapshot with no
> consumer) was deleted. Verified: `frames: 72` reproduces the historical CSV byte-for-byte.

Two different running icons — do not assume they are the same animation:
- **Turn bar / settings preview — "card flip · vertical diagonal axis"**: the 5:7 card is rotated
  by `pokerSpin.restAngle` (≈35.5377° = `atan(w/h)`) so its own top-left → bottom-right diagonal
  stands vertical, and it is then squashed horizontally about that vertical line
  (`translate(8,8) → scaleX(cosθ) → rotate(restAngle) → translate(-8,-8)`), so the rotation origin
  is the card centre. Suits cycle ♠ → ♥ → ♦ → ♣ on the front with the DeepSeek whale on the back.
  It is an inline SVG built at runtime by `buildPokerSpinSVG` from `iconConfig` (so a
  `localStorage['dsh-turn-fold:icons']` pack override reaches it); the axis group is
  `.ccg-axis-rest-rotation`, and CSS must never restate its angle.
- **Step group header (running) — "face rotation · flat-rotated 35.5°"**: the five equal faces
  (♠ ♥ ♦ ♣ + whale, no front/back) keep rotating exactly as in the reference design's row 3 (its
  `const ANIM_SVG` animation body plus the `svg3dRotated()` step), and the whole visible animation is
  wrapped in one plane rotation
  (`<g class="tf-step-flat-rotation" transform="rotate(35.5377 8 8)">`, angle from the same
  `pokerSpin.restAngle`, which must round to the design's literal 35.5). The 35.5° target angle and
  the design label come from **row 5's** click-toggle variant, not from row 3's own previews (those
  render at `ANIM_ANGLES = [0, 30, 45, 60, 90]`). It is a **self-running SVG baked into `client.js`**
  by `npm run sync:step-anim`, used as the `[data-step-process-icon]::before` mask data URI;
  regenerating it asserts the reference design's wiring and structure (row 3's animation body and
  flat-rotation wiring, row 5's 35.5 literal, the rotation group wrapping every phase, no banned
  axis-rotation identifiers) and **prints** the output counts to stdout — the count invariants
  (5 phases / 72 animateTransform / 15 animate / `0.8s`×82 / `4s`×5) are asserted by
  `tests/unit.css.test.mjs`'s flat-rotation contract. Because it is a build-time artifact, a runtime
  icon-pack override does **not** rewrite it, and the script reads **only `pokerSpin.restAngle`** (plus
  the reference HTML) — re-run it after changing that one value if the step rotation must follow.

The settings option row is built by `pokerPreviews(tick)`: four static stack/fan previews whose
faces shift one slot through the face pool (`♠♥♦♣` + whale) every second — `tick` comes from the
shared 1s live clock (`usePreviewTick`), so the row keeps changing while the popup is open and
unsubscribes when it closes. Option rows keep the `previews(tick)` signature; rows that don't
animate (native chevron) simply ignore the argument.

## The official chevron is NOT in the JSON

The `native` style uses the plugin's **own** inline SVG (`NativeChevronIcon`), whose geometry is
aligned value-by-value with the official `IconChevronDownOutlineRegular` (viewBox 16, stroke 1,
size 14, `rotate(180deg)` when open). It follows the DSH theme through CSS variables and is not
part of `icons/default.json` — do not try to relocate it, and do not look for a `default` style
value or a host `ui-primitives` icon: the plugin requires **no** `@deepseek-ai/*` client package at
runtime.

## Critical SVG pitfalls (this user's browser / DSH environment)

Recorded in the project memory file (`MEMORY.md` in the plugin repo — workspace-only, not shipped in the npm package); respect them or icons render transparent/blank:
- **`fill="var(--xxx)"` as an SVG presentation attribute does NOT work** → transparent cards. Use CSS classes or literal values.
- **CSS cannot override an explicit `fill` on `<defs>` content referenced by `<use>`** → never write `fill` in defs; inherit from the `<use>` element and control via CSS.
- **`clip-rule="evenodd"` clip-path does not work** → drop clip-path entirely.
- **CSS `transform-origin` on SVG `<g>` is unreliable** → use `translate(cx,cy) → animateTransform scale → translate(-cx,-cy)` or `animateTransform additive="sum"`.
- **A CSS `transform` rule silently overrides the SVG `transform` attribute** (and `transform-box:view-box` resolves `50% 50%` in the element's *local* space, which is NOT the card centre) → never restate a rotation angle as CSS `transform`; write it once as the `transform` attribute on the group (Turn running icon: `.ccg-axis-rest-rotation`; Step running icon: `tf-step-flat-rotation` — both take their angle from `pokerSpin.restAngle`). The Turn side is guarded by `tests/unit.poker.test.mjs`; the Step side is structurally immune instead — the running SVG lives inside a CSS `mask-image` data URI, so page CSS cannot reach into it.
- **`display:none` / wrong attribute-selector level hides whole blocks** → prefer `visibility:hidden`; put `[data-top]` on the correct `<g>` level.
- Masks: use `mask-type:luminance` (white=visible, black=hidden); black occluder must be larger than the card (e.g. 8.72 vs 8, rx 1.86 vs 1.5) so stroke is fully knocked out; suffix mask ids/urls uniquely per instance.

## Workflow

1. Ask the user what to change: card look, suit design, geometry (corner radius / fan angle / stack offset), running animation, or switching to the official chevron.
2. Prefer **Path A** (versioned, reproducible). If the user only wants a quick local preview, offer **Path B**.
3. After edits, always: `npm run sync:icons`, `npm run icons:check`, `node --check client.js`. When the change touches `pokerSpin.restAngle`, also run `npm run sync:step-anim` — the Step running rotation reads **only that value** plus the reference HTML (row 3's animation body + row 5's 35.5° label); `pokerPips` / `pokerSpinDeepseek` changes do **not** need it.
   Also run `npm test` **when you are in the plugin source checkout** — the suite lives in `tests/`
   and needs devDependencies, and **neither ships in the npm tarball**. In an installed copy
   `node --test "tests/*.test.mjs"` matches nothing and exits 0, which looks green but tests
   nothing; there, `npm run icons:check` plus `node --check client.js` are all you can verify.
4. Apply it as described in Path A step 3 (hot reload or app restart) — **not** a page refresh.
