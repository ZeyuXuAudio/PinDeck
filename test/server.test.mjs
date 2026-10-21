/* The server as a real process: supported-platform startup, capabilities, the Claude Code lifecycle with a
   fake claude (test/fixtures/fake-claude: no network, no AI), security checks, conflict-safe saves, Undo/Redo
   and the file watcher. Every test works on a fresh copy of ocean-example with its own PINDECK_HOME.

   Tests for a platform other than this machine's override process.platform; they check the code paths, not
   the platform. Linux support needs these tests to pass on real Linux (CI, or an approved test machine). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliCommand } from "../lib/capabilities.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, "server.mjs");
const FAKE_CLAUDE = path.join(ROOT, "test", "fixtures", "fake-claude");
const EXAMPLE = path.join(ROOT, "ocean-example");
const REAL = process.platform;
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/* A folder with a copy of the example deck (a name with spaces and quotes), state, a fake claude log and
   shims for macOS-only tools that record any call. */
function fixture(t, deckName = `deck with spaces 'and' "quotes"`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pindeck test "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deck = path.join(root, deckName);
  fs.cpSync(EXAMPLE, deck, { recursive: true });
  const shims = path.join(root, "shims");
  fs.mkdirSync(shims);
  for (const tool of ["osascript", "afconvert"]) {
    fs.writeFileSync(path.join(shims, tool), `#!/bin/sh\necho "$0 $*" >> "${path.join(root, "mac-tools.log")}"\nexit 1\n`, { mode: 0o755 });
  }
  return { root, deck, home: path.join(root, "state"), log: path.join(root, "claude.log"), shims,
    macTools: () => fs.existsSync(path.join(root, "mac-tools.log")) ? fs.readFileSync(path.join(root, "mac-tools.log"), "utf8") : "" };
}

function spawnServer(fx, { platform = REAL, env = {}, args = ["--port", "0"], deck = fx.deck } = {}) {
  const pre = [];
  if (platform !== REAL) {
    const preload = path.join(fx.root, `platform-${platform}.mjs`);
    fs.writeFileSync(preload, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`);
    pre.push("--import", preload);
  }
  const child = spawn(process.execPath, [...pre, SERVER, deck, ...args], {
    env: { ...process.env, PATH: `${fx.shims}${path.delimiter}${process.env.PATH}`, PINDECK_HOME: fx.home,
      CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: fx.log, CHROME_BIN: path.join(fx.root, "no-chrome"),
      PINDECK_LINUX_CHROME: "", CLAUDE_MODEL: "", PORT: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, exited, output: () => out + err };
}

async function startServer(t, fx, opts = {}) {
  const s = spawnServer(fx, opts);
  t.after(async () => {
    if (s.child.exitCode === null && s.child.signalCode === null) { s.child.kill("SIGKILL"); await s.exited; }
    for (const pid of fakePids(fx)) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  const url = await waitFor(() => /PinDeck: (http:\/\/127\.0\.0\.1:\d+)\//.exec(s.output())?.[1] ||
    (s.child.exitCode !== null && Promise.reject(new Error("server exited: " + s.output()))), "the server to start");
  const html = await (await fetch(url + "/")).text();
  const token = /name="editor-token" content="([0-9a-f]+)"/.exec(html)[1];
  const api = async (p, body, headers = {}) => {
    const res = await fetch(`${url}/api/${p}`, {
      method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "x-editor-token": token, "content-type": "application/json", ...headers } });
    const raw = await res.text();
    let data = raw;
    try { data = JSON.parse(raw); } catch {}
    return { status: res.status, data, rev: res.headers.get("x-deck-rev") };
  };
  return { ...s, url, token, api, port: +new URL(url).port };
}
const fakeLog = (fx) => fs.existsSync(fx.log) ? fs.readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const fakePids = (fx) => [...new Set(fakeLog(fx).filter((e) => e.event === "start").map((e) => e.pid))];
const firstSlideEid = (deck) => /<section[^>]*data-eid="([^"]+)"/.exec(fs.readFileSync(path.join(deck, "index.html"), "utf8"))[1];
const chatOf = (fx) => {
  const dir = path.join(fx.home, "decks");
  const f = path.join(dir, fs.readdirSync(dir)[0], "chat.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")).chat; } catch { return []; }
};
/* Another program edits the deck: a whole-file write, as most editors do */
function externalEdit(deck, file, fn) {
  const f = path.join(deck, file);
  fs.writeFileSync(f, fn(fs.readFileSync(f, "utf8")));
}
function raw(port, { method = "GET", p = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/* ---- Supported platforms ---------------------------------------------------------------------- */
for (const platform of ["linux", "darwin"]) {
  const mocked = platform !== REAL ? ` (process.platform mocked on ${REAL}: code path only)` : "";
  test(`${platform}${mocked}: starts with fake Claude and no Chrome; hand edits work`, async (t) => {
    const fx = fixture(t);
    const s = await startServer(t, fx, { platform });
    const st = (await s.api("status")).data;
    assert.equal(st.capabilities.platform, platform);
    assert.equal(st.capabilities.claude.available, true);
    assert.equal(st.chrome, false);
    assert.match(st.capabilities.screenshot.reason, /Chrome|CHROME_BIN/);
    assert.equal(st.capabilities.chromePath, undefined, "no executable paths in the status");
    assert.match(st.rev, /^[0-9a-f]{16}$/);

    // the fake claude runs in the deck, talks to this server, and gets PinDeck's narrow permissions
    const start = await waitFor(() => fakeLog(fx).find((e) => e.event === "start"), "claude to start");
    assert.equal(fs.realpathSync(start.cwd), fs.realpathSync(fx.deck));
    assert.equal(start.url, s.url);
    const a = start.argv;
    assert.equal(a[a.indexOf("--setting-sources") + 1], "");
    assert.ok(a.includes("--strict-mcp-config"));
    const rel = path.relative(fx.deck, path.join(ROOT, "cli.mjs")).split(path.sep).join("/");
    assert.ok(a.includes(`Bash(${cliCommand(rel)}:*)`), "the CLI permission is the one quoted command");
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    assert.deepEqual(allowed, ["Read", "Glob", "Grep", "Edit(./index.html)", "Edit(./theme.css)", `Bash(${cliCommand(rel)}:*)`],
      "no broader permissions");
    assert.deepEqual(a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--disallowedTools") + 3), ["Edit(./brand.css)", "Write(./brand.css)"]);

    // a hand edit (speaker notes) is saved into the deck copy
    const eid = firstSlideEid(fx.deck);
    const r = await s.api("notes", { eid, text: "Notes from the test", rev: st.rev });
    assert.equal(r.status, 200);
    assert.ok(fs.readFileSync(path.join(fx.deck, "index.html"), "utf8").includes("Notes from the test"));
    assert.notEqual(r.rev, st.rev);

    // runtime files are private
    const stateDir = path.join(fx.home, "decks", fs.readdirSync(path.join(fx.home, "decks"))[0]);
    assert.equal(fs.statSync(path.join(stateDir, "server.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(fx.home, "server.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.ok(!s.output().includes(s.token), "the token is not logged");

    if (platform === "linux") {
      // macOS-only features are off with a reason, refused before doing anything, and never call macOS tools
      for (const k of ["pdfPages", "pptxImport", "pptxPictures", "audioConvert", "pdfExport", "headlessLayout"])
        assert.equal(st.capabilities[k].available, false, k);
      const imp = await fetch(`${s.url}/api/import`, { method: "POST", body: "PK",
        headers: { "x-editor-token": s.token, "x-filename": "a.pptx" } });
      assert.equal(imp.status, 501);
      const pdf = await fetch(`${s.url}/api/upload`, { method: "POST", body: "%PDF-1.4\n%%EOF\n",
        headers: { "x-editor-token": s.token, "x-filename": "paper.pdf" } });
      const up = await pdf.json();
      assert.equal(pdf.status, 200);
      assert.equal(up.pages, undefined);
      assert.equal((await s.api(`pdf-figure?file=${encodeURIComponent(up.path)}&page=1`)).status, 501);
      assert.equal((await s.api("shot?slide=1")).status, 501);
      assert.equal((await s.api("pdf?slide=handout")).status, 501);
      const layout = await s.api("layout?slide=1");   // no editor tab open, no headless Chrome
      assert.equal(layout.status, 503);
      assert.match(layout.data, /editor open in a browser/);
      assert.equal(fx.macTools(), "", "no osascript or afconvert on Linux");
    }
  });
}

test("Claude turn with fake Claude: edit, undo and redo", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const theme = path.join(fx.deck, "theme.css");
  const before = fs.readFileSync(theme, "utf8");
  assert.equal((await s.api("message", { text: "please edit theme" })).status, 200);
  await waitFor(async () => !(await s.api("status")).data.busy && fs.readFileSync(theme, "utf8").includes("fake claude edit"), "the turn");
  const turn = await waitFor(() => chatOf(fx).find((e) => e.kind === "turn"), "the turn entry");
  assert.deepEqual(turn.files.map((f) => f.file), ["theme.css"]);
  assert.equal((await s.api("undo", {})).status, 200);
  assert.equal(fs.readFileSync(theme, "utf8"), before);
  assert.equal((await s.api("redo", {})).status, 200);
  assert.ok(fs.readFileSync(theme, "utf8").includes("fake claude edit"));
  assert.equal(fakePids(fx).length, 1, "one claude process for the whole chat");
});

test("Malformed and partial stream lines do not break a turn", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx, { env: { FAKE_CLAUDE_MODE: "garbage" } });
  assert.equal((await s.api("message", { text: "hello" })).status, 200);
  await waitFor(() => chatOf(fx).find((e) => e.kind === "assistant" && e.text === "Done (fake)."), "the answer");
  assert.equal((await s.api("status")).data.busy, false);
});

test("Missing claude: manual editing works, messages are refused before anything happens", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx, { env: { CLAUDE_BIN: path.join(fx.root, "no such dir", "claude") } });
  const st = (await s.api("status")).data;
  assert.equal(st.capabilities.claude.available, false);
  assert.match(st.capabilities.claude.reason, /does not exist/);
  const m = await s.api("message", { text: "hello" });
  assert.equal(m.status, 503);
  assert.equal(m.data.code, "claude-unavailable");
  assert.equal(chatOf(fx).length, 0);
  assert.equal((await s.api("notes", { eid: firstSlideEid(fx.deck), text: "still editable" })).status, 200);
});

test("Claude that fails to log in ends the turn with an error; the editor keeps working", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx, { env: { FAKE_CLAUDE_MODE: "auth-fail" } });
  assert.equal((await s.api("message", { text: "hello" })).status, 200);
  const turn = await waitFor(() => chatOf(fx).find((e) => e.kind === "turn"), "the failed turn");
  assert.match(turn.error, /Claude Code stopped .*Please run \/login/);
  assert.equal((await s.api("status")).data.busy, false);
  assert.equal((await s.api("notes", { eid: firstSlideEid(fx.deck), text: "after the failure" })).status, 200);
});

/* ---- Lifecycle -------------------------------------------------------------------------------- */
test("SIGTERM: Claude gets end of input, the server exits and removes only its own server files", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const [pid] = await waitFor(() => fakePids(fx).length && fakePids(fx), "claude to start");
  s.child.kill("SIGTERM");
  const r = await s.exited;
  assert.equal(r.code, 0);
  assert.ok(fakeLog(fx).some((e) => e.event === "eof" && e.pid === pid));
  await waitFor(() => !alive(pid), "claude to exit", 3000);
  assert.equal(fs.existsSync(path.join(fx.home, "server.json")), false);
});

test("SIGTERM with a Claude that ignores end of input and SIGTERM: killed, bounded shutdown", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx, { env: { FAKE_CLAUDE_MODE: "stubborn" } });
  const [pid] = await waitFor(() => fakePids(fx).length && fakePids(fx), "claude to start");
  const t0 = Date.now();
  s.child.kill("SIGTERM");
  await s.exited;
  assert.ok(Date.now() - t0 < 8000);
  assert.ok(fakeLog(fx).some((e) => e.event === "sigterm"));
  await waitFor(() => !alive(pid), "claude to be killed", 3000);
});

test("A second server for another deck keeps the first one's discovery file intact on exit", async (t) => {
  const fx = fixture(t);
  const other = path.join(fx.root, "second deck");
  fs.cpSync(EXAMPLE, other, { recursive: true });
  const s1 = await startServer(t, fx);
  const s2 = await startServer(t, fx, { deck: other });
  const global = path.join(fx.home, "server.json");
  assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).token, s2.token);
  s1.child.kill("SIGTERM");
  await s1.exited;
  assert.equal(JSON.parse(fs.readFileSync(global, "utf8")).token, s2.token);
});

test("Restart: a new token; the old one is refused (the editor reloads on 403)", async (t) => {
  const fx = fixture(t);
  const s1 = await startServer(t, fx);
  s1.child.kill("SIGTERM");
  await s1.exited;
  const s2 = await startServer(t, fx);
  assert.notEqual(s1.token, s2.token);
  const old = await fetch(`${s2.url}/api/ping`, { headers: { "x-editor-token": s1.token } });
  assert.equal(old.status, 403);
});

/* ---- Failed starts leave everything as it was ------------------------------------------------- */
async function failedStart(t, fx, opts) {
  const before = sha(path.join(fx.deck, "index.html"));
  const s = spawnServer(fx, opts);
  t.after(() => s.child.kill("SIGKILL"));
  const r = await Promise.race([s.exited, sleep(10000).then(() => ({ code: "timeout" }))]);
  assert.equal(sha(path.join(fx.deck, "index.html")), before, "deck unchanged");
  assert.equal(fs.existsSync(fx.home), false, "no state written");
  assert.equal(fakeLog(fx).length, 0, "Claude not started");
  return { ...r, output: s.output() };
}
test("Invalid port: exits before touching deck or state", async (t) => {
  const fx = fixture(t);
  for (const port of ["abc", "70000", "-1", "5180x"]) {
    const r = await failedStart(t, fx, { args: ["--port", port] });
    assert.equal(r.code, 2);
    assert.match(r.output, /Invalid port/);
  }
});
test("Port in use: exits before touching deck or state", async (t) => {
  const fx = fixture(t);
  const blocker = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  t.after(() => blocker.close());
  const r = await failedStart(t, fx, { args: ["--port", String(blocker.address().port)] });
  assert.equal(r.code, 1);
  assert.match(r.output, /is in use/);
});
test("Missing deck or index.html: exits with a message, nothing written", async (t) => {
  const fx = fixture(t);
  const r = await failedStart(t, fx, { deck: path.join(fx.root, "missing") });
  assert.equal(r.code, 1);
  assert.match(r.output, /No index\.html/);
});
test("Read-only deck folder: refused before anything is written", { skip: process.getuid?.() === 0 && "root ignores permissions" }, async (t) => {
  const fx = fixture(t);
  fs.chmodSync(fx.deck, 0o555);
  let r;
  try { r = await failedStart(t, fx); } finally { fs.chmodSync(fx.deck, 0o755); }
  assert.equal(r.code, 1);
  assert.match(r.output, /not writable/);
});

/* ---- Deck files ------------------------------------------------------------------------------- */
test("Deck media: length, byte ranges (Safari needs 206), 416 for bad ranges, audio types", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const wav = fs.readFileSync(path.join(fx.deck, "figures/sample_a.wav"));
  const get = (p, headers = {}) => fetch(`${s.url}/deck/${p}`, { headers });

  let r = await get("figures/sample_a.wav");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(+r.headers.get("content-length"), wav.length);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(wav));

  r = await get("figures/sample_a.wav", { range: "bytes=0-1" });   // Safari's first probe
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 0-1/${wav.length}`);
  assert.equal(+r.headers.get("content-length"), 2);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(wav.subarray(0, 2)));

  r = await get("figures/sample_a.wav", { range: "bytes=100-" });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(wav.subarray(100)));

  r = await get("figures/sample_a.wav", { range: "bytes=-10" });
  assert.equal(r.headers.get("content-range"), `bytes ${wav.length - 10}-${wav.length - 1}/${wav.length}`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(wav.subarray(-10)));

  r = await get("figures/sample_a.wav", { range: `bytes=${wav.length}-` });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), `bytes */${wav.length}`);
  await r.arrayBuffer();

  fs.writeFileSync(path.join(fx.deck, "figures/clip.m4a"), "x");
  r = await get("figures/clip.m4a");
  assert.equal(r.headers.get("content-type"), "audio/mp4");
  await r.arrayBuffer();
  assert.equal((await get("figures/missing.wav")).status, 404);
  assert.equal((await get("figures")).status, 404);

  // HTML with the editor bridge: still whole, with the right length
  r = await get("index.html?editor=1", { range: "bytes=0-1" });
  assert.equal(r.status, 200);
  const page = Buffer.from(await r.arrayBuffer());
  assert.equal(+r.headers.get("content-length"), page.length);
  assert.match(page.toString(), /<script src="\/editor\/bridge\.js"><\/script>\n<\/body>/);
});

/* ---- Security --------------------------------------------------------------------------------- */
test("Loopback only; bad host, token and origin are refused", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  assert.equal(await raw(s.port, { p: "/", headers: { host: `evil.example:${s.port}` } }), 403);
  assert.equal(await raw(s.port, { p: "/api/status", headers: { host: `127.0.0.1:${s.port}` } }), 403);
  assert.equal(await raw(s.port, { p: "/api/status", headers: { host: `127.0.0.1:${s.port}`, "x-editor-token": "0".repeat(32) } }), 403);
  assert.equal(await raw(s.port, { method: "POST", p: "/api/notes", headers: { host: `127.0.0.1:${s.port}`,
    "x-editor-token": s.token, origin: "http://evil.example", "content-type": "application/json" } }), 403);
  assert.equal(await raw(s.port, { p: "/api/status", headers: { host: `localhost:${s.port}`, "x-editor-token": s.token } }), 200);
  assert.notEqual(await raw(s.port, { p: "/deck/..%2f..%2fstate%2fserver.json", headers: { host: `127.0.0.1:${s.port}` } }), 200);
  // nothing listens on the other interfaces
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (lan) {
    const ok = await new Promise((r) => net.connect(s.port, lan.address).on("connect", function () { this.destroy(); r(true); }).on("error", () => r(false)));
    assert.equal(ok, false);
  }
});

/* ---- Conflicts: stale edits, Undo and Redo ------------------------------------------------------ */
test("A change based on an old revision is refused and the file is left as it is", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const eid = firstSlideEid(fx.deck);
  const r0 = (await s.api("status")).data.rev;
  const r1 = (await s.api("notes", { eid, text: "first", rev: r0 })).rev;
  externalEdit(fx.deck, "index.html", (h) => h.replace("</body>", "<!-- external -->\n</body>"));
  const file = path.join(fx.deck, "index.html");
  const before = sha(file);
  const stale = await s.api("notes", { eid, text: "second", rev: r1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "stale");
  assert.equal(sha(file), before);
  assert.equal((await s.api("notes", { eid, text: "second", rev: stale.data.rev })).status, 200);
  assert.ok(fs.readFileSync(file, "utf8").includes("<!-- external -->"));
});

test("Undo and Redo refuse to overwrite external changes, and work again once the files match", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const file = path.join(fx.deck, "index.html");
  const eid = firstSlideEid(fx.deck);
  assert.equal((await s.api("notes", { eid, text: "undo me" })).status, 200);
  const edited = fs.readFileSync(file, "utf8");
  externalEdit(fx.deck, "index.html", (h) => h.replace("</body>", "<!-- external -->\n</body>"));
  const external = sha(file);
  const u = await s.api("undo", {});
  assert.equal(u.status, 409);
  assert.equal(u.data.code, "diverged");
  assert.deepEqual(u.data.files, ["index.html"]);
  assert.equal(sha(file), external, "nothing written");
  fs.writeFileSync(file, edited);
  assert.equal((await s.api("undo", {})).status, 200);
  assert.ok(!fs.readFileSync(file, "utf8").includes("undo me"));
  const undone = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(fx.deck, "theme.css"), "/* replaced elsewhere */\n");
  const rd = await s.api("redo", {});
  assert.equal(rd.status, 409);
  assert.deepEqual(rd.data.files, ["theme.css"]);
  assert.equal(fs.readFileSync(file, "utf8"), undone);
});

test("Undo does not overwrite a file created where a deleted picture was", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const html = fs.readFileSync(path.join(fx.deck, "index.html"), "utf8");
  const eid = /<img\b[^>]*transmission_loss\.svg[^>]*>/.exec(html)[0].match(/data-eid="([^"]+)"/)[1];
  const info = (await s.api(`delete-info?eid=${encodeURIComponent(eid)}`)).data;
  const pic = info.files.find((f) => f.rel === "figures/transmission_loss.svg");
  assert.ok(pic && !pic.usedElsewhere);
  const picFile = path.join(fx.deck, pic.rel);
  const original = fs.readFileSync(picFile);
  assert.equal((await s.api("delete", { eid, files: [pic.rel] })).status, 200);
  assert.equal(fs.existsSync(picFile), false);
  fs.writeFileSync(picFile, "<svg>someone else's new picture</svg>");
  const u = await s.api("undo", {});
  assert.equal(u.status, 409);
  assert.deepEqual(u.data.files, [pic.rel]);
  assert.equal(fs.readFileSync(picFile, "utf8"), "<svg>someone else's new picture</svg>");
  fs.rmSync(picFile);
  assert.equal((await s.api("undo", {})).status, 200);
  assert.ok(fs.readFileSync(picFile).equals(original));
});

/* ---- Watcher, live reload and reconnect ------------------------------------------------------- */
function events(t, s) {
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const list = [];
  (async () => {
    const res = await fetch(`${s.url}/api/events?t=${s.token}`, { signal: ctrl.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev) list.push({ ev, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return list;
}

test("Edits by another process reach the editor with the new revision and get element ids", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const list = events(t, s);
  const hello = await waitFor(() => list.find((e) => e.ev === "hello"), "hello");
  assert.equal(hello.data.rev, (await s.api("status")).data.rev);
  // a separate process writes the deck, the way another editor would (temporary file, then rename)
  const file = path.join(fx.deck, "index.html");
  const html = fs.readFileSync(file, "utf8").replace(/(<section class="slide"[^>]*>)/, '$1\n<p class="from-outside">Added outside</p>');
  execFileSync(process.execPath, ["-e", `const fs=require("fs");fs.writeFileSync(process.argv[1]+".tmp~",process.argv[2]);fs.renameSync(process.argv[1]+".tmp~",process.argv[1])`, file, html]);
  const ev = await waitFor(() => list.find((e) => e.ev === "files" && e.data.files.includes("index.html")), "a files event");
  assert.equal(ev.data.manual, false);
  await waitFor(() => /<p class="from-outside" data-eid="[^"]+">/.test(fs.readFileSync(file, "utf8")), "the new element's id", 5000);
  await waitFor(async () => list.at(-1).data.rev === (await s.api("status")).data.rev, "the latest revision");
});

test("A deck file missing for a moment (replace by delete and recreate) does not stop the server", async (t) => {
  const fx = fixture(t);
  const s = await startServer(t, fx);
  const file = path.join(fx.deck, "index.html");
  const html = fs.readFileSync(file, "utf8");
  fs.rmSync(file);
  await sleep(1200);   // past the watcher's id pass
  fs.writeFileSync(file, html);
  assert.equal((await s.api("status")).status, 200);
  assert.equal((await s.api("notes", { eid: firstSlideEid(fx.deck), text: "still fine" })).status, 200);
});

/* ---- Git: ids stay out of commits --------------------------------------------------------------- */
let hasGit = true;
try { execFileSync("git", ["--version"]); } catch { hasGit = false; }
test("git-setup keeps ids out of staged content; live files keep them; real edits are not staged", { skip: !hasGit && "no git" }, async (t) => {
  const fx = fixture(t, "repo/my talk");
  const git = (...a) => execFileSync("git", ["-C", fx.deck, ...a], { encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  execFileSync("git", ["init", "-q", path.dirname(fx.deck)]);   // the repository is the folder above the deck
  execFileSync(process.execPath, [path.join(ROOT, "cli.mjs"), "git-setup", fx.deck]);
  assert.match(git("config", "--get", "filter.pindeck-ids.clean"), /data-eid/);
  git("add", "-A");
  git("commit", "-qm", "deck");
  const s = await startServer(t, fx);
  const file = path.join(fx.deck, "index.html");
  assert.match(fs.readFileSync(file, "utf8"), /data-eid=/, "ids in the working file");
  await waitFor(() => git("status", "--porcelain", "--", "index.html") === "", "git to see no change for ids alone").catch((e) => { throw new Error(e.message + ": " + JSON.stringify(git("status", "--porcelain")) + " staged-has-ids=" + /data-eid/.test(git("show", ":./index.html"))); });
  assert.doesNotMatch(git("show", ":./index.html"), /data-eid=/);
  // a real edit shows as modified and is not staged by PinDeck
  assert.equal((await s.api("notes", { eid: firstSlideEid(fx.deck), text: "a real edit" })).status, 200);
  await sleep(300);
  assert.match(git("status", "--porcelain", "--", "index.html"), /^ M/);
  assert.match(git("diff", "--", "index.html"), /a real edit/);
  assert.doesNotMatch(git("diff", "--", "index.html"), /data-eid/);
});
