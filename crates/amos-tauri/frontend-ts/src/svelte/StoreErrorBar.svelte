<script lang="ts">
  // StoreErrorBar.svelte — the shared, honest line for "the store refused this write".
  //
  // Content screens write through `writeStoreValueChecked` and must not apply a change
  // the store rejected (it would show data that vanishes on reload). This renders the
  // one message they set in that case, so every screen reports it the same way and the
  // tests can target a single testid. `message === ""` renders nothing.
  let { message }: { message: string } = $props();
</script>

{#if message}
  <p
    role="status"
    data-testid="store-write-error"
    class="mb-2 shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-[11px] text-danger dark:bg-white/10"
  >
    {message}
  </p>
{/if}
