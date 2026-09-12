# amos-ui-ts — Amos System UI

The production System UI: **bun + Vite + Svelte 5 (runes) + TypeScript + Tailwind**.
React was removed (`../docs/react-removal-plan.md`); every built-in screen is a
Svelte component and the shell mounts them directly — there is no React fallback.

- Entry: `index.html → src/shell-entry.ts → mount(Shell.svelte)`.
- Multi-window behaviour is documented in `../docs/multi-window.md`.

## Layout

```
frontend-ts/
├── index.html
├── vite.config.ts / vitest.config.ts / svelte.config.js
├── tailwind.config.js / postcss.config.js
├── scripts/            # unwired/i18n scans, coverage + smoke runners
├── svelte-tests/       # Svelte DOM tests (vitest)
└── src/
    ├── shell-entry.ts  # boot: hydrate shared store → apply OS chrome → mount(Shell)
    ├── index.css
    ├── i18n/           # locales/{zh,en}.ts + typed t()
    ├── lib/            # pure domain modules + Tauri backend bridges
    ├── svelte/         # Shell.svelte, app screens, system panels, appRegistry.ts
    ├── types/          # ambient d.ts for the Svelte/runes build
    └── __tests__/      # pure + DOM tests (bun, via scripts/bun-iso-test.mjs)
```

## Shared state

Settings / notifications / home layout live in the shared `amos.*` store. Writes go
through `src/lib/amosStore.writeStoreValue` → `src/lib/backend.systemStoreSet`
(`store_set`) to the Rust `SharedStore`; boot pulls the durable copy back with
`hydrateFromSystemStore()` (`store_snapshot`), and `src/svelte/store.ts`
`createStoreValue` subscribes to the `store-updated` event. See
`../docs/multi-window.md` §5.

## Commands (run from this directory)

```bash
bun install              # first time (Vite, Svelte 5, Tailwind, vitest…)
bun run dev              # http://localhost:1420 (matches the Tauri devUrl)
bun run build            # vite build → dist/
bun run test             # pure + DOM tests (bun)
bun run test:svelte      # Svelte DOM tests (vitest, svelte-tests/)
bun run typecheck        # tsc --noEmit
bun run typecheck:svelte # svelte-check
bun run check            # test + typecheck + typecheck:svelte + test:svelte + scans
bun run coverage:gate    # src/lib line coverage ≥ threshold (scripts/lib-coverage-gate.mjs)
bun run smoke:ui         # build + preview + headless Chrome home-render smoke
```

## Migration history

The React → Svelte migration is complete and React is gone from the production
build (`../docs/react-removal-plan.md`); there are no `*-parity.test.ts` dual-
implementation suites left. Historical records: `SVELTE5_PILOT.md`,
`DOCK_MIGRATION_ROADMAP.md`, `SVELTE_MIGRATION_AUDIT.md`,
`SVELTE_MIGRATION_DATA.md` (bundle-size data).

Screens reuse the shared pure libs (`lib/*.ts`), the persisted store (`store.ts`)
and the reactive i18n / theme singletons (`locale.svelte.ts` /
`theme.svelte.ts`); `appRegistry.ts` is the single id → screen table.

## Notes

- **AI / 同传(interpreter)** need a local daemon (`AMOS_BACKEND=… amos-ai` + the
  translate stack) when running inside Tauri; without it those screens show a
  localized "daemon not connected" fallback. Everything else works standalone via
  `bun run dev`.
- The Tauri config already points at this package (`build.devUrl` → `:1420`,
  `build.frontendDist` → `../frontend-ts/dist`); there is no legacy vanilla UI to
  switch back to.
