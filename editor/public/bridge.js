/* Editor bridge, injected into the deck page by the editor server (never saved to the deck).

   Modes (?editor=...):
     main     the visible slide in the editor: navigation, pins, hover outlines
     measure  hidden 1280x720 copy used to measure any slide without moving the user's view
     shot     headless screenshot of one slide, with pin markers
     dump     headless measurement; writes the result into the DOM for --dump-dom */

(function () {
  const params = new URLSearchParams(location.search);
  const MODE = params.get("editor");
  const FOOTER_TOP = 647;   // footer rule, brand.css (centred on y = 648.7, 3 px)
  const LOCKED_SEL = ".slide-foot, .logo-al, .logo-fau, .logo-fh, .banner";
  const host = () => (window.parent !== window ? window.parent.__editorHost : null);
  let W = 1280, H = 720;

  /* ---- Styles for editor-only overlays ---------------------------------------- */
  const css = document.createElement("style");
  // --u = screen pixels per slide pixel, inverted: overlays keep a constant on-screen size at any zoom
  css.textContent = `
    .__pin { position:absolute; z-index:1000; width:calc(26px*var(--u,1)); height:calc(26px*var(--u,1));
      margin:calc(-13px*var(--u,1)) 0 0 calc(-13px*var(--u,1)); border-radius:50%;
      background:#ED8C01; color:#fff; font:700 calc(14px*var(--u,1))/calc(26px*var(--u,1)) system-ui, sans-serif; text-align:center;
      box-shadow:0 0 0 calc(2px*var(--u,1)) #fff, 0 calc(2px*var(--u,1)) calc(6px*var(--u,1)) rgba(0,0,0,.45);
      cursor:pointer; pointer-events:auto; }
    .__hover { position:absolute; z-index:999; pointer-events:none; outline:calc(2px*var(--u,1)) dashed #ED8C01;
      outline-offset:calc(2px*var(--u,1)); background:rgba(237,140,1,.06); }
    .__hover span { position:absolute; left:calc(-2px*var(--u,1)); background:#ED8C01; color:#fff; white-space:nowrap;
      font:600 calc(11px*var(--u,1))/calc(17px*var(--u,1)) system-ui, sans-serif; padding:0 calc(5px*var(--u,1));
      border-radius:calc(3px*var(--u,1)); }
    .__hover span.above { top:calc(-21px*var(--u,1)); } .__hover span.below { bottom:calc(-21px*var(--u,1)); }
    .__hover.locked { outline-color:#888; background:rgba(0,0,0,.04); }
    .__hover.locked span { background:#888; }
    .__flash { position:absolute; z-index:998; pointer-events:none; outline:calc(3px*var(--u,1)) solid #ED8C01;
      outline-offset:calc(3px*var(--u,1)); animation:__flash 1.4s ease-out forwards; }
    @keyframes __flash { 0%,60% { opacity:1 } 100% { opacity:0 } }
    html.__pinmode .reveal .slides section, html.__pinmode .reveal .slides section * { cursor:crosshair !important; }
    html.__pinmode .reveal .slides section .__pin { cursor:pointer !important; }`;
  document.head.appendChild(css);

  /* ---- Geometry ------------------------------------------------------------------ */
  const slides = () => Reveal.getSlides();
  const indexOf = (sec) => slides().indexOf(sec);
  const r1 = (v) => Math.round(v);
  function frame(sec) {
    const r = sec.getBoundingClientRect();
    return { r, s: r.width / W || 1 };
  }
  function boxOf(el, sec) {
    const { r, s } = frame(sec);
    const b = el.getBoundingClientRect();
    return { x: r1((b.left - r.left) / s), y: r1((b.top - r.top) / s), w: r1(b.width / s), h: r1(b.height / s) };
  }
  const byEid = (eid, root = document) => root.querySelector(`[data-eid="${CSS.escape(eid)}"]`);

  /* Visible text of an element, without KaTeX's hidden MathML copy. */
  function textOf(el, ownOnly) {
    if (el.tagName === "IMG") return el.getAttribute("alt") || (el.getAttribute("src") || "").split("/").pop();
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(".katex-mathml, .__pin, .__hover, .__flash, aside.notes, script, style")) return NodeFilter.FILTER_REJECT;
        if (ownOnly) { const owner = p.closest("[data-eid]"); if (owner !== el) return NodeFilter.FILTER_REJECT; }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      const n = walker.currentNode;
      out += n.nodeValue + (n.parentElement.closest(".katex") ? "" : " "); // KaTeX splits math into one span per glyph
    }
    return out.replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  }
  function fontOf(el) {
    const cs = getComputedStyle(el);
    return `${Math.round(parseFloat(cs.fontSize))}px${+cs.fontWeight >= 600 ? " bold" : ""}`;
  }
  function slideInfo(sec, i = indexOf(sec)) {
    const head = sec.querySelector("h1, h2, h3");
    let title = "", sub = "";
    if (head) {
      const subEl = head.querySelector(".sub");
      sub = subEl ? textOf(subEl) : "";
      title = textOf(head);
      if (sub && title.endsWith(sub)) title = title.slice(0, -sub.length).trim();
    }
    const kind = [...sec.classList].find((c) => /-slide$/.test(c)) || "content";
    return { index: i, eid: sec.dataset.eid || `#${i + 1}`, title: title || sec.dataset.eid || `Slide ${i + 1}`, sub, kind,
      hasFooter: !!sec.querySelector(".slide-foot") };
  }
  function info() {
    return { slides: slides().map((s, i) => slideInfo(s, i)), current: indexOf(Reveal.getCurrentSlide()) };
  }

  /* ---- Layout measurement ------------------------------------------------------------- */
  function measureSection(sec) {
    const si = slideInfo(sec);
    const els = [sec, ...sec.querySelectorAll("[data-eid]")];
    const elements = [], meta = [];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const b = boxOf(el, sec);
      let depth = 0;
      for (let p = el.parentElement; p && p !== sec.parentElement; p = p.parentElement) if (p.dataset?.eid) depth++;
      const hidden = cs.display === "none" || cs.visibility === "hidden" || (b.w === 0 && b.h === 0);
      const leaf = !el.querySelector("[data-eid]");
      const own = el === sec ? "" : textOf(el, !leaf);
      const tag = el.tagName.toLowerCase() + (el.classList.length ? "." + [...el.classList].filter((c) => !/^(fragment|visible|current-fragment|present|past|future)$/.test(c)).join(".") : "");
      const e = { eid: el.dataset.eid || si.eid, tag: tag.replace(/\.$/, ""), depth, ...b };
      if (own && el.tagName !== "IMG" && el !== sec) e.font = fontOf(el);
      if (own) e.text = own;
      if (hidden) e.hidden = true;
      if (el !== sec && el.matches(LOCKED_SEL)) e.locked = true;
      elements.push(e);
      meta.push({ el, e, hidden, cs, inSvg: !!el.closest("svg") && el.tagName.toLowerCase() !== "svg" });
    }

    const issues = [];
    const rel = (eid) => (eid.startsWith(si.eid + "/") ? eid.slice(si.eid.length) : eid);
    const flagged = new Set();
    const underFlagged = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (flagged.has(p)) return true; return false; };
    for (const { el, e, hidden, cs } of meta) {
      if (el === sec || hidden || e.locked) continue;
      if (e.x < -1 || e.y < -1 || e.x + e.w > W + 1 || e.y + e.h > H + 1) {
        if (!underFlagged(el)) issues.push(`${rel(e.eid)} extends outside the slide (box x=${e.x}..${e.x + e.w}, y=${e.y}..${e.y + e.h})`);
        flagged.add(el);
      } else if (si.hasFooter && e.y + e.h > FOOTER_TOP + 1 && e.y < H) {
        if (!underFlagged(el)) issues.push(`${rel(e.eid)} reaches y=${e.y + e.h}, below the footer rule (y=${FOOTER_TOP})`);
        flagged.add(el);
      }
      const clips = /(hidden|clip|auto|scroll)/.test(cs.overflowX + cs.overflowY);
      if (clips && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2))
        issues.push(`${rel(e.eid)} clips its content (${Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth)} px hidden)`);
    }
    // Overlaps between elements that are not nested in each other (SVG groups excluded: they overlap by design)
    const cand = meta.filter((m) => m.el !== sec && !m.hidden && !m.e.locked && !m.inSvg && m.e.w * m.e.h > 0);
    let overlaps = 0;
    for (let i = 0; i < cand.length && overlaps < 8; i++) {
      for (let j = i + 1; j < cand.length && overlaps < 8; j++) {
        const a = cand[i], b = cand[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ix = Math.min(a.e.x + a.e.w, b.e.x + b.e.w) - Math.max(a.e.x, b.e.x);
        const iy = Math.min(a.e.y + a.e.h, b.e.y + b.e.h) - Math.max(a.e.y, b.e.y);
        if (ix <= 0 || iy <= 0) continue;
        const area = ix * iy, small = Math.min(a.e.w * a.e.h, b.e.w * b.e.h);
        if (area < 100 || area < 0.05 * small) continue;
        // skip pairs whose ancestors already overlap (report the outermost pair only)
        const pa = a.el.parentElement?.closest("[data-eid]"), pb = b.el.parentElement?.closest("[data-eid]");
        if (pa && pb && pa !== pb && !pa.contains(pb) && !pb.contains(pa) && pa !== sec && pb !== sec) continue;
        issues.push(`${rel(a.e.eid)} overlaps ${rel(b.e.eid)} (${ix} x ${iy} px)`);
        overlaps++;
      }
    }
    return { slide: si, width: W, height: H, footerTop: FOOTER_TOP, elements, issues };
  }
  // Layout is computed synchronously on read, so no timer is needed (timers are throttled in background tabs).
  const nextFrame = () => Promise.resolve();

  /* ---- Navigation ------------------------------------------------------------------------ */
  function goto(index) {
    const sec = slides()[index];
    if (!sec) return;
    const ix = Reveal.getIndices(sec);
    Reveal.slide(ix.h, ix.v);
  }
  function indices(index) { const sec = slides()[index]; return sec ? Reveal.getIndices(sec) : { h: 0, v: 0 }; }

  /* ---- Pins and hover ---------------------------------------------------------------------- */
  let pinMode = false, pins = [];
  function wordAt(x, y, el) {
    let node, offset;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || node.nodeType !== 3 || !el.contains(node) || node.parentElement.closest(".katex-mathml")) return null;
    const s = node.nodeValue;
    const isW = (c) => /[\p{L}\p{N}_\-.,%×]/u.test(c);
    let a = offset, b = offset;
    while (a > 0 && isW(s[a - 1])) a--;
    while (b < s.length && isW(s[b])) b++;
    const w = s.slice(a, b).replace(/[.,]+$/, "");
    return w || null;
  }
  function targetOf(t) {
    if (!t || !t.closest) return null;
    const sec = t.closest(".reveal .slides section");
    if (!sec || t.closest(".__pin, .__hover")) return null;
    const foot = t.closest(".slide-foot");
    const el = foot ? sec : t.closest("[data-eid]") || sec;
    const locked = foot ? "footer, set by brand.css (locked)" : el !== sec && el.matches(LOCKED_SEL) ? "positioned by brand.css (locked)" : null;
    return { sec: el === sec ? sec : el.closest("section"), el, locked, foot };
  }
  function onPointerDown(e) {
    if (!pinMode || MODE !== "main") return;
    e.preventDefault(); e.stopPropagation();
  }
  function onClick(e) {
    if (!pinMode || MODE !== "main") return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const marker = e.target.closest?.(".__pin");
    if (marker) { host()?.removePin(+marker.dataset.n); return; }
    const t = targetOf(e.target);
    if (!t) return;
    const { r, s } = frame(t.sec);
    const point = { x: r1((e.clientX - r.left) / s), y: r1((e.clientY - r.top) / s) };
    const box = t.foot ? boxOf(t.foot, t.sec) : boxOf(t.el, t.sec);
    const at = { fx: box.w ? Math.min(1, Math.max(0, (point.x - box.x) / box.w)) : 0.5, fy: box.h ? Math.min(1, Math.max(0, (point.y - box.y) / box.h)) : 0.5 };
    const cellEl = e.target.closest?.("td, th");
    const textEl = e.target.nodeType === 1 && e.target.closest(".__pin") == null ? e.target : t.el;
    const pin = {
      slide: slideInfo(t.sec), eid: t.el.dataset.eid || slideInfo(t.sec).eid,
      tag: t.foot ? "footer.slide-foot" : t.el.tagName.toLowerCase() + (t.el.classList.length ? "." + [...t.el.classList].join(".") : ""),
      text: textOf(t.foot || t.el).slice(0, 200), box, point, at,
      word: wordAt(e.clientX, e.clientY, t.foot || t.el), font: fontOf(textEl),
      cell: cellEl ? { row: cellEl.parentElement.rowIndex, col: cellEl.cellIndex, text: textOf(cellEl) } : null,
      locked: t.locked,
    };
    host()?.addPin(pin);
  }
  let hoverBox = null;
  function onMove(e) {
    if (!pinMode || MODE !== "main") return hideHover();
    const t = targetOf(e.target);
    if (!t) return hideHover();
    if (!hoverBox) { hoverBox = document.createElement("div"); hoverBox.className = "__hover"; hoverBox.appendChild(document.createElement("span")); }
    const target = t.foot || t.el;
    const b = boxOf(target, t.sec);
    if (hoverBox.parentElement !== t.sec) t.sec.appendChild(hoverBox);
    Object.assign(hoverBox.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" });
    hoverBox.classList.toggle("locked", !!t.locked);
    const eid = t.foot ? "footer (locked)" : t.el.dataset.eid || "";
    hoverBox.firstChild.textContent = (t.el === t.sec && !t.foot ? "slide " : "") + eid.replace(/^[^/]+\//, "/") + (t.locked && !t.foot ? " (locked)" : "");
    hoverBox.firstChild.className = b.y < 30 ? "below" : "above";
  }
  function hideHover() { hoverBox?.remove(); }

  function renderPins(list) {
    pins = list || [];
    document.querySelectorAll(".__pin").forEach((p) => p.remove());
    for (const p of pins) {
      const sec = byEid(p.slide.eid);
      if (!sec || sec.tagName !== "SECTION") continue;
      let x = p.point.x, y = p.point.y;
      const el = p.eid !== p.slide.eid ? byEid(p.eid, sec) : null;
      if (el && el.getClientRects().length) {
        const b = boxOf(el, sec);
        x = b.x + p.at.fx * b.w; y = b.y + p.at.fy * b.h;
      }
      const m = document.createElement("div");
      m.className = "__pin";
      m.dataset.n = p.n;
      m.textContent = p.n;
      m.title = "Click to remove pin " + p.n;
      Object.assign(m.style, { left: x + "px", top: y + "px" });
      sec.appendChild(m);
    }
  }
  function highlight(eid) {
    const el = byEid(eid);
    if (!el) return;
    const sec = el.tagName === "SECTION" ? el : el.closest("section");
    if (sec !== Reveal.getCurrentSlide()) return;
    const b = boxOf(el, sec);
    const f = document.createElement("div");
    f.className = "__flash";
    Object.assign(f.style, { left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" });
    sec.appendChild(f);
    setTimeout(() => f.remove(), 1500);
  }

  /* ---- Stylesheet hot swap (no reload, no flicker) -------------------------------------------- */
  function reloadCss(files) {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
    return Promise.all(links.filter((l) => files.some((f) => new URL(l.href).pathname.endsWith("/" + f))).map((l) =>
      new Promise((resolve) => {
        const n = l.cloneNode();
        const u = new URL(l.href);
        u.searchParams.set("v", Date.now());
        n.href = u.href;
        n.onload = n.onerror = () => { l.remove(); resolve(); setTimeout(() => renderPins(pins), 0); };
        l.after(n);
      })));
  }

  /* ---- Start ------------------------------------------------------------------------------------- */
  async function start() {
    W = Reveal.getConfig().width; H = Reveal.getConfig().height;
    const base = { transition: "none", backgroundTransition: "none", fragments: false };
    const setUnit = () => document.documentElement.style.setProperty("--u", String(1 / (Reveal.getScale() || 1)));
    Reveal.on("resize", setUnit);
    if (MODE === "main") Reveal.configure({ ...base });
    else Reveal.configure({ ...base, margin: 0, keyboard: false });
    setUnit();
    await document.fonts.ready;

    if (MODE === "shot" || MODE === "dump") {
      const sec = byEid(params.get("slide") || "") || slides()[0];
      goto(indexOf(sec));
      await nextFrame();
      if (MODE === "shot") {
        try { renderPins(JSON.parse(params.get("pins") || "[]").map((p) => ({ ...p, slide: { eid: sec.dataset.eid } }))); } catch {}
      } else {
        let out;
        try { out = measureSection(sec); } catch (err) { out = { error: String(err) }; }
        const s = document.createElement("script");
        s.id = "__editor_layout"; s.type = "application/json";
        s.textContent = JSON.stringify(out).replace(/</g, "\\u003c");
        document.body.appendChild(s);
      }
      return;
    }

    const api = {
      info, goto, indices, highlight, reloadCss,
      setPinMode(on) { pinMode = !!on; document.documentElement.classList.toggle("__pinmode", pinMode); if (!pinMode) hideHover(); },
      renderPins,
      async measure(index) {
        goto(index);
        await nextFrame();
        return measureSection(slides()[index]);
      },
    };
    window.__editorBridge = api;

    if (MODE === "main") {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseleave", hideHover);
      window.addEventListener("keydown", (e) => {
        if (e.target.closest?.("input, textarea, [contenteditable]")) return;
        const k = e.key;
        if (k === "p" || k === "P" || k === "Escape" || (k === "Enter" && !e.shiftKey) ||
            ((e.metaKey || e.ctrlKey) && (k === "z" || k === "k"))) {
          e.preventDefault(); e.stopImmediatePropagation();
          host()?.key(k, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
        }
      }, true);
      Reveal.on("slidechanged", () => { hideHover(); host()?.slideChanged(indexOf(Reveal.getCurrentSlide())); });
      const startAt = +params.get("start");
      if (startAt) goto(startAt);
    }
    host()?.bridgeReady(MODE, api, window);
  }
  if (typeof Reveal === "undefined") return;
  if (Reveal.isReady()) start(); else Reveal.on("ready", start);
})();
