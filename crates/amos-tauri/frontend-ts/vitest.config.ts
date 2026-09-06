import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

/**
 * Vitest config for the SVELTE component suite only.
 *
 * The rest of the repo tests run under `bun` + happy-dom (scripts/bun-iso-test.mjs,
 * scanning only `src/__tests__`), which has no `.svelte` loader. So `.svelte`
 * DOM tests live in their own top-level `svelte-tests/` directory (outside the
 * bun scan) and run here with vite-plugin-svelte compiling the components.
 */
export default defineConfig({
  plugins: [
    svelte(),
    // Pushes `browser` ahead of `node` in resolve.conditions so Svelte resolves
    // to its client build (not the SSR build) under vitest's Node-like loader —
    // otherwise Svelte 5 `mount` throws "not available on the server". It also
    // wires up automatic DOM cleanup between tests.
    svelteTesting(),
  ],
  test: {
    environment: "happy-dom",
    setupFiles: ["./svelte-tests/setup-localstorage.ts"],
    include: ["svelte-tests/**/*.test.ts"],
    exclude: ["node_modules/**", "src/__tests__/**"],
    // A handful of React↔Svelte parity DOM tests mount + settle on a per-test
    // `setTimeout`; under heavy parallel CI load these can rarely trip a timing
    // window even though every case passes deterministically in isolation. A
    // single retry keeps the aggregate gate green without masking real failures
    // (each case is otherwise stable).
    retry: 1,
  },
});
