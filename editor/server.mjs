#!/usr/bin/env node
/* PinDeck: local server.

   pindeck [deck-dir] [--port 5180] [--model <name>]      (or: node server.mjs ...)

   - serves the editor UI and the deck (with a bridge script injected in edit mode)
   - pushes file changes to the browser (server-sent events) for live reload
   - runs one long-lived Claude Code process for the chat sidebar
   - snapshots files around every Claude turn for diffs and undo
   - answers `cli.mjs layout|shot|slides` for Claude's self-checks
   Listens on 127.0.0.1 only; every API call needs the per-run token.
   Runtime files (chat, screenshots, backups) live in ~/.pindeck, never in the deck or the package. */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assignEids, parse, findSlides } from "./lib/eids.mjs";
import { unifiedDiff } from "./lib/diff.mjs";
import { ClaudeSession } from "./lib/claude.mjs";
import { formatLayout, formatPin } from "./lib/layout.mjs";

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
// one-time move from the old location (editor/.state, before PinDeck became a package)
const OLD_STATE = path.join(EDITOR_DIR, ".state");
if (fs.existsSync(path.join(OLD_STATE, "chat.json")) && !fs.existsSync(path.join(STATE_DIR, "chat.json"))) {
  try {
    const old = JSON.parse(fs.readFileSync(path.join(OLD_STATE, "server.json"), "utf8"));
    if (path.resolve(old.deckDir || "") === DECK_DIR || path.basename(old.deckDir || "") === "audiolabs-template") {
      fs.copyFileSync(path.join(OLD_STATE, "chat.json"), path.join(STATE_DIR, "chat.json"));
      if (fs.existsSync(path.join(OLD_STATE, "backups")))
        fs.cpSync(path.join(OLD_STATE, "backups"), path.join(STATE_DIR, "backups"), { recursive: true });
      console.log(`Moved the chat history from ${OLD_STATE} to ${STATE_DIR}.`);
    }
  } catch {}
}
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
const ourWrites = new Map(); // file -> hash of content we wrote, to tell our writes from others
function writeDeck(f, content) {
  ourWrites.set(f, hash(content));
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
  }
  return r;
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
  `${ORIGIN}/deck/${DECK_FILE}?` + new URLSearchParams({ editor: mode, ...params });
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

/* ---- Chat state and the Claude Code session --------------------------------------------- */
const CHAT_FILE = path.join(STATE_DIR, "chat.json");
const state = {
  chat: [], seq: 0, busy: false, model: MODEL || null, sessionId: null,
  turns: [], turn: null, notes: [], pins: [], current: null,
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
const status = () => ({ busy: state.busy, model: state.model, sessionId: state.sessionId,
  running: session.running, deck: DECK_DIR, chrome: !!CHROME });
const pushStatus = () => broadcast("status", status());

const systemPrompt = fs.readFileSync(path.join(EDITOR_DIR, "lib/system-prompt.md"), "utf8")
  .replaceAll("{{CLI}}", CLI_CMD);
let stderrTail = "";
const session = new ClaudeSession({
  cwd: DECK_DIR,
  env: { DECK_EDITOR_URL: ORIGIN, DECK_EDITOR_TOKEN: TOKEN },
  args: [
    "--append-system-prompt", systemPrompt,
    "--permission-mode", "default",
    "--allowedTools", "Read", "Glob", "Grep", ...EDITABLE.map((f) => `Edit(./${f})`), `Bash(${CLI_CMD}:*)`,
    "--disallowedTools", ...LOCKED.flatMap((f) => [`Edit(./${f})`, `Write(./${f})`]),
    ...(MODEL ? ["--model", MODEL] : []),
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
      const m = cmd.match(/cli\.mjs\s+(\w+)\s*(.*)$/);
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
  const t = { id: turn.id, before: turn.before, after, files, undone: false };
  if (files.length) state.turns.push(t);
  addEntry({ kind: "turn", turnId: files.length ? t.id : null, files, error, cost, duration,
    denials, restored, newIds: eid.assigned.length });
  pushStatus();
}

function buildPrompt({ text: userText, pins = [], layouts = [], current, screenshot }) {
  const ctx = [];
  if (current) ctx.push(`The user is looking at slide ${current.index + 1} (${current.eid}).`);
  if (state.notes.length) { ctx.push(...state.notes.map((n) => "Note: " + n)); state.notes = []; }
  if (pins.length) ctx.push("Pins (numbered clicks; the user refers to them by number):\n" + pins.map(formatPin).join("\n"));
  for (const L of layouts) ctx.push("Layout:\n" + formatLayout(L));
  if (screenshot) ctx.push(`Screenshot of slide ${screenshot.slide} with the pin markers: ${screenshot.path} (Read it).`);
  return (ctx.length ? `<editor-context>\n${ctx.join("\n\n")}\n</editor-context>\n\n` : "") + userText;
}

/* ---- File watching -------------------------------------------------------------------------- */
let changed = new Set(), flush = null, eidTimer = null;
fs.watch(DECK_DIR, { recursive: true }, (_ev, file) => {
  if (!file || /(^|\/)\.|\.bak$|~$/.test(file)) return;
  changed.add(file.split(path.sep).join("/"));
  clearTimeout(flush);
  flush = setTimeout(() => {
    const files = [...changed];
    changed = new Set();
    let external = false;
    for (const f of files) {
      const c = readDeck(f);
      if (c != null && ourWrites.get(f) === hash(c)) continue;
      if (EDITABLE.includes(f) && !state.busy) external = true;
    }
    if (external) {
      state.notes = [...new Set([...state.notes,
        "The deck files changed outside this chat since your last turn (edited by hand or by another tool). Re-read before editing."])];
      // new elements from a hand edit get ids once the file is quiet
      clearTimeout(eidTimer);
      eidTimer = setTimeout(() => { if (!state.busy) runEidPass(); }, 800);
    }
    broadcast("files", { files });
  }, 120);
});

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
    if (req.method === "GET" && p.startsWith("/deck/")) {
      const f = safeJoin(DECK_DIR, p.slice(6) || DECK_FILE);
      if (!f) return text(res, 403, "Forbidden");
      const mode = url.searchParams.get("editor");
      if (!mode || !f.endsWith(".html")) return serveFile(res, f);
      return serveFile(res, f, (s) => {
        // headless runs must not stream media, or Chrome never finishes the page
        if (mode === "shot" || mode === "dump") s = s.replace(/\bpreload="(auto|metadata)"/g, 'preload="none"');
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
      if (b.screenshot && b.current) {
        try { screenshot = { slide: b.current.index + 1, path: await takeShot(b.current) }; }
        catch (e) { addEntry({ kind: "notice", text: "Screenshot failed: " + e.message }); }
      }
      const label = (p) => (p.tag?.startsWith("footer") ? "footer" : p.eid === p.slide.eid ? "slide" : p.eid.replace(/^[^/]+\//, ""));
      const entry = addEntry({ kind: "user", text: b.text, screenshot: !!screenshot,
        pins: (b.pins || []).map((p) => ({ n: p.n, eid: p.eid, label: label(p), slide: p.slide.index + 1 })) });
      startTurn(buildPrompt({ ...b, screenshot }), entry);
      return json(res, 200, { id: entry.id });
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
      Object.assign(state, { chat: [], sessionId: null, turns: [], turn: null, busy: false, notes: [] });
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
      if (state.busy) return json(res, 409, { error: "Wait until Claude has finished." });
      const live = state.turns.filter((t) => !t.undone);
      const t = live[live.length - 1];
      if (!t || t.id !== +m[1]) return json(res, 409, { error: "Only the most recent change can be undone." });
      const edited = EDITABLE.some((f) => readDeck(f) !== t.after[f]);
      for (const f of EDITABLE) if (t.before[f] != null && readDeck(f) !== t.before[f]) writeDeck(f, t.before[f]);
      t.undone = true;
      state.notes.push(`The user undid your change from turn ${t.id}; ${t.files.map((f) => f.file).join(" and ")} are back to the state before it. Re-read before editing.`);
      broadcast("undone", { turnId: t.id });
      if (edited) addEntry({ kind: "notice", text: "Undone. Edits made after that change were reverted too." });
      return json(res, 200, {});
    }

    // CLI endpoints (used by Claude Code via cli.mjs)
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
