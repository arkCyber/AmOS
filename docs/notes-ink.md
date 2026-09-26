# Handwriting (ink) in Notes — design (REQ-A526)

Status: **implemented** (2026-09-19). `lib/ink.ts` + `InkCanvas.svelte` exist and are
wired into `NoteEditor.svelte` (an alternating view of the same note) and surfaced by
`NotesApp.svelte` (a per-device preference and a row badge). Design record below kept as
the reference for behaviour and semantics.

**Read the boundaries section before trusting a threshold.** Five of the six failure
modes in this feature were validated only against **synthetic `PointerEvent`s** — no
digitizer was available in this environment.

## Goal

Give Notes a first-class **handwriting** surface: a stylus draws variable-width ink,
a finger can draw too, a resting palm must not, and the drawing is part of the note —
saved by the same autosave, carried by the same store, exported by the same list.

Scope decision (agreed up front): **integrate into Notes**, no standalone app — which
keeps the 33-app `appMeta` contract test untouched. v1 tools are **pen + eraser**; no
highlighter, no layers, no text/ink interleaving.

## Where the geometry lives (the load-bearing decision)

**All of it is in `lib/ink.ts` — pure TypeScript, in the frontend process.** No Rust, no
`stroke_*` Tauri command, no IPC.

Why: a stroke is sampled at the pointer's own rate (a 120 Hz stylus, up to ~240
coalesced samples/s), and every sample must become a pixel **in the same frame**. A host
round trip per sample would put IPC latency inside the stroke, which is precisely the
input the user feels. The model is presentational, so no host state is involved.
`lib/menuPlacement.ts` and `lib/virtualScroll.ts` are the same shape of module.

The consequence is that `ink.ts` is testable with no browser at all, and the component
holds no geometry.

## Data model

```ts
export type InkTool = "pen" | "eraser";
export interface InkPoint  { x: number; y: number; p: number; t: number }   // p,t ∈ [0,1]
export interface InkStroke { tool: InkTool; color: string; width: number; pts: InkPoint[] }
export interface Ink       { w: number; h: number; strokes: InkStroke[] }
```

`Note` gains an **optional** `ink?: Ink`.

- **Coordinates are CSS px in the strip's own space at capture time**, and `w`/`h` record
  that space. Rendering multiplies by `fitScale(ink.w, viewW)`, so a window resize
  rescales the drawing rather than losing it. Real pixels (not normalized `[0,1]`) keep
  `ERASER_RADIUS`, `stroke.width` and the hit test in the same units as the test
  assertions.
- **`w`/`h` describe a strip that grows downward.** The drawing surface scrolls; ink is
  never anchored to character offsets in the text.
- **`ink` is absent, not empty, on a note without a drawing.** See the back-compat
  invariant below — this is enforced structurally, not by convention.

### Back-compat invariant (`notes.ts`)

`normalizeNotes` used to drop any entry whose `text` was not a string, which made a
pure-drawing note impossible. It now keeps an entry when it has **either** a body **or**
a drawable layer:

```ts
const hasText = typeof o.text === "string";
const ink = normalizeInk(o.ink);
if (!hasText && !ink) return;          // still drops a truly empty entry
const text = hasText ? (o.text as string) : "";
```

and the pushed object spreads `...(ink ? { ink } : {})`. So **a note written before this
feature produces an object with no `ink` key at all** — the assertion is
`"ink" in out[0] === false`, not `toBeUndefined()`. The difference matters: a stray
`ink: undefined` own-property would survive in memory and be dropped by
`JSON.stringify`, so the round-tripped value and the in-memory value would disagree.

`editNote` takes an optional 5th `ink?: Ink | null`:

- `undefined` → **leave the ink alone** (this is what keeps a pure-text edit from
  disturbing a drawing it never touched),
- `null`/empty → **clear it**, by `delete next.ink` (not `= undefined`), for the same
  structural reason;
- a blank body with no ink is still a same-reference no-op (refusing to strand a note
  with nothing in it), but a blank body **with** ink persists.

`duplicateNote` copies `ink` by reference; the value is treated as immutable everywhere.

## Input routing: `classifyPointer`

`InkPointerSample` is **deliberately free of DOM types** so this is a pure predicate:

```ts
{ pointerType, width, height, isPrimary, penActive, palmRejection } → "draw" | "palm" | "ignore"
```

Order is the specification:

1. `"pen"` → **draw**, unconditionally. A pen is never a palm; contact geometry does not
   get a vote.
2. `"mouse"` → draw (the desktop shell and the test suite both need this path).
3. anything that is not `"touch"` → **ignore**. An unknown pointer type must not invent
   input.
4. `"touch"` with `palmRejection === false` → draw. **An explicit user override beats
   every heuristic.**
5. `"touch"` while a pen was seen within `PALM_PEN_IDLE_MS` (4000 ms) → **palm**. This is
   the rule that does the work on real hardware: a palm resting on the glass while a pen
   writes.
6. `"touch"` whose contact-ellipse long axis is ≥ `PALM_CONTACT_MIN` (22 px) → palm.
   A fingertip contact ellipse is roughly 12–18 px; a palm heel or knuckle is 25–60 px+.
   22 sits between the two distributions with margin on both sides.
7. `"touch"` that is not `isPrimary` → palm.
8. otherwise → draw (a real finger).

**Pressure is deliberately not used as a palm signal.** Many touch controllers report a
constant `0` or `1` for a finger; a pressure threshold would be a coin flip presented as
a decision. `pressure` is only ever read from `pointerType === "pen"`, where it is a
measurement.

On the canvas, a `palm` decision is **captured and then swallowed** — not left
uncaptured. An uncaptured contact keeps delivering moves to the scroll container, so the
page would scroll under the user's hand.

## The canvas: `InkCanvas.svelte`

**SVG, not `<canvas>`.** Three reasons, the last decisive:

- a variable-width stroke is a *filled outline*, and one `<path>` carries it as a single
  node the browser re-renders without this component repainting anything;
- a canvas would need a second, untested rasteriser for the same geometry;
- **happy-dom implements no 2D context**, so a canvas renderer would be unverifiable in
  the test suite.

`strokePath(pts, width)` emits the closed outline (offset polyline on both sides plus a
close), so a pressure-varying stroke is still one node — which is what gives the latency
property below for free via Svelte's keyed list diffing.

Pointer path:

- `pointerdown` → build the sample → `classifyPointer` → `ignore` returns; `palm` is
  captured and tracked in a `Set`; otherwise the id becomes active and, for the eraser,
  one `eraseAt` is committed immediately.
- `pointermove` → skipped for palms; for the active id, expanded through `coalesced(e)`,
  then `appendPoint` per sample, then a repaint is scheduled.
- `pointerup` / `pointercancel` / `lostpointercapture` → `simplifyStroke` (RDP,
  `INK_SIMPLIFY_TOL` 0.5 px — typically a five- to ten-fold payload cut with no visible
  change), grow `h` to the lowest point, then `onChange`.

**`pointercancel` is handled on the same path as `pointerup`, and every exit releases the
active id.** A system gesture that steals the pointer would otherwise leave the id stuck,
and the next pen-down would read as a second contact and be rejected as a palm — the user
would experience it as "the pen stopped working".

**`coalesced(e)` is the highest-value defence in this change.** `getCoalescedEvents` is a
Chromium/WebKit extension that is absent in happy-dom and has been missing or throwing on
some WebView builds. A throw there aborts the move handler and **silently truncates every
stroke on that device**, with no error the user or a test would see. It therefore returns
`[e]` when the function is missing, when the call throws, and when the result is empty.

`onChange` fires **only on stroke commit and per eraser pass**, never per move — so the
editor's 600 ms debounce stays as cheap for a drawing as it is for a keystroke.

## Views, persistence, and the toolbar

Ink and text are **alternating views of one note**, not an overlay: `{#if drawOn}
<InkCanvas/> {:else} <textarea/> {/if}`. Anchoring strokes to a scrolling text body needs
character-offset anchoring, which is a substantially larger data model. One layer at a
time is the honest, convergent boundary — and it matches the storage shape (a strip that
carries its own `w`/`h`).

Persistence adds no new mechanism. `NoteEditor` holds `inkVal` and passes it to the same
`commit()`, which already routes through the **verified** write
(`writeStoreValueChecked`): a rejected write is reported as a failed save, never as
`保存于 HH:MM:SS`. Both exit paths (`‹ back` and `onDestroy`) call `deb.flush()`, so
however the editor closes, pending strokes are written, not dropped.

When a note has ink but the text view is showing, a small `✎ 手写` badge explains where
the writing went — otherwise it is an empty textarea with no explanation.

Toolbar additions follow the existing preview button exactly: `aria-pressed`,
accent-when-on, `data-testid`, and a `title` from the message catalog.

## Preference

`NotesPrefs.palmRejection` (default **true**), normalized so a missing or non-boolean
value degrades to `true`. It is a **per-device** preference, not per-note: the contact
ellipse that makes a palm a palm is a property of the digitizer, not of the drawing. It
reuses the existing `amos.notesPrefs` store key — no new storage key, and therefore no new
scanner surface.

## Bounded payload

`INK_MAX_STROKES` (2000), `INK_MAX_POINTS` (2000), `INK_MIN_DIST` (0.75 px sample
gating), `INK_SIMPLIFY_TOL` (0.5 px RDP on commit) plus `INK_MIN_WIDTH`/`INK_MAX_WIDTH`
(0.75–6 px) bound a single note's payload and keep every drawn value in a range the rest
of the module can assume. `normalizeInk` enforces all of them **on read**, so a corrupt or
hostile store degrades to "this note has no ink" instead of hanging the renderer or
emitting `NaN` into an SVG path. Numbers are not coerced from strings: `"3"` is a
different serialization and accepting it would hide a bug in whatever wrote it.

## Boundaries (what this does *not* claim)

1. **No hardware validation.** Every threshold, the pressure/tilt curves, the committed
   stroke shape and the palm window were exercised only against synthetic
   `PointerEvent`s. No digitizer was measured.
2. **Contact geometry may be absent.** A device that reports `width`/`height = 0` for
   touch never trips the geometric rule, leaving only the pen-active rule. That is a real
   and unquantified exposure; the `palmRejection` switch and the draw-mode toggle are the
   escape hatches.
3. **The coalescing path is exercised by a stub.** Real `getCoalescedEvents` behaviour —
   rate, ordering, whether WKWebView fires it at all — is unverified.
4. **v1 is one layer at a time.** Ink and text do not interleave; strokes are not
   anchored to character offsets. This is a deliberate boundary, not an oversight.
5. **`tiltX`/`tiltY` only widen the stroke.** No tilt shading, no azimuthal rotation, no
   true chisel edge. Calling this "tilt support" without that qualifier would be
   overclaiming.
6. **Payload is bounded but unmeasured.** The real byte count of a long handwriting
   session was not measured; `INK_MAX_*` plus RDP bound it, and a quota failure surfaces
   through the existing `save_failed` path rather than silently.
7. **`note_export` still exports text only.** A pure-drawing note exports as an empty
   body.
8. **No Rust changes, deliberately.** Ink is presentational and latency-sensitive; a
   `stroke_*` command would add a round trip to every pointermove.
