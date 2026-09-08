<script lang="ts">
  // TerminalApp.svelte — AmOS Terminal (offline-safe demo shell).
  //
  // HONESTY: AmOS has no real PTY by default (docs/terminal-design.md). This
  // screen runs a small built-in command set via the pure lib/terminal.ts (no
  // process is ever spawned) and clearly states that a real shell needs the
  // `terminal-pty` device build. When that backend ships, this screen swaps the
  // demo evaluator for the real term_* bridge.
  import { termBanner, runTermLine, pushHistory, PROMPT, type TermLine } from "../lib/terminal";
  import { t } from "./locale.svelte";

  let lines = $state<TermLine[]>(termBanner(t("terminal.demo")));
  let draft = $state("");
  let hist = $state<string[]>([]);
  let histIdx = $state(-1);

  const submit = () => {
    const r = runTermLine(draft, "AmOS Terminal (offline demo)");
    const base = r.clear ? [] : lines;
    lines = [...base, ...r.lines];
    hist = pushHistory(hist, draft);
    histIdx = -1;
    draft = "";
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hist.length === 0) return;
      histIdx = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
      draft = hist[histIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx < 0) return;
      histIdx += 1;
      draft = histIdx >= hist.length ? "" : hist[histIdx]!;
    }
  };

  const kindCls = (k: TermLine["kind"]): string =>
    k === "err"
      ? "text-danger"
      : k === "cmd"
        ? "text-accent"
        : k === "muted"
          ? "opacity-60"
          : "text-neutral-100 dark:text-white";
</script>

<div class="flex h-full flex-col bg-[#0c0c0e] text-[13px] leading-snug">
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 font-mono">
    {#each lines as ln (ln)}
      <p class={"whitespace-pre-wrap break-words " + kindCls(ln.kind)}>{ln.text}</p>
    {/each}
  </div>
  <div class="flex items-center gap-1 border-t border-white/10 px-3 py-2 font-mono">
    <span class="shrink-0 text-emerald-300">{PROMPT}</span>
    <input
      bind:value={draft}
      onkeydown={(e) => {
        onKey(e);
        if (e.key === "Enter") submit();
      }}
      placeholder={t("terminal.input")}
      aria-label={t("terminal.input")}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      class="min-w-0 flex-1 bg-transparent text-neutral-100 outline-none placeholder:opacity-40"
    />
  </div>
</div>
