# amos-ui-ts (migration target)

Next-generation System UI: **Vite + React + TypeScript + Tailwind CSS**.
A staged migration that **replaces** `../frontend` (vanilla JS) module-by-module —
nothing here is wired into the running Tauri app yet (the old UI keeps working
until feature parity, then `tauri.conf.json` is repointed to this package).

## What exists now (stage 1 + 2)

- **System requirements (first-class, tested):**
  - Light / dark **theme** with `light | dark | auto` (auto = follow OS via
    `prefers-color-scheme`; Tailwind `darkMode: "class"`), persisted + bridgeable
    to the legacy shared store (`window.Amos`).
  - **i18n (zh/en)** dictionaries with typed keys, `{param}` interpolation, and a
    `useI18n()` hook; locale persisted + sets `<html lang>`.
- A tiny demo `App` proving both (appearance + language segmented controls and a
  home/dock grid whose labels localize), to be replaced by the real launcher.

## Layout

```
frontend-ts/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js     # darkMode:'class', content=./src
├── postcss.config.js
└── src/
    ├── main.tsx           # mounts <App/> (+ optional window.Amos bridge typing)
    ├── App.tsx            # demo shell (theme + i18n toggles, home/dock sample)
    ├── index.css          # @tailwind directives
    ├── theme/             # ThemeProvider/useTheme + pure resolveDark/applyDarkClass
    ├── i18n/              # I18nProvider/useI18n + locales/zh.ts en.ts + types
    ├── components/Segmented.tsx
    └── __tests__/         # vitest unit tests (theme, i18n)
```

## Commands (run from this directory; requires network once)

```bash
npm install          # first time (react, vite, typescript, tailwind, vitest…)
npm run dev          # http://localhost:1420 (matches Tauri devUrl convention)
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # vite build → dist/
```

## Wires to Tauri (do AFTER feature parity)

In `crates/amos-tauri/tauri.conf.json` point the shell at this package and add
`devUrl`/`frontendDist`:

- `build.devUrl` → `http://localhost:1420`
- `build.frontendDist` → `../frontend-ts/dist`
- dev server: `npm run dev` (port 1420) before `cargo tauri dev`.

## Run in Tauri (reversible)

The new UI is **not** wired by default (the legacy vanilla UI keeps working). To
preview the TS shell inside the Tauri window and switch back later:

```bash
# point Tauri at this package, and build it
cd crates/amos-tauri && ./switch-frontend.sh ts     # frontendDist -> frontend-ts/dist, devUrl -> :1420
cd ../amos-tauri/frontend-ts && bun run build       # produce dist/
cd .. && cargo run -p amos-tauri                    # or: cargo tauri dev

# revert to the legacy UI whenever needed
cd crates/amos-tauri && ./switch-frontend.sh legacy
```

> Real chat/translation for **AI** and **同传(interpreter)** requires the TS shell
> running inside Tauri **and** a local daemon (`AMOS_BACKEND=ggml/ollama … amos-ai`,
> translate stack). Without it those two apps show a localized "daemon not
> connected" fallback. Everything else (14 apps + lock/recents/spotlight, light/dark,
> zh/en) works standalone via `bun run dev`.

## Status (as of last update)
- Apps ported: clock, settings, calculator, weather, notes, photos, files,
  messages, phone, music, maps, camera, ai, interpreter (14/14 slots).
- System: theme (light|dark|auto), i18n (zh/en), lock, Recents, Spotlight, Home/Dock,
  shared `amos.*` store bridge, SSR mount smoke.
- Test/build: `bun test`, `bun run typecheck`, `bun run build`.

## Next steps

1. Port the core shell (router / home / dock / lock / recents / Spotlight) as
   React components consuming the same `amos.*` shared-store keys.
2. Move app-localization strings into `locales/` as each app is ported.
3. Port apps one-by-one, replacing the vanilla copy after each lands; retire
   `../frontend` last.
