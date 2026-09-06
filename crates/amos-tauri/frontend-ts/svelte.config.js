// Svelte 5 config — consumed by both vite-plugin-svelte (build/dev) and
// svelte-check (typecheck). Runes mode is the default in Svelte 5, so no
// compilerOptions are required. `preprocess` intentionally omitted: Svelte 5
// compiles TypeScript in `<script lang="ts">` natively and these components
// use no scoped <style> (all styling is global Tailwind from index.css).
export default {};
