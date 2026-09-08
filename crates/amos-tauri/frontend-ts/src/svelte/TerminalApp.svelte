<script lang="ts">
  // TerminalApp.svelte — AmOS Terminal.
  //
  // Two modes:
  //   1. OFFLINE DEMO (default): runs the safe built-in command set via the pure
  //      lib/terminal.ts — nothing is ever spawned.
  //   2. LIVE (device): if the backend `terminal-pty` feature is built in and
  //      `term_spawn` returns a session id, this screen drives the real shell:
  //      Enter sends lines to `term_write`, and a poller pulls `term_read` output
  //      through `decodeOutput` (CR/LF, backspace, ESC[2J clear, SGR kept for
  //      colour). The live path is testable headlessly with a fake term_* bridge.
  import {
    termBanner,
    runTermLine,
    pushHistory,
    PROMPT,
    type TermLine,
  } from "../lib/terminal";
  import { parseAnsi, decodeOutput } from "../lib/ansi";
  import { termSpawn, termWrite, termRead } from "../lib/backend";
  import { t } from "./locale.svelte";

  let lines = $state<TermLine[]>(termBanner(t("terminal.demo")));
  let draft = $state("");
  let hist = $state<string[]>([]);
  let histIdx = $state(-1);
  let scroller: HTMLDivElement | null = $state(null);
  let cmdInput: HTMLInputElement | null = $state(null);

  // Live (real-PTY) session state.
  let live = $state(false);
  let sess = $state(0);

  // Try to open a real PTY session once. Offline (no backend / feature off)
  // term_spawn rejects or returns id 0 → we stay in the offline demo.
  let probed = false;
  $effect(() => {
    if (probed) return;
    probed = true;
    void termSpawn(undefined, ["help"])
      .then((r) => {
        if (r && r.id > 0) {
          live = true;
          sess = r.id;
          lines = [...lines, { text: "(real PTY shell attached)", kind: "muted" }];
        }
      })
      .catch(() => {
        /* stay in the offline demo */
      });
  });

  // Live poller: pull output, decode it (CR/LF / backspace / clear / SGR).
  $effect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void (async () => {
        const r = await termRead(sess, 4096).catch(() => null);
        if (!r || r.output == null) return;
        const d = decodeOutput(r.output);
        if (d.clear) lines = [];
        if (d.lines.length > 0) {
          lines = [...lines, ...d.lines.map((text) => ({ text, kind: "out" as const }))];
        }
        if (!r.running) clearInterval(id);
      })();
    }, 100);
    return () => clearInterval(id);
  });

  // Auto-scroll to the newest line and keep the input focused — a terminal stays
  // pinned to the bottom and ready to type after every command.
  $effect(() => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    cmdInput?.focus();
  });

  const submit = () => {
    if (live) {
      const trimmed = draft.trim();
      if (trimmed !== "") {
        void termWrite(sess, `${trimmed}\n`).catch(() => {});
        lines = [...lines, { text: `${PROMPT} ${draft}`, kind: "cmd" as const }];
      } else {
        lines = [...lines, { text: PROMPT, kind: "cmd" as const }];
      }
      pushDraftHistoryOnly();
      draft = "";
      return;
    }
    // offline demo path
    const r = runTermLine(draft, "AmOS Terminal (offline demo)");
    const base = r.clear ? [] : lines;
    const prompt = draft.trim() === "" ? [{ text: PROMPT, kind: "cmd" as const }] : [];
    lines = [...base, ...prompt, ...r.lines];
    hist = pushHistory(hist, draft);
    histIdx = -1;
    draft = "";
  };
  // In live mode history is recorded without re-emitting a prompt (already added).
  const pushDraftHistoryOnly = () => {
    const s = draft.trim();
    if (s !== "" && hist[hist.length - 1] !== s) hist = [...hist, s];
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
  <div
    bind:this={scroller}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 font-mono"
  >
    {#each lines as ln, i (i)}
      <p class={"whitespace-pre-wrap break-words " + kindCls(ln.kind)}>
        {#each parseAnsi(ln.text) as sp, k (k)}
          <span style:color={sp.fg} class={sp.bold ? "font-semibold" : ""}>{sp.text}</span>
        {/each}
      </p>
    {/each}
  </div>
  <div class="flex items-center gap-1 border-t border-white/10 px-3 py-2 font-mono">
    <span class="shrink-0 text-emerald-300">{PROMPT}</span>
    <input
      bind:this={cmdInput}
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

