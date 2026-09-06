import { readFileSync } from "node:fs";
const t = readFileSync("coverage/lcov.info", "utf8");
const rows = [];
for (const f of t.split("end_of_record")) {
  const sf = (f.match(/SF:(.*)/) || [])[1];
  const lf = (f.match(/\nLF:(\d+)/) || [])[1];
  const lh = (f.match(/\nLH:(\d+)/) || [])[1];
  if (!sf || !lf || lh === undefined) continue;
  if (!sf.includes("src/lib/")) continue;
  const total = Number(lf);
  const hit = Number(lh);
  rows.push({ f: sf.replace(/^.*\/src\/lib\//, ""), hit, total, pct: (hit / total) * 100 });
}
rows.sort((a, b) => a.pct - b.pct);
for (const r of rows.slice(0, 20)) {
  console.log(
    r.pct.toFixed(1).padStart(5) + "%  " + String(r.hit).padStart(4) + "/" + String(r.total).padStart(4) + "  " + r.f,
  );
}
