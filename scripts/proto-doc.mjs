#!/usr/bin/env node
/**
 * proto-doc.mjs — generate the gRPC API reference from `proto/*.proto`
 * (FUNCTIONAL_GAP_ANALYSIS #38: no developer API docs).
 *
 * The `.proto` files ARE the API contract (11 services / 58 RPCs over the shared
 * Unix Domain Socket), but nothing rendered them: a reader had to open nine files and
 * count braces. This generates `docs/api-grpc.md` — services, methods, messages,
 * fields and enums, each carrying the doc comment that lives beside it in the proto.
 *
 * Why a hand-rolled parser instead of `protoc --doc_out`: the repo's scanners are
 * deliberately dependency-free (`unwired-scan.mjs`, `hot-loop-scan.mjs`) so they run
 * anywhere `node` does — including the CI lint job, which does not install protoc
 * plugins. This never executes or imports the code it inspects.
 *
 * Usage (from the repo root):
 *   node scripts/proto-doc.mjs                 # write docs/api-grpc.md
 *   node scripts/proto-doc.mjs --check         # fail if the checked-in doc is stale
 *   node scripts/proto-doc.mjs --stdout        # print instead of writing
 *   node scripts/proto-doc.mjs --selftest      # prove the parser handles real syntax
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const protoDir = join(repoRoot, "proto");
const outPath = join(repoRoot, "docs", "api-grpc.md");

/** Strip a `//` comment, returning { code, comment }. */
function splitComment(line) {
  const i = line.indexOf("//");
  if (i < 0) return { code: line, comment: "" };
  return { code: line.slice(0, i), comment: line.slice(i + 2).trim() };
}

/** Collapse a doc-comment buffer into one prose line ("a · b"). */
function prose(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse one `.proto` source into { header, package, services, messages, enums }.
 * Handles the constructs the real files use — `rpc` with `stream` markers, messages
 * with `repeated` / `optional` / `map<k,v>` fields, `oneof` groups, enums, and the
 * doc comments beside each declaration (plus a file-header comment block).
 */
export function parseProto(src) {
  const lines = src.split("\n");
  const out = { header: [], package: "", services: [], messages: [], enums: [] };
  let doc = [];
  let block = null; // { kind: "service"|"message"|"enum", ... , depth }
  let oneof = null;

  const fieldRe =
    /^(?:(repeated|optional|required)\s+)?(map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;/;

  for (const raw of lines) {
    const { code, comment } = splitComment(raw);
    const t = code.trim();

    if (t === "") {
      // A comment-only line accumulates; a real blank line ends the block (so a
      // comment does not attach to a declaration far below it).
      if (comment) doc.push(comment);
      else doc = [];
      continue;
    }

    if (!block && /^syntax\s*=/.test(t)) {
      // The comment block above `syntax` is the file header.
      out.header = doc;
      doc = [];
      continue;
    }
    if (!block && /^package\s+/.test(t)) {
      out.package = t.replace(/^package\s+/, "").replace(/;.*$/, "").trim();
      doc = [];
      continue;
    }

    let m;
    if ((m = /^service\s+(\w+)\s*\{/.exec(t))) {
      block = { kind: "service", name: m[1], doc: prose(doc) || prose([comment]), methods: [], depth: 1 };
      out.services.push(block);
      doc = [];
      continue;
    }
    if ((m = /^message\s+(\w+)\s*\{/.exec(t))) {
      block = { kind: "message", name: m[1], doc: prose(doc) || prose([comment]), fields: [], depth: 1 };
      out.messages.push(block);
      doc = [];
      oneof = null;
      continue;
    }
    if ((m = /^enum\s+(\w+)\s*\{/.exec(t))) {
      block = { kind: "enum", name: m[1], doc: prose(doc) || prose([comment]), values: [], depth: 1 };
      out.enums.push(block);
      doc = [];
      continue;
    }
    if (!block) continue;

    if ((m = /^rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/.exec(t))) {
      block.methods.push({
        name: m[1],
        clientStream: Boolean(m[2]),
        request: m[3],
        serverStream: Boolean(m[4]),
        reply: m[5],
        doc: prose(doc) || prose([comment]),
      });
      doc = [];
      if (t.includes("{")) block.depth += 1;
      continue;
    }
    if (block.kind === "message" && (m = /^oneof\s+(\w+)\s*\{/.exec(t))) {
      oneof = m[1];
      block.depth += 1;
      doc = [];
      continue;
    }
    if (block.kind === "enum" && (m = /^(\w+)\s*=\s*(\d+)\s*;/.exec(t))) {
      block.values.push({ name: m[1], number: Number(m[2]), doc: prose(doc) });
      doc = [];
      continue;
    }
    if (block.kind === "message" && (m = fieldRe.exec(t))) {
      block.fields.push({
        label: m[1] ?? "",
        type: m[2],
        name: m[3],
        number: Number(m[4]),
        oneof,
        doc: prose(doc) || prose([comment]),
      });
      doc = [];
      continue;
    }

    // Brace bookkeeping (also covers `oneof`/nested blocks and inline `{}` bodies).
    for (const ch of t) {
      if (ch === "{") block.depth += 1;
      else if (ch === "}") block.depth -= 1;
    }
    if (block.depth <= 0) {
      block = null;
      oneof = null;
      doc = [];
    }
    // Anything else (options, comments, nested decls we don't model) is ignored.
  }
  return out;
}

export function parseDir(dir = protoDir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".proto"))
    .sort()
    .map((f) => ({ file: f, ...parseProto(readFileSync(join(dir, f), "utf8")) }));
}

// --- render ------------------------------------------------------------------
const esc = (s) => s.replace(/\|/g, "\\|");

function renderMethod(m) {
  const kind =
    m.clientStream && m.serverStream
      ? "bidirectional streaming"
      : m.serverStream
        ? "server streaming"
        : m.clientStream
          ? "client streaming"
          : "unary";
  return `| \`${m.name}\` | \`${m.request}\` | \`${m.reply}\` | ${kind} | ${esc(m.doc) || "—"} |`;
}

function renderMessage(msg) {
  const rows = msg.fields.map((f) => {
    const type = f.label === "repeated" ? `repeated \`${f.type}\`` : `\`${f.type}\``;
    const notes = [f.oneof ? `in \`oneof ${f.oneof}\`` : "", f.label === "optional" ? "optional" : "", f.doc]
      .filter(Boolean)
      .join(" · ");
    return `| \`${f.name}\` | ${type} | ${f.number} | ${esc(notes) || "—"} |`;
  });
  const head = msg.doc ? `**\`${msg.name}\`** — ${esc(msg.doc)}\n` : `**\`${msg.name}\`**\n`;
  if (rows.length === 0) return `${head}\n*(no fields)*\n`;
  return `${head}\n| Field | Type | # | Notes |\n|---|---|---|---|\n${rows.join("\n")}\n`;
}

/** Render the whole reference (deterministic: files and declarations keep their order). */
export function render(parsed) {
  const totals = parsed.reduce(
    (a, p) => ({
      services: a.services + p.services.length,
      rpcs: a.rpcs + p.services.reduce((n, s) => n + s.methods.length, 0),
      messages: a.messages + p.messages.length,
      enums: a.enums + p.enums.length,
    }),
    { services: 0, rpcs: 0, messages: 0, enums: 0 },
  );

  const out = [];
  out.push("# gRPC API reference");
  out.push("");
  out.push(
    "> **Generated** by `scripts/proto-doc.mjs` from `proto/*.proto` — do not edit by",
    "> hand. `make api-docs` regenerates it; `make lint` fails when it is stale, so the",
    "> contract and this page cannot drift apart.",
  );
  out.push("");
  out.push(
    `The daemon serves all of these over **one shared Unix Domain Socket** (default \$AMOS_SOCKET).`,
    `${totals.services} services · ${totals.rpcs} RPCs · ${totals.messages} messages · ${totals.enums} enums,`,
    `across ${parsed.length} \`.proto\` files.`,
  );
  out.push("");
  out.push("## Index");
  out.push("");
  out.push("| File | Package | Services | RPCs | Messages | Enums |");
  out.push("|---|---|---|---|---|---|");
  for (const p of parsed) {
    const rpcs = p.services.reduce((n, s) => n + s.methods.length, 0);
    // Must match GitHub's heading slug for the `## \`<file>\`` heading below:
    // lowercase, punctuation dropped, spaces to hyphens ("ai_agent.proto" →
    // "ai_agentproto"), or the index links would silently 404.
    const anchor = p.file
      .toLowerCase()
      .replace(/[^a-z0-9_ -]/g, "")
      .replace(/\s+/g, "-");
    out.push(
      `| [\`${p.file}\`](#${anchor}) | \`${p.package || "—"}\` | ${p.services.length} | ${rpcs} | ${p.messages.length} | ${p.enums.length} |`,
    );
  }
  out.push("");

  for (const p of parsed) {
    out.push(`## \`${p.file}\``);
    out.push("");
    if (p.package) out.push(`Package: \`${p.package}\``);
    if (p.header.length) {
      out.push("");
      out.push(prose(p.header));
    }
    out.push("");

    if (p.services.length) {
      out.push("### Services");
      out.push("");
      for (const s of p.services) {
        out.push(`#### \`${s.name}\``);
        out.push("");
        if (s.doc) out.push(s.doc, "");
        out.push("| Method | Request | Reply | Kind | Notes |");
        out.push("|---|---|---|---|---|");
        for (const m of s.methods) out.push(renderMethod(m));
        out.push("");
      }
    }
    if (p.messages.length) {
      out.push("### Messages");
      out.push("");
      for (const m of p.messages) {
        out.push(renderMessage(m));
      }
    }
    if (p.enums.length) {
      out.push("### Enums");
      out.push("");
      for (const e of p.enums) {
        out.push(e.doc ? `**\`${e.name}\`** — ${esc(e.doc)}` : `**\`${e.name}\`**`, "");
        out.push("| Value | # | Notes |");
        out.push("|---|---|---|");
        for (const v of e.values) out.push(`| \`${v.name}\` | ${v.number} | ${esc(v.doc) || "—"} |`);
        out.push("");
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// --- self-test ---------------------------------------------------------------
/**
 * `--selftest` pins the parser against the syntax the real files use (and a few
 * constructs they do not yet, so a future proto cannot silently degrade the doc).
 * A generator that quietly drops fields is worse than no generator.
 */
function runSelfTest() {
  const fixture = `
// File header line one.
// File header line two.
syntax = "proto3";
package demo;

// A service.
service Demo {
  // Unary.
  rpc One (Req) returns (Rep);
  // Server streaming.
  rpc Two (Req) returns (stream Rep);
  rpc Three (stream Req) returns (stream Rep);
}

// A request.
message Req {
  string id = 1;                 // the id
  repeated string tags = 2;
  optional bool flag = 3;
  map<string, string> ctx = 4;
  oneof payload {
    string text = 5;
    bytes blob = 6;              // binary
  }
}

message Empty {}

enum Kind {
  KIND_UNSPECIFIED = 0;
  // A real kind.
  KIND_A = 1;
}
`;
  const cases = [];
  const p = parseProto(fixture);
  cases.push(["file header is captured", prose(p.header) === "File header line one. File header line two."]);
  cases.push(["package", p.package === "demo"]);
  cases.push(["service + doc", p.services.length === 1 && p.services[0].doc === "A service."]);
  const methods = p.services[0].methods;
  cases.push(["3 rpcs parsed", methods.length === 3]);
  cases.push(["unary kind", methods[0].name === "One" && !methods[0].serverStream && !methods[0].clientStream]);
  cases.push(["server streaming", methods[1].serverStream === true && methods[1].clientStream === false]);
  cases.push(["bidi streaming", methods[2].serverStream === true && methods[2].clientStream === true]);
  cases.push(["method doc comment", methods[0].doc === "Unary."]);
  const req = p.messages.find((m) => m.name === "Req");
  cases.push(["message doc", req.doc === "A request."]);
  cases.push(["5 fields + 2 oneof members", req.fields.length === 6]);
  cases.push(["field comment", req.fields[0].doc === "the id"]);
  cases.push(["repeated label", req.fields[1].label === "repeated"]);
  cases.push(["optional label", req.fields[2].label === "optional"]);
  cases.push(["map type", req.fields[3].type === "map<string, string>"]);
  cases.push(["oneof membership + name", req.fields[4].oneof === "payload" && req.fields[5].oneof === "payload"]);
  cases.push(["oneof closes before the next level", p.messages.find((m) => m.name === "Empty").fields.length === 0]);
  cases.push(["enum values + doc", p.enums[0].values.length === 2 && p.enums[0].values[1].doc === "A real kind."]);
  const md = render([{ file: "demo.proto", ...p }]);
  cases.push(["render includes service table", md.includes("| `One` | `Req` | `Rep` | unary | Unary. |")]);
  cases.push(["render includes bidi kind", md.includes("| `Three` | `Req` | `Rep` | bidirectional streaming | — |")]);
  cases.push(["render notes the oneof", md.includes("in `oneof payload`")]);

  // The reference must be *tracked*, not merely present: a generated-but-untracked doc
  // is green on every developer machine and then fails `make lint` on a clean checkout
  // (CI). `null` means "no git work tree to consult" (a tarball) — never "untracked".
  const trackedMakefile = trackedInGit(join(repoRoot, "Makefile"));
  cases.push([
    "trackedInGit: a tracked path ⇒ true (or null outside a work tree)",
    trackedMakefile === true || trackedMakefile === null,
  ]);
  const ghost = trackedInGit(join(repoRoot, "docs", "no-such-file-xyz.md"));
  cases.push([
    "trackedInGit: an absent path is never reported as tracked",
    ghost !== true,
  ]);

  let failed = 0;
  for (const [name, ok] of cases) {
    if (ok) console.log(`  [ok] ${name}`);
    else {
      failed++;
      console.log(`  [FAIL] ${name}`);
    }
  }
  if (failed > 0) {
    console.log(`[proto-doc] selftest FAILED (${failed}/${cases.length}).`);
    process.exit(1);
  }
  console.log(`[proto-doc] selftest OK — ${cases.length} parser/render case(s).`);
}

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

const md = render(parseDir());

/**
 * Is `abs` tracked by git? `true`/`false`, or `null` when we are not inside a git
 * work tree (a source tarball has no index to consult) — callers must treat `null` as
 * "cannot tell", never as "untracked".
 */
function trackedInGit(abs) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", abs], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (e) {
    // 128 = "not a git repository"; anything else means the index was consulted and
    // the path is not in it (or a real git failure). Distinguish the two honestly.
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      return null;
    }
    return false;
  }
}

if (args.includes("--stdout")) {
  process.stdout.write(md);
  process.exit(0);
}

if (args.includes("--check")) {
  if (!existsSync(outPath)) {
    console.log("[proto-doc] FAIL — docs/api-grpc.md is missing. Run `make api-docs`.");
    process.exit(1);
  }
  // Existing is not the same as *checked in*: a generated-but-untracked reference
  // passes every local run and then makes `make lint` fail on a clean checkout (CI
  // does a bare actions/checkout, then `make lint`). That is exactly the "green on my
  // machine" trap this gate exists to prevent, so it must be an error, not a note.
  const tracked = trackedInGit(outPath);
  if (tracked === false) {
    console.log(
      "[proto-doc] FAIL — docs/api-grpc.md exists but is NOT tracked by git, so `make lint` fails on a clean checkout (CI). Run `git add docs/api-grpc.md`.",
    );
    process.exit(1);
  }
  const current = readFileSync(outPath, "utf8");
  if (current !== md) {
    const a = current.split("\n");
    const b = md.split("\n");
    const first = a.findIndex((l, i) => l !== b[i]);
    console.log(
      `[proto-doc] FAIL — docs/api-grpc.md is stale (first difference at line ${first + 1}).`,
    );
    console.log(`  checked in: ${JSON.stringify(a[first] ?? "<eof>")}`);
    console.log(`  generated:  ${JSON.stringify(b[first] ?? "<eof>")}`);
    console.log("  Run `make api-docs` and commit the result.");
    process.exit(1);
  }
  console.log("[proto-doc] OK — docs/api-grpc.md matches proto/*.proto.");
  process.exit(0);
}

writeFileSync(outPath, md);
const p = parseDir();
const rpcs = p.reduce((n, x) => n + x.services.reduce((k, s) => k + s.methods.length, 0), 0);
console.log(
  `[proto-doc] wrote docs/api-grpc.md — ${p.length} file(s), ${p.reduce((n, x) => n + x.services.length, 0)} service(s), ${rpcs} rpc(s).`,
);
