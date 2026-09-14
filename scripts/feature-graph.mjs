/**
 * feature-graph.mjs — the workspace's feature graph, shared by the gates that reason about
 * "is this feature-gated thing compiled/run?" (`feature-surface-scan.mjs`, REQ-A191, and
 * `feature-test-scan.mjs`, REQ-A192).
 *
 * Why a module: both gates need the same two facts — which features a crate declares and
 * what enabling one feature *transitively* enables (`amos-tauri/android` → `amos-radio/android`;
 * `amos-ai/telemetry-spy-audit` → `amos-ai/telemetry-spy` + `amos-telemetry-spy/audit`). Two
 * copies of that resolver would drift, and a gate that mis-resolves transitivity reports the
 * wrong thing in both directions. This file has **no `main`**, so importing it never runs a
 * gate.
 *
 * Resolution rules (permissive on purpose — a gate must not fail a surface a step really
 * compiles): a bare feature name counts for the packages an invocation names, or (with
 * `--workspace`) for every crate declaring it; `crate/feature` counts directly; `dep:x`
 * entries are dependency enablers, not features; `crate?/feature` is treated as the feature.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Parse `crates/<crate>/Cargo.toml` feature tables (single- and multi-line lists). */
export function crateManifests(root) {
  const dir = join(root, "crates");
  const features = new Map();
  const owners = new Map(); // feature name -> crates declaring it
  const crates = [];
  const targets = [];
  if (!existsSync(dir)) return { features, owners, crates, targets };
  for (const crate of readdirSync(dir)) {
    const file = join(dir, crate, "Cargo.toml");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    crates.push(crate);
    const block = text.match(/\n\[features\]\n([\s\S]*?)(?=\n\[|$)/);
    if (block) {
      let open = null;
      const push = (t) => {
        for (const m of t.matchAll(/"([^"]+)"/g)) open.items.push(m[1]);
      };
      const store = () => {
        features.set(`${crate}/${open.name}`, open.items);
        if (!owners.has(open.name)) owners.set(open.name, []);
        owners.get(open.name).push(crate);
        open = null;
      };
      for (const line of block[1].split("\n")) {
        if (open === null) {
          const start = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*\[(.*)$/);
          if (!start) continue;
          open = { name: start[1], items: [] };
          push(start[2]);
          if (start[2].includes("]")) store();
        } else {
          push(line);
          if (line.includes("]")) store();
        }
      }
    }
    for (const section of text.split(/\n(?=\[\[)/)) {
      const head = section.trim().match(/^\[\[(example|bin|test|bench)\]\]/);
      if (!head) continue;
      const name = (section.match(/name\s*=\s*"([^"]+)"/) || [])[1];
      const req = section.match(/required-features\s*=\s*\[([^\]]*)\]/);
      const requires = [...(req?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (requires.length === 0) continue; // built by every default-features run
      targets.push({ crate, kind: head[1], name: name ?? `${crate}-default`, requires });
    }
  }
  return { features, owners, crates, targets };
}

/**
 * Which features the invocations enable, transitively. `invocations` may come from either
 * gate's parser as long as they carry `{ packages, features, workspace, allFeatures }`.
 */
export function coveredFeatures(manifests, invocations) {
  const { features, owners, crates } = manifests;
  const covered = new Set();
  const queue = [];
  const enable = (key) => {
    if (features.has(key) && !covered.has(key)) (covered.add(key), queue.push(key));
  };
  for (const inv of invocations) {
    for (const raw of inv.features ?? []) {
      if (raw.includes("/")) {
        const [crate, feat] = raw.split("/");
        enable(`${crate}/${feat.replace(/\?$/, "")}`);
        continue;
      }
      if (inv.allFeatures) continue;
      const declaring = owners.get(raw) ?? [];
      if (inv.packages.length > 0) {
        for (const crate of inv.packages) if (declaring.includes(crate)) enable(`${crate}/${raw}`);
      } else {
        for (const crate of declaring) enable(`${crate}/${raw}`);
      }
    }
    if (inv.allFeatures) {
      for (const crate of inv.workspace ? crates : inv.packages) {
        for (const key of features.keys()) if (key.startsWith(`${crate}/`)) enable(key);
      }
    }
  }
  while (queue.length) {
    const key = queue.shift();
    const [crate] = key.split("/");
    for (const item of features.get(key) ?? []) {
      if (item.startsWith("dep:")) continue;
      if (item.includes("/")) {
        const [other, feat] = item.split("/");
        enable(`${other}/${feat.replace(/\?$/, "")}`);
      } else if (features.has(`${crate}/${item}`)) {
        enable(`${crate}/${item}`);
      } else {
        for (const other of owners.get(item) ?? []) enable(`${other}/${item}`);
      }
    }
  }
  return covered;
}
