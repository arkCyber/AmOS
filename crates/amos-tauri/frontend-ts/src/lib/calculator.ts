/**
 * Pure calculator reducer mirroring the (already fixed) legacy vanilla logic so
 * it can be unit-tested headlessly and shared with the React UI.
 */
export interface CalcState {
  acc: string; // accumulated "left operand + operator", e.g. "9 − "
  cur: string; // current operand being typed
  justEq: boolean; // last press was "=" → a fresh number starts next
}

export const ERR = "ERR";

export function calcInit(): CalcState {
  return { acc: "", cur: "0", justEq: false };
}

/** Normalize iOS display symbols to ASCII math operators. */
function normalize(s: string): string {
  return s
    .replace(/＋/g, "+")
    .replace(/−/g, "-")
    .replace(/×/g, "*")
    .replace(/÷/g, "/");
}

/**
 * Tiny recursive-descent evaluator for `+ - * /` (no `eval`/`new Function`, so
 * no code-execution surface). Supports unary minus; throws on malformed input,
 * division by zero, or a non-finite result.
 */
function evalExpr(s: string): number {
  const expr = normalize(s);
  let i = 0;
  const n = expr.length;
  const skipWs = () => {
    while (i < n && expr[i] === " ") i++;
  };
  const num = (): number => {
    skipWs();
    const j = i;
    let dot = false;
    while (i < n) {
      const c = expr.charAt(i); // charAt never returns undefined (empty string past end)
      if (c >= "0" && c <= "9") i++;
      else if (c === "." && !dot) {
        dot = true;
        i++;
      } else break;
    }
    if (i === j) throw new Error("calc"); // no digits consumed
    return Number(expr.slice(j, i));
  };
  const unary = (): number => {
    skipWs();
    if (i < n && expr[i] === "-") {
      i++;
      return -unary();
    }
    return num();
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      skipWs();
      const c = i < n ? expr[i] : "";
      if (c === "*" || c === "/") {
        i++;
        const r = unary();
        if (c === "/") {
          if (r === 0) throw new Error("calc"); // division by zero
          v /= r;
        } else v *= r;
      } else break;
    }
    return v;
  };
  const sum = (): number => {
    let v = term();
    for (;;) {
      skipWs();
      const c = i < n ? expr[i] : "";
      if (c === "+" || c === "-") {
        i++;
        const r = term();
        v = c === "+" ? v + r : v - r;
      } else break;
    }
    return v;
  };
  const v = sum();
  skipWs();
  if (i !== n) throw new Error("calc"); // trailing garbage
  if (!Number.isFinite(v)) throw new Error("calc");
  return v;
}

function evalNum(s: string): number {
  return evalExpr(s);
}
function fmt(v: number): string {
  return String(Number(v.toPrecision(12))); // tame 0.1+0.2 float noise
}

/** Apply one button press and return the next state (pure). */
export function calcPress(st: CalcState, label: string): CalcState {
  let { acc, cur, justEq } = st;

  // Aerospace-grade error policy: once ERR, the display is frozen — only "C"
  // clears it (no half-typed "ERR × …" garbage, no NaN leak).
  if (cur === ERR && label !== "C") return st;

  if (/[0-9]/.test(label)) {
    if (justEq) {
      acc = "";
      cur = label;
      justEq = false;
    } else {
      cur = cur === "0" ? label : cur + label;
    }
  } else if (label === ".") {
    if (justEq) {
      acc = "";
      cur = "0.";
      justEq = false;
    } else if (!cur.includes(".")) {
      cur += ".";
    }
  } else if (label === "C") {
    acc = "";
    cur = "0";
    justEq = false;
  } else if (label === "⌫") {
    cur = cur.length > 1 ? cur.slice(0, -1) : "0";
  } else if (label === "%") {
    try {
      cur = fmt(evalNum(cur) / 100);
    } catch {
      cur = ERR;
    }
  } else if (label === "=") {
    try {
      cur = fmt(evalNum(acc + cur));
    } catch {
      cur = ERR;
    }
    acc = "";
    justEq = true;
  } else {
    // operator (＋ − × ÷); fold any pending operation, then stage this one
    justEq = false;
    if (acc) {
      try {
        cur = fmt(evalNum(acc + cur));
      } catch {
        // hard error: freeze at ERR until cleared with C
        return { acc: "", cur: ERR, justEq: false };
      }
    }
    acc = `${cur} ${label} `;
    cur = "0";
  }
  return { acc, cur, justEq };
}

/** Text shown in the display for a state. */
export function calcDisplay(st: CalcState): string {
  if (st.justEq) return st.cur;
  return st.acc ? `${st.acc}${st.cur === "0" ? "" : st.cur}` : st.cur;
}

/** Run a whole sequence of presses, returning the display text. */
export function calcRun(presses: string[]): string {
  return presses.reduce((s, k) => calcPress(s, k), calcInit()).cur;
}

export interface CalcEntry {
  expr: string; // e.g. "9 − 3"
  result: string; // e.g. "6" (plain ASCII result, ERR if not solvable)
}

/**
 * Build the history row a completed "=" would produce from the state *before*
 * "=" is pressed. Returns null when there is no pending binary operation
 * (acc empty) or the expression is not solvable.
 */
export function calcEntry(st: CalcState): CalcEntry | null {
  if (!st.acc) return null;
  const expr = `${st.acc}${st.cur}`.replace(/\s+$/g, "");
  try {
    return { expr, result: fmt(evalNum(expr)) };
  } catch {
    return null; // division by zero etc. — nothing meaningful to record
  }
}

/**
 * Add an entry to the history (newest first, dedup by expr+result) while capping
 * the list length. Pure — returns a fresh array.
 */
export function addHistory(
  history: readonly CalcEntry[],
  entry: CalcEntry,
  cap = 12,
): CalcEntry[] {
  const rest = history.filter((h) => h.expr !== entry.expr || h.result !== entry.result);
  const next = [entry, ...rest];
  return cap > 0 ? next.slice(0, cap) : next;
}

/**
 * Map a physical-keyboard event to the on-screen label the calculator
 * understands (the reducer speaks iOS symbols: ＋−×÷). Returns null when the
 * key isn't a calculator input, so callers can skip preventDefault.
 * `modifiers` is truthy when ctrl/meta/alt is held → always ignored.
 */
export function calcFromKey(
  key: string,
  modifiers?: boolean,
): string | null {
  if (modifiers) return null;
  if (/^[0-9.]$/.test(key)) return key;
  if (key === "Enter" || key === "=") return "=";
  if (key === "Backspace") return "⌫";
  if (key === "Delete" || key === "Escape" || key === "c" || key === "C") return "C";
  if (key === "%") return "%";
  if (key === "+") return "+";
  if (key === "-") return "−"; // display glyph the reducer also normalizes
  if (key === "*") return "×";
  if (key === "/") return "÷";
  return null;
}
