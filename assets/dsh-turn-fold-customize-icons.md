# Customize dsh-turn-fold Icons

The plugin's fold-bar icons are **poker cards** (default style) or the **official chevron** (`default` style, picked in the gear popup). Poker icon data is externalized; edit the data source, not hard-coded strings.

## Icon data source & pipeline

```
dsh-turn-fold/
├── icons/default.json        ← 唯一数据源（meta / pokerR / pokerPips / pokerSVGBase /
│                                pokerTransforms / pokerSpin / pokerAnimSVG / pokerSpinDeepseek）
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
3. Refresh the DSH web page so the client bundle reloads `client.js`.
Remind the user: this project is **web-only** — a browser refresh is what applies the change (there is no desktop build to restart). If the fold bars look "gone" and there is no error, first confirm the page was actually refreshed.

### Path B — runtime localStorage override (no code change, session-local)
Write a complete icon package (same shape as `icons/default.json`, including `meta.compat`) to `localStorage['dsh-turn-fold:icons']`. It wins over the built-in defaults until removed. To reset: `localStorage.removeItem('dsh-turn-fold:icons')`.

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
  "pokerSpin":       { ... },          // running-icon flip: restAngle = vertical-diagonal axis ≈35.5377°
  "pokerAnimSVG":    "...",            // legacy data (largest block) — no longer consumed at runtime
  "pokerSpinDeepseek":"..."            // DeepSeek face
}
```

The **running** icon (both the Turn bar while a turn is live and the settings preview) is the
"card flip · vertical diagonal axis" card: the 5:7 card is rotated by `pokerSpin.restAngle`
(≈35.5377° = `atan(w/h)`) so its own top-left → bottom-right diagonal stands vertical, and it is
then squashed horizontally about that vertical line (`translate(8,8) → scaleX(cosθ) →
rotate(restAngle) → translate(-8,-8)`), so the rotation origin is the card centre. Suits cycle
♠ → ♥ → ♦ → ♣ on the front with the DeepSeek whale on the back.

The settings option row is built by `pokerPreviews(tick)`: four static stack/fan previews whose
faces shift one slot through the face pool (`♠♥♦♣` + whale) every second — `tick` comes from the
shared 1s live clock (`usePreviewTick`), so the row keeps changing while the popup is open and
unsubscribes when it closes. Option rows keep the `previews(tick)` signature; rows that don't
animate (native chevron) simply ignore the argument.

## The official default chevron is NOT in the JSON

`default` style uses the **official ui-primitives icons** (`IconChevronRightOutline14` / `IconChevronDownOutline14` via `DisclosureRow`), with a small inline `DefaultChevronIcon` fallback. It follows the DSH theme and is not part of `icons/default.json` — do not try to relocate it.

## Critical SVG pitfalls (this user's browser / DSH environment)

Recorded in the project memory file (`MEMORY.md` in the plugin repo — workspace-only, not shipped in the npm package); respect them or icons render transparent/blank:
- **`fill="var(--xxx)"` as an SVG presentation attribute does NOT work** → transparent cards. Use CSS classes or literal values.
- **CSS cannot override an explicit `fill` on `<defs>` content referenced by `<use>`** → never write `fill` in defs; inherit from the `<use>` element and control via CSS.
- **`clip-rule="evenodd"` clip-path does not work** → drop clip-path entirely.
- **CSS `transform-origin` on SVG `<g>` is unreliable** → use `translate(cx,cy) → animateTransform scale → translate(-cx,-cy)` or `animateTransform additive="sum"`.
- **A CSS `transform` rule silently overrides the SVG `transform` attribute** (and `transform-box:view-box` resolves `50% 50%` in the element's *local* space, which is NOT the card centre) → never restate a flip-axis angle as CSS `transform`; write it once as the `transform` attribute on the group (running icon: `.ccg-axis-rest-rotation`, angle from `pokerSpin.restAngle`). Guarded by `tests/unit.poker.test.mjs`.
- **`display:none` / wrong attribute-selector level hides whole blocks** → prefer `visibility:hidden`; put `[data-top]` on the correct `<g>` level.
- Masks: use `mask-type:luminance` (white=visible, black=hidden); black occluder must be larger than the card (e.g. 8.72 vs 8, rx 1.86 vs 1.5) so stroke is fully knocked out; suffix mask ids/urls uniquely per instance.

## Workflow

1. Ask the user what to change: card look, suit design, geometry (corner radius / fan angle / stack offset), running animation, or switching to the official chevron.
2. Prefer **Path A** (versioned, reproducible). If the user only wants a quick local preview, offer **Path B**.
3. After edits, always: `npm run sync:icons`, `npm run icons:check`, `node --check client.js`, and `npm test` (the suite asserts icon-related rendering).
4. Remind the user to **refresh the DSH web page** (web-only project) before judging the result.
