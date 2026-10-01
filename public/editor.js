/* PinDeck UI: slide list, canvas with pins, chat with Claude Code. */

const TOKEN = document.querySelector('meta[name="editor-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = (p, body) => fetch("/api/" + p, {
  method: body === undefined ? "GET" : "POST",
  headers: { "x-editor-token": TOKEN, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const savedSlide = (() => { try { return +localStorage.getItem("editor.slide") || 0; } catch { return 0; } })();
const state = {
  status: {}, slides: [], current: savedSlide, pins: [], mode: "select", sel: null, // mode: "select" (move, resize) or "pin"
  busy: false, status: {}, turns: new Map(), // turnId -> { undone }
};

/* ---- Frames ---------------------------------------------------------------------------- */
let main = null;        // { iframe, bridge }
let pendingMain = null; // iframe being loaded (double buffering avoids a white flash)
let measure = null;     // { iframe, bridge }
let measureReady = null, measureResolve = null;

function deckSrc(mode, extra = "") { return `/deck/index.html?editor=${mode}${extra}`; }

function loadMain() {
  const f = document.createElement("iframe");
  f.className = "loading";
  f.title = "Slide";
  f.src = deckSrc("main", `&start=${state.current}`);
  $("stage").appendChild(f);
  if (pendingMain) pendingMain.remove();
  pendingMain = f;
}
function loadMeasure() {
  measure?.iframe.remove();
  measureReady = new Promise((r) => (measureResolve = r));
  const f = document.createElement("iframe");
  f.className = "measure";
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.src = deckSrc("measure");
  measure = { iframe: f, bridge: null };
  $("stage").appendChild(f);
}

window.__editorHost = {
  bridgeReady(role, bridge, win) {
    if (role === "measure") {
      if (measure && measure.iframe.contentWindow === win) { measure.bridge = bridge; measureResolve(bridge); }
      return;
    }
    if (!pendingMain || pendingMain.contentWindow !== win) return;
    const old = main;
    main = { iframe: pendingMain, bridge };
    pendingMain = null;
    main.iframe.classList.remove("loading");
    old?.iframe.remove();
    const inf = bridge.info();
    state.slides = inf.slides;
    state.current = Math.min(state.current, state.slides.length - 1);
    if (inf.current !== state.current) bridge.goto(state.current);
    bridge.setMode(state.mode);
    bridge.setEditable(!state.busy);
    refreshPinsFromSlides();
    bridge.renderPins(state.pins);
    if (state.sel) bridge.selectEid(state.sel.eid);
    renderSlides();
    renderToolbar();
  },
  slideChanged(index) {
    state.current = index;
    try { localStorage.setItem("editor.slide", String(index)); } catch {}
    renderSlides();
    renderToolbar();
    api("current", { index, eid: state.slides[index]?.eid });
  },
  addPin(pin) {
    const n = state.pins.reduce((m, p) => Math.max(m, p.n), 0) + 1;
    state.pins.push({ ...pin, n });
    pinsChanged();
  },
  removePin(n) {
    state.pins = state.pins.filter((p) => p.n !== n);
    pinsChanged();
  },
  key(k, mod) { handleKey(k, mod); },
  selectionChanged(info) { state.sel = info; renderPinTray(); },
  commitEdit(op, label) { commitEdit(op, label); },
  async textSource(eid, path) {
    flushNudge();
    await editChain;
    const res = await api(`source?${new URLSearchParams({ eid, path: JSON.stringify(path || []) })}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { toast(d.error || "Could not load the text."); return null; }
    return d.html;
  },
  commitText(edit) {
    editChain = editChain.then(async () => {
      const res = await api("text", edit);
      if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Could not save the text.");
      loadMain();   // re-render: math, footer numbers, and the file as saved
    });
  },
  commitSplit(op, done) {
    editChain = editChain.then(async () => {
      const res = await api("split", op);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(d.error || "Could not add the bullet."); loadMain(); return; }
      done?.(d.eid);
    });
  },
  commitRemove(eid) {
    editChain = editChain.then(async () => {
      const res = await api("remove", { eid });
      if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Could not remove the bullet.");
      loadMain();
    });
  },
  refresh() { editChain = editChain.then(() => loadMain()); },
  editingChanged(on) { state.editing = on; },
  dropFiles(files, at) { attachFiles(files, at); },
  dragOver(on) { $("drop-hint").hidden = !on; },
  toast(msg) { toast(msg); },
};

/* ---- Hand edits (drag, resize, nudge) ---------------------------------------------------------- */
let editChain = Promise.resolve(), nudgeAcc = null, nudgeTimer = null;
function postEdit(op, label) {
  editChain = editChain.then(async () => {
    const res = await api("edit", { ops: [op], label });
    if (!res.ok) {
      toast((await res.json().catch(() => ({}))).error || "Could not save the change.");
      loadMain();   // show the file as it is
    }
  });
  return editChain;
}
function flushNudge() {
  clearTimeout(nudgeTimer);
  if (!nudgeAcc) return;
  const n = nudgeAcc;
  nudgeAcc = null;
  postEdit(n.op, `Moved ${n.name} by ${n.dx}, ${n.dy} px`);
}
function commitEdit(op, label) {
  if (label?.nudge) {   // arrow keys: one change per burst of key presses
    if (nudgeAcc && nudgeAcc.op.eid !== op.eid) flushNudge();
    nudgeAcc ??= { name: label.name, dx: 0, dy: 0 };
    nudgeAcc.dx += label.dx; nudgeAcc.dy += label.dy; nudgeAcc.op = op;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(flushNudge, 600);
    return;
  }
  flushNudge();
  postEdit(op, label);
}
async function undoRedo(which) {
  flushNudge();
  await editChain;
  const res = await api(which, {});
  if (!res.ok) toast((await res.json().catch(() => ({}))).error || `Nothing to ${which}.`);
}
let toastTimer = null;
function toast(msg, { html = false, ms = 3200 } = {}) {
  $("toast")[html ? "innerHTML" : "textContent"] = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), ms);
}

async function measureSlide(index) {
  const b = await measureReady;
  return b.measure(index);
}
// one measurement at a time: the measure frame has a single "current slide"
let measureChain = Promise.resolve();
const queueMeasure = (index) => (measureChain = measureChain.then(() => measureSlide(index), () => measureSlide(index)));

/* ---- Slides ---------------------------------------------------------------------------------- */
function goto(i) {
  if (i < 0 || i >= state.slides.length) return;
  main?.bridge.goto(i);
}
function renderSlides() {
  const counts = {};
  state.pins.forEach((p) => (counts[p.slide.index] = (counts[p.slide.index] || 0) + 1));
  $("slide-count").textContent = state.slides.length ? `${state.slides.length} slides` : "";
  $("slide-list").innerHTML = state.slides.map((s, i) => `
    <li data-i="${i}" class="${i === state.current ? "active" : ""}" title="${esc(s.eid)}">
      <span class="num">${i + 1}</span>
      <span><div class="t">${esc(s.title)}</div>${s.sub ? `<div class="s">${esc(s.sub)}</div>` : ""}
        ${s.kind !== "content" ? `<span class="kind">${esc(s.kind.replace(/-slide$/, ""))}</span>` : ""}</span>
      ${counts[i] ? `<span class="badge" title="${counts[i]} pin(s)">${counts[i]}</span>` : "<span></span>"}
    </li>`).join("");
  $("slide-list").querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}
$("slide-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) goto(+li.dataset.i);
});
function renderToolbar() {
  const s = state.slides[state.current];
  $("slide-pos").textContent = s ? `${state.current + 1} / ${state.slides.length}` : "– / –";
  $("slide-title").textContent = s ? s.title + (s.sub ? " · " + s.sub : "") : "";
  $("pin-toggle").setAttribute("aria-pressed", String(state.mode === "pin"));
  $("select-toggle").setAttribute("aria-pressed", String(state.mode === "select"));
  $("pin-hint").hidden = state.mode !== "pin";
  const st = state.status;
  $("undo").disabled = !st.undo || state.busy;
  $("redo").disabled = !st.redo || state.busy;
  $("undo").title = st.undo ? `Undo: ${st.undo} (⌘Z)` : "Undo (⌘Z)";
  $("redo").title = st.redo ? `Redo: ${st.redo} (⇧⌘Z)` : "Redo (⇧⌘Z)";
}
$("prev").onclick = () => goto(state.current - 1);
$("next").onclick = () => goto(state.current + 1);
$("pin-toggle").onclick = () => setMode(state.mode === "pin" ? "select" : "pin");
$("select-toggle").onclick = () => setMode("select");
$("undo").onclick = () => undoRedo("undo");
$("redo").onclick = () => undoRedo("redo");
/* ---- PDF export ---------------------------------------------------------------------------- */
function setExportMenu(open) {
  $("export-menu").hidden = !open;
  $("export-btn").setAttribute("aria-expanded", String(open));
}
$("export-btn").onclick = (e) => { e.stopPropagation(); setExportMenu($("export-menu").hidden); };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) setExportMenu(false); });
$("export-menu").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-export]");
  if (!item) return;
  setExportMenu(false);
  const kind = item.dataset.export, label = kind === "presentation" ? "presentation" : "handout";
  const btn = $("export-btn");
  btn.disabled = true;
  btn.textContent = "Exporting…";
  toast(`Creating the ${label} PDF…`, { ms: 60000 });
  try {
    flushNudge();
    await editChain;   // export what is saved, including the latest hand edits
    const res = await api("export", { kind });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Export failed.");
    toast(`Saved ${esc(d.rel)} (${Math.round(d.bytes / 1024)} kB)<a href="${d.url}" target="_blank" rel="noopener">Open</a>`,
      { html: true, ms: 10000 });
  } catch (err) {
    toast(String(err.message || err), { ms: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = "Export ▾";
  }
});

$("present").onclick = () => {
  const ix = main?.bridge.indices(state.current) || { h: 0, v: 0 };
  window.open(`/deck/index.html#/${ix.h}${ix.v ? "/" + ix.v : ""}`, "_blank");
};

/* ---- Pins --------------------------------------------------------------------------------------- */
function setMode(m) {
  state.mode = m;
  if (m !== "select") state.sel = null;
  main?.bridge.setMode(m);
  renderToolbar();
  renderPinTray();
}
function refreshPinsFromSlides() {
  // after a reload, slide indices may have moved: re-resolve by slide id, drop pins whose slide is gone
  state.pins = state.pins.flatMap((p) => {
    const i = state.slides.findIndex((s) => s.eid === p.slide.eid);
    return i < 0 ? [] : [{ ...p, slide: { ...p.slide, index: i } }];
  });
}
function pinsChanged() {
  main?.bridge.renderPins(state.pins);
  renderPinTray();
  renderSlides();
  api("pins", { pins: state.pins });
}
function shortEid(p) {
  if (p.tag?.startsWith("footer")) return "footer";
  return p.eid === p.slide.eid ? "slide" : p.eid.replace(/^[^/]+\//, "");
}
function renderPinTray() {
  const sel = state.sel;
  $("pin-tray").innerHTML = (sel ? `
    <span class="chip sel" data-sel title="Selected: ${esc(sel.eid)}. Claude sees it as “this”.">
      <span class="n">▢</span> S${sel.slide.index + 1} · ${esc(sel.eid.replace(/^[^/]+\//, ""))} <span class="dim">${sel.box.w} × ${sel.box.h}</span>
      <button class="x" data-unsel aria-label="Deselect">×</button></span>` : "") + state.pins.map((p) => `
    <span class="chip" data-n="${p.n}" title="${esc(p.eid)}${p.text ? " — " + esc(p.text.slice(0, 80)) : ""}">
      <span class="n">${p.n}</span> S${p.slide.index + 1} · ${esc(shortEid(p))}${p.word ? ` “${esc(p.word)}”` : ""}
      ${p.locked ? '<span class="lock" title="Brand-locked">🔒</span>' : ""}
      <button class="x" data-x="${p.n}" aria-label="Remove pin ${p.n}">×</button></span>`).join("");
  $("clear-pins").hidden = !state.pins.length;
}
$("pin-tray").addEventListener("click", (e) => {
  const x = e.target.closest("[data-x]");
  if (x) return window.__editorHost.removePin(+x.dataset.x);
  if (e.target.closest("[data-unsel]")) return main?.bridge.deselect();
  if (e.target.closest("[data-sel]")) return main?.bridge.highlight(state.sel.eid);
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const p = state.pins.find((p) => p.n === +chip.dataset.n);
  if (!p) return;
  if (p.slide.index !== state.current) goto(p.slide.index);
  setTimeout(() => main?.bridge.highlight(p.eid), 60);
});
$("pin-tray").addEventListener("mouseover", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.dataset.hl) return;
  chip.dataset.hl = "1";
  setTimeout(() => delete chip.dataset.hl, 1500);
  const p = state.pins.find((p) => p.n === +chip.dataset.n);
  if (p && p.slide.index === state.current) main?.bridge.highlight(p.eid);
});
$("clear-pins").onclick = () => { state.pins = []; pinsChanged(); };

/* ---- Chat ----------------------------------------------------------------------------------------- */
const chatEl = $("chat");
const entryEls = new Map();
function md(s) {
  // small, safe subset: code blocks, inline code, bold, lists, paragraphs
  const blocks = [];
  s = esc(s).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const out = s.split(/\n{2,}/).map((para) => {
    const lines = para.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s/.test(l) || !l.trim()))
      return "<ul>" + lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s/, ""))}</li>`).join("") + "</ul>";
    return `<p>${inline(lines.join("<br>"))}</p>`;
  }).join("");
  return out.replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => `<pre>${blocks[a ?? b]}</pre>`);
}
function entryHtml(e) {
  switch (e.kind) {
    case "user":
      return `${esc(e.text)}${e.pins?.length || e.screenshot || e.selection || e.attachments?.length ? `<div class="chips">${e.selection ?
        `<span class="chip sel" title="${esc(e.selection.eid)}"><span class="n">▢</span> S${e.selection.slide} · ${esc(e.selection.label)}</span>` : ""}${(e.pins || []).map((p) =>
        `<span class="chip" title="${esc(p.eid)}"><span class="n">${p.n}</span> S${p.slide} · ${esc(p.label || p.eid)}</span>`).join("")}${
        e.screenshot ? '<span class="chip">📷 screenshot</span>' : ""}${(e.attachments || []).map((a) =>
        `<span class="chip att-chip" title="${esc(a.path)}">${a.kind === "image" ? `<img src="/deck/${esc(a.path)}" alt="">` : "🔊"} ${esc(a.path.split("/").pop())}</span>`).join("")}</div>` : ""}`;
    case "assistant": return md(e.text);
    case "tool":
      return `<span><span class="tn">${esc(e.name)}</span> ${esc(e.detail || "")}${e.error ? `<span class="err">${esc(e.error)}</span>` : ""}</span>`;
    case "edit": {
      const t = state.turns.get(e.turnId);
      return `<span class="files ${t?.undone ? "undone" : ""}">✎ ${esc(e.label)}</span>
        <button class="small" data-diff="${e.turnId}">Diff</button>
        ${t && !t.undone ? `<button class="small" data-undo="${e.turnId}">Undo</button>` : t?.undone ? "<span>undone</span>" : ""}`;
    }
    case "turn": {
      const t = e.turnId ? state.turns.get(e.turnId) : null;
      const parts = [];
      if (e.error) parts.push(`<span class="warn">${esc(e.error)}</span>`);
      if (e.files?.length) {
        parts.push(`<span class="files ${t?.undone ? "undone" : ""}">Changed ${e.files.map((f) =>
          `${esc(f.file)} <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`).join(", ")}</span>`);
        parts.push(`<button class="small" data-diff="${e.turnId}">Diff</button>`);
        if (t && !t.undone) parts.push(`<button class="small" data-undo="${e.turnId}">Undo</button>`);
        if (t?.undone) parts.push("<span>undone</span>");
      } else if (!e.error) parts.push("No file changes");
      if (e.restored?.length) parts.push(`<span class="warn">${esc(e.restored.join(", "))} is locked; the change was reverted.</span>`);
      if (e.denials?.length) parts.push(`<span class="warn">Blocked: ${e.denials.map((d) => esc(`${d.name} ${d.detail}`)).join(", ")}</span>`);
      if (e.duration) parts.push(`<span class="meta">${(e.duration / 1000).toFixed(1)} s</span>`);
      return parts.join(" ");
    }
    default: return esc(e.text);
  }
}
function renderEntry(e) {
  $("chat-empty").hidden = true;
  let el = entryEls.get(e.id);
  if (!el) {
    el = document.createElement("div");
    entryEls.set(e.id, el);
    chatEl.appendChild(el);
  }
  el.className = `msg ${e.kind}`;
  el.innerHTML = entryHtml(e);
  el.__entry = e;
}
function rerenderTurns() { entryEls.forEach((el) => { if (["turn", "edit"].includes(el.__entry?.kind)) el.innerHTML = entryHtml(el.__entry); }); }
const scrollChat = () => { chatEl.scrollTop = chatEl.scrollHeight; };
function clearChat() {
  entryEls.forEach((el) => el.remove());
  entryEls.clear();
  $("chat-empty").hidden = false;
}

chatEl.addEventListener("click", async (e) => {
  const d = e.target.closest("[data-diff]");
  if (d) {
    const res = await api(`turn/${d.dataset.diff}/diff`);
    const txt = await res.text();
    $("diff-body").innerHTML = txt.split("\n").map((l) => {
      const c = l.startsWith("+++") || l.startsWith("---") ? "f" : l.startsWith("@@") ? "h" : l[0] === "+" ? "a" : l[0] === "-" ? "d" : "";
      return `<span class="${c}">${esc(l) || " "}</span>`;
    }).join("");
    $("diff-dialog").showModal();
    return;
  }
  const u = e.target.closest("[data-undo]");
  if (u) {
    u.disabled = true;
    flushNudge();
    await editChain;
    const res = await api(`turn/${u.dataset.undo}/undo`, {});
    if (!res.ok) { u.disabled = false; toast((await res.json()).error); }
  }
});
$("diff-close").onclick = () => $("diff-dialog").close();

function setBusy(busy) {
  state.busy = busy;
  $("working").hidden = !busy;
  main?.bridge.setEditable(!busy);
  $("send").hidden = busy;
  $("stop").hidden = !busy;
}

async function send() {
  const text = $("input").value.trim();
  if (!text || state.busy) return;
  if (attachments.some((a) => a.status === "uploading")) return toast("Wait until the attachments have finished uploading.");
  $("send").disabled = true;
  try {
    // measure every pinned slide plus the current one, in the user's own browser
    flushNudge();
    await editChain;
    const idx = [...new Set([...state.pins.map((p) => p.slide.index), state.current])].slice(0, 4);
    const layouts = [];
    for (const i of idx) { try { layouts.push(await queueMeasure(i)); } catch {} }
    const s = state.slides[state.current];
    const res = await api("message", {
      text, pins: state.pins, selection: state.sel, layouts, screenshot: $("shot").checked,
      attachments: attachments.filter((a) => a.status === "ready").map(({ path, kind, name, bytes, width, height, duration,
        sampleRate, channels, waveform, droppedAt }) => ({ path, kind, name, bytes, width, height, duration, sampleRate, channels, waveform, droppedAt })),
      current: s ? { index: state.current, eid: s.eid } : null,
    });
    if (!res.ok) { alert((await res.json()).error || "Could not send."); return; }
    $("input").value = "";
    autosize();
    $("shot").checked = false;
    clearAttachments();
    state.pins = [];
    pinsChanged();
    if (state.mode === "pin") setMode("select");
  } finally {
    $("send").disabled = false;
  }
}
$("send").onclick = send;
$("stop").onclick = () => api("stop", {});
$("new-chat").onclick = async () => {
  if (!confirm("Start a new conversation? Claude forgets this chat; your slides stay as they are.")) return;
  await api("new-chat", {});
};
function autosize() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(220, Math.max(64, t.scrollHeight + 2)) + "px";
}
$("input").addEventListener("input", autosize);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  if (e.key === "Escape") { $("input").blur(); if (state.mode === "pin") setMode("select"); }
});

/* ---- Keyboard ------------------------------------------------------------------------------------ */
function handleKey(k, mod = {}) {
  if (mod.meta && (k === "z" || k === "Z")) return undoRedo(mod.shift ? "redo" : "undo");
  if (mod.meta) return;
  if (k === "p" || k === "P") setMode(state.mode === "pin" ? "select" : "pin");
  else if (k === "v" || k === "V") setMode("select");
  else if (k === "Escape") { if (state.mode === "pin") setMode("select"); else main?.bridge.deselect(); }
  else if (k === "Enter") { if (!(state.sel && state.mode === "select" && main?.bridge.editSelection())) $("input").focus(); }
  else if (k.startsWith("Arrow") && state.sel && state.mode === "select") {
    const step = mod.shift ? 10 : 1;
    main?.bridge.nudge(k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0, k === "ArrowUp" ? -step : k === "ArrowDown" ? step : 0);
  }
  else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") goto(state.current - 1);
  else if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " ") goto(state.current + 1);
}
document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, dialog")) return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); return handleKey(e.key, { meta, shift: e.shiftKey }); }
  if (meta || e.altKey) return;
  if (["p", "P", "v", "V", "Escape", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) {
    e.preventDefault();
    handleKey(e.key, { shift: e.shiftKey });
  }
});

/* ---- Server events ---------------------------------------------------------------------------------- */
function applyStatus(s) {
  state.status = s;
  setBusy(!!s.busy);
  $("model").textContent = s.model ? `· ${s.model}` : "";
  $("conn").classList.toggle("on", !!s.running);
  $("conn").title = s.running ? "Claude Code is running" : "Claude Code starts with the next message";
  $("shot").disabled = !s.chrome;
  $("shot").parentElement.title = s.chrome ? "Attach a screenshot of the current slide with the pin markers"
    : "Screenshots need Chrome or Chromium";
  renderToolbar();
}
function connect() {
  const es = new EventSource(`/api/events?t=${TOKEN}`);
  es.addEventListener("hello", (ev) => {
    const d = JSON.parse(ev.data);
    clearChat();
    state.turns = new Map(d.turns.map((t) => [t.id, t]));
    d.chat.forEach(renderEntry);
    applyStatus(d.status);
    scrollChat();
  });
  es.addEventListener("chat", (ev) => {
    const e = JSON.parse(ev.data);
    if ((e.kind === "turn" || e.kind === "edit") && e.turnId) state.turns.set(e.turnId, { id: e.turnId, undone: false });
    renderEntry(e);
    scrollChat();
  });
  es.addEventListener("chat-update", (ev) => renderEntry(JSON.parse(ev.data)));
  es.addEventListener("status", (ev) => applyStatus(JSON.parse(ev.data)));
  es.addEventListener("reset", () => { clearChat(); state.turns.clear(); });
  es.addEventListener("undone", (ev) => {
    const d = JSON.parse(ev.data);
    const t = state.turns.get(d.turnId);
    if (t) t.undone = d.undone !== false;
    rerenderTurns();
  });
  es.addEventListener("files", (ev) => {
    const { files, manual } = JSON.parse(ev.data);
    const cssOnly = files.every((f) => f.endsWith(".css"));
    if (manual && main) {
      loadMeasure();   // the visible slide already shows the hand edit
    } else if (cssOnly && main) {
      main.bridge.reloadCss(files);
      measure?.bridge?.reloadCss(files);
    } else {
      loadMain();
      loadMeasure();
    }
  });
  es.addEventListener("measure", async (ev) => {
    const { id, index } = JSON.parse(ev.data);
    try { api("measure-result", { id, result: await queueMeasure(index) }); }
    catch (err) { api("measure-result", { id, error: String(err) }); }
  });
  // EventSource reconnects by itself; if the server restarted, our token is stale: reload the page
  es.onerror = async () => {
    try { if ((await api("ping")).status === 403) location.reload(); } catch {}
  };
}

/* ---- Attachments: figures and audio for the next message -------------------------------------------
   Files are uploaded at once into <deck>/figures/. Images get their pixel size, audio its duration and a
   waveform SVG (bars, viewBox 1000 x 120, like the template's audio player), all computed here in the
   browser. Removing an attachment before sending deletes the uploaded file again. */
let attachments = [], attachSeq = 0;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i, AUDIO_EXT = /\.(wav|mp3|ogg|oga|m4a|aac|flac|opus)$/i;
const kindOf = (f) => (f.type.startsWith("image/") || IMAGE_EXT.test(f.name) ? "image"
  : f.type.startsWith("audio/") || AUDIO_EXT.test(f.name) ? "audio" : null);
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

async function uploadBlob(blob, name) {
  const res = await fetch("/api/upload", { method: "POST", body: blob,
    headers: { "x-editor-token": TOKEN, "x-filename": encodeURIComponent(name), "content-type": blob.type || "application/octet-stream" } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `Could not upload ${name}.`);
  return d;
}
function imageSize(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {});
    img.onerror = () => resolve({});
    img.src = URL.createObjectURL(file);
  });
}
async function audioInfo(file) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    const n = 220, W = 1000, H = 120, len = audio.length;
    const chans = [...Array(audio.numberOfChannels)].map((_, c) => audio.getChannelData(c));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = Math.floor((i * len) / n), b = Math.floor(((i + 1) * len) / n);
      for (const ch of chans) for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(ch[j]));
      peaks.push(m);
    }
    const top = Math.max(...peaks) || 1;
    const bars = peaks.map((p, i) => {
      const h = Math.max(3, (p / top) * (H - 10));
      return `<rect x="${(i * W / n + 1.2).toFixed(1)}" y="${((H - h) / 2).toFixed(1)}" width="${(W / n - 2.4).toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>`;
    }).join("");
    return { meta: { duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels },
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g fill="#6B7785">${bars}</g></svg>` };
  } catch {
    return { meta: {}, svg: null };   // a format the browser cannot decode: attach it without waveform
  }
}
async function attachFile(file, droppedAt) {
  const name = file.name && file.name !== "image.png" ? file.name : `pasted-image-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  const kind = kindOf({ type: file.type || "", name });
  if (!kind) return toast(`${file.name || "This file"} is not an image or audio file.`);
  const a = { id: ++attachSeq, name, kind, status: "uploading", bytes: file.size, droppedAt,
    preview: kind === "image" ? URL.createObjectURL(file) : null };
  attachments.push(a);
  renderAttachments();
  try {
    let wave = null;
    if (kind === "image") Object.assign(a, await imageSize(file));
    else { const info = await audioInfo(file); Object.assign(a, info.meta); wave = info.svg; }
    Object.assign(a, await uploadBlob(file, name));
    if (wave) {
      const w = await uploadBlob(new Blob([wave], { type: "image/svg+xml" }), a.path.split("/").pop().replace(/\.[^.]+$/, "") + "-wave.svg");
      a.waveform = w.path;
    }
    a.status = attachments.includes(a) ? "ready" : "removed";
    if (a.status === "removed") api("upload-remove", { path: a.path, waveform: a.waveform });   // removed while uploading
  } catch (err) {
    a.status = "error";
    a.error = String(err.message || err);
  }
  renderAttachments();
}
function attachFiles(files, droppedAt) { [...files].forEach((f) => attachFile(f, droppedAt)); }
function removeAttachment(id) {
  const a = attachments.find((x) => x.id === id);
  if (!a) return;
  attachments = attachments.filter((x) => x !== a);
  if (a.status === "ready") api("upload-remove", { path: a.path, waveform: a.waveform });
  if (a.preview) URL.revokeObjectURL(a.preview);
  renderAttachments();
}
function clearAttachments() {
  attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
  attachments = [];
  renderAttachments();
}
function renderAttachments() {
  $("attach-tray").innerHTML = attachments.map((a) => {
    const info = a.status === "uploading" ? "uploading…" : a.status === "error" ? a.error
      : [a.kind === "image" && a.width ? `${a.width} × ${a.height}` : "", a.duration ? `${a.duration.toFixed(1)} s` : "",
         fmtBytes(a.bytes), a.droppedAt ? `dropped on slide ${a.droppedAt.slide.index + 1}` : ""].filter(Boolean).join(" · ");
    return `<span class="att ${a.status}" title="${esc(a.path || a.name)}">
      ${a.kind === "image" ? `<img class="thumb" src="${a.preview || "/deck/" + esc(a.path)}" alt="">` : '<span class="icon-box">🔊</span>'}
      <span class="meta"><b>${esc(a.path ? a.path.split("/").pop() : a.name)}</b><span>${esc(info)}</span></span>
      ${a.status === "uploading" ? '<span class="spinner"></span>' : ""}
      <button class="x" data-unattach="${a.id}" aria-label="Remove ${esc(a.name)}">×</button></span>`;
  }).join("");
}
$("attach-tray").addEventListener("click", (e) => {
  const x = e.target.closest("[data-unattach]");
  if (x) removeAttachment(+x.dataset.unattach);
});
$("attach").onclick = () => $("file-input").click();
$("file-input").onchange = () => { attachFiles($("file-input").files); $("file-input").value = ""; };
$("input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  attachFiles(files);
});
// drag and drop onto the chat (the slide frame forwards its own drops through the bridge)
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("drop-hint").hidden = false; } });
document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();   // never let the browser open the file instead
  dragDepth = 0;
  $("drop-hint").hidden = true;
  attachFiles(e.dataTransfer.files);
});

/* ---- Start ------------------------------------------------------------------------------------------- */
loadMain();
loadMeasure();
renderPinTray();
connect();
