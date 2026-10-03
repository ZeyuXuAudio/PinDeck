/* PowerPoint import: turns slides read by pptx.mjs into slides of this deck, in its own layouts.

   What is reliable becomes real HTML: titles, bullets, paragraphs, references and speaker notes.
   Pictures are copied. Everything drawn from shapes (diagrams, tables, charts, pictures with labels on
   them) becomes a picture cut from the slide as PowerPoint renders it (see pptx-render.mjs).

   Two steps, so the server can render the cut-outs in between:
     planSlides(model, numbers, opts) -> plans: the slide's text and layout, and per picture either
                                         a media part to copy or a region of the slide to render
     slidesHtml(deckHtml, css, plans)  -> the new <section>s, in the style of the deck's own slides
   buildImport() runs both, with the rendering and the figure files in between. */

import fs from "node:fs";
import path from "node:path";
import { renderJobs } from "./pptx-render.mjs";
import { parse, findSlides, walk, elementEnd, classList } from "./eids.mjs";
import { findAll as xfindAll, textOf as xtextOf } from "./xml.mjs";

/* ---- Geometry -------------------------------------------------------------------------------------- */
const right = (b) => b.x + b.w, bottom = (b) => b.y + b.h;
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y }; };
const pad = (b, d) => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
const meets = (a, b) => a.x <= right(b) && b.x <= right(a) && a.y <= bottom(b) && b.y <= bottom(a);
const overlapArea = (a, b) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const bboxOf = (boxes) => boxes.reduce((u, b) => (u ? union(u, b) : b), null);

/* ---- Text ------------------------------------------------------------------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const paraText = (p) => p.runs.map((r) => (r.br ? " " : r.math ? mathText(r.math) : r.text || "")).join("").replace(/\s+/g, " ").trim();
const mathText = (m) => xfindAll(m, "m:t").map(xtextOf).join("");

function runsHtml(runs) {
  let out = "";
  for (const r of runs) {
    if (r.br) { out += "<br>"; continue; }
    if (r.math) { out += esc(mathText(r.math)); continue; }
    let s = esc(r.text || "");
    if (!s) continue;
    // keep surrounding spaces outside the tags: "<strong>Goal:</strong> text"
    const [, lead, core, trail] = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!core) { out += s; continue; }
    let h = core;
    if (r.sup) h = `<sup>${h}</sup>`;
    if (r.sub) h = `<sub>${h}</sub>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.href) h = `<a href="${escAttr(r.href)}">${h}</a>`;
    out += lead + h + trail;
  }
  return out.replace(/<\/strong>(\s*)<strong>/g, "$1").replace(/<\/em>(\s*)<em>/g, "$1").trim();
}

/* Paragraphs as HTML: runs of bullets become one <ul class="bullets"> nested by level, others <p>. */
function parasHtml(paras, ind) {
  const out = [];
  for (let i = 0; i < paras.length;) {
    if (!paras[i].bullet) { out.push(`${ind}<p>${runsHtml(paras[i].runs)}</p>`); i++; continue; }
    // a tree of items: a deeper paragraph belongs to the item before it
    const root = { level: -1, kids: [] }, stack = [root];
    while (i < paras.length && paras[i].bullet) {
      const p = paras[i++];
      while (stack.length > 1 && stack.at(-1).level >= p.level) stack.pop();
      const item = { level: p.level, p, kids: [] };
      stack.at(-1).kids.push(item);
      stack.push(item);
    }
    const list = (items, ind2, cls) => [`${ind2}<ul${cls}>`, ...items.map((it) => it.kids.length
      ? `${ind2}  <li>${runsHtml(it.p.runs)}\n${list(it.kids, ind2 + "    ", "")}\n${ind2}  </li>`
      : `${ind2}  <li>${runsHtml(it.p.runs)}</li>`), `${ind2}</ul>`].join("\n");
    out.push(list(root.kids, ind, ' class="bullets"'));
  }
  return out.join("\n");
}

/* The text of a paragraph split at its line breaks */
function lineParts(p) {
  const parts = [];
  let cur = "";
  for (const r of p.runs) { if (r.br) { parts.push(cur); cur = ""; } else cur += r.math ? mathText(r.math) : r.text || ""; }
  return [...parts, cur];
}

/* Rough size of the text itself (a placeholder box is often much larger than its text) */
function textExtent(shape) {
  let h = 8, widest = 0;
  for (const p of shape.paras) {
    for (const t of lineParts(p)) {
      const w = t.length * 0.45 * p.size + 36 * (p.level + (p.bullet ? 1 : 0));
      widest = Math.max(widest, w);
      h += Math.max(1, Math.ceil(w / Math.max(shape.box.w, 100))) * 1.2 * p.size;
    }
    h += 0.2 * p.size;
  }
  return { x: shape.box.x, y: shape.box.y, w: Math.min(shape.box.w, widest + 16), h: Math.min(shape.box.h, h) };
}

const REF_RE = /et al\.|\b(19|20)\d\d\b|doi|arxiv|proc\.|journal|trans\.|conf\.|icassp|interspeech|eusipco|waspaa/i;
const EVENT_RE = /\b(19|20)\d\d\b|conference|workshop|symposium|meeting|congress|seminar|colloquium|tagung|konferenz|interspeech|icassp|eusipco|waspaa|\bdaga\b|\baes\b/i;
const INSTITUTE_RE = /universit|institut|laborator|\blabs?\b|department|school|college|fraunhofer|gmbh|\binc\b|\bltd\b|center|centre|faculty|fakultät/i;

/* ---- Planning ------------------------------------------------------------------------------------------ */
/* opts: { prefix: file name stem for new figures, height: slide height in px (720) } */
export function planSlides(model, numbers, { prefix = "import", height = model.height } = {}) {
  const wanted = new Set(numbers);
  // the deck's usual body text size: the size of most first-level text in body placeholders
  const count = new Map();
  for (const s of model.slides) for (const sh of s.shapes) if (sh.ph && ["body", "obj"].includes(sh.ph.type))
    for (const p of sh.paras || []) if (!p.level) count.set(Math.round(p.size), (count.get(Math.round(p.size)) || 0) + paraText(p).length);
  const refSize = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || 32;
  return model.slides.filter((s) => wanted.has(s.n)).map((s) => planSlide(s, { prefix, height, refSize }));
}

/* Text noticeably smaller (or larger) than the deck's body text keeps that difference */
function sizeRatio(paras, refSize) {
  const top = paras.filter((p) => p.level === Math.min(...paras.map((q) => q.level)));
  const r = top.reduce((a, p) => a + p.size, 0) / top.length / refSize;
  return r > 0.9 && r < 1.1 ? 1 : Math.max(0.5, Math.min(1.25, r));
}

function planSlide(slide, { prefix, height, refSize }) {
  const plan = { n: slide.n, kind: slide.kind, hidden: slide.hidden, title: slide.title, subtitle: slide.subtitle,
    titleRuns: null, notes: slide.notes, body: [], refs: [], figures: [], extra: {} };
  const shapes = slide.shapes.filter((s) => s.box && s.box.w > 0.5 && s.box.h > 0.5 || s.tag === "cxnSp" && s.box);
  const isTitle = (s) => s.ph && ["title", "ctrTitle"].includes(s.ph.type);
  const hasText = (s) => s.tag === "sp" && s.paras?.some((p) => paraText(p));

  if (slide.kind === "title" || slide.kind === "section") {
    // title slides: the lines below the title, top to bottom, are subtitle, authors, event, institute
    const lines = shapes.filter((s) => !isTitle(s) && hasText(s) && !(s.filled && !s.ph))
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
      .flatMap((s) => s.paras.map((p) => ({ p, ph: s.ph?.type })));
    const pick = (pred) => { const i = lines.findIndex(pred); return i < 0 ? null : lines.splice(i, 1)[0].p; };
    const sub = pick((l) => l.ph === "subTitle");
    if (!plan.subtitle && (sub || slide.kind === "title")) {
      const first = sub || (lines.length > 1 || slide.kind === "section" ? pick(() => true) : null);
      if (first) plan.subtitle = paraText(first);
    }
    if (slide.kind === "title") {
      const ev = pick((l) => EVENT_RE.test(paraText(l.p)));
      const inst = pick((l) => INSTITUTE_RE.test(paraText(l.p)) && !/\band\b|,/.test(paraText(l.p)));
      const auth = pick(() => true);
      plan.extra = { authors: auth && runsHtml(auth.runs), event: ev && runsHtml(ev.runs), institute: inst && runsHtml(inst.runs) };
    }
    return plan;
  }

  // Content slides. Visible shapes (pictures, frames, lines, filled or outlined shapes) that touch form
  // a figure; short text boxes on or next to a figure are its labels.
  const avs = shapes.filter((s) => s.tag === "pic" && s.av);
  const visuals = shapes.filter((s) => !s.av && (s.tag === "pic" || s.tag === "graphicFrame" || s.tag === "cxnSp" ||
    (s.tag === "sp" && !s.ph && (s.filled || s.lined))));
  const texts = shapes.filter((s) => s.tag === "sp" && !isTitle(s) && s.ph?.type !== "subTitle" && hasText(s) && !visuals.includes(s));

  let clusters = visuals.map((v) => ({ members: [v], box: v.box }));
  const mergeAll = () => {
    for (let changed = true; changed;) {
      changed = false;
      outer: for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        if (meets(pad(clusters[i].box, 12), pad(clusters[j].box, 12))) {
          clusters[i] = { members: [...clusters[i].members, ...clusters[j].members], box: union(clusters[i].box, clusters[j].box) };
          clusters.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  };
  mergeAll();
  // a lone line or an empty frame filling most of the slide is decoration, not a figure
  clusters = clusters.filter((c) => !(c.members.length === 1 && c.members[0].tag === "cxnSp") &&
    !(c.members.length === 1 && c.members[0].tag === "sp" && !hasText(c.members[0]) && c.box.w * c.box.h > 0.5 * 1280 * height));
  const free = new Set(texts);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of free) {
      const chars = t.paras.reduce((n, p) => n + paraText(p).length, 0);
      const short = !t.ph && chars <= 60 && t.paras.length <= 3;
      const near = chars <= 40 ? 20 : 10;   // captions sit a little further away
      const c = clusters.find((c) => meets(pad(c.box, near), t.box) && (short || overlapArea(c.box, t.box) >= 0.6 * t.box.w * t.box.h));
      if (!c) continue;
      c.members.push(t);
      c.box = union(c.box, t.box);
      c.labels = [...(c.labels || []), t];
      free.delete(t);
      changed = true;
    }
    if (changed) mergeAll();
  }

  // references: text near the bottom that reads like a citation
  const items = [];
  for (const t of texts.filter((t) => free.has(t))) {
    const txt = t.paras.map(paraText).join(" ");
    if (!t.ph && t.box.y >= 0.8 * height && REF_RE.test(txt)) plan.refs.push(...t.paras);
    else items.push({ type: "text", paras: t.paras, box: textExtent(t), real: t.box, ratio: sizeRatio(t.paras, refSize) });
  }
  const titleShape = shapes.find(isTitle);
  // where the title's text ends (its box is often taller): lines at 1.1 times the font size below the inset
  const titleBottom = titleShape ? titleShape.box.y + 4.8 + titleShape.paras.reduce((h, p) => h + lineParts(p).length * 1.1 * p.size, 0) : 0;
  let k = 0;
  const name = (ext) => `figures/${prefix}-s${String(slide.n).padStart(2, "0")}-${++k}.${ext}`;
  for (const c of clusters) {
    const only = c.members.length === 1 ? c.members[0] : null;
    let fig;
    if (only?.tag === "pic" && only.displayable && !only.cropped) fig = { file: name(only.ext), media: only.media, box: c.box, alt: `Figure from slide ${slide.n}` };
    else {
      // fallback when no renderer is available: the largest picture of the group, if any
      const pics = c.members.filter((m) => m.tag === "pic" && m.displayable).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
      // the picture covers the shapes and the text in the labels (a text box is taller than its text)
      // labels: from the top of their first line (inset 4.8 px plus the space above capitals)
      let ink = bboxOf(c.members.map((m) => {
        if (!(c.labels || []).includes(m)) return m.box;
        const top = 4.8 + 0.12 * m.paras[0].size;
        return { ...m.box, y: m.box.y + top, h: Math.max(1, m.box.h - top - 4) };
      }));
      let crop = pad(ink, 4);
      if (crop.y < titleBottom + 1 && bottom(ink) > titleBottom + 40) crop = { ...crop, y: Math.max(titleBottom + 1, ink.y - 1), h: bottom(crop) - Math.max(titleBottom + 1, ink.y - 1) };
      fig = { file: name("png"), crop, box: ink, fallback: pics[0] ? { media: pics[0].media, ext: pics[0].ext } : null,
        alt: `${only?.table ? "Table" : only?.chart ? "Chart" : "Figure"} from slide ${slide.n}` };
    }
    plan.figures.push(fig);
    items.push({ type: "fig", fig, box: c.box, real: c.box });
  }
  for (const a of avs) {
    if (!a.av.media) continue;
    const fig = { file: name(path.posix.extname(a.av.media).slice(1).toLowerCase() || (a.av.kind === "video" ? "mp4" : "wav")), media: a.av.media, av: a.av.kind, box: a.box };
    plan.figures.push(fig);
    items.push({ type: "fig", fig, box: a.box, real: a.box });
  }

  plan.body = layout(items);
  return plan;
}

/* XY cut: split into rows or columns where nothing crosses the gap (the cut with the wider gap wins),
   recursively; what cannot be cut is read top to bottom. Small overlaps are allowed, since text sizes
   are estimates and text boxes have padding. */
function layout(items) {
  if (items.length <= 1) return items;
  const cut = (pos, len, overlap) => {
    const sorted = [...items].sort((a, b) => a.box[pos] - b.box[pos]);
    const groups = [[sorted[0]]];
    let end = sorted[0].box[pos] + sorted[0].box[len], gap = Infinity;
    for (const it of sorted.slice(1)) {
      if (it.box[pos] >= end - overlap) { gap = Math.min(gap, it.box[pos] - end); groups.push([it]); }
      else groups.at(-1).push(it);
      end = Math.max(end, it.box[pos] + it.box[len]);
    }
    return { groups, gap };
  };
  const rows = cut("y", "h", 8), cols = cut("x", "w", 24);
  if (rows.groups.length > 1 && (cols.groups.length === 1 || rows.gap >= cols.gap)) return rows.groups.flatMap(layout);
  if (cols.groups.length > 1) return [{ type: "cols", cols: cols.groups.map(layout), widths: cols.groups.map((c) => bboxOf(c.map((i) => i.box)).w) }];
  return [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/* Render jobs for the figures that are cut from the slide picture. */
export function cropJobs(plans, dir) {
  return plans.flatMap((p) => p.figures.filter((f) => f.crop).map((f) => ({ page: p.n, box: [f.crop.x, f.crop.y, f.crop.w, f.crop.h], scale: 2, out: path.join(dir, path.basename(f.file)), fig: f })));
}

/* ---- HTML in the deck's style ---------------------------------------------------------------------------- */
function cssVar(css, name, fallback) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([\\d.]+)px`));
  return m ? +m[1] : fallback;
}

/* The deck's own slides, used as models: content, title and section slides, and how headings look. */
function deckModels(html) {
  const tree = parse(html);
  const slides = findSlides(tree);
  const kindOf = (s) => classList(s).find((c) => /-slide$/.test(c)) || "content";
  const findIn = (node, pred) => { let hit = null; walk({ children: [node] }, (c) => { if (!hit && pred(c)) hit = c; return !hit; }); return hit; };
  const content = slides.find((s) => kindOf(s) === "content" && findIn(s, (c) => classList(c).includes("slide-head")));
  const out = { title: slides.find((s) => kindOf(s) === "title-slide"), section: slides.find((s) => kindOf(s) === "section-slide"),
    content, sectionCount: (before) => slides.filter((s, i) => i <= before && kindOf(s) === "section-slide").length, slides };
  out.head = { mode: "plain", headTag: '<div class="slide-head">', h2Tag: "<h2>", subTag: '<span class="sub">', kickerTag: '<p class="kicker">',
    sectionTag: '<section class="slide">', bodyTag: '<div class="slide-body">', hasRefs: /class="[^"]*\brefs\b/.test(html) };
  if (content) {
    const tag = (n) => html.slice(n.start, n.tagEnd + 1).replace(/\s+data-eid="[^"]*"/g, "");
    out.head.sectionTag = tag(content).replace(/\s+data-visibility="[^"]*"/, "");
    const head = findIn(content, (c) => classList(c).includes("slide-head"));
    out.head.headTag = tag(head);
    const h2 = findIn(head, (c) => /^h[1-3]$/.test(c.name));
    const sub = h2 && findIn(h2, (c) => classList(c).includes("sub"));
    const kicker = findIn(head, (c) => classList(c).includes("kicker"));
    const body = findIn(content, (c) => classList(c).includes("slide-body"));
    if (h2) out.head.h2Tag = tag(h2), out.head.h2Close = `</${h2.name}>`;
    if (body) out.head.bodyTag = tag(body);
    if (sub) out.head.mode = "sub", out.head.subTag = tag(sub);
    else if (kicker) out.head.mode = "kicker", out.head.kickerTag = tag(kicker), out.head.kickerClose = `</${kicker.name}>`;
  }
  return out;
}

/* deckHtml: index.html; css: theme.css + brand.css; plans: from planSlides with figure files settled
   (fig.file, or fig.missing when it could not be made); after: index of the slide they follow. */
export function slidesHtml(deckHtml, css, plans, { after = -1, indent = "  " } = {}) {
  const models = deckModels(deckHtml);
  const m = cssVar(css, "m", 50), bodyTop = cssVar(css, "body-top", 150), footTop = cssVar(css, "foot-top", 650);
  const body = { w: 1280 - 2 * m, h: footTop - 30 - bodyTop, fs: cssVar(css, "fs-body", 28) };
  let section = models.sectionCount(after);
  const out = [];
  for (const p of plans) {
    let html;
    if (p.kind === "section" && models.section) html = sectionSlide(deckHtml, models.section, p, ++section);
    else if (p.kind === "title" && models.title) html = titleSlide(deckHtml, models.title, p);
    else html = contentSlide(models.head, p, body, indent);
    if (p.hidden) html = html.replace(/^<section\b[^>]*/, '$& data-visibility="hidden"');
    out.push(html);
  }
  return out;
}

function headHtml(h, p) {
  const title = esc(p.title || `Slide ${p.n}`), sub = p.subtitle ? esc(p.subtitle) : "";
  const close = h.h2Close || "</h2>";
  if (h.mode === "sub") return `${h.headTag}${h.h2Tag}${title}${sub ? `${h.subTag}${sub}</span>` : ""}${close}</div>`;
  if (h.mode === "kicker") return sub ? `${h.headTag}${h.kickerTag}${title}${h.kickerClose || "</p>"}${h.h2Tag}${sub}${close}</div>`
    : `${h.headTag}${h.h2Tag}${title}${close}</div>`;
  return `${h.headTag}${h.h2Tag}${title}${sub ? `: ${sub}` : ""}${close}</div>`;
}

function contentSlide(h, p, body, ind) {
  const i1 = ind + "  ", i2 = i1 + "  ";
  const { fig: scale, font } = fit(p.body, body);
  const lines = [h.sectionTag, `${i1}${headHtml(h, p)}`];
  const bodyTag = font < 1 ? h.bodyTag.replace(/>$/, ` style="font-size:${Math.round(font * 100)}%">`) : h.bodyTag;
  if (p.body.length) lines.push(`${i1}${bodyTag}`, blocksHtml(p.body, i2, scale), `${i1}</div>`);
  if (p.refs.length) lines.push(h.hasRefs ? `${i1}<div class="refs">${p.refs.map((r) => runsHtml(r.runs)).join("<br>\n" + i2)}</div>`
    : `${i1}<p class="muted" style="font-size:.6em">${p.refs.map((r) => runsHtml(r.runs)).join("<br>")}</p>`);
  if (p.notes) lines.push(`${i1}<aside class="notes">${esc(p.notes).replace(/\n+/g, "<br>")}</aside>`);
  lines.push(`${ind}</section>`);
  return lines.join("\n");
}

/* How tall a layout would be in the deck: text in the deck's font size, figures scaled by f, all text by k */
const GAP = 16, COL_GAP = 56;
function heightOf(items, width, f, k, fs) {
  let h = 0;
  for (const it of items) {
    if (it.type === "text") {
      for (const p of it.paras) {
        const size = fs * k * (it.ratio || 1) * (p.level ? 0.86 : 1);
        const w = Math.max(80, width - 32 * (p.level + 1));
        for (const t of lineParts(p)) h += Math.max(1, Math.ceil(t.length * 0.53 * size / w)) * 1.3 * size;
        h += 0.5 * size;
      }
    } else if (it.type === "cols") {
      const total = it.widths.reduce((a, b) => a + b, 0), avail = width - COL_GAP * (it.cols.length - 1);
      h += Math.max(...it.cols.map((c, i) => heightOf(c, avail * it.widths[i] / total, f, k, fs)));
    } else if (it.fig.av === "audio") h += 60;
    else { const w = Math.min(it.box.w * f, width); h += it.box.h * w / it.box.w; }
    h += GAP;
  }
  return h - GAP;
}
/* The largest figure scale and text size (text shrinks last) at which the slide fits its body area */
function fit(items, body) {
  for (const k of [1, 0.94, 0.88, 0.82, 0.76, 0.7])
    for (let f = 1; f >= 0.5; f -= 0.05) if (heightOf(items, body.w, f, k, body.fs) <= body.h) return { fig: f, font: k };
  return { fig: 0.5, font: 0.7 };
}

function blocksHtml(items, ind, scale) {
  return items.map((it) => {
    if (it.type === "cols" && items.length > 1) return blocksHtml([{ ...it, auto: true }], ind, scale);
    if (it.type === "text") {
      const html = parasHtml(it.paras, ind);
      return it.ratio && it.ratio !== 1 ? html.replace(/^(\s*<(?:ul|p)\b)/, `$1 style="font-size:${it.ratio.toFixed(2)}em"`).replace(/\n(\s*<p)>/g, `\n$1 style="font-size:${it.ratio.toFixed(2)}em">`) : html;
    }
    if (it.type === "cols") {
      const n = it.cols.length, total = it.widths.reduce((a, b) => a + b, 0);
      // the columns keep their widths from the slide, unless they are about equal
      const even = Math.max(...it.widths) / Math.min(...it.widths) < 1.2;
      const cls = "cols";
      let style = even && n === 2 ? "" : ` style="grid-template-columns:${it.widths.map((w) => `${(w / total * n).toFixed(2)}fr`).join(" ")}"`;
      const cols = it.cols.map((col) => col.length === 1 && col[0].type !== "text" ? blocksHtml(col, ind + "  ", scale)
        : `${ind}  <div>\n${blocksHtml(col, ind + "    ", scale)}\n${ind}  </div>`);
      if (it.auto) style = style ? style.replace(/"$/, '; height:auto"') : ' style="height:auto"';
      return `${ind}<div class="${cls} top"${style}>\n${cols.join("\n")}\n${ind}</div>`;
    }
    const f = it.fig;
    if (f.missing) return `${ind}<div class="callout">${esc(f.missing)}</div>`;
    if (f.av === "audio") return `${ind}<audio controls src="${escAttr(f.file)}" preload="metadata"></audio>`;
    if (f.av === "video") return `${ind}<figure class="fig"><video controls src="${escAttr(f.file)}" preload="metadata" style="width:${Math.round(f.box.w * scale)}px"></video></figure>`;
    return `${ind}<figure class="fig"><img src="${escAttr(f.file)}" alt="${escAttr(f.alt || "")}" style="width:${Math.round(f.box.w * scale)}px"></figure>`;
  }).join("\n");
}

/* Title and section slides: a copy of the deck's own, with the texts replaced. */
function fillModel(html, model, fills) {
  let frag = html.slice(model.start, elementEnd(html, model)).replace(/\s+data-eid="[^"]*"/g, "");
  const root = parse(frag).children[0];
  const edits = [];
  const findIn = (pred) => { let hit = null; walk({ children: [root] }, (c) => { if (!hit && pred(c)) hit = c; return !hit; }); return hit; };
  const drop = (n) => {
    let a = n.start;
    while (a > 0 && /[ \t]/.test(frag[a - 1])) a--;
    if (frag[a - 1] === "\n") a--;
    edits.push({ start: a, end: elementEnd(frag, n), text: "" });
  };
  for (const [pred, value] of fills) {
    const n = findIn(pred);
    if (!n) continue;
    if (value == null || value === "") drop(n);
    else edits.push({ start: n.contentStart, end: n.closeStart, text: value });
  }
  for (const c of root.children) if (c.name === "aside") drop(c);
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) frag = frag.slice(0, e.start) + e.text + frag.slice(e.end);
  return frag.replace(/\s+data-visibility="[^"]*"/, "");
}
const has = (cls) => (n) => classList(n).includes(cls);

function titleSlide(html, model, p) {
  const sub = p.subtitle ? esc(p.subtitle) : "";
  const tplHasSub = /class="[^"]*\bsubtitle\b/.test(html.slice(model.start, elementEnd(html, model)));
  const frag = fillModel(html, model, [
    [(n) => n.name === "h1", esc(p.title) + (sub && !tplHasSub ? `<br>\n          ${sub}` : "")],
    [has("subtitle"), sub],
    [has("authors"), p.extra.authors],
    [has("event"), p.extra.event],
    [has("institute"), p.extra.institute],
  ]);
  return addNotes(frag, p);
}
function sectionSlide(html, model, p, number) {
  const tpl = html.slice(model.start, elementEnd(html, model));
  const numWidth = (tpl.match(/class="[^"]*\bnum\b[^"]*"[^>]*>\s*([^<]*)</) || [, "00"])[1].trim().length;
  const frag = fillModel(html, model, [
    [has("num"), String(number).padStart(numWidth, "0")],
    [(n) => /^h[12]$/.test(n.name), esc(p.title || `Section ${number}`)],
    [(n) => n.name === "p" && !has("kicker")(n) && !has("num")(n), p.subtitle ? esc(p.subtitle) : null],
  ]);
  return addNotes(frag, p);
}
function addNotes(frag, p) {
  if (!p.notes) return frag;
  const close = frag.lastIndexOf("</section>");
  const ind = (frag.match(/\n([ \t]*)<\/section>\s*$/) || [, ""])[1];
  return frag.slice(0, close).replace(/\s*$/, "") + `\n${ind}  <aside class="notes">${esc(p.notes).replace(/\n+/g, "<br>")}</aside>\n${ind}` + frag.slice(close);
}

/* ---- All together ------------------------------------------------------------------------------------------ */
/* Plans the slides, renders the cut-outs from the slide PDF (if there is one) and returns the new
   slides and the figure files to write: { fragments, files: [{ rel, data }], plans }. Nothing is written
   into the deck here. */
export async function buildImport({ model, numbers, pdf, workDir, deckDir, deckHtml, css, after, prefix }) {
  const plans = planSlides(model, numbers, { prefix });
  const taken = new Set();
  const free = (rel) => {
    const ext = path.posix.extname(rel), stem = rel.slice(0, -ext.length);
    let r = rel, k = 2;
    while (taken.has(r) || fs.existsSync(path.join(deckDir, r))) r = `${stem}-${k++}${ext}`;
    taken.add(r);
    return r;
  };
  for (const p of plans) for (const f of p.figures) f.file = free(f.file);
  const jobs = pdf ? cropJobs(plans, workDir) : [];
  if (jobs.length) await renderJobs(pdf, jobs.map(({ fig, ...j }) => j), workDir);
  const files = [];
  for (const p of plans) {
    for (const f of p.figures) {
      const job = jobs.find((j) => j.fig === f);
      let data = null;
      if (f.media) data = model.zip.read(f.media);
      else if (job && fs.existsSync(job.out)) data = fs.readFileSync(job.out);
      else if (f.fallback) {
        data = model.zip.read(f.fallback.media);
        taken.delete(f.file);
        f.file = free(f.file.replace(/\.png$/, "." + f.fallback.ext));
      }
      if (data) files.push({ rel: f.file, data });
      else f.missing = `${f.alt || "A figure"}: PinDeck needs PowerPoint or Keynote to make a picture of it.`;
    }
  }
  return { plans, files, fragments: slidesHtml(deckHtml, css, plans, { after }) };
}
