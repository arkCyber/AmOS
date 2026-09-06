# Svelte 5 pilot — React → Svelte migration scaffold

**Goal:** validate — inside this real repo, on the real toolchain — that a
Svelte 5 (compiled, runes, no virtual DOM) component can live in the existing
React/Tauri shell, reuse the existing pure logic, ship a smaller lazily-loaded
chunk, and be tested. The calculator is the pilot screen.

Status of this branch: **scaffold compiles, ships, and is fully tested.**

---

## Why this matters for the AmOS target

AmOS renders its System UI in a WebView (Tauri). On constrained/low-power
Android WebViews the virtual-DOM diff React pays for is pure overhead. Svelte 5
compiles reactivity away at build time → smaller JS, fewer bytes parsed on
startup, and targeted DOM updates instead of reconciliation. This pilot proves
the plumbing; the real payoff is measured per-app (bundle + frame budget) as
more screens migrate.

Two honest caveats baked into the plan:
1. The biggest lever for *very* low power is moving UI out of the WebView into
   the existing Rust/Tauri layer — Svelte is an *incremental* win on the UI we
   do keep in the WebView, not a replacement for that strategy.
2. `lib/` (60+ pure TS modules, thousands of lines) is framework-free and is
   **reused as-is**. Only the ~20k lines of `.tsx` + the `useStoreValue`-style
   hook layer are the migration surface.

---

## What was added

| Path | Role |
|---|---|
| `svelte.config.js` | Vite/Svelte config (runes are default in Svelte 5) |
| `vite.config.ts` | registers `@sveltejs/vite-plugin-svelte` alongside the React plugin |
| `tailwind.config.js` | `content` now includes `.svelte` so Tailwind generates Svelte classes |
| `src/types/svelte.d.ts` | ambient `*.svelte` module so `tsc` resolves `.svelte` imports |
| `src/svelte/CalculatorApp.svelte` | Svelte 5 port of the calculator (runes, React-free) |
| `src/svelte/i18n.ts` | framework-free i18n reusing the shared `zh`/`en` dicts (no React) |
| `src/components/SvelteCalculatorHost.tsx` | React host: `mount()`/`unmount()` the Svelte component, forward shell `t` |
| `src/apps.tsx` | `CalculatorEntry` gated swap (see below) |
| `vitest.config.ts` | separate runner for `.svelte` DOM tests |
| `svelte-tests/calculator.test.ts` | real DOM tests against the Svelte component |
| `package.json` | new devDeps + `typecheck:svelte`, `test:svelte` scripts |

New deps: `svelte`, `@sveltejs/vite-plugin-svelte`, `svelte-check`, `vitest`,
`@testing-library/svelte`.

---

## Architecture of the seam

```
apps.tsx  CalculatorEntry
   ├── PROD / localStorage opt-in  ─► SvelteCalculatorHost (dynamic import
   │                                  → mount CalculatorApp.svelte)
   └── otherwise (bun tests / vite dev) ─► Calculator (React, unchanged)
```

- The `.svelte` file is only ever loaded via a **dynamic `import()`** executed
  when the host renders. The 112 happy-dom tests run under **`bun`**, which has
  no `.svelte` loader — because they never reach the Svelte branch, they stay
  green and never touch the `.svelte` module graph.
- **Production build** (`vite build`, what Tauri ships to a device) picks the
  Svelte calculator — that's the A/B you validate on-device.
- **`vite dev`** defaults to React; preview Svelte by running
  `localStorage.setItem("amos.ui.svelteCalc", "1")` then reloading.
- i18n: the shell's live `t` is passed into the Svelte component as a prop, so
  it retranslates the moment the shell locale changes. Svelte files that run
  standalone fall back to `makeT()` against the shared `amos-ui.locale` store.

Two runners, cleanly separated:
- `bun` + happy-dom owns `src/__tests__/**` (the React suite; no `.svelte`).
- `vitest` owns `svelte-tests/**` (the `.svelte` DOM tests; vite-plugin-svelte
  compiles components). `vitest.config.ts` uses the official
  `@testing-library/svelte/vite` `svelteTesting()` plugin, which puts the
  `browser` export-condition ahead of `node` so Svelte resolves to its client
  build (otherwise Svelte 5 `mount` throws “not available on the server”).

---

## How to run / verify

From `crates/amos-tauri/frontend-ts`:

```bash
npm run test:svelte        # vitest: 5 .svelte DOM tests
npm run typecheck:svelte   # svelte-check: typechecks .svelte + whole src
npm run typecheck          # tsc --noEmit (repo-wide, includes new host/imports)
npm run build              # vite build → dist/ (Svelte calc becomes its own chunk)
node scripts/bun-iso-test.mjs test   # full 112-file bun suite (no regressions)
```

Production build output shows the Svelte calculator split into its own chunk:

```
dist/assets/index-*.js            ≈ 497 kB │ gzip 153 kB   (React shell, unchanged)
dist/assets/CalculatorApp-*.js    ≈  12.7 kB│ gzip 5.7 kB  (Svelte calc, lazy)
```

---

## ⚠️ Known issues / open items

1. **`bun.lock` is out of date.** The 4 devDeps (`@sveltejs/vite-plugin-svelte`,
   `svelte-check`, `vitest`, `@testing-library/svelte`) were installed with npm
   because `bun add` hung on registry resolution in this environment
   (network). `svelte` itself was added via bun. Run `bun install` once the
   network is stable to refresh `bun.lock` before committing, especially if CI
   uses `--frozen-lockfile`.
2. **`.svelte` tests need vitest**, so there are now two runners. That's the
   standard, lowest-risk way to compile `.svelte` for DOM tests given bun has no
   loader; it is isolated to `svelte-tests/` and `vitest.config.ts`.
3. **React body retained.** The React `Calculator` stays (as reference + bun-test
   path) until a later phase deletes it once the Svelte version is confirmed
   on-device.
4. **Bundle note:** the host statically imports `mount`/`unmount` from `svelte`,
   so a small Svelte runtime joins the main chunk today. A later optimization is
   to lazy-import the host too.

---

---

## Phase 2 — infrastructure layer + second screen (Weather)

Beyond the calculator pilot, this adds the reusable Svelte **infrastructure
layer** and migrates a second, store-driven screen.

New infra modules (`src/svelte/`):

| Module | Role |
|---|---|
| `locale.svelte.ts` | **Reactive i18n singleton** (runes). `t()`/`locale()` read a shared `$state`; components update in place when `setLocale()` is called. Reuses the pure helpers in `./i18n.ts`. |
| `locale-events.ts` | Plain (non-runes) shared event name. The React host can't import a runes `.svelte.ts` under `bun`, so it **broadcasts** the shell locale as a window event the singleton listens for. |
| `store.ts` | **`createStoreValue(key, fallback)`** — the Svelte counterpart of React's `useStoreValue`. A `svelte/store` `writable` that seeds from + subscribes to the shared amos.* store (same-window `STORE_CHANGED_EVENT`, cross-tab `storage`, Tauri `store-updated`). Exposes `save(v)`. |
| `theme.svelte.ts` | **Reactive theme singleton** (runes): `themeMode()`/`themeDark()`, `setThemeMode()`, `toggleTheme()`, OS-preference tracking — mirrors React's `useTheme`. |

Consolidation: the per-app `SvelteCalculatorHost` was replaced by a **generic
`src/components/SvelteAppHost.tsx`** that mounts any `.svelte` via a stable
loader and re-keys Svelte i18n on shell locale change (no remount / no state
loss). Both `calculator` and `weather` route through it behind the same PROD
gate (`svelteEnabled()`); React versions remain the bun-test path.

Second migrated screen — **Weather** (`src/svelte/WeatherApp.svelte`), the
smallest registered app (~106 React lines). It reuses `lib/weather.ts` (pure),
persists `amos.weather.cities`/`amos.weather.city` via `$state`+`$effect`
(parallels React's `useState`+`useEffect`), and reads the reactive `t`/`locale`.

Third migrated screen — **Contacts** (`src/svelte/ContactsApp.svelte`). This
consolidates the sample: it's a full store CRUD app (add/edit/fav/delete-confirm
+ search/sort/group) reusing `lib/contacts.ts`, and derives its "Frequent/Recent"
quick-dial chips from the shared call log via `createStoreValue` — a second real
consumer. The only backend-touching action (dial) calls the same `lib/backend`
functions the React app uses.

Fourth migrated screen — **Privacy/Permissions** (`src/svelte/PermissionsApp.svelte`).
A permissions dashboard whose ledger (`amos.permissions`) works fully offline via
`lib/permissions.ts`; the daemon "recent access" audit section only renders when
the bridge actually answers. Demonstrates locale-reactive label tables via
`$derived`.

Vite chunks now split the five apps + shared infra from the React shell
(`CalculatorApp` ≈4 kB, `WeatherApp` ≈3.8 kB, `PermissionsApp` ≈4.5 kB,
`ContactsApp` ≈8.4 kB, `locale.svelte` shared ≈9 kB, `store` shared ≈1.4 kB,
gzip). Main React bundle unchanged.

**Calculator history is now persisted** through the shared store via
`createStoreValue` — its first *real consumer* — so completed calculations
survive reopening (bridged into component state with an idiomatic `$effect` +
`subscribe`). This also hardened the infra: `store.ts` is exercised in production
code, not just unit tests.

Tests (`vitest`, in `svelte-tests/`), **74 passing across 22 files**:
- `calculator.test.ts` (7): keypad, keyboard, persisted history, in-place locale switch
- `clock.svelte.test.ts` (4): world cities, tab switch, stopwatch/timer initial, alarm add
- `clock-parity.test.ts` (2): **React ↔ Svelte dual-implementation** for clock
- `messages.svelte.test.ts` (3): seeded thread, send appends, clear → empty
- `messages-parity.test.ts` (1): **React ↔ Svelte dual-implementation** for messages (send)
- `music.svelte.test.ts` (3): seeded track/rows, play↔pause, next changes track
- `music-parity.test.ts` (2): **React ↔ Svelte dual-implementation** for music
- `notes.svelte.test.ts` (3): empty, add+expand+persist, archive→归档 tab
- `files.svelte.test.ts` (3): seed root, create folder, enter folder→empty
- `photos.svelte.test.ts` (3): seed grid, open viewer→delete, multi-select batch-delete
- `notes-parity.test.ts` (1): **React ↔ Svelte dual-implementation** for notes (add)
- `phone.svelte.test.ts` (3): keypad/backspace/clear, tab pages, offline dial→localized error
- `weather.svelte.test.ts` (5): incl. a live in-place language switch
- `calculator-parity.test.ts` (8): **React ↔ Svelte dual-implementation** for the calculator
- `weather-parity.test.ts` (2): **React ↔ Svelte dual-implementation** for weather
- `permissions-parity.test.ts` (2): **React ↔ Svelte dual-implementation** for the privacy ledger
- `contacts-parity.test.ts` (2): **React ↔ Svelte dual-implementation** for contacts (add/fav)
- `contacts.svelte.test.ts` (6): CRUD — empty/add/dup-guard/favorite/delete-confirm/search
- `permissions.svelte.test.ts` (3): offline ledger grant/revoke persistence
- `locale.svelte.test.ts` (3): reactive i18n persistence (setLocale → store + <html lang>)
- `store.test.ts` (5): seed/broadcast, key isolation, cross-tab `storage`,
  Tauri `store-updated`, unsubscribe teardown
- `theme.svelte.test.ts` (3)

> Testing note: happy-dom's `localStorage` is unreliable under vitest here, so
> `svelte-tests/setup-localstorage.ts` installs an in-memory `Storage` shim
> (reset before each test) — the real app's WebView localStorage is unaffected.

## Suggested next steps

- [ ] Refresh `bun.lock` (`bun install`) once network allows.
- [ ] A/B on a real Android device: bundle bytes + interaction frame rate,
      Svelte calculator vs React calculator.
- [ ] Port i18n/theme/stores to runes/`$derived` stores, then migrate the next
      screens (Clock, Settings panels) — small, dependency-free screens first.
- [ ] Once ≥2 screens are Svelte, delete the React counterparts + their bun DOM
      tests and move that coverage to vitest.
- [ ] Track bundle-gzip per app before/after to gate the migration with data.

