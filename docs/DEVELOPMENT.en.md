# Tests and release (engineering appendix)

> Engineering appendix to the [README](../README.en.md): test-suite index, CI and release flow.

## Tests

```sh
npm install        # first run: installs jsdom / react / react-dom (devDependencies)
npm test           # node --test over tests/
npm run check      # syntax check client.js / index.js
```

The suite loads the real `client.js` (via `__ModuleLoader__` injection + `__test`
exports — no copy-paste drift). The table below is a **curated** view by capability, not an
exhaustive inventory — see the `tests/` directory for the full list:

| File | Coverage |
| --- | --- |
| `unit.logic.test.mjs` | Metric pure functions: `turnClockOf` / `computeTurnMetrics` / `readStepUsage` (official TurnLocation / step usage / turn-tail aggregate), formatting, field visibility + localStorage persistence; identical inputs produce byte-identical outputs (no fake growth) |
| `unit.turn-renderer.test.mjs` | Turn renderer: `open=false → click → setOpen(true)`, `open=true → click → setOpen(false)`; `foldable=false`/aborted/error → static bar with no setOpen path; Running Bar appears at 0s, non-interactive, touches no fold state; smooth handover on turn close; degraded rendering without `turnProcess` |
| `unit.poker.test.mjs` | Activity→suit mapping (full official ProcessActivity vocabulary), stack/fan/flip SVG generation, **running flip axis = vertical diagonal axis (axis angle = `atan(w/h)` + geometry/origin checks + a CSS-override regression guard)**, component rendering, reduced-motion and no-WAAPI static fallback |
| `unit.css.test.mjs` | Step skin gate (`applyIconStyle()` flipping `disabled` on the two style sheets) + official DOM hook rules; **flat-rotation contract (the tilt only exists when expanded: collapsed = upright, expanded = 35.5°, driven by the official `aria-expanded`; the two assets differ only by the outermost `<g class="tf-step-flat-rotation">` wrapper; the `tf-step-flat-rotation` group wrapping every phase, angle taken verbatim from `pokerSpin.restAngle` and asserted to round to the design literal 35.5, five phases / 72 animateTransform / 15 animate / `0.8s`×82 / `4s`×5 untouched, ±3.1° planar tilt, four knockout masks, poker 5:7 card)**; **architecture guard: the old engine's `:has()` hiding rules must be gone** |
| `unit.gear.test.mjs` | Settings popup: field checkboxes, persistence, icon style / step skin selectors (hooks-order guard); **the "poker" preview row rotating one face per second (pure shift + the real shared 1s clock + unsubscribe on close)** |
| `unit.compat.test.mjs` | **Registration audit: only `turn-process` is shadowed**, `exports.inject=['slots']`, priority-conflict yielding, soft degradation of registration errors; **architecture guard: zero old-engine identifiers / official-renderer delegation plumbing / transcriptView writes (comment-stripped, scanning both `client.js` and `index.js`); the plugin has zero scroll permission (0 `.scrollTop` writes, no `scrollIntoView`/`scrollTo`/`overflow-anchor`, no `data-chat-following-tail` read, no `data-conversation-scroll` sweep, no DOM observers at all); style-injection failure must not break plugin activation (a throwing appendChild still registers)**; rendering compatibility across the four official transcript modes |
| `unit.step-cards.test.mjs` | Step card-count bridge: official `counts` summation → 3/5 cards, morph identity continuity, per-group mask geometry, whole bridge chain (groupSource subscription, same-domain rule revocation/restoration, leader unmount cleanup); **step file list: path extraction (settled/running/preparing/truncated/directory-tool/escaped), basename de-dup + `+N` folding, session-scope branches, running-state output, refresh on argument change, empty fallback without ChatNodeStore** |
| `unit.step-session-scope.test.mjs` | Session scoping: selector prefix and escaping, bare-session branch regression lock, same-groupKey two-tree isolation, tree-only multi-session safe degradation (session-specific rules withdrawn, restored without a refresh, completedFaceSets retained, running rotation unaffected) |
| `unit.docs.test.mjs` | **zh/en docs pairing guard (README + docs/ appendices)**: language-neutral facts (ranges / identifiers / commits / selectors / storage keys) identical on both sides; paired statements for the parallel sections (the six style injections, running-metric semantics, the known-issue section) present on both sides; the style-injection list length == the actual number of injections in `client.js` (change one side and forget the other → red); `NOTICE_VERSION` == `package.json`'s `version` (forget it at release time → red); README size cap (engineering detail stays in docs/) |
| `unit.host-compat.test.mjs` | Cross-version capability matrix (three-state semantics, UNKNOWN ≠ LEGACY), registration gating (modern host never activates legacy; legacy host records Turns only), full-host selector generation per branch + jsdom two-tree matching, runtime resolution, metrics/fold decoupling, two-line diagnostics |
| `regression.test.mjs` | Historical regressions: live-clock orphan timer, **no fake token growth (unchanged data → unchanged digits)**, gear stopPropagation, degradation requirements (corrupt icon pack/settings fall back to defaults) |

> `--test-isolation=none` (built into `npm test`) is required on Windows sandboxes where
> spawning child processes is not allowed; plain Linux/macOS CI can use it too.
> **Node versions**: the plugin's runtime (`engines.node`) follows DSH itself =
> `^22.19.0 || >=24.0.0`; **running the tests** additionally needs jsdom 30 from
> devDependencies, which requires `^22.22.2 || ^24.15.0 || >=26` — CI pins Node 24. A
> mismatched Node only produces an EBADENGINE warning on `npm install`; it does not affect
> loading the plugin inside DSH.


## CI & release

GitHub Actions runs syntax checks, the icon-source drift check, the full `npm test` suite
and an `npm pack --dry-run` package-content assertion on every PR / push to `main` or
`better`; pushing a `v*` tag publishes to npm (OIDC Trusted Publishing) and creates a
GitHub Release. The same
source is also published under the **legacy package name** `dsh-turn-fold` (existing
installs update through that name), so **both names** must have Trusted Publishing
configured against this repository's release workflow.

**Release approval gate (recommended)**: the publish job is bound to the `npm-publish`
environment. Once you add required reviewers to that environment (repo Settings →
Environments), **any `v*` tag push must be approved by a human before it actually
publishes** — the tag push itself is the trigger, there is no second confirmation
otherwise. This machine has no npm unpublish permission, so a wrong version can only be
fixed by the user in the npm UI; this gate is the only pre-publish brake. Without
configured reviewers the environment adds no protection (behaviour unchanged).

```sh
npm version patch    # or minor / major: bumps the version and tags v*
# manually set client.js's NOTICE_VERSION to the same version (a test guards it)
git push --follow-tags
```

> `NOTICE_VERSION` (the baseline for an icon pack's `meta.compat`) must be byte-identical
> to `package.json`'s `version`; forgetting it turns the Release test step red.

