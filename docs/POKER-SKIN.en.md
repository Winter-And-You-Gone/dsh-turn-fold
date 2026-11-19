# Poker Step Skin and icon details (engineering appendix)

> Engineering appendix to the [README](../README.en.md): step reskin, running rotation, face allocation and icon data source.

## Poker Step Skin

The official step group bar (official title semantics, official shimmer, official paging
and search reveal) works untouched; the plugin only reskins it:

- A **transparent-bodied** poker card (CSS mask, current-color stroke + suit pip,
  wallpaper shows through) replaces the official activity icon. The card shares **one
  design language** with the Turn-bar poker icon: a 24×24 artwork canvas, a 16-unit mask
  rendered at 24px (1.5px/unit) → card outer edge ≈9.62×13.05px with a 1.05px stroke; and
  **both sides put that 24px canvas inside the official 16×16 leading box, centred and
  overflowing** (the Turn bar's `.ccg-poker-icon` is 16×16, the same size as the official
  `.leading`) ⇒ ink indent 1.3px and a 6(gap)+1.3 = 7.3px gap to the text, pixel-identical
  on both bars **at the default content font size**. **Recorded boundary**: the official
  `.leading` is `calc(16px + var(--dsh-content-font-delta, 0px))`, so it grows with a larger
  content font, while the plugin's `.ccg-poker-icon` and bar label are fixed (16px / 14px) and
  do not scale — at other font sizes the two bars are no longer pixel-equal
  (the earlier 24px box left 5.3px of empty space on each side, making the Turn
  bar's letter spacing 4px wider and shifting its card 4px right — verified by measurement);
- **Completed two-state icon** (fold-state aware): collapsed = a stack of suit cards
  (closed = cards put away), expanded = a fan (open = cards looked through) — same face
  pool and ordering as the running faces, with the geometry taken straight from the Turn
  bar's **stack3/stack5 · fan3/fan5** transform tables (`icons/default.json` data source).
  **Card identity is continuous**: the same card id is the same card in stack and fan with
  an unchanged layer order — stack3's top card card3 is the rightmost card in fan3 (same
  shape as fan5: the middle card does not rotate, the sides are symmetric, a larger id sits
  further right), and on expand it travels from the top-left position to the right while
  staying on top. **The card count follows this Process Group's tool-call count**: the
  official `summary.counts[].count` sum ≤3 → 3 cards, ≥4 → 5 cards (old hosts / no data →
  the safe 5-card fallback, never guessing 3). **Open/close has a morph transition**:
  pre-sampled stack↔fan interpolation frames (cubic-bezier(.22,1,.36,1) sampling, 400ms,
  16 samples = 17 keyframes, each frame a static SVG) swapped frame-by-frame via CSS
  keyframes — the animation replays from the start on every state change (same-URL mask
  images share one SMIL timeline across the page in Chromium and do not restart on
  re-apply; the frame sequence sidesteps that), with the per-frame occluder synced too.
  **The easing applies to the "geometry progress" only and the two directions mirror each
  other**: the frame-time progress u=0→1 first goes through that one easing to give the
  geometry progress (expand `progress = E(u)`, close `progress = 1 - E(u)`) while the
  geometry helper does plain linear interpolation — so both directions start fastest,
  decelerate and settle softly (measured: ≈74% of the distance in the first 100ms, ≈0.25% in
  the last 100ms), the same feel as the Turn bar's
  `transition: transform .45s cubic-bezier(.22,1,.36,1)`. **It is not a time reversal**
  (`E(1-u)`): that would make the close start at zero speed and end steepest (only ≈0.25% in
  the first 100ms, ≈74% in the last 100ms) — "slow then abrupt", the opposite of expanding.
  Overlaps use **real knockout masking**: each lower card carries an
  inline luminance mask whose occluder is a solid black card face (fill=black) covering
  the whole upper-card footprint — the card body stays transparent (wallpaper/image
  backgrounds show through) while lower strokes and pips never bleed through the upper
  card (occluders must be inlined shapes — Chromium does not render `<use>` references
  inside `<mask>` content). **The official chevron stays hidden under the Poker skin**
  (normal/hover/focus/active all show Poker; official hover tint and focus ring are
  untouched);
- The suit maps from the official `data-process-activity` value (single `ACTIVITY_SUIT`
  source generating the CSS): thinking/questions → ♥, read/readImage/search/webSearch/
  webFetch → ♠, edit/write → ♦, commands/code → ♣, subagents/plan/tools → 🐋whale
  (DeepSeek logo); unregistered activities fall back to ♥ (this mapping now mainly
  serves as the reduced-motion running fallback);
- **Running face rotation · flat-rotated 35.5° only when expanded** (**not** the Turn bar's
  vertical-diagonal-axis flip — the two are deliberately different): a running step (official
  title shimmer. Soft running-state dependencies — DSH 0.1.7 renders `data-text-shimmer`,
  DSH 0.2.0+ renders `data-shimmer`; both are real official historical contracts and the
  plugin supports both) keeps the **five equal card faces** (♠ ♥ ♦ ♣ + the DeepSeek whale;
  no front/back). **The tilt belongs to "running + expanded" only**: collapsed running uses
  the same rotation animation **upright**, and only the expanded state rotates the whole
  visible animation (cards, suits, and the masks they reference) **around the icon centre by
  35.5°**. A self-running SVG (SMIL) is used as the card's CSS mask, so the stroke color keeps
  following `currentColor`:
  - **State fact** = the official group header button's `aria-expanded="true"` (official
    `ChatGroupSeat` always renders `aria-expanded={open}`; the plugin's Legacy Header renders
    the same hook too; it is the same official fact the completed fan uses). Running +
    collapsed → upright; running + expanded → tilted. Zero JS state, pure CSS cascade;
  - **Two assets**: the expanded state uses the generated block's data URI (with the rotation
    wrapper); the collapsed state uses an upright SVG **derived at runtime by stripping the
    outermost `<g class="tf-step-flat-rotation" …>` wrapper** from that same block. Both
    animation bodies are byte-identical (a guard asserts "only the wrapper differs"), so
    there is no second keyframe set. Cost: the two data URIs have separate SMIL timelines, so
    toggling restarts the phase at 0 (the toggle is user-initiated, acceptable);
  - **Design source**: the reference `docs/扑克牌轮换_动态蒙版遮挡_文件图标加强版.html` — the
    animation body comes from **row 3** (`── 第三行：五牌面轮换动画 ──`): the five-face rotation
    itself (`const ANIM_SVG`) plus `svg3dRotated()`: insert
    `<g class="anim-root-rotation" transform="rotate(angle 8 8)">` right after `</defs>`. The
    reference's own comment: "rotate the whole visible animation around the 16×16 canvas centre
    **without touching any keyframe**; `defs` keeps its original coordinates while the outer
    transform rotates cards, suits and the referenced masks together". The **35.5° target angle
    and the design label themselves come from row 5** — the click-toggle variant under
    `── 第五行：两个"点击切换型"动画 ──` ("牌面轮换 · 平面旋转 35.5°" /
    `const target = toward35 ? 35.5 : 0`; row 3's own previews are rendered at
    `ANIM_ANGLES = [0, 30, 45, 60, 90]` and carry no 35.5 literal);
  - **Angle**: `icons/default.json → pokerSpin.restAngle` (≈35.5377° = `atan(w/h)`, the same
    data source the Turn bar's axis reads). The generator asserts it rounds to one decimal
    equal to the row-5 variant's literal **35.5** — drift on either side fails the run;
  - **Generated** by `npm run sync:step-anim` into the `>>> step-running-poker-svg` marker
    block of `client.js`. What the script asserts is the **wiring and structure**: row 3's
    animation body and flat-rotation wiring are still there (`const ANIM_SVG`, `svg3dRotated`,
    `anim-root-rotation`, `rotate(' + angle + ' 8 8)`), row 5's 35.5 literal is still there, the
    rotation group genuinely wraps every phase, and the output carries none of the banned
    identifiers from the row-4/5 axis-rotation era; it also **prints** the output's counts to
    stdout. The count invariants themselves — **5 phase groups / 72 animateTransform /
    15 animate / `0.8s`×82 / `4s`×5** — are asserted by `tests/unit.css.test.mjs`'s
    "flat rotation contract" (i.e. "rotation added, keyframes untouched"); the script is not a
    pre-commit guard for those numbers;
  - **Structure**: the five-face rotation (every 0.8s two full flat cards drift slightly apart
    on opposite diagonals and merge again, the only rotate being a ±3.1° 2D in-plane tilt; the
    layer order flips mid-way with `discrete`; four dynamic luminance masks knock the lower
    card's strokes out under the upper card; five phases form a 4s loop: diamond → club →
    spade → heart → deepseek → back to diamond); **the expanded variant wraps it in**
    `<g class="tf-step-flat-rotation" transform="rotate(35.5377 8 8)">`, and the collapsed
    variant is that same body with the wrapper removed;
  - **Recorded boundary**: this SVG is baked into `client.js` at build time; a runtime
    localStorage icon-pack override does not rewrite it (overrides only reach the Turn-bar
    flip and the runtime-generated completed two-state faces) — same nature as before;
  - The running look is independent of the card count, and when the step settles the
    shimmer disappears → automatic fallback to the completed two-state icon (collapsed
    stack / expanded fan) — pure CSS cascade, zero JS running state; static suit card
    under reduced motion (the tilt is disabled with it);
  - The rotation angle lives **only** in the SVG `transform` attribute: **CSS must never
    restate it** (a CSS transform silently overrides the attribute — the Turn bar hit
    exactly that bug; same for both assets). The step-side class name `tf-step-flat-rotation`
    is deliberately distinct from the Turn bar's `ccg-axis-rest-rotation`; guards live in
    `tests/unit.css.test.mjs` ("flat rotation contract");
- **Step file list** (the "which files did this step touch" text at the group header's tail, pure CSS
  text): data comes from the official API only — `GroupSnapshot.members` (each member node's key) →
  the official `ChatNodeStore.get(key)` tool node (`ToolChatData.root` = `name` + `argsRaw`) →
  `JSON.parse(argsRaw)` for `file_path/filePath/file/target/path`; the outlet is the official header
  button's `button[data-process-activity]::after{content:"…"}` — **no official DOM writes, no added
  official attributes, no DOM observation** (architecture red lines: see the banned identifiers in
  `tests/unit.compat.test.mjs` and the bridge guards in `tests/unit.step-cards.test.mjs`). Display
  rule: basenames, de-duplicated, then cut by a **whole-name budget** — at most 3 names, with the
  budget **derived from the content width** (`stepFilesBudgetPx()` =
  `clamp(content width − 300px, 150px, 380px)`, where the 300px reserves room for the label, icon and
  gear). The content width is **measured**: it takes the `clientWidth` of a row inside the official
  content column (`[data-chat-group-key]` group roots, session-scoped when a session anchor exists,
  rows with width 0 skipped) — the official `--dsh-chat-content-width` is declared on the
  conversation content element (not `:root`, and custom properties do not inherit upward) *and* its
  computed value is `var()/clamp()` text that `parseFloat` cannot read a number from, so it is not a
  usable numeric source. Only when nothing at all can be measured does it fall back to the viewport
  estimate (`window.innerWidth − 312`, floor 320, finally 680), and it is re-measured on window
  resize and when the group entry list changes. Names are then compared in **ASCII-equivalent
  characters** (ASCII 1, CJK/full width 2.4 ≈ 1em/6px) ⇒ ≈63 characters on wide windows (filling
  380px), while narrow windows clamp at `STEP_FILES_MIN_PX` (150px ≈ 25 equivalent ASCII characters;
  the old fixed fallback constant `STEP_FILES_BUDGET` (32 characters ≈ 192px) is deleted). Names that
  no longer fit are folded whole into ` +N`, which must itself fit the budget. **The first name is the
  one exception**: to keep at least one name (otherwise the text carries no information) it is always
  shown, so it may itself exceed the budget — and if it is wider than the `max-width` it gets
  ellipsized. That is a **recorded boundary**: do not expect "never half a filename" to hold for a
  single over-long name. The
  `max-width` written into CSS is **the same pixel value** the data layer used (the old fixed `44ch`
  fallback used a different yardstick *and* wasted half the available space — measured: on a 680px row
  the old rule spent only 130–167px with 231–468px left empty); the normal case never triggers the CSS
  clamp, and the earlier `ChatGroup…` fragment problem stays fixed. Directory-ish tools
  (`glob/grep/find/ls`) contribute no filename
  from their `path` (it is a search root; `file_path` is always trusted); directories (trailing
  separator) and `url` values are not files; the list shows for running and completed groups alike
  (while running it accumulates from official tool data, with `turnDataSource(turn,'tool-call')` as a
  refresh trigger only), and disappears with the group/session. It lives in its own stylesheet
  (`style-step-files`) and is **not** toggled by `iconStyle` (information is not skin, so it shows in
  native mode too); the legacy host surface (0.1.2–0.1.6) produces none; **recorded boundary**: only
  the **top-level** member nodes of the group are read — files that appear exclusively in PTC child
  calls (`ToolCallBlock.subCalls`) are not included;
- **Soft dependency**: every selector is pinned to the official DOM hooks; the gate is
  the skin `<style>` element's `disabled` property (the plugin never writes global
  `document.body` state) — if DSH renames the hooks, the **worst degradation is the skin
  disappearing and the official icon showing as-is**; official folding is unaffected.
  The running-state recognition relies on the official shimmer attributes (either
  one present → Running Step Poker animation; both absent → static Poker fallback;
  even if the visual hooks fail, Step Fold / Tool / Think / Turn Fold and page
  stability are never affected).


## Poker leading icon

The fold-bar icons are driven by **one unified mode** (⚙ gear on the bar → the
**"Fold icons"** selector in the popup); the turn bar's leading icon defaults to **animated
poker cards**, and the same setting also decides the Step skin:

- **Completed state**: stack of cards (≤3 tools+subagents → 3 cards, more → 5), fan when expanded;
- **Face pool**: ♠ ♥ ♦ ♣ + DeepSeek whale logo (**choose one of five**), remembered per turn;
- **Settings preview**: the four static previews (3-card stack / 3-card fan / 5-card stack / 5-card
  fan) shift their faces **one slot through the face pool (♠♥♦♣ + DeepSeek whale) every second**,
  with the previews phase-offset so four different faces are on screen at any moment; the fifth item
  is the real running flip component. The rotation reuses the shared 1s live clock that drives the
  duration stopwatch: it subscribes only while the popup is mounted and unsubscribes when it closes
  (no second timer, no idle ticking);
- **Running state**: diagonal-axis card flip (four suits cycling, logo on the back), native
  SVG animation that survives re-renders;
- **Official icons (native)**: Turn keeps **everything the enhanced bar shows** (duration /
  TTFT / tokens / tok/s / cache / "Turn N" / gear / durable metrics / official fold
  behaviour — still rendered by `EnhancedTurnProcessView`, **not** switched back to the
  official `TurnProcessNodeView`); only the leading icon becomes an official-style fold
  chevron, geometry value-for-value the official `IconChevronDownOutlineRegular`
  (viewBox 16, stroke 1, size 14), pointing down when collapsed and `rotate(180deg)` up when
  expanded (the official 100ms transition); running / non-collapsible turns have no official
  fold chevron anyway, so the leading slot stays empty. Step **fully restores the official
  ProcessGroupHeader's own icons** — activity icon, hover/focus chevron, open/closed
  direction, shimmer, title and disclosure all as-is (implemented by disabling the plugin's
  two skin stylesheets, `disabled=true`; not one byte of official DOM is touched). Switching
  needs **no page refresh**: `iconStyle` is subscribed exactly once, unconditionally, in
  `EnhancedTurnProcessView` and passed down as a plain string prop to the bar and the
  leading-icon factory `turnPokerIcon(iconStyle, …)` (subscribing inside `TurnBarView` would
  be a conditional Hook — `canToggle` changes with the turn lifecycle — so a source guard
  locks this down), and Step flips the two stylesheets' `disabled` gate synchronously via
  `applyIconStyle()`;
- **Migration**: in the old settings, either `foldIcon` or `stepSkin` being `native` →
  after upgrading `iconStyle=native` (returning users do not suddenly get poker back); both
  poker → poker; an existing new field wins. Migration happens in the read layer only; the
  next real save writes just `iconStyle` and deletes those two keys, keeping unknown fields
  (nothing is written to disk at start-up);
- **Occlusion**: luminance mask cuts the overlapped region of lower cards following the
  upper card's transform; card bodies are transparent (correct over wallpapers);
- **Data source**: `icons/default.json` (suit paths, card geometry, stack/fan transforms, and the
  `pokerSpin` semantic knobs `restAngle` / `strokeW` / `frames` / `flipMs`) — run
  `npm run sync:icons` to inject, `npm run icons:check` to verify. **Keyframes are not stored in the
  data source**: `scaleX = cos(2πk/frames)` is a formula (`frames: 72` = 5°/step, byte-identical to
  the historical literal table, locked by a guard), and the source no longer carries values nothing
  reads — the old `scaleKeys`/`scaleKeyTimes` (73 values, zero runtime readers) and `pokerAnimSVG`
  (a 54 KB snapshot, zero consumers) are gone, which alone shrank `client.js` by ~59 KB.
  The **Step running rotation** is a build-time artifact on top of it: `npm run sync:step-anim`
  regenerates it from the reference design's animation body (row 3) plus row 5's 35.5° design label
  (this is the expanded-state tilt; the collapsed state strips the wrapper at runtime),
  and the script reads **only `pokerSpin.restAngle`** (plus the reference HTML) — changing
  `pokerPips` / `pokerSpinDeepseek` does **not** require re-running it; if `restAngle` changes and the
  script is not re-run, the running angle stays stale (`npm test`'s generation-block guard fails
  first).
- **What an icon pack (`localStorage['dsh-turn-fold:icons']`) reaches** (the asymmetry is by design).
  ⚠️ `iconConfig` is read **once at module init** (there is no storage listener), so **every
  row below needs a page refresh** — not just the step group-header skin:

  | Covered | Not covered |
  | --- | --- |
  | Turn-bar running flip + completed stack/fan faces | **Step running five-face rotation** (baked into `client.js` at build time by `npm run sync:step-anim` from the design reference — an icon-pack change does not reach it) |
  | Settings-preview faces | Official chevron style (`iconStyle = native`, not part of the data source) |
  | **Step group-header skin** (card size/masks/suit mapping: on plugin activation `buildStepSkinCss` reads the **live** `iconConfig`) | — |
  | Geometry/timing knobs (`restAngle`/`strokeW`/`frames`/`flipMs`/`pokerPips`/stack-fan tables) | — |

  To reset: `localStorage.removeItem('dsh-turn-fold:icons')` (also after a refresh).
  A pack with **missing fields no longer throws**: a missing suit in `pokerPips` falls back
  per suit to the built-in default (such a pack used to throw during render, and the Turn
  bar has no error boundary); but a **missing `pokerSpinDeepseek` is meaningful** (= no whale
  face, the pool degrades to four suits) and is never filled back in.
- **Volume gating for `iconStyle = native`**: the skin CSS (~522 KB measured) and the
  per-group completed-face assets (up to 10 variants, ~2.9 MB total) are only generated in
  poker mode — native users do not pay for parsing or retaining them; switching back to poker
  materializes them lazily via `applyIconStyle()` (idempotent, so toggling never duplicates).

