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
    termRefused,
    termRefusalReason,
    type TermLine,
  } from "../lib/terminal";
  import { parseAnsi, decodeOutput } from "../lib/ansi";
  import { termSpawn, termWrite, termRead, termKill, termResize } from "../lib/backend";
  import { amosWarn } from "../lib/debugLog";
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
    // `lastSize` is the dedup key above, so it must record the size the **session
    // actually took**, not the one we asked for: assigning it first meant a refused
    // resize was remembered as applied, and the session stayed on its old grid while the
    // box drew a new one. The observer only calls back on a real layout change, so this
    // is the next keyboard/rotation/app-switch — narrow, but it is the retry the session
    // has.
    //
    // A refusal is **not** `null`: `term_resize` answers `TermOut` (not `Result`), so the
    // reason arrives in the reply with `id: 0` and `running: false` — `invoke` reports the
    // call as ok. `if (reply)` therefore tested a value that is an object on every path
    // and could never be false; `termRefused` is the predicate that reads the channel the
    // host actually uses.
    const reply = await termResize(sess, size.cols, size.rows);
    if (!termRefused(reply)) lastSize = size;
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
      // "No orphan" is a claim the reply has to confirm: `term_kill` answers `TermOut`,
      // so a kill the host refused still looks like a successful call (see `termRefused`),
      // and the `catch` that used to sit here could never run at all. There is no window
      // left to draw in, so the ledger gets the breadcrumb — the child outliving the app
      // is exactly the kind of thing only a log can tell you about.
      void termKill(sess).then((r) => {
        if (termRefused(r) || (r !== null && r.running)) {
          amosWarn("terminal", "term_kill did not confirm the session ended", {
            session: sess,
            reason: termRefusalReason(r),
            running: r === null ? null : r.running,
          });
        }
      });
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
      const shown = draft;
      pushDraftHistoryOnly();
      draft = "";
      if (trimmed === "") {
        appendLines([{ text: PROMPT, kind: "cmd" as const }]);
        return;
      }
      // The reply is the **only** verdict this call has: `term_write` answers `TermOut`, so
      // a refusal is a perfectly successful bridge call whose `error` carries the reason and
      // whose `id` is 0 (`invoke` never folds that to `null`, REQ-A296). The `.catch()` that
      // guarded this line could therefore never run — the command cannot throw — and the
      // reply was discarded along with it, so the screen drew `$ mycommand` as an **entered**
      // command for a write the session never took, and the user waited for output that could
      // not come. An ENDED pty is the ordinary way in: the poller stops polling when the shell
      // exits but leaves `live` true, so the prompt keeps accepting lines. Draw the command
      // line only once the shell has actually taken it, and say the reason when it has not.
      void termWrite(sess, `${trimmed}\n`).then((r) => {
        if (termRefused(r)) {
          const reason = termRefusalReason(r);
          appendLines([
            {
              text: t("terminal.writeFailed", {
                detail: reason === "" ? t("terminal.writeNoReason") : reason,
              }),
              kind: "err" as const,
            },
          ]);
          return;
        }
        appendLines([{ text: `${PROMPT} ${shown}`, kind: "cmd" as const }]);
      });
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

