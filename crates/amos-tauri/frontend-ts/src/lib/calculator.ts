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

function toJs(s: string): string {
  return s.replace(/−/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
}
function evalNum(s: string): number {
  const v = new Function(`"use strict"; return (${toJs(s)});`)() as unknown;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("calc");
  return v;
}
function fmt(v: number): string {
  return String(Number(v.toPrecision(12))); // tame 0.1+0.2 float noise
}

/** Apply one button press and return the next state (pure). */
export function calcPress(st: CalcState, label: string): CalcState {
  let { acc, cur, justEq } = st;

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
    // operator (＋ − × ÷); keep current entry as the left operand
    justEq = false;
    try {
      if (acc) cur = fmt(evalNum(acc + cur));
    } catch {
      cur = ERR;
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
