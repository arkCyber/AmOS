<script lang="ts">
  // AppIcon.svelte — the Svelte twin of components/AppIcon.tsx.
  // Both paint the SAME pure model in src/lib/appIcon.ts (tone/face/SVG markup),
  // so the two renderers can never drift on colour or geometry.
  import type { Snippet } from "svelte";
  import { bespokeGlyphSvg, isBespokeTile, tileBackground } from "../lib/appIcon";

  let {
    id,
    icon = null,
    tileClassName = "h-14 w-14 rounded-[19px]",
    glyphClassName = "text-[2.5rem]",
    style = "",
    children,
  }: {
    id: string;
    icon?: string | null;
    tileClassName?: string;
    glyphClassName?: string;
    style?: string;
    children?: Snippet;
  } = $props();

  const bg = $derived(tileBackground(id));
  const bespoke = $derived(isBespokeTile(id));
  const markup = $derived(bespokeGlyphSvg(id));
</script>

<span
  class="relative grid select-none place-items-center overflow-hidden shadow-md ring-1 ring-black/10 transition-all duration-150 dark:ring-white/10 {tileClassName}"
  style={`background-image:${bg};${style}`}
>
  <span
    aria-hidden="true"
    class="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_60%_at_50%_-10%,rgba(255,255,255,0.3),transparent_55%)]"
  ></span>
  {#if bespoke && markup}
    <!-- Framework-agnostic SVG bytes produced by lib/appIcon.ts -->
    <span class="grid h-full w-full place-items-center">{@html markup}</span>
  {:else if icon}
    <span
      class="grid h-full w-full place-items-center leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.18)] {glyphClassName}"
    >{icon}</span>
  {:else if children}
    {@render children()}
  {/if}
</span>
