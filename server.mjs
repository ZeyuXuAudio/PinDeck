#!/usr/bin/env node
/* PinDeck: local server.

   pindeck [deck-dir] [--port 5180] [--model <name>]      (or: node server.mjs ...)

   - serves the editor UI and the deck (with a bridge script injected in edit mode)
   - pushes file changes to the browser (server-sent events) for live reload
   - runs one long-lived Claude Code process for the chat sidebar
   - snapshots files around every Claude turn for diffs and undo
   - answers `cli.mjs layout|shot|slides|pdf` for Claude's self-checks and exports
   - exports the deck as a PDF handout or a PDF presentation (build steps on separate pages)
   - stores figures and audio attached to chat messages in <deck>/figures/ for Claude to use
   Listens on 127.0.0.1 only; every API call needs the per-run token.
   Runtime files (chat, screenshots, backups) live in ~/.pindeck, never in the deck or the package. */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assignEids, parse, findSlides, setStyles, getInner, setInner, insertAfter, removeElement, deleteTarget, fileRefs, insertSlide, setAttr } from "./lib/eids.mjs";
import { unifiedDiff } from "./lib/diff.mjs";
import { ClaudeSession } from "./lib/claude.mjs";
import { formatLayout, formatPin } from "./lib/layout.mjs";
import { printLayout, printPdf, PDF_HEAD_TAG, PDF_PAGE_TAG } from "./lib/pdf.mjs";

/* ---- Config ------------------------------------------------------------------ */
const USAGE = `Usage: pindeck [deck-folder] [--port 5180] [--model <name>]

Opens the reveal.js deck in deck-folder (default: the current folder) in PinDeck.
The folder must contain index.html.`;
const EDITOR_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : dflt; };
const PORT = +opt("--port", process.env.PORT || 5180);
const MODEL = opt("--model", process.env.CLAUDE_MODEL || "");
const DECK_DIR = path.resolve(argv[0] || process.cwd());
const DECK_FILE = "index.html";
const EDITABLE = ["index.html", "theme.css"];      // Claude may edit these
const LOCKED = ["brand.css"];                      // never, enforced twice
const HOME_DIR = process.env.PINDECK_HOME || path.join(os.homedir(), ".pindeck");
const deckKey = path.basename(DECK_DIR).replace(/[^\w.-]+/g, "_") + "-" +
  crypto.createHash("sha1").update(DECK_DIR).digest("hex").slice(0, 8);
const STATE_DIR = path.join(HOME_DIR, "decks", deckKey);
const SHOT_DIR = path.join(STATE_DIR, "shots");
const TOKEN = crypto.randomBytes(16).toString("hex");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLI_REL = path.relative(DECK_DIR, path.join(EDITOR_DIR, "cli.mjs")).split(path.sep).join("/");
const CLI_CMD = /\s/.test(CLI_REL) ? `node "${CLI_REL}"` : `node ${CLI_REL}`;

if (!fs.existsSync(path.join(DECK_DIR, DECK_FILE))) {
  console.error(`No ${DECK_FILE} in ${DECK_DIR}\n\n${USAGE}`);
  process.exit(1);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const serverInfo = JSON.stringify({ url: ORIGIN, token: TOKEN, deckDir: DECK_DIR, pid: process.pid }, null, 2);
fs.writeFileSync(path.join(STATE_DIR, "server.json"), serverInfo);
fs.writeFileSync(path.join(HOME_DIR, "server.json"), serverInfo); // the CLI's fallback: most recent server

/* ---- Small helpers --------------------------------------------------------------- */
const MIME = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", wav: "audio/wav", mp3: "audio/mpeg",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", md: "text/plain; charset=utf-8" };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex");
const readDeck = (f) => { try { return fs.readFileSync(path.join(DECK_DIR, f), "utf8"); } catch { return null; } };
const ourWrites = new Map(); // file -> { hash, manual } of what we wrote, to tell our writes from others
function writeDeck(f, content, manual = false) {
  ourWrites.set(f, { hash: hash(content), manual });
  fs.writeFileSync(path.join(DECK_DIR, f), content);
}
const snapshot = (files) => Object.fromEntries(files.map((f) => [f, readDeck(f)]));
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const text = (res, code, s) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(s); };
async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}
function safeJoin(base, rel) {
  const p = path.resolve(base, "." + path.posix.normalize("/" + decodeURIComponent(rel)));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

/* ---- Server-sent events ------------------------------------------------------------ */
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000);

/* ---- Element ids ----------------------------------------------------------------------- */
let backedUp = false;
function runEidPass() {
  const html = readDeck(DECK_FILE);
  const r = assignEids(html);
  if (r.changed) {
    if (!backedUp) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.mkdirSync(path.join(STATE_DIR, "backups"), { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, "backups", `index-${ts}.html`), html);
      backedUp = true;
    }
    writeDeck(DECK_FILE, r.html);
    refreshGit();
  }
  return r;
}

/* With the "pindeck-ids" git filter (`node cli.mjs git-setup`) git strips the ids from commits and
   diffs. But git lists a file as modified whenever its size differs from what it recorded, without
   comparing contents, and adding ids changes the size. So after adding ids PinDeck re-records the file
   in git (`git add`), but only when that changes nothing: its content without ids must equal what git
   already has staged. A file with real edits is left alone and shows as modified, as it should. */
let gitFilter = null;   // null: not checked yet
const git = (args, cb) => execFile("git", ["-C", DECK_DIR, ...args], { encoding: "utf8" }, (err, out) => cb(err, (out || "").trim()));
function refreshGit() {
  const run = () => git(["hash-object", `--path=${DECK_FILE}`, DECK_FILE], (e1, cleaned) => {
    if (e1 || !cleaned) return;
    git(["ls-files", "-s", "--", DECK_FILE], (e2, entry) => {
      const staged = entry.split(/\s+/)[1];
      if (!e2 && staged === cleaned) git(["add", "--", DECK_FILE], () => {});
    });
  });
  if (gitFilter === null) {
    git(["check-attr", "filter", "--", DECK_FILE], (err, out) => {
      gitFilter = !err && /: filter: pindeck-ids$/.test(out);
      if (gitFilter) run();
    });
  } else if (gitFilter) run();
}
function slideList() {
  const html = readDeck(DECK_FILE);
  return findSlides(parse(html)).map((s, index) => ({ index, eid: s.attrs["data-eid"]?.value || null }));
}
function resolveSlide(spec) {
  const slides = slideList();
  if (!spec || spec === "current") return slides[state.current?.index ?? 0] || slides[0];
  if (/^\d+$/.test(spec)) return slides[+spec - 1];
  return slides.find((s) => s.eid === spec) || slides.find((s) => s.eid && s.eid.startsWith(spec));
}

/* ---- Headless Chrome (screenshots, and layout when no editor tab is open) --------------- */
const CHROME = [process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p));
/* Headless Chrome on macOS often lingers long after it has written its output, so we
   watch the output and stop Chrome as soon as `done(stdout, stderr)` says we have it. */
let chromeSeq = 0;
function chrome(args, done) {
  if (!CHROME) return Promise.reject(new Error("No Chrome/Chromium found (set CHROME_BIN)."));
  return new Promise((resolve, reject) => {
    // a profile per run: concurrent runs must not share one
    const profile = path.join(STATE_DIR, "chrome", `p${process.pid}-${++chromeSeq}`);
    const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--mute-audio", `--user-data-dir=${profile}`,
      "--window-size=1280,720", "--force-device-scale-factor=1", "--virtual-time-budget=5000", ...args]);
    let out = "", err = "", finished = false;
    const finish = (fn, v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      proc.kill("SIGKILL");
      setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 500);
      fn(v);
    };
    const check = () => { if (done(out, err)) finish(resolve, out); };
    proc.stdout.on("data", (d) => { out += d; check(); });
    proc.stderr.on("data", (d) => { err += d; check(); });
    proc.on("error", (e) => finish(reject, e));
    proc.on("exit", () => (done(out, err) ? finish(resolve, out) : finish(reject, new Error("Chrome exited without output."))));
    const timer = setTimeout(() => finish(reject, new Error("Chrome timed out.")), 25000);
  });
}
const deckUrl = (mode, params = {}) =>
  `${ORIGIN}/deck/${DECK_FILE}?` + new URLSearchParams({ editor: mode, showHiddenSlides: "true", ...params });
async function takeShot(slide) {
  const pins = state.pins.filter((p) => p.slide.eid === slide.eid).map((p) => ({ n: p.n, eid: p.eid, at: p.at, point: p.point }));
  const out = path.join(SHOT_DIR, `${slide.eid.replace(/[^\w-]/g, "_")}-${Date.now()}.png`);
  await chrome([`--screenshot=${out}`, deckUrl("shot", { slide: slide.eid, pins: JSON.stringify(pins) })],
    (_o, err) => /bytes written to file/.test(err) && fs.existsSync(out));
  if (!fs.existsSync(out)) throw new Error("Chrome did not write the screenshot.");
  // keep the folder small
  const old = fs.readdirSync(SHOT_DIR).map((f) => path.join(SHOT_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(40);
  old.forEach((f) => fs.rmSync(f, { force: true }));
  return out;
}
async function measureHeadless(slide) {
  const dom = await chrome(["--dump-dom", deckUrl("dump", { slide: slide.eid })], (o) => /<\/html>\s*$/i.test(o));
  const m = /<script id="__editor_layout" type="application\/json">([\s\S]*?)<\/script>/.exec(dom);
  if (!m) throw new Error("Headless layout measurement failed.");
  const r = JSON.parse(m[1]);
  if (r.error) throw new Error(r.error);
  return r;
}

/* Measuring in the editor tab is fast and is exactly what the user sees. */
const pending = new Map();
let measureSeq = 0;
function measureInEditor(slide) {
  if (!clients.size) return Promise.reject(new Error("no editor tab"));
  const id = ++measureSeq;
  broadcast("measure", { id, index: slide.index, eid: slide.eid });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error("editor did not answer")); }, 8000);
    pending.set(id, { resolve, reject, t });
  });
}
const measure = (slide) => measureInEditor(slide).catch(() => measureHeadless(slide));

/* PDF export. handout: one page per slide, build steps in their final state.
   presentation: one page per build step (a slide with two clicks gives three pages).
   Files go to <deck>/export/. One export at a time. */
let exportQueue = Promise.resolve(), snapSeq = 0;
const snapshots = new Map();   // id -> static print layout, served at /deck/__pindeck-print-<id>.html
function exportPdf(kind, includeHidden = false) {
  if (!CHROME) return Promise.reject(new Error("PDF export needs Chrome or Chromium (set CHROME_BIN)."));
  const split = kind === "presentation";
  const name = `${path.basename(DECK_DIR)}-${split ? "presentation" : "handout"}.pdf`;
  const out = path.join(DECK_DIR, "export", name);
  const profile = (step) => path.join(STATE_DIR, "chrome", `pdf-${process.pid}-${Date.now()}-${step}`);
  const run = async () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const html = await printLayout(CHROME,
      `${ORIGIN}/deck/${DECK_FILE}?editor=pdf&print-pdf&pdfSeparateFragments=${split}&showHiddenSlides=${!!includeHidden}`, profile("layout"));
    const id = `${process.pid}-${++snapSeq}`;
    snapshots.set(id, html);
    try { await printPdf(CHROME, `${ORIGIN}/deck/__pindeck-print-${id}.html`, out, profile("print")); }
    finally { snapshots.delete(id); }
    return { kind: split ? "presentation" : "handout", path: out, rel: path.relative(DECK_DIR, out),
      url: `/deck/export/${encodeURIComponent(name)}`, bytes: fs.statSync(out).size };
  };
  const job = exportQueue.then(run, run);
  exportQueue = job.catch(() => {});
  return job;
}

/* ---- Chat state and the Claude Code session --------------------------------------------- */
const CHAT_FILE = path.join(STATE_DIR, "chat.json");
const state = {
  chat: [], seq: 0, busy: false, model: MODEL || null, sessionId: null,
  turns: [], redo: [], turn: null, notes: [], pins: [], current: null,
  uploads: new Set(),   // files uploaded for the next message; removable until it is sent
};
try {
  const saved = JSON.parse(fs.readFileSync(CHAT_FILE, "utf8"));
  Object.assign(state, { chat: saved.chat || [], seq: saved.seq || 0, sessionId: saved.sessionId || null });
} catch {}
const saveChat = () => fs.writeFile(CHAT_FILE,
  JSON.stringify({ chat: state.chat.slice(-400), seq: state.seq, sessionId: state.sessionId }), () => {});
function addEntry(entry) {
  entry.id = ++state.seq;
  entry.time = Date.now();
  state.chat.push(entry);
  broadcast("chat", entry);
  saveChat();
  return entry;
}
const liveTurns = () => state.turns.filter((t) => !t.undone);
const changeLabel = (t) => (t ? (t.kind === "manual" ? t.label : "Claude's change") : null);
/* Model and effort for the Claude Code session. ~/.pindeck/config.json holds them: PinDeck creates it
   with the defaults below, you can edit it, and a choice in the chat header's menu is saved there too,
   so the file always shows what PinDeck uses. --model on the command line applies to one run only. */
const MODELS = ["opus", "sonnet"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULTS = { model: "sonnet", effort: "medium" };
const CONFIG_FILE = path.join(HOME_DIR, "config.json");
const settings = { ...DEFAULTS };
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
catch (e) { if (e.code !== "ENOENT") console.warn(`${CONFIG_FILE} is not valid JSON; using the defaults.`); }
if (MODELS.includes(fileConfig.model)) settings.model = fileConfig.model;
else if (fileConfig.model !== undefined) console.warn(`config.json: unknown model "${fileConfig.model}" (use ${MODELS.join(" or ")}); using ${DEFAULTS.model}.`);
if (EFFORTS.includes(fileConfig.effort)) settings.effort = fileConfig.effort;
else if (fileConfig.effort !== undefined) console.warn(`config.json: unknown effort "${fileConfig.effort}" (use ${EFFORTS.join(", ")}); using ${DEFAULTS.effort}.`);
const saveSettings = () => fs.writeFile(CONFIG_FILE, JSON.stringify({ ...fileConfig, model: settings.model, effort: settings.effort }, null, 2) + "\n", () => {});
if (fileConfig.model !== settings.model || fileConfig.effort !== settings.effort) saveSettings();   // create or complete the file
if (MODEL) settings.model = MODEL;   // --model on the command line: this run only, not saved

const status = () => ({ busy: state.busy, model: state.model, sessionId: state.sessionId, settings: { ...settings },
  running: session.running, deck: DECK_DIR, deckFile: DECK_FILE, chrome: !!CHROME,
  undo: changeLabel(liveTurns().at(-1)), redo: changeLabel(state.redo.at(-1)) });
const pushStatus = () => broadcast("status", status());

const systemPrompt = fs.readFileSync(path.join(EDITOR_DIR, "lib/system-prompt.md"), "utf8")
  .replaceAll("{{CLI}}", CLI_CMD);
let stderrTail = "";
const session = new ClaudeSession({
  cwd: DECK_DIR,
  env: { DECK_EDITOR_URL: ORIGIN, DECK_EDITOR_TOKEN: TOKEN },
  args: () => [
    "--append-system-prompt", systemPrompt,
    "--permission-mode", "default",
    "--allowedTools", "Read", "Glob", "Grep", ...EDITABLE.map((f) => `Edit(./${f})`), `Bash(${CLI_CMD}:*)`,
    "--disallowedTools", ...LOCKED.flatMap((f) => [`Edit(./${f})`, `Write(./${f})`]),
    ...(settings.model ? ["--model", settings.model] : []),
    ...(settings.effort ? ["--effort", settings.effort] : []),
  ],
  onStderr: (s) => { stderrTail = (stderrTail + s).slice(-2000); },
  onEvent: handleEvent,
  onExit: (code, signal) => {
    if (state.busy) finishTurn({ error: `Claude Code stopped (${signal || "exit " + code}). ${stderrTail.trim().split("\n").pop() || ""}` });
    pushStatus();
  },
});
function ensureSession() {
  if (!session.running) { stderrTail = ""; session.start(state.sessionId); pushStatus(); }
}

function toolSummary(name, input = {}) {
  const base = (p) => (p ? path.relative(DECK_DIR, p) || path.basename(p) : "");
  switch (name) {
    case "Read": return { name: "Read", detail: base(input.file_path) };
    case "Edit": case "MultiEdit": case "Write": return { name: "Edit", detail: base(input.file_path) };
    case "Bash": {
      const cmd = String(input.command || "");
      const m = cmd.match(/cli\.mjs["']?\s+(\w+)\s*(.*)$/);
      return m ? { name: m[1] === "shot" ? "Screenshot" : m[1] === "layout" ? "Check layout" : m[1], detail: m[2].trim() }
               : { name: "Run", detail: cmd.slice(0, 80) };
    }
    case "Glob": case "Grep": return { name, detail: input.pattern || "" };
    default: return { name, detail: "" };
  }
}
const toolEntries = new Map(); // tool_use_id -> entry
function handleEvent(ev) {
  if (ev.type === "system" && ev.subtype === "init") {
    state.model = ev.model || state.model;
    state.sessionId = ev.session_id;
    saveChat();
    pushStatus();
  } else if (ev.type === "assistant" && state.turn) {
    for (const b of ev.message?.content || []) {
      if (b.type === "text" && b.text.trim()) addEntry({ kind: "assistant", text: b.text.trim() });
      if (b.type === "tool_use") toolEntries.set(b.id, addEntry({ kind: "tool", ...toolSummary(b.name, b.input) }));
    }
  } else if (ev.type === "user" && state.turn) {
    for (const b of ev.message?.content || []) {
      if (b.type === "tool_result" && b.is_error) {
        const e = toolEntries.get(b.tool_use_id);
        const msg = (Array.isArray(b.content) ? b.content.map((c) => c.text || "").join(" ") : String(b.content || "")).slice(0, 200);
        if (e) { e.error = msg; broadcast("chat-update", e); }
      }
    }
  } else if (ev.type === "result" && state.turn) {
    finishTurn({
      error: ev.is_error && ev.subtype !== "success" ? (ev.subtype === "error_during_execution" ? "Stopped." : ev.result || ev.subtype) : null,
      cost: ev.total_cost_usd, duration: ev.duration_ms,
      denials: (ev.permission_denials || []).map((d) => toolSummary(d.tool_name, d.tool_input)),
    });
  }
}

function startTurn(promptText, userEntry) {
  state.turn = { id: userEntry.id, before: snapshot([...EDITABLE, ...LOCKED]) };
  state.busy = true;
  pushStatus();
  ensureSession();
  session.send([{ type: "text", text: promptText }]);
}

function finishTurn({ error, cost, duration, denials = [] }) {
  const turn = state.turn;
  state.turn = null;
  state.busy = false;
  if (!turn) return pushStatus();
  // Lock 2: restore any locked file that changed during the turn
  const restored = [];
  for (const f of LOCKED) {
    const now = readDeck(f);
    if (turn.before[f] != null && now !== turn.before[f]) { writeDeck(f, turn.before[f]); restored.push(f); }
  }
  const eid = runEidPass();
  const after = snapshot(EDITABLE);
  const files = EDITABLE.map((f) => {
    const d = unifiedDiff(turn.before[f] ?? "", after[f] ?? "", f);
    return { file: f, added: d.added, removed: d.removed };
  }).filter((f) => f.added || f.removed);
  const t = { id: turn.id, kind: "claude", before: turn.before, after, files, undone: false };
  if (files.length) { state.turns.push(t); state.redo = []; }
  addEntry({ kind: "turn", turnId: files.length ? t.id : null, files, error, cost, duration,
    denials, restored, newIds: eid.assigned.length });
  pushStatus();
}

/* ---- Attachments: figures and audio added to a chat message -------------------------------------- */
const ATTACH_TYPES = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"],
  audio: ["wav", "mp3", "ogg", "oga", "m4a", "aac", "flac", "opus"],
};
const ATTACH_MAX = 100 * 1024 * 1024;
const attachKind = (name) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  return Object.keys(ATTACH_TYPES).find((k) => ATTACH_TYPES[k].includes(ext)) || null;
};
/* A clean, unused file name in figures/: "My Figure (2).PNG" -> "figures/my-figure-2.png" */
function attachPath(original) {
  const ext = path.extname(original).toLowerCase();
  const base = path.basename(original, path.extname(original)).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  let rel = `figures/${base}${ext}`, k = 2;
  while (fs.existsSync(path.join(DECK_DIR, rel))) rel = `figures/${base}-${k++}${ext}`;
  return rel;
}
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
function formatAttachment(a) {
  if (a.kind === "image")
    return `- ${a.path}: image${a.width ? `, ${a.width} × ${a.height} px` : ""}, ${kb(a.bytes)}` +
      (/\.(png|jpe?g|gif|webp)$/i.test(a.path) ? ". Read it directly to see it (no resizing needed)." : a.path.endsWith(".svg") ? " (SVG, readable as text)." : ".");
  const meta = [a.duration ? `${a.duration.toFixed(1)} s` : "", a.sampleRate ? `${Math.round(a.sampleRate / 1000)} kHz` : "",
    a.channels ? (a.channels === 1 ? "mono" : `${a.channels} channels`) : "", kb(a.bytes)].filter(Boolean).join(", ");
  return `- ${a.path}: audio, ${meta}` + (a.waveform ? `; waveform image ${a.waveform} (bars, viewBox 1000 × 120) for an audio player with waveform.` : ".");
}
const formatDrop = (a) => (a.droppedAt?.slide ? ` Dropped onto slide ${a.droppedAt.slide.index + 1} (${a.droppedAt.slide.eid}) at ` +
  `x=${a.droppedAt.point.x} y=${a.droppedAt.point.y}${a.droppedAt.eid ? `, over ${a.droppedAt.eid}` : ""}: probably where the user wants it.` : "");

function buildPrompt({ text: userText, pins = [], selection, layouts = [], current, screenshot, attachments = [] }) {
  const ctx = [];
  if (current) ctx.push(`The user is looking at slide ${current.index + 1} (${current.eid}).`);
  if (state.notes.length) {
    const notes = state.notes.slice(-15);
    if (state.notes.length > notes.length) ctx.push(`Note: ${state.notes.length - notes.length} earlier changes are not listed; re-read the files.`);
    ctx.push(...notes.map((n) => "Note: " + n));
    state.notes = [];
  }
  if (selection) ctx.push(`Selected element (what "this" or "it" most likely refers to): ${selection.eid} (${selection.tag}), ` +
    `box x=${selection.box.x} y=${selection.box.y} w=${selection.box.w} h=${selection.box.h} on slide ${selection.slide.index + 1}.`);
  if (pins.length) ctx.push("Pins (numbered clicks; the user refers to them by number):\n" + pins.map(formatPin).join("\n"));
  for (const L of layouts) ctx.push("Layout:\n" + formatLayout(L));
  if (screenshot) ctx.push(`Screenshot of slide ${screenshot.slide} with the pin markers: ${screenshot.path} (Read it).`);
  if (attachments.length) ctx.push("Attached files (the user added them to this message; they are saved in the deck folder, " +
    "use these paths relative to index.html):\n" + attachments.map((a) => formatAttachment(a) + formatDrop(a)).join("\n"));
  return (ctx.length ? `<editor-context>\n${ctx.join("\n\n")}\n</editor-context>\n\n` : "") + userText;
}

/* ---- File watching -------------------------------------------------------------------------- */
let changed = new Set(), flush = null, eidTimer = null;
fs.watch(DECK_DIR, { recursive: true }, (_ev, file) => {
  if (!file || /(^|\/)\.|\.bak$|~$|^export[\/]/.test(file)) return;
  changed.add(file.split(path.sep).join("/"));
  clearTimeout(flush);
  flush = setTimeout(() => {
    const files = [...changed];
    changed = new Set();
    let external = false, manual = true;
    for (const f of files) {
      const c = readDeck(f);
      const w = ourWrites.get(f);
      if (c != null && w && w.hash === hash(c)) { if (!w.manual) manual = false; continue; }
      manual = false;
      if (EDITABLE.includes(f) && !state.busy) external = true;
    }
    if (external) {
      state.notes = [...new Set([...state.notes,
        "The deck files changed outside this chat since your last turn (edited by hand or by another tool). Re-read before editing."])];
      // new elements from a hand edit get ids once the file is quiet
      clearTimeout(eidTimer);
      eidTimer = setTimeout(() => { if (!state.busy) runEidPass(); }, 800);
    }
    // manual: only drag/resize writes, which the browser already shows; no reload of the visible slide
    broadcast("files", { files, manual });
  }, 120);
});

/* ---- Hand edits ----------------------------------------------------------------------------------------- */
function recordHandEdit(before, html, label, note, { manual = true, deletedFiles = [], chat = true } = {}) {
  writeDeck(DECK_FILE, html, manual);
  const after = snapshot(EDITABLE);
  const d = unifiedDiff(before[DECK_FILE], after[DECK_FILE], DECK_FILE);
  const t = { id: state.seq + 1, kind: "manual", label, before, after, deletedFiles,
    files: [{ file: DECK_FILE, added: d.added, removed: d.removed }], undone: false };
  state.turns.push(t);
  state.redo = [];
  // chat: false keeps the edit out of the chat (it stays in the undo history and Claude is still told)
  if (chat) addEntry({ kind: "edit", turnId: t.id, label, files: t.files });
  else state.seq++;   // keep turn ids unique: they share the counter with chat entries
  state.notes.push(note);
  pushStatus();
  return t.id;
}

/* What deleting an element would remove, and which of its files nothing else uses. Files outside the
   deck folder, in vendor/, or still referenced elsewhere (index.html, theme.css) are never offered. */
function deletePlan(eid) {
  const html = readDeck(DECK_FILE);
  const target = deleteTarget(html, eid);
  if (!target) return null;
  const rest = removeElement(html, target.eid);
  const css = (readDeck("theme.css") || "") + (readDeck("brand.css") || "");
  const files = fileRefs(target.outer).flatMap((ref) => {
    const abs = path.resolve(DECK_DIR, ref);
    const rel = path.relative(DECK_DIR, abs).split(path.sep).join("/");
    if (rel.startsWith("..") || rel.startsWith("vendor/") || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [];
    const usedElsewhere = fileRefs(rest).some((r) => path.resolve(DECK_DIR, r) === abs) || css.includes(ref) || css.includes(rel);
    return [{ rel, bytes: fs.statSync(abs).size, usedElsewhere }];
  });
  return { ...target, html: rest, files };
}

/* ---- Undo (Claude's turns and hand edits share one history) ---------------------------------------- */
function undo(res) {
  if (state.busy) return json(res, 409, { error: "Wait until Claude has finished." });
  const t = liveTurns().at(-1);
  if (!t) return json(res, 409, { error: "Nothing to undo." });
  const edited = EDITABLE.some((f) => readDeck(f) !== t.after[f]);
  for (const f of EDITABLE) if (t.before[f] != null && readDeck(f) !== t.before[f]) writeDeck(f, t.before[f]);
  for (const { rel, data } of t.deletedFiles || []) {   // files deleted with an element come back too
    fs.mkdirSync(path.dirname(path.join(DECK_DIR, rel)), { recursive: true });
    fs.writeFileSync(path.join(DECK_DIR, rel), data);
  }
  t.undone = true;
  state.redo.push(t);
  state.notes.push(t.kind === "manual"
    ? `The user undid their hand edit (${t.label}); ${DECK_FILE} is back to the state before it.`
    : `The user undid your change from turn ${t.id}; ${t.files.map((f) => f.file).join(" and ")} are back to the state before it. Re-read before editing.`);
  broadcast("undone", { turnId: t.id, undone: true });
  if (edited) addEntry({ kind: "notice", text: "Undone. Edits made after that change were reverted too." });
  pushStatus();
  return json(res, 200, {});
}

/* ---- HTTP ------------------------------------------------------------------------------------- */
const BRIDGE_TAG = `<script src="/editor/bridge.js"></script>\n</body>`;


function serveFile(res, file, transform) {
  fs.readFile(file, (err, data) => {
    if (err) return text(res, 404, "Not found");
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(transform ? transform(String(data)) : data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  try {
    // UI and deck files (read-only)
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return serveFile(res, path.join(EDITOR_DIR, "public/index.html"), (s) => s.replace("%%TOKEN%%", TOKEN));
    if (req.method === "GET" && p.startsWith("/editor/")) {
      const f = safeJoin(path.join(EDITOR_DIR, "public"), p.slice(8));
      return f ? serveFile(res, f) : text(res, 403, "Forbidden");
    }
    let snap;
    if (req.method === "GET" && (snap = p.match(/^\/deck\/__pindeck-print-([\w-]+)\.html$/))) {
      const html = snapshots.get(snap[1]);
      if (!html) return text(res, 404, "Not found");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && p.startsWith("/deck/")) {
      const f = safeJoin(DECK_DIR, p.slice(6) || DECK_FILE);
      if (!f) return text(res, 403, "Forbidden");
      const mode = url.searchParams.get("editor");
      if (!mode || !f.endsWith(".html")) return serveFile(res, f);
      return serveFile(res, f, (s) => {
        // headless runs must not stream media, or Chrome never finishes the page
        if (mode === "shot" || mode === "dump" || mode === "pdf") s = s.replace(/\bpreload="(auto|metadata)"/g, 'preload="none"');
        if (mode === "pdf") return s.replace(/<\/head>/i, PDF_HEAD_TAG).replace(/<\/body>/i, PDF_PAGE_TAG);
        return s.replace(/<\/body>/i, BRIDGE_TAG);
      });
    }

    // API: token required; POSTs must come from the editor page itself
    if (!p.startsWith("/api/")) return text(res, 404, "Not found");
    const tok = req.headers["x-editor-token"] || url.searchParams.get("t");
    if (tok !== TOKEN) return text(res, 403, "Bad token");
    const origin = req.headers.origin;
    if (req.method === "POST" && origin && origin !== ORIGIN && origin !== `http://localhost:${PORT}`)
      return text(res, 403, "Bad origin");

    if (p === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ chat: state.chat, status: status(),
        turns: state.turns.map((t) => ({ id: t.id, undone: t.undone })) })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/ping") return json(res, 200, { ok: true });
    if (p === "/api/current" && req.method === "POST") { state.current = await body(req); return json(res, 200, {}); }
    if (p === "/api/pins" && req.method === "POST") { state.pins = (await body(req)).pins || []; return json(res, 200, {}); }
    if (p === "/api/measure-result" && req.method === "POST") {
      const b = await body(req);
      const w = pending.get(b.id);
      if (w) { pending.delete(b.id); clearTimeout(w.t); b.error ? w.reject(new Error(b.error)) : w.resolve(b.result); }
      return json(res, 200, {});
    }

    if (p === "/api/message" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is still working." });
      const b = await body(req);
      if (!b.text?.trim()) return json(res, 400, { error: "Empty message." });
      let screenshot = null;
      const shotSlide = typeof b.screenshot === "object" && b.screenshot?.eid ? b.screenshot : b.screenshot ? b.current : null;
      if (shotSlide) {
        try { screenshot = { slide: shotSlide.index + 1, path: await takeShot(shotSlide) }; }
        catch (e) { addEntry({ kind: "notice", text: "Screenshot failed: " + e.message }); }
      }
      const label = (p) => (p.tag?.startsWith("footer") ? "footer" : p.eid === p.slide.eid ? "slide" : p.eid.replace(/^[^/]+\//, ""));
      // only files PinDeck itself stored can be attached
      b.attachments = (b.attachments || []).filter((a) => a && state.uploads.has(a.path) && fs.existsSync(path.join(DECK_DIR, a.path)));
      b.attachments.forEach((a) => { state.uploads.delete(a.path); if (a.waveform) state.uploads.delete(a.waveform); });
      const entry = addEntry({ kind: "user", text: b.text, screenshot: !!screenshot,
        attachments: b.attachments.map((a) => ({ path: a.path, kind: a.kind, name: a.name })),
        selection: b.selection ? { eid: b.selection.eid, label: b.selection.eid.replace(/^[^/]+\//, ""), slide: b.selection.slide.index + 1 } : null,
        pins: (b.pins || []).map((p) => ({ n: p.n, eid: p.eid, label: label(p), slide: p.slide.index + 1 })) });
      startTurn(buildPrompt({ ...b, screenshot }), entry);
      return json(res, 200, { id: entry.id });
    }
    if (p === "/api/upload" && req.method === "POST") {
      const original = decodeURIComponent(String(req.headers["x-filename"] || "file"));
      const kind = attachKind(original);
      if (!kind) return json(res, 415, { error: `Only images (${ATTACH_TYPES.image.join(", ")}) and audio (${ATTACH_TYPES.audio.join(", ")}) can be attached.` });
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > ATTACH_MAX) return json(res, 413, { error: `${original} is larger than ${kb(ATTACH_MAX)}.` });
        chunks.push(c);
      }
      const buf = Buffer.concat(chunks);
      const rel = attachPath(original);
      fs.mkdirSync(path.join(DECK_DIR, "figures"), { recursive: true });
      ourWrites.set(rel, { hash: hash(buf.toString("utf8")), manual: true });   // no slide reload for a new file
      fs.writeFileSync(path.join(DECK_DIR, rel), buf);
      state.uploads.add(rel);
      return json(res, 200, { path: rel, kind, bytes: buf.length, url: `/deck/${rel}` });
    }
    if (p === "/api/upload-remove" && req.method === "POST") {
      const b = await body(req);
      for (const rel of [b.path, b.waveform].filter(Boolean)) {
        if (!state.uploads.has(rel)) continue;   // only unsent uploads, never other deck files
        state.uploads.delete(rel);
        fs.rmSync(path.join(DECK_DIR, rel), { force: true });
      }
      return json(res, 200, {});
    }
    if (p === "/api/settings" && req.method === "POST") {
      const b = await body(req);
      const model = b.model ?? settings.model, effort = b.effort ?? settings.effort;
      if (!MODELS.includes(model) || !EFFORTS.includes(effort)) return json(res, 400, { error: "Unknown model or effort." });
      if (model === settings.model && effort === settings.effort) return json(res, 200, { settings });
      if (state.busy) return json(res, 409, { error: "Wait until Claude has finished, then change the model or effort." });
      Object.assign(settings, { model, effort });
      saveSettings();
      // restart the session with the new flags; --resume keeps the conversation
      if (session.running) { session.stop(); setTimeout(ensureSession, 300); }
      addEntry({ kind: "notice", text: `Model: ${model[0].toUpperCase() + model.slice(1)}, effort: ${effort}. The conversation continues.` });
      pushStatus();
      return json(res, 200, { settings });
    }
    if (p === "/api/slide-hidden" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const before = snapshot(EDITABLE);
      const slides = findSlides(parse(before[DECK_FILE]));
      const index = slides.findIndex((s) => s.attrs["data-eid"]?.value === b.eid);
      if (index < 0) return json(res, 404, { error: "Slide not found in the file." });
      const r = setAttr(before[DECK_FILE], b.eid, "data-visibility", b.hidden ? "hidden" : null);
      if (!r.changed) return json(res, 200, { unchanged: true });
      const turnId = recordHandEdit(before, r.html, `${b.hidden ? "Hid" : "Showed"} slide ${index + 1}`,
        `The user ${b.hidden ? "hid" : "showed again"} slide ${index + 1} (${b.eid}). Hidden slides carry ` +
        `data-visibility="hidden": they stay in the file but are skipped when presenting and in PDF exports.`,
        { manual: true, chat: false });   // the editor reloads the slide itself; undo is in the toolbar
      return json(res, 200, { turnId, index });
    }
    if (p === "/api/add-slide" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      if (!["content", "section", "duplicate"].includes(b.kind)) return json(res, 400, { error: "Unknown slide kind." });
      const before = snapshot(EDITABLE);
      const r = insertSlide(before[DECK_FILE], b.kind, b.after);
      if (r.error) return json(res, 409, { error: r.error });
      const html = assignEids(r.html).html;
      const slide = findSlides(parse(html))[r.index];
      const eid = slide.attrs["data-eid"].value;
      const what = { content: "content slide", section: "section divider", duplicate: "copy of the slide" }[b.kind];
      const turnId = recordHandEdit(before, html, `Added a ${what} (slide ${r.index + 1})`,
        `The user added a ${what} as slide ${r.index + 1} (${eid})` + (b.kind === "duplicate" ? `, a copy of ${b.after}.` : " with placeholder text."),
        { manual: true });   // the editor reloads itself and opens the new slide; no second reload from the watcher
      return json(res, 200, { turnId, index: r.index, eid });
    }
    if (p === "/api/stop" && req.method === "POST") {
      if (state.busy && session.running) {
        session.interrupt();
        setTimeout(() => { if (state.busy) { session.stop(); } }, 5000); // force if it does not answer
      }
      return json(res, 200, {});
    }
    if (p === "/api/new-chat" && req.method === "POST") {
      session.stop();
      Object.assign(state, { chat: [], sessionId: null, turns: [], redo: [], turn: null, busy: false, notes: [] });
      saveChat();
      broadcast("reset", { chat: [] });
      ensureSession();
      pushStatus();
      return json(res, 200, {});
    }
    let m;
    if ((m = p.match(/^\/api\/turn\/(\d+)\/diff$/))) {
      const t = state.turns.find((t) => t.id === +m[1]);
      if (!t) return text(res, 404, "No such change");
      return text(res, 200, EDITABLE.map((f) => unifiedDiff(t.before[f] ?? "", t.after[f] ?? "", f).text).filter(Boolean).join("\n\n"));
    }
    if ((m = p.match(/^\/api\/turn\/(\d+)\/undo$/)) && req.method === "POST") {
      const t = liveTurns().at(-1);
      if (t && t.id !== +m[1]) return json(res, 409, { error: "Only the most recent change can be undone." });
      return undo(res);
    }
    if (p === "/api/undo" && req.method === "POST") return undo(res);
    if (p === "/api/redo" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Wait until Claude has finished." });
      const t = state.redo.at(-1);
      if (!t) return json(res, 409, { error: "Nothing to redo." });
      if (EDITABLE.some((f) => (readDeck(f) ?? null) !== (t.before[f] ?? null))) {
        state.redo = [];
        pushStatus();
        return json(res, 409, { error: "The files changed since the undo, so it cannot be redone." });
      }
      state.redo.pop();
      for (const f of EDITABLE) if (t.after[f] != null) writeDeck(f, t.after[f]);
      for (const { rel } of t.deletedFiles || []) fs.rmSync(path.join(DECK_DIR, rel), { force: true });
      t.undone = false;
      state.notes.push(t.kind === "manual" ? `The user redid their hand edit: ${t.label}.`
        : `The user redid your change from turn ${t.id} after undoing it.`);
      broadcast("undone", { turnId: t.id, undone: false });
      pushStatus();
      return json(res, 200, {});
    }

    // Delete an element (and, if the user agrees, the files only it uses)
    if (p === "/api/delete-info") {
      const plan = deletePlan(url.searchParams.get("eid"));
      if (!plan) return json(res, 404, { error: "Element not found in the file." });
      return json(res, 200, { eid: plan.eid, tag: plan.tag, files: plan.files });
    }
    if (p === "/api/delete" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const plan = deletePlan(b.eid);
      if (!plan) return json(res, 404, { error: "Element not found in the file." });
      const before = snapshot(EDITABLE);
      const wanted = new Set(b.files || []);
      const deletedFiles = plan.files.filter((f) => wanted.has(f.rel) && !f.usedElsewhere)
        .map((f) => ({ rel: f.rel, data: fs.readFileSync(path.join(DECK_DIR, f.rel)) }));
      const short = plan.eid.replace(/^[^/]+\//, "/");
      const label = `Deleted ${short}` + (deletedFiles.length ? ` and ${deletedFiles.map((f) => f.rel).join(", ")}` : "");
      const turnId = recordHandEdit(before, plan.html, label,
        `The user deleted ${plan.eid} (${plan.tag}) by hand` + (deletedFiles.length ? `, together with the file(s) ${deletedFiles.map((f) => f.rel).join(", ")}` : "") + ".",
        { manual: false, deletedFiles });
      for (const f of deletedFiles) fs.rmSync(path.join(DECK_DIR, f.rel), { force: true });
      return json(res, 200, { turnId, deleted: plan.eid, files: deletedFiles.map((f) => f.rel) });
    }

    // Hand edits from the editor: drag/resize (inline styles) and text
    if (p === "/api/edit" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const before = snapshot(EDITABLE);
      const r = setStyles(before[DECK_FILE], b.ops || []);
      if (r.missing.length) return json(res, 404, { error: `No element ${r.missing.join(", ")} in ${DECK_FILE}.` });
      if (!r.changed) return json(res, 200, { unchanged: true });
      const label = String(b.label || "Edited layout").slice(0, 200);
      const turnId = recordHandEdit(before, r.html, label,
        `The user edited the layout by hand: ${label}. This is an inline style on the element in ${DECK_FILE}.`);
      return json(res, 200, { turnId });
    }
    if (p === "/api/source") {
      const html = getInner(readDeck(DECK_FILE), url.searchParams.get("eid"), JSON.parse(url.searchParams.get("path") || "[]"));
      return html == null ? json(res, 404, { error: "Element not found in the file." }) : json(res, 200, { html });
    }
    if (p === "/api/text" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const before = snapshot(EDITABLE);
      const r = setInner(before[DECK_FILE], b.eid, b.path || [], String(b.html ?? ""));
      if (!r) return json(res, 404, { error: `No element ${b.eid} in ${DECK_FILE}.` });
      if (!r.changed) return json(res, 200, { unchanged: true });
      const label = String(b.label || "Edited text").slice(0, 200);
      const where = b.eid + (b.path?.length ? ` (cell ${b.path.map((i) => i + 1).join("/")})` : "");
      const turnId = recordHandEdit(before, r.html, label,
        `The user edited the text of ${where} by hand. It now reads: "${String(b.text || "").slice(0, 300)}".`);
      return json(res, 200, { turnId });
    }

    // Enter in a bullet: the bullet keeps the text before the caret, a new bullet after it gets the rest
    if (p === "/api/split" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const before = snapshot(EDITABLE);
      const r1 = setInner(before[DECK_FILE], b.eid, [], String(b.html ?? ""));
      if (!r1) return json(res, 404, { error: `No element ${b.eid} in ${DECK_FILE}.` });
      const r2 = insertAfter(r1.html, b.eid, { tag: "li", cls: b.cls || "", inner: String(b.newHtml ?? ""), newEid: b.newEid });
      const short = (e) => e.replace(/^[^/]+\//, "/");
      const turnId = recordHandEdit(before, r2.html, `New bullet after ${short(b.eid)}`,
        `The user added a bullet (${r2.eid}) after ${b.eid} by pressing Enter while editing; ${b.eid} now reads "${String(b.text || "").slice(0, 200)}".`);
      return json(res, 200, { turnId, eid: r2.eid });
    }
    if (p === "/api/remove" && req.method === "POST") {
      if (state.busy) return json(res, 409, { error: "Claude is working. Wait until it has finished." });
      const b = await body(req);
      const before = snapshot(EDITABLE);
      const html = removeElement(before[DECK_FILE], b.eid);
      if (html == null) return json(res, 404, { error: `No element ${b.eid} in ${DECK_FILE}.` });
      const turnId = recordHandEdit(before, html, `Removed empty bullet ${b.eid.replace(/^[^/]+\//, "/")}`,
        `The user removed the empty bullet ${b.eid}.`);
      return json(res, 200, { turnId });
    }

    if (p === "/api/export" && req.method === "POST") {
      const b = await body(req);
      try { return json(res, 200, await exportPdf(b.kind, b.includeHidden)); }
      catch (e) { return json(res, 500, { error: String(e.message || e) }); }
    }

    // CLI endpoints (used by Claude Code via cli.mjs)
    if (p === "/api/pdf") {
      const kind = url.searchParams.get("slide") || url.searchParams.get("kind") || "handout";
      if (!["handout", "presentation"].includes(kind)) return text(res, 400, 'Use "handout" or "presentation".');
      const r = await exportPdf(kind, url.searchParams.get("all") === "1");
      return text(res, 200, r.path);
    }
    if (p === "/api/slides") {
      return text(res, 200, slideList().map((s) => `${String(s.index + 1).padStart(2)}  ${s.eid}`).join("\n"));
    }
    if (p === "/api/layout" || p === "/api/shot") {
      const slide = resolveSlide(url.searchParams.get("slide"));
      if (!slide) return text(res, 404, `No slide "${url.searchParams.get("slide")}". Use \`${CLI_CMD} slides\`.`);
      if (!slide.eid) runEidPass();
      const s2 = slide.eid ? slide : resolveSlide(String(slide.index + 1));
      if (p === "/api/shot") return text(res, 200, await takeShot(s2));
      return text(res, 200, formatLayout(await measure(s2)));
    }
    return text(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) text(res, 500, String(e.message || e));
  }
});

/* ---- Start ------------------------------------------------------------------------------------- */
const first = runEidPass();
if (first.changed) console.log(`Added ${first.assigned.length} element ids to ${DECK_FILE} (backup in ${path.join(STATE_DIR, "backups")}).`);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`PinDeck: ${ORIGIN}/`);
  console.log(`Deck: ${DECK_DIR}`);
  if (!CHROME) console.log("No Chrome found: screenshots are disabled (set CHROME_BIN).");
  ensureSession();
});
const quit = () => { session.stop(); setTimeout(() => process.exit(0), 300); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
