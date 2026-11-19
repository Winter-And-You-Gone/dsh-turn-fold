# Turn metrics, implementation and known issues (engineering appendix)

> Engineering appendix to the [README](../README.en.md): metric semantics, the visual counter, implementation notes and known issues.

## Turn bar metric semantics

- **Field slots always exist**: the fields enabled in settings occupy their slots from 0s
  (with no real data they show `—`); arriving real data only replaces the `—`, and no new
  field segment appears at completion; a disabled field disappears entirely (not even `—`).
  Every statistic comes from official real data and is **never fabricated** (no estimation,
  no data = `—`). The running token digits are a presentation-only display value: with
  official data = the real value plus a bounded visual offset; before the first official
  usage report = an independent visual counter (see "real data layer / display layer"
  below). The screen-reader (sr-only) text is **always** the official real value
  (`— token` until the real value arrives).
- **Metric sources (all official real data)**:
  - Duration: `TurnLocation.start.time → end.time` (live clock fills in while running);
  - TTFT: **durable first** — the plugin's own official projection `turnFoldMetrics`
    (see "durable Turn metrics" below) gives the turn's stable first-token latency
    (`firstTokenTime - stepStartTime`, the same semantics as official statistics);
    then the client-side `finalNode.timing` (present only when this page saw it live);
    while running, before official timing is ready, a **provisional** visible-first-token
    latency (`data.time - stepStartTime`; remembered once observed in the page, and kept
    on settle when the exact value is missing instead of falling back to `—`);
  - Tokens / cache-hit: the official aggregated `tokenUsage` on turn-tail after the turn
    closes (`deriveTurnTokenUsage` folds every billed attempt, including retried ones;
    cache denominator = prompt-side total); while running or when absent, per-step usage
    accumulation is used (the official step data store is independent of node visibility,
    so hidden tool-only steps are still counted);
  - tok/s: **decode-speed** (the same definition as the official StatsPills) —
    `Σ outputTokens ÷ Σ(completedTime − firstTokenTime)`, counting only steps where
    first-token time, completion time and outputTokens are all present; TTFT, tool
    execution, waiting between steps and the whole turn's wall-clock time never enter the
    denominator. The decode evidence is **durable first** as well (projection), with the
    client-side step aggregate as the fallback.
- **Durable Turn metrics (the `turnFoldMetrics` projection, and why it is needed)**: the
  official client records `finalNode.timing.firstTokenTime` only when it receives
  `assistant/live-chunk` (a transient client event that is **not persisted**)
  (`ui-chat/.../assistant.ts:146,154`), and neither `settleMessage()` nor the history-rebuild
  `fallbackState()` restores it from the persisted `assistant/message.stream` — so **after a
  page reload or when opening a historical session TTFT and tok/s both disappear**
  (`TTFT —` / `— tok/s`), while the official bottom sessionStats still has both values (it
  folds them durably with `assistantStreamFirstTokenTime(event.data.stream)`). The plugin
  therefore registers its own projection on the host half (official public extension point
  `ctx.sessionProjections.register`; the unit is plugin-owned, read-only, returns the same
  reference and produces no extra broadcasts), folding per-turn metrics with event semantics
  **identical, one by one,** to the official sessionStats; the host pushes it to the client
  over the projection wire and the front end reads it with
  `useProjection('turnFoldMetrics')` — LIVE / SETTLED / RELOAD / HISTORY all read from the
  same source. On older hosts without that service the whole registration is skipped and the
  front end falls back to client-side step data (degradation = those two fields show `—`
  after a reload; nothing is fabricated). Three numbers per turn, capped at 2000 turns
  (older turns degrade to `—`).
- **Real data layer / display layer (the running token)**:
  - `canonicalTokens` (real data layer) = `computeTurnMetrics`'s `tokens` (official usage /
    turn-tail aggregate) — the only authoritative value; it takes part in tok/s, cache hit,
    TTFT and the durable projection. Before official usage arrives it **stays `undefined`**
    and is never written back from a display value;
  - `displayTokens` (display layer) is used by the running UI only, lives entirely in a
    component-local ref (never written to localStorage / the projection / any node data) and
    takes part in no statistic:
    - **with canonical**: `displayTokens = canonicalTokens + visual offset`;
    - **without canonical** (official usage has not reported yet): once the **running**
      assistant-step already has visible reasoning/text (official `blockIsVisible` semantics:
      tool-call / empty text do not count) the token slot starts a **presentation-only visual
      counter** — its first frame is `1` (it does not wait for 200ms), it then grows on the
      same cadence with the deterministic step sequence `+1, +1, +10` (no random jitter),
      independently capped at 500, and it calibrates to the official token count the moment
      the first real usage arrives; the screen-reader text still shows `— token` until then;
    - **hint**: it does not start right after sending a message, while the model has not
      produced any visible content yet (it never starts jumping up from 0 on its own);
  - **it only grows while the model is really streaming visible assistant output**: during
    tool execution, waiting for results/approval/subagents, or when that step has already
    settled (or has no visible block yet) the digits **freeze** and do not fall back to
    `— token` (avoiding a `137 → — → number` jump);
  - the cadence is fixed and deterministic: **one UI tick every 200ms**;
  - the canonical visual-offset ceiling is `min(500, max(20, canonicalTokens × 5%))`
    (e.g. 1,000 → +50; 10,000 → +500; 100,000 → +500), stops at the ceiling and waits for
    the next real usage;
  - **official usage update → immediate calibration**: bootstrap/offset are all cleared and
    the next frame equals the new real value directly (never rolls slowly over from the old
    display value), then keeps growing slowly from the new baseline. **Calibration does not
    change the subscription state**: if that assistant-step is still streaming visible
    content the ticker stays subscribed and the next tick continues from the new baseline;
    if it has meanwhile entered tool execution / waiting (no running visible step) only the
    real value is shown and the ticker unsubscribes. **Turn settle → everything resets**,
    and a historical session / page reload shows the official real value only (`— token`
    again without canonical);
  - **performance**: the visual ticker subscribes only while there is really an animation
    (running + visible output + the Token field enabled + reduce-motion off) — historical
    turns, closed turns and tool/waiting phases never subscribe; with no active subscriber
    the module-level interval **stops entirely** (100 historical turns = 0 subscribers + 0
    timers);
  - with the system "reduce motion" setting on it snaps back **immediately** (dropping the
    visual offset already rolled out: canonical → show canonical, no canonical → back to
    `— token`) and unsubscribes; toggling that setting mid-session takes effect live
    (media-query change event drives the re-render). In normal mode the visual digits roll
    while the sr-only text stays canonical (screen readers always get the real value).
- **Rolling-digit animation**: while running, each digit rolls to its new value
  (odometer effect with back easing); a full sr-only copy keeps screen readers intact;
  degrades to static digits under "reduce motion".
- **Permanent divider line** below the bar (`--dsw-alias-line-secondary` token chain,
  theme-aware).
- **Accessibility**: `aria-expanded` / `aria-label`, keyboard operable (Enter / Space);
  non-collapsible turns (e.g. official Verbose semantics, aborted/failed turns) render
  as a static bar.
- **All four official transcript modes work**: the turn bar renders under Compact /
  Standard / Detailed / Verbose; `foldable=false` (e.g. Verbose) and paginated history
  (without `turn/start` in the window, where the official control is absent) degrade
  gracefully.

## How it works (why no source patches are needed)

- The DSH session UI is assembled from Cordis plugins + the slot system; every chat-flow
  block is dispatched through the `conversation.chat.node` keyed slot by node kind, and
  **registering the same key replaces that renderer (lowest renders)**.
- This plugin shadows the official `turn-process` renderer with `priority: -1` — on
  **modern hosts** the only official renderer it replaces. It does not shadow `tool-call` /
  `assistant-step` / `context` / `user`, does not scan official slot entries for
  delegation, and does not copy official inject hooks (official components are always
  rendered by their own official entries). **Exception**: on legacy hosts outside the
  declared `engines.dsh` range (0.1.1–0.1.6) the plugin registers its own renderers through
  the Legacy compatibility layer — unreachable within the declared range, see the Legacy
  section.
- **Fold semantics come entirely from the official owner state**: the official
  `ChatNodeSeat` builds `turnProcess = { spec, foldable, hasContent, open, setOpen }`
  for every node and hides/shows members itself (`data-turn-process-hidden`). The plugin
  bar only calls `turnProcess.setOpen(!open)` on click; `canCollapse` mirrors the
  official renderer (`foldable && hasContent`, and never collapsible for open/aborted/
  error turns — the official `turnProcessAlwaysOpen` semantics).
- **Running status bar**: the official `turn-process` node is projected at `turn/start`,
  but the official renderer returns null until the turn closes — the plugin renderer
  shows the Running Turn Bar in that phase (0s start, real metrics, no folding
  behavior). When the turn closes, the same renderer switches to the full bar.
- **Known issue: follow release caused by the running bar (root cause not pinned down, the plugin
  patches nothing)**: that row is **0px** while running officially and about **37px** here (24px row +
  1px divider + 4/8 margins), and it sits at the top of the turn — i.e. **above the reading anchor**.
  **Observed chain**: a layout change at the turn boundary opens the official 500ms reader-sample
  window (`use-chat-viewport` judges the scroll event as `movedByReader`, and `use-chat-reading`'s
  `onResize` stops following during it) → the next turn's growth lands inside that window → the window
  closes with a `nearBottom` (25px) re-decision → follow is released, so the running step bar can come
  to rest inside the composer's (in-scrollport, sticky) covered band. **Live-machine evidence**:
  disabling the plugin makes the symptom disappear — so the plugin's own 37px row-height change
  (0 → ≈37px at the turn top) **is a contributor**; but the **root cause is not yet pinned down** (the
  interaction between the official follow policy and the plugin's layout changes has not been fully
  attributed). **Per the user's rule the plugin adds no compensation or patch** (it writes no official
  scroll position, reads no official follow state, observes no DOM), and a guard test pins "zero
  scroll writes" (0 `.scrollTop` writes, no `scrollIntoView` / `scrollTo` / `overflow-anchor`, no
  `data-chat-following-tail` / `data-conversation-scroll`, no ResizeObserver / MutationObserver /
  IntersectionObserver — see `tests/unit.compat.test.mjs`) so that no workaround can creep back in.
  **The leading open lead (not a fix)**: the plugin's own **layout churn** at turn boundaries — every
  new `(count, topFace)` variant **appends** a 220–390 KB `<style>` (measured: ≈218–235 KB for 3
  cards, ≈378 KB for 5 cards, ≈3 MB after 10 variants) that is written once and **never rewritten**;
  on top of that, the per-group rule tables (`style-step-cards` / `style-step-files`) are rewritten
  wholesale whenever their content changes. (Since 2026-10-13 `iconStyle = native` no longer
  generates those assets or the skin sheet — see the volume gating above — but the poker-mode
  volume is unchanged, so the lead still stands.)
- **Metrics read surface (read-only official data, no membership recomputation)**:
  `node.location.turn` (`TurnLocation`: start/end/status/reason/steps) + turn data store
  (`get('turn-tail')` official aggregate `tokenUsage`, `get('turn-process')` official
  spec) + per-step `data.get('assistant-step')` (usage / `finalNode.timing`). The
  snapshot is subscribed via `useChat` (a merged `SessionStandardProps` member) to drive
  re-renders; the step data store is independent of node visibility, so hidden
  tool-only steps are not missed.
- **Poker step skin (pure CSS)**: official `ChatGroupSeat` / `ProcessGroupHeader` render
  the step groups and titles as-is; the plugin CSS hides the official icon content
  inside `data-step-process-icon` and renders a poker card via `::before` + CSS mask,
  with the suit derived from `data-process-activity` through `ACTIVITY_SUIT` (JS mapping
  → CSS rules generated from the same source). Gate: `applyIconStyle()` flips `disabled`
  on the skin and step-count style sheets (it writes **no `document.body` attribute** and
  touches no official DOM).
  **No MutationObserver, no React root appended to the official header, no plugin-owned
  step open state.**
- **Conflict-yielding registration**: before registering, the plugin probes whether
  `priority: -1` for the same key is taken (`ctx.slots.entries`) and yields to the next
  free value (official `0` is always reserved) with a `console.warn`.
- **Soft degradation on registration errors (never breaks DSH boot)**: all slot
  registrations go through one pipeline that catches both inject-declaration waits and
  register errors; a single failed entry only skips itself, logs a `console.warn` and
  shows one neutral degradation Toast. The host-half skill registration is equally
  double-guarded.
- **Settings are fully independent**: the plugin never reads — let alone writes — the
  official `transcriptView` field (locked by a source-level architecture-guard test).
  Plugin settings live in `localStorage['dsh-turn-fold:settings']` (two keys only: field
  visibility and the unified icon style — the old `foldIcon` / `stepSkin` pair is migrated
  once at read time and then deleted); icon packs still use
  `localStorage['dsh-turn-fold:icons']`.
- **Locale follows the UI**: copy reads `document.documentElement.lang` (set by
  `dsh-client-locale` when DSH switches language), falling back to browser languages.

## Notes

- Compatibility target: the **DSH 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3
  / 0.2.2-rc.1 / 0.2.2-rc.2 / 0.2.2-rc.3 `conversation.chat.node` + `turn-process` owner-state
  contract** (the first
  three are LIVE-HOST VERIFIED; 0.2.1-rc.2 is CONTRACT-VERIFIED against release commit
  `d1b9c04067` and the version matrix, plus LOAD/APPLY VERIFIED on a source-built 0.2.1-rc.2
  host with an isolated profile; 0.2.1-rc.3 is CONTRACT-VERIFIED against release commit
  `1f81c047fc`; 0.2.2-rc.1 is CONTRACT-VERIFIED + LOAD/APPLY VERIFIED against release commit
  `66491b05e3` — source-built host, isolated profile: the bundle is composed into the boot
  graph, four style sheets are injected, capability detection reports `turn=modern`, zero
  exceptions; Turn Bar takeover still needs a real model session; 0.2.2-rc.2 is
  CONTRACT-VERIFIED against release commit `ddac96760b` — additive-only plus the new
  `context` ProcessActivity word-list entry, already consumed by the plugin's suit map;
  0.2.2-rc.3 is CONTRACT-VERIFIED against release commit `38a6a5c965` — version bumps only —
  see the capability
  matrix above). The full contract surface
  exists from 0.1.7-rc.1 onward (`TurnProcessOwnerProps`, the reactive `useTurnData` hook,
  `ChatNodeStore.turnDataSource` — verified against the rc.1 sources).
  **Older versions are no longer declared compatible** — a dormant install does not
  count as compatibility; compatibility means the plugin's core features really work.
  If a DSH upgrade changes the contract above, this plugin may need a matching
  maintenance release (plugin maintenance, never source patches).
- **Declared host requirement**: `engines.dsh` = `>=0.1.7-rc.1` in `package.json`
  (**floor only, no ceiling** — since 2026-10-25; before that it was a closed range locked
  to verified host versions, and every DSH release required raising the ceiling and shipping,
  otherwise the 0.2.1+ host preflight skipped the bundle and the plugin silently disappeared
  for users who updated their desktop app). The plugin marketplace (dshmarket) still reads
  this field from the npm `latest` manifest to show the badge and to block updates that
  certainly cannot satisfy it (only hosts below 0.1.7-rc.1 are blocked now). **Since DSH 0.2.1
  the host enforces the field too** (the `app-boot` plugin-compatibility preflight): a
  floor-only range satisfies every future version, so the bundle always passes the preflight
  and loads; on unverified versions incompatibility is absorbed by **crash isolation** —
  failed probes → zero registration (FAIL OPEN); a crashed renderer → the official
  SlotErrorBoundary replaces that single slot entry with a placeholder; a failed activation →
  app-boot's per-entry containment and the host keeps booting; every host-notification
  callback (`ctx.on("slots/changed")` / `slots.onEntryError` / `slots.subscribe`) is wrapped
  in a try/catch guard so a throwing listener never escapes into the host dispatch. Contract
  audits continue after every DSH upgrade (the zh capability matrix is the evidence table of
  verified baselines) but no longer gate loading — adaptation went from "must ship a release"
  to "should re-verify".
- **Integration dependency list** (check against DSH upgrades; audited via a
  contract-by-contract diff of 0.1.7-rc.2 `787b746b80` ↔ 0.2.0-rc.2 `c1b47e41fc` ↔
  0.2.1-rc.2 `d1b9c04067` ↔ 0.2.1-rc.3 `1f81c047fc` ↔ 0.2.2-rc.1 `66491b05e3` ↔
  0.2.2-rc.2 `ddac96760b` ↔ 0.2.2-rc.3 `38a6a5c965`: the
  Public/stable contracts are unchanged across all seven releases; 0.2.1 only adds the
  `interrupted` stop semantics, group-tree placement, and the `engines.dsh` preflight; rc.3
  only bumps the version and the `engines.dsh` ceiling; 0.2.2 only adds the
  `conversation.chat.text-interaction` / `conversation.chat.user.before` slots, the
  package-asset route, and the `foldedReplies` setting, and removes
  `ChatNodeOwnerProps.fileMentions` / `compactAnswer` / `data-turn-process-answer` (none of
  which the plugin uses); 0.2.2-rc.2 further adds the `conversation.chat.markdown.fence`
  slot / `consumeOlder` / the `conversation.hero.frame` wrapper / composer paste routing /
  the `sessionHeader` menu and extends the ProcessActivity word list with `context`
  (all-Context groups; the plugin's suit map already covers it), and 0.2.2-rc.3 only bumps
  package.json versions — all either already consumed by the plugin or host-side behaviour):
  - **Cordis activation**: `exports.inject = ["slots"]` + `ctx.inject(["slots"], …)`
    (the client slots service and keyed-slot registration semantics; the official
    `boot-client` is unchanged);
  - **Public/stable**: the `conversation.chat.node` keyed slot (`turn-process` key +
    `TurnProcessOwnerProps` owner state); `TurnLocation` (start/end/status/steps), the
    step data store (`assistant-step` usage/timing) and the turn data store
    (`turn-tail` / `turn-process`) — all from the official `dsh-client-ui-chat` /
    `dsh-client-ui-conversation` contracts;
  - **Soft visual dependency**: `data-step-process-icon` / `data-step-process-chevron`
    / `data-process-activity` plus its `aria-expanded="true"` (step skin only: the first is
    the card render slot, the second is the official chevron the skin hides, the last two
    decide whether the expanded state fans out; failure = the skin disappears or degrades
    to the collapsed state, official icons and folding stay intact);
  - **Soft visual dependency (running state, dual contract)**: the official
    `TextShimmer`-rendered shimmer attribute (carried by the `ChatGroupSeat` title while
    `!data.closed`). The attribute name evolved across official versions — both are real
    official historical contracts (source evidence):
    - DSH 0.1.7 (release commit `787b746b807df83776957875683b8853c862ca2c`,
      `TextShimmer.tsx`: `data-text-shimmer={active || undefined}`) →
      `data-text-shimmer="true"`;
    - DSH 0.2.0+ (master, `TextShimmer.tsx`: `data-shimmer={active || undefined}`) →
      `data-shimmer="true"`.
    The plugin supports both: either one present → Running Step Poker animation
    (`:has()` matching swaps the card mask to the **five-face rotation SVG** —
    ♠ ♥ ♦ ♣ + the DeepSeek whale as five equal faces, one rotation every 0.8s, a 4s loop with
    dynamic knockout of the lower card; **upright while collapsed, and only the expanded state
    (the same button's `aria-expanded="true"`) rotates the whole animation around the icon
    centre by 35.5°**);
    both absent →
    completed two-state fallback (collapsed five-suit stack / expanded fan).
    **Used only to identify running steps for the poker rotation animation**; when the
    official turn/step closes the attribute disappears, the animation rule stops
    matching, and the card settles with zero JS. Whether or not the visual hooks
    fail, Step Fold / Tool / Think / Turn Fold and page stability are never affected;
  - **Soft style injection (non-ideal, recorded as-is)**: the plugin injects minimal
    `<style>` elements into `document.head` — base styles, the step skin, the per-group
    step-count overlay rules, the per-group completed-face assets (one element per
    `(count, topFace)` variant, written once), and the per-group step file-list rules
    (its own element, decoupled from the skin gate; the legacy Step layer adds one more).
    As of the
    current DSH master (21638c5631) there is no style-registration API for plain-JS
    client plugins (the only `createElement('style')` in the tree belongs to the web app
    itself), while the step skin must target the official DOM inside the official header
    and cannot live in the plugin's React subtree. Worst-case failure = missing turn-bar
    styling and no step skin; official folding is unaffected (each injection point catches its
    own errors — see the "style injection must not break plugin activation" test in
    `unit.compat.test.mjs`). The plugin will migrate once an official style extension point exists.
    With `iconStyle = native` the skin sheet and the per-group completed-face assets are **not
    generated at all** (only the empty element placeholder and the `disabled` gate remain);
    switching back to poker materializes them lazily.
- Behavior changes compared to the previous generation (≤0.5.x):
  - Step grouping/titles are fully returned to the official engine — the plugin-made
    "Ran N commands / Read … / Thought N times" segment titles, in-title file-link
    copying, `[ +N -M ]` line stats and the title cache are deleted (official title
    semantics apply);
  - The "pending/folded N steps" field is deleted (membership is official; the plugin no
    longer counts steps);
  - **The old +1/+11 fake growth is deleted** — the running token slot is now a
    **presentation-only visual counter** (the canonical real value and the display value are
    strictly layered, see "real data layer / display layer" above): it calibrates immediately
    when real usage arrives, and settle / history / reload show the official real value only;
  - **Zero runtime dependency on host client packages** — chevron / notifications are
    plugin-owned (official practices: do not require Harness Client packages at
    runtime); the settings panel renders inside the opening turn bar's own React tree
    (no body portal / standalone root); metrics subscribe via the official smallest
    slices (`useTurnData('turn-tail')` + `turnDataSource(turn, 'assistant-step')`)
    instead of the whole snapshot;
  - The "Turn-Fold" transcript mode and the shadowed official settings row are deleted —
    the four official modes keep working and plugin settings are pure UI enhancements;
  - The 0s placeholder moved from "right below the user message" onto the official
    `turn-process` node: it appears when the turn starts (the `turn/start` projection);
    the sub-second window between sending and `turn/start` is covered by the official
    "Deep diving..." status line;
  - Running TTFT first shows a **provisional visible-first-token latency** (official `data.time`
    − step/start; no render-time approximation, no estimation) and is overwritten by the
    **exact** value on settle; the exact value's stable source is the plugin's durable
    projection (still there after a reload / in historical sessions), with client timing and
    the in-page observation cache as ordered fallbacks — see "metric sources".
