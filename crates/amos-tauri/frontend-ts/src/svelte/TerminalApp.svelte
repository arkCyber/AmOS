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
    capLines,
    PROMPT,
    type TermLine,
  } from "../lib/terminal";
  import { parseAnsi, decodeOutput } from "../lib/ansi";
  import { termSpawn, termWrite, termRead, termKill, termResize } from "../lib/backend";
  import { t } from "./locale.svelte";
  import { onDestroy } from "svelte";
  import { ptySizeFor } from "../lib/terminal";

  let lines = $state<TermLine[]>(termBanner(t("terminal.demo")));
  let draft = $state("");
  let hist = $state<string[]>([]);
  let histIdx = $state(-1);
  let scroller: HTMLDivElement | null = $state(null);
  let cmdInput: HTMLInputElement | null = $state(null);

  // Every transcript write goes through the scrollback cap so a long-running
  // (live) session never grows the DOM without bound.
  const setLines = (next: TermLine[]) => {
    lines = capLines(next);
  };
  const appendLines = (add: TermLine[]) => {
    lines = capLines([...lines, ...add]);
  };

  // ---- PTY window size ----
  // `term_spawn` starts the session at a fixed 120×24; without telling the shell
  // the real grid, wrapping and full-screen programs (vim/htop) draw for the wrong
  // width. Measure one character cell in the scroller's own font, convert the
  // content box to cols/rows, and push it with `term_resize` on attach + on every
  // container resize. Unmeasurable geometry is skipped (host default left alone).
  let lastSize = { cols: 0, rows: 0 };

  function charMetrics(el: HTMLElement): { w: number; h: number } | null {
    try {
      const cs = getComputedStyle(el);
      const probe = document.createElement("pre");
      probe.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;";
      probe.style.font = cs.font;
      probe.style.lineHeight = cs.lineHeight;
      probe.textContent = "M".repeat(100);
      el.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      el.removeChild(probe);
      const w = rect.width / 100;
      const h = rect.height;
      return w > 0 && h > 0 ? { w, h } : null;
    } catch {
      return null;
    }
  }

  async function syncPtySize(): Promise<void> {
    if (!live || sess <= 0 || !scroller) return;
    const cell = charMetrics(scroller);
    if (!cell) return;
    let boxPadX = 0;
    let boxPadY = 0;
    try {
      const cs = getComputedStyle(scroller);
      boxPadX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      boxPadY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch {
      /* unmeasurable padding → treat as 0 */
    }
    const size = ptySizeFor({
      width: scroller.clientWidth - boxPadX,
      height: scroller.clientHeight - boxPadY,
      charW: cell.w,
      charH: cell.h,
    });
    if (!size || (size.cols === lastSize.cols && size.rows === lastSize.rows)) return;
    lastSize = size;
    try {
      await termResize(sess, size.cols, size.rows);
    } catch {
      /* offline / feature off — the session keeps its default grid */
    }
  }

  // Live (real-PTY) session state.
  let live = $state(false);
  let sess = $state(0);
  /** Watches the terminal box so a real session tracks the actual grid size. */
  let ro: ResizeObserver | null = null;

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
          appendLines([{ text: "(real PTY shell attached)", kind: "muted" }]);
          // Tell the shell how big the terminal actually is (spawn used 120×24).
          void syncPtySize();
          if (typeof ResizeObserver !== "undefined" && scroller) {
            ro = new ResizeObserver(() => void syncPtySize());
            ro.observe(scroller);
          }
        }
      })
      .catch(() => {
        /* stay in the offline demo */
      });
  });

  // Leave cleanly: kill the PTY session when the app unmounts (no orphan child).
  onDestroy(() => {
    ro?.disconnect();
    ro = null;
    if (live && sess > 0) {
      void termKill(sess).catch(() => {});
    }
  });

  // Live poller: pull output, decode it (CR/LF / backspace / clear / SGR).
  $effect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void (async () => {
        const r = await termRead(sess, 4096).catch(() => null);
        if (!r || r.output == null) return;
        const d = decodeOutput(r.output);
        if (d.clear) setLines([]);
        if (d.lines.length > 0) {
          appendLines(d.lines.map((text) => ({ text, kind: "out" as const })));
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
        appendLines([{ text: `${PROMPT} ${draft}`, kind: "cmd" as const }]);
      } else {
        appendLines([{ text: PROMPT, kind: "cmd" as const }]);
      }
      pushDraftHistoryOnly();
      draft = "";
      return;
    }
    // offline demo path
    const r = runTermLine(draft, "AmOS Terminal (offline demo)");
    const base = r.clear ? [] : lines;
    const prompt = draft.trim() === "" ? [{ text: PROMPT, kind: "cmd" as const }] : [];
    setLines([...base, ...prompt, ...r.lines]);
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

