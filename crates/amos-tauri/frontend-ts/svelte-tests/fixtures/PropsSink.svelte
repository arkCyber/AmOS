<script lang="ts">
  // Test fixture: a minimal CONTROLLED Svelte screen that consumes a propsBus
  // channel and emits a one-shot action back — used by SveltePropsHost.spec.
  import { propsChannel } from "../../src/svelte/propsBus";

  const bus = propsChannel<Record<string, unknown>>("sink");
  let val = $state<Record<string, unknown> | undefined>(undefined);
  $effect(() => {
    const un = bus.subscribe((v) => {
      if (v !== undefined) val = v;
    });
    return un;
  });
  const json = $derived(JSON.stringify(val));
</script>

<div data-testid="sink">{json}</div>
<button aria-label="ping" onclick={() => bus.emit("ping", "pong")}>ping</button>
