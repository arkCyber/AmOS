# React → Svelte subtraction plan (System UI)

Status: **in progress** (2026-09-09). Goal: the System UI is **Svelte-only** at
runtime already (`index.html → src/shell-entry.ts → Shell.svelte`); React is
**retired residual source + its own DOM tests**. This doc is the safe, stepwise
plan to actually delete React without breaking tests or the `make cov` (≥90% on
`src/lib/**`) gate.

## Verified facts
- Runtime graph (`.svelte` + `src/lib` non-test + `src/index.css`) does **not**
  import `react`/`react-dom`/`App`/`components`/`apps` — except the **React-hook
  files inside `src/lib`** (below).
- React lives in: React host, React components, React-hook libs, `apps.tsx`
  (re-exports `lib/appMeta` + React `COMPONENTS`), `i18n/index.tsx` &
  `theme/index.tsx` providers, and ~25 `src/__tests__/*.test.tsx`.

## Delete set (grouped)
- **A — React host**: `src/main.tsx`, `src/App.tsx`.
- **B — React components**: `src/components/*.tsx` (incl. `SvelteAppHost`/
  `SveltePropsHost` which host Svelte leaves inside the React shell).
- **C — React-hook libs under `src/lib`**: `useOutgoingCalls.ts`,
  `useWindowLayout.ts`, `useOnline.ts`, `useStoreValue.ts`, `useFocusTrap.ts`,
  `useNotificationAlert.ts`, `keepAwake.ts` (React hooks `useScreenHold`/
  `useCallKeepAwake`). `keepAwake.ts` also holds a **pure reason bus**
  (`screenHeld`/`heldReasons`/`assertHold`/`releaseHold`/`clearAllHolds`) that
  should be kept as non-React `lib/keepAwakeCore.ts` (+ `.test.ts`) if any
  Svelte consumer needs it.
- **D — React sources**: `apps.tsx` (React `COMPONENTS`/`AppComponent`/
  `svelteEnabled`), `i18n/index.tsx`, `theme/index.tsx`.
- **E — React tests**: all `src/__tests__/*.test.tsx` that mount React host /
  components / hooks. Shared-pure-logic cases must first move to `.test.ts`
  (e.g. `cameraCapture`, `keepAwake`, store normalize).
- **F — deps/config**: `react@^18`, `react-dom`, `@types/react`,
  `@testing-library/react` (+ react-is), `@vitejs/plugin-react`, and the
  `react()` plugin in `vite.config.*`.

## Blockers to resolve before/while deleting
1. **`core.test.ts` imported React `../apps`** → **DONE**: now imports
   `lib/appMeta` (`APP_META as APPS`); 9 tests green, no React in graph.
2. **`make cov` ≥90% on `src/lib`**: deleting C + their `.test.tsx` shifts the
   denominator. Preserve real pure logic as non-React `lib` + `.test.ts` first
   (keep-awake reason bus; store normalize currently in `useStoreValue.ts`).
3. Confirm **no Svelte/leaf consumer** of `lib/keepAwake`/`useStoreValue`
   (Svelte uses runes; display keep-awake may need a Svelte adapter over a kept
   pure core).
4. After E deletion, ensure every deleted shared-pure case still has a Svelte /
   `.test.ts` equivalent (camera capture, focus-trap, online, keep-awake, …).

## ⚠️ Correction (2026-09-09, discovered by a reverted Step-3 attempt)
`src/i18n/index.tsx` and `src/theme/index.tsx` are **NOT pure React providers**:
they export pure logic consumed by pure tests — `i18n/index.tsx` exports
`translate` (`i18n.test.ts`, `telemetrySpy.test.ts`); `theme/index.tsx` exports
`applyDarkClass`/`isThemeMode`/`resolveDark` (`theme.test.ts`). Therefore they
cannot be deleted in Step 3; first **extract these pure helpers into a non-React
core** (aligning with the Svelte `svelte/i18n.ts` theme core), point the `.test.ts`
at that core, then `index.tsx` becomes provider-only and deletable with React.


## Order (each step ends with `bun run check` + `make cov` + `vite build`)
1. Migrate `core.test.ts` → `appMeta` ✅; add/confirm pure `.test.ts`
   equivalents for shared logic in React tests.
2. ✅ Extracted `lib/keepAwakeCore.ts` (React-free reason bus) +
   `__tests__/keepAwakeCore.test.ts` (4); legacy `keepAwake.ts` now delegates
   (single source — React `keepAwake.test.tsx` stays green). Audited
   `useStoreValue.ts` = thin React adapter over `amosStore` (no standalone pure
   logic; Svelte already reads `amosStore` directly) — nothing further to extract.
3. Delete A, B, D (React host/components/`apps.tsx`/`i18n`/`theme` providers).
4. Delete C React-hook libs + E React tests.
5. Remove F deps + vite `react()`; final `bun run dev` = Svelte shell.

## Integrity rules
- Never delete while a non-React test/file still imports it (grep first).
- Keep `make cov` ≥90% on `src/lib`; keep `svelte-check` 0/0; keep `bun run
  check` green after every step.
- Pure logic stays pure; React-specific UI (hooks/components) is deleted, not
  "ported" unless Svelte truly needs it.

## ⚠️ Step-3 is an ATOMIC deletion (no independent deletions exist)
React self-references form a closed set: `src/i18n/index.tsx` is imported by
React `apps.tsx`/`App.tsx`; `src/theme/index.tsx` by `App.tsx`; `components/` by
`App.tsx` + their tests. Therefore there is **no zero-risk single-file deletion**
among the React sources until the whole set goes together. Step 3 must delete
**A (host) + B (components) + D (apps/i18n/theme providers) + E (the React
`.tsx` tests that render them)** in **one coordinated change**, then gate with
`bun run check` + `make cov` + `vite build`. Audit (2026-09-09): the 16 orphaned
`.tsx` tests import React host/components but **none import pure `src/lib`** —
safe to remove without losing shared pure logic.

