/* Stable element ids for PinDeck.

   Gives every slide <section> and every visible element inside it a readable
   data-eid attribute ("summary", "summary/callout", "summary/li-2"), so the
   editor, the pins and Claude can all name the same element.

   The HTML is edited as text: only the attribute is inserted, so comments,
   indentation and everything else in the file stay exactly as they are.
   Existing ids are kept; duplicates (e.g. from a copied slide) are renamed. */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);

/* Elements that get an id. Inline formatting (strong, em, sup, br, ...) does not:
   a pin on bold text resolves to the enclosing element plus the clicked word. */
const TAGGED = new Set(["section", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li",
  "dl", "dt", "dd", "figure", "figcaption", "img", "svg", "table", "caption", "tr", "div",
  "button", "audio", "video", "iframe", "pre", "blockquote", "canvas", "header", "footer",
  "aside", "nav", "article"]);
const GENERIC_CLASSES = new Set(["fragment", "slide", "visible", "current-fragment", "present",
  "past", "future", "top", "left", "right", "center"]);

const ATTR_RE = /([^\s"'=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(src, offset) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    let valueStart = -1;
    if (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined) {
      let k = m[0].indexOf("=") + 1;
      while (/\s/.test(m[0][k])) k++;
      if (m[0][k] === '"' || m[0][k] === "'") k++;
      valueStart = offset + m.index + k;
    }
    const start = offset + m.index;
    attrs[name] = { value, valueStart, valueEnd: valueStart + value.length, start, end: start + m[0].length };
  }
  return attrs;
}

/* Minimal HTML tokenizer: builds an element tree with source offsets. */
export function parse(html) {
  const root = { name: "#root", children: [], parent: null };
  let cur = root;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(lt, lt + 80));
      if (!m) { i = lt + 1; continue; }
      const name = m[1].toLowerCase();
      // pop to the matching element (tolerates unclosed <p>/<li>)
      let node = cur;
      while (node !== root && node.name !== name) node = node.parent;
      if (node !== root) {
        let c = cur;
        while (c !== node) { c.closeStart = lt; c = c.parent; }
        node.closeStart = lt;
        cur = node.parent;
      }
      i = lt + m[0].length;
      continue;
    }
    if (!/[a-zA-Z]/.test(html[lt + 1] || "")) { i = lt + 1; continue; }

    // opening tag: scan to '>' outside quotes
    let j = lt + 1;
    while (j < n && /[\w:-]/.test(html[j])) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const nameEnd = j;
    let quote = null;
    while (j < n) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    const tagEnd = j; // index of '>'
    const selfClose = html[tagEnd - 1] === "/";
    const attrSrc = html.slice(nameEnd, selfClose ? tagEnd - 1 : tagEnd);
    const node = {
      name, start: lt, nameEnd, tagEnd, selfClose,
      attrs: parseAttrs(attrSrc, nameEnd),
      children: [], parent: cur, contentStart: tagEnd + 1, closeStart: -1,
    };
    cur.children.push(node);
    i = tagEnd + 1;
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {
      const close = html.toLowerCase().indexOf("</" + name, i);
      node.closeStart = close < 0 ? n : close;
      const gt = html.indexOf(">", node.closeStart);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

const classesOf = (node) => (node.attrs.class?.value || "").split(/\s+/).filter(Boolean);

function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d));
}
function textOf(html, node) {
  if (node.closeStart < 0) return "";
  return decode(html.slice(node.contentStart, node.closeStart).replace(/<[^>]*>/g, " "))
    .replace(/\\[()[\]]/g, " ").replace(/\s+/g, " ").trim();
}
function slug(text, maxWords = 4) {
  const words = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join("-");
}
function walk(node, fn) {
  for (const c of node.children) { if (fn(c) !== false) walk(c, fn); }
}
function find(node, pred) {
  let hit = null;
  walk(node, (c) => { if (hit) return false; if (pred(c)) { hit = c; return false; } });
  return hit;
}

/* Slides are the <section>s inside the element with class "slides" (Reveal.js). */
export function findSlides(tree) {
  const slidesEl = find(tree, (c) => classesOf(c).includes("slides"));
  if (!slidesEl) return [];
  const out = [];
  const visit = (node) => {
    for (const c of node.children) {
      if (c.name !== "section") continue;
      out.push(c);
      visit(c); // vertical stacks
    }
  };
  visit(slidesEl);
  return out;
}

function slideTitle(html, section) {
  const cls = classesOf(section);
  const heading = find(section, (c) => /^h[1-3]$/.test(c.name));
  let main = "", sub = "";
  if (heading) {
    const subEl = find(heading, (c) => classesOf(c).includes("sub"));
    sub = subEl ? textOf(html, subEl) : "";
    main = textOf(html, heading);
    if (sub && main.endsWith(sub)) main = main.slice(0, -sub.length).trim();
  }
  return { main, sub, kind: cls.find((c) => /-slide$/.test(c)) || "content" };
}

function elementName(node) {
  if (node.name === "g") {
    const idx = node.attrs["data-fragment-index"]?.value;
    return idx ? `step-${idx}` : "g";
  }
  const cls = classesOf(node).find((c) => !GENERIC_CLASSES.has(c));
  return cls ? slug(cls.replace(/-/g, " "), 3) || node.name : node.name;
}

/* Returns { html, changed, assigned: [eid...], renamed: [[old,new]...], slides: [{eid,title,kind}] } */
export function assignEids(html) {
  const tree = parse(html);
  const sections = findSlides(tree);
  const used = new Set();
  const edits = []; // { at, insert } or { start, end, replace }
  const assigned = [], renamed = [];

  // Pass 1: slide ids. Content slides that share a main title ("Background") are named by subtitle.
  const titles = sections.map((s) => slideTitle(html, s));
  const mainCount = {};
  titles.forEach((t) => { if (t.main) mainCount[t.main] = (mainCount[t.main] || 0) + 1; });

  const unique = (base) => {
    let name = base, k = 2;
    while (used.has(name)) name = `${base}-${k++}`;
    used.add(name);
    return name;
  };
  const setEid = (node, eid) => {
    const existing = node.attrs["data-eid"];
    if (existing) {
      edits.push({ start: existing.valueStart, end: existing.valueEnd, replace: eid });
      renamed.push([existing.value, eid]);
    } else {
      let at = node.selfClose ? node.tagEnd - 1 : node.tagEnd;
      while (at > node.nameEnd && /\s/.test(html[at - 1])) at--;
      edits.push({ start: at, end: at, replace: ` data-eid="${eid}"` });
      assigned.push(eid);
    }
    node.eid = eid;
  };

  // Keep every existing, non-duplicate id first so new names never collide with them.
  const keep = new Set();
  sections.forEach((s) => walk({ children: [s] }, (c) => {
    const v = c.attrs?.["data-eid"]?.value;
    if (v && !used.has(v)) { used.add(v); keep.add(c); c.eid = v; }
  }));

  const slides = [];
  sections.forEach((section, i) => {
    const t = titles[i];
    if (!keep.has(section)) {
      let base;
      if (t.kind === "title-slide") base = "title";
      else if (t.kind === "closing-slide") base = "closing";
      else if (t.sub && mainCount[t.main] > 1) base = slug(t.sub);
      else base = slug(t.main) || slug(t.sub);
      setEid(section, unique(base || `slide-${i + 1}`));
    }
    slides.push({ eid: section.eid, title: [t.main, t.sub].filter(Boolean).join(" / "), kind: t.kind });

    // Pass 2: elements inside the slide
    const visit = (node, inSvg) => {
      for (const c of node.children) {
        if (c.name === "section") continue; // nested slide, handled on its own
        const cls = classesOf(c);
        if (c.name === "aside" && cls.includes("notes")) continue;
        if (c.attrs["data-noeid"]) continue;
        const isSvgRoot = c.name === "svg";
        const tagged = inSvg ? c.name === "g" : (TAGGED.has(c.name) || (c.name === "span" && cls.length > 0));
        if (tagged && !keep.has(c)) setEid(c, unique(`${section.eid}/${elementName(c)}`));
        visit(c, inSvg || isSvgRoot);
      }
    };
    visit(section, false);
  });

  if (!edits.length) return { html, changed: false, assigned, renamed, slides };
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.replace + out.slice(e.end);
  return { html: out, changed: true, assigned, renamed, slides };
}

/* ---- Inline style edits (drag and resize in the editor) ---------------------------------- */

/* Sets or removes CSS properties in a style attribute, keeping the untouched declarations
   exactly as written. A value of null or "" removes the property. */
export function mergeStyle(src, set) {
  const parts = src.split(";").filter((p) => p.trim());
  const todo = Object.fromEntries(Object.entries(set).map(([k, v]) => [k.toLowerCase(), v]));
  const out = [];
  for (const p of parts) {
    const name = p.split(":")[0].trim().toLowerCase();
    if (!(name in todo)) { out.push(p); continue; }
    const v = todo[name];
    delete todo[name];
    if (v != null && v !== "") out.push(`${p.match(/^\s*/)[0]}${name}: ${v}`);
  }
  for (const [k, v] of Object.entries(todo)) if (v != null && v !== "") out.push(`${out.length ? " " : ""}${k}: ${v}`);
  return out.join(";").trim();
}

/* edits: [{ eid, set: { prop: value|null } }]. Returns { html, changed, missing: [eid] }. */
export function setStyles(html, edits) {
  const tree = parse(html);
  const byEid = new Map();
  walk(tree, (c) => { const v = c.attrs?.["data-eid"]?.value; if (v && !byEid.has(v)) byEid.set(v, c); });
  const ops = [], missing = [];
  for (const e of edits) {
    const node = byEid.get(e.eid);
    if (!node) { missing.push(e.eid); continue; }
    const st = node.attrs.style;
    const value = mergeStyle(st ? st.value : "", e.set).replace(/"/g, "'");
    if (st) {
      if (value === st.value) continue;
      if (value) ops.push({ start: st.valueStart, end: st.valueEnd, replace: value });
      else {
        let a = st.start;
        while (a > node.nameEnd && /\s/.test(html[a - 1])) a--;
        ops.push({ start: a, end: st.end, replace: "" });
      }
    } else if (value) {
      let at = node.selfClose ? node.tagEnd - 1 : node.tagEnd;
      while (at > node.nameEnd && /\s/.test(html[at - 1])) at--;
      ops.push({ start: at, end: at, replace: ` style="${value}"` });
    }
  }
  if (!ops.length) return { html, changed: false, missing };
  ops.sort((a, b) => b.start - a.start);
  let out = html;
  for (const o of ops) out = out.slice(0, o.start) + o.replace + out.slice(o.end);
  return { html: out, changed: true, missing };
}

/* ---- Text edits (inline editing in the editor) --------------------------------------------- */

/* The element with this id, or a descendant reached by element-child indices (path), e.g. a
   table cell [2] under a row that has the id. */
function nodeAt(html, eid, path = []) {
  let node = null;
  walk(parse(html), (c) => { if (node) return false; if (c.attrs?.["data-eid"]?.value === eid) { node = c; return false; } });
  for (const i of path) node = node?.children[i] || null;
  return node && node.closeStart >= 0 ? node : null;
}

/* Inner HTML of an element exactly as written in the source (math still as TeX). */
export function getInner(html, eid, path) {
  const node = nodeAt(html, eid, path);
  return node ? html.slice(node.contentStart, node.closeStart) : null;
}

/* Replaces the inner HTML of one element. Returns { html, changed } or null if not found. */
export function setInner(html, eid, path, inner) {
  const node = nodeAt(html, eid, path);
  if (!node) return null;
  const old = html.slice(node.contentStart, node.closeStart);
  if (old === inner) return { html, changed: false };
  return { html: html.slice(0, node.contentStart) + inner + html.slice(node.closeStart), changed: true };
}

/* ---- New bullets (Enter in a list item) ------------------------------------------------------ */

const allEids = (html) => {
  const ids = new Set();
  walk(parse(html), (c) => { const v = c.attrs?.["data-eid"]?.value; if (v) ids.add(v); });
  return ids;
};
const closeEnd = (html, node) => html.indexOf(">", node.closeStart) + 1;
const lineIndent = (html, at) => {
  const ls = html.lastIndexOf("\n", at - 1) + 1;
  const pre = html.slice(ls, at);
  return /^\s*$/.test(pre) ? pre : "";
};

/* Inserts <tag class=...>inner</tag> right after the element `eid`, on its own line with the same
   indentation. The new element gets `newEid`, or a free variant of it. Returns { html, eid }. */
export function insertAfter(html, eid, { tag = "li", cls = "", inner = "", newEid }) {
  const node = nodeAt(html, eid);
  if (!node) return null;
  const used = allEids(html);
  let id = newEid || `${eid}-next`, k = 2;
  const base = id.replace(/-\d+$/, "");
  while (used.has(id)) id = `${base}-${k++}`;
  const end = closeEnd(html, node);
  const indent = lineIndent(html, node.start);
  const attrs = (cls ? ` class="${cls.replace(/"/g, "")}"` : "") + ` data-eid="${id}"`;
  const el = `${indent ? "\n" + indent : ""}<${tag}${attrs}>${inner}</${tag}>`;
  return { html: html.slice(0, end) + el + html.slice(end), eid: id };
}

/* Removes the element `eid`, and its line if nothing else is on it. Returns the new html or null. */
export function removeElement(html, eid) {
  const node = nodeAt(html, eid);
  if (!node) return null;
  let a = node.start, b = closeEnd(html, node);
  const indent = lineIndent(html, a);
  if (indent || html[a - 1] === "\n") {
    const rest = html.slice(b).match(/^[ \t]*(?=\n|$)/);
    if (rest) { a -= indent.length; b += rest[0].length; if (html[a - 1] === "\n") a--; }
  }
  return html.slice(0, a) + html.slice(b);
}
