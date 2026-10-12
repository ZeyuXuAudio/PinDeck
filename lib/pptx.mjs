/* PowerPoint (.pptx) reader: turns a presentation into a plain model PinDeck can import.

   readPptx(buffer) -> { width, height, slides: [slide] } with, per slide:
     n, hidden, layout ("title", "secHead", "obj", ... or the layout's name), kind (title/section/content),
     title, subtitle (strings), shapes (every shape with its box and, for text, its paragraphs),
     steps (build steps: which shapes or paragraphs appear or disappear on which click), notes
   Boxes are in slide pixels with the slide 1280 px wide (the PinDeck canvas). */

import path from "node:path";
import { readZip } from "./zip.mjs";
import { parseXml, kid, kids, path as xpath, find, findAll, textOf } from "./xml.mjs";

const R = "r:id", EMBED = "r:embed", LINK = "r:link";
const BROWSER_IMAGES = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"]);
const on = (v) => v === "1" || v === "true" || v === "on";   // OOXML booleans

function relsOf(zip, part) {
  const relPath = path.posix.join(path.posix.dirname(part), "_rels", path.posix.basename(part) + ".rels");
  const xml = zip.text(relPath);
  const out = {};
  if (!xml) return out;
  for (const r of findAll(parseXml(xml), "Relationship")) {
    const t = r.attrs.Target || "";
    // relative to the part's folder, or absolute from the package root ("/ppt/slides/slide1.xml")
    const target = r.attrs.TargetMode === "External" ? t
      : path.posix.normalize(t.startsWith("/") ? t.slice(1) : path.posix.join(path.posix.dirname(part), t));
    out[r.attrs.Id] = { target, type: (r.attrs.Type || "").split("/").pop(), external: r.attrs.TargetMode === "External" };
  }
  return out;
}

/* ---- Text ------------------------------------------------------------------------------------------ */
/* A coloured run (not black, white or grey, and not a dark or light theme colour) is an accent */
function accentColour(fill) {
  const rgb = fill && kid(fill, "a:srgbClr")?.attrs.val;
  if (rgb) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(rgb.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max > 0.25 && (max - min) / max > 0.4;
  }
  const scheme = fill && kid(fill, "a:schemeClr")?.attrs.val;
  return !!scheme && /^accent\d$/.test(scheme);
}

function runsOf(p, rels) {
  const runs = [];
  const visit = (el) => {
    for (const c of el.children || []) {
      if (!c.name) continue;
      if (c.name === "a:r" || c.name === "a:fld") {
        const rPr = kid(c, "a:rPr");
        const link = rPr && kid(rPr, "a:hlinkClick");
        // only web and mail links: a javascript: or file: link must not reach the deck
        const href = link && rels[link.attrs[R]]?.external && /^(https?:|mailto:)/i.test(rels[link.attrs[R]].target.trim())
          ? rels[link.attrs[R]].target.trim() : null;
        runs.push({ text: textOf(kid(c, "a:t")), b: rPr?.attrs.b === "1", i: rPr?.attrs.i === "1", href,
          sup: rPr?.attrs.baseline > 0, sub: rPr?.attrs.baseline < 0, hl: accentColour(rPr && kid(rPr, "a:solidFill")) });
      } else if (c.name === "a:br") runs.push({ br: true });
      else if (c.name === "a14:m" || c.name === "m:oMathPara" || c.name === "m:oMath") runs.push({ math: c });
      else if (c.name === "mc:AlternateContent") {
        // prefer the math in mc:Choice; fall back to the plain text of mc:Fallback
        const choice = kid(c, "mc:Choice"), fb = kid(c, "mc:Fallback");
        const m = choice && (find(choice, "a14:m") || find(choice, "m:oMathPara") || find(choice, "m:oMath"));
        if (m) runs.push({ math: m });
        else if (fb) visit(fb);
      }
    }
  };
  visit(p);
  // PowerPoint splits text into many runs (spell checking, edits); join neighbours that look the same.
  // A run of only spaces carries no visible formatting, so it joins the run before it.
  const same = (a, b) => a.b === b.b && a.i === b.i && a.href === b.href && a.sup === b.sup && a.sub === b.sub && a.hl === b.hl;
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (r.text != null && last?.text != null && (same(last, r) || (!r.text.trim() && !r.href))) last.text += r.text;
    else out.push(r.text != null ? { ...r } : r);
  }
  return out;
}
/* Font sizes in hundredths of a point per list level (1-9), from a list style (a:lstStyle, p:bodyStyle) */
function levelSizes(style) {
  const out = {};
  for (let l = 1; l <= 9; l++) {
    const sz = xpath(style, `a:lvl${l}pPr`, "a:defRPr")?.attrs.sz;
    if (sz) out[l - 1] = +sz;
  }
  return out;
}
/* sizes: { own (the shape's lstStyle), inherited (master body or other style), base (presentation default) } */
function paragraphsOf(txBody, rels, { bulletsByDefault, sizes = {}, pxPerPt = 1 }) {
  if (!txBody) return [];
  const out = [];
  const own = levelSizes(kid(txBody, "a:lstStyle"));
  const scale = +(xpath(txBody, "a:bodyPr", "a:normAutofit")?.attrs.fontScale || 100000) / 100000;
  let index = -1;
  for (const p of kids(txBody, "a:p")) {
    index++;   // counts empty paragraphs too: animations refer to paragraphs by this number
    const pPr = kid(p, "a:pPr");
    const runs = runsOf(p, rels);
    const lvl = +(pPr?.attrs.lvl || 0);
    const runSz = Math.max(0, ...findAll(p, "a:rPr").map((r) => +(r.attrs.sz || 0)));
    const sz = runSz || +(kid(p, "a:endParaRPr")?.attrs.sz || 0) || own[lvl] || sizes.inherited?.[lvl] || sizes.base?.[lvl] || 1800;
    const plain = runs.map((r) => r.text || "").join("");
    if (!plain.trim() && !runs.some((r) => r.math)) continue;
    const level = +(pPr?.attrs.lvl || 0);
    let bullet = bulletsByDefault;
    if (pPr && kid(pPr, "a:buNone")) bullet = false;
    if (pPr && (kid(pPr, "a:buChar") || kid(pPr, "a:buAutoNum"))) bullet = true;
    out.push({ index, level, bullet, numbered: !!(pPr && kid(pPr, "a:buAutoNum")), runs, size: sz / 100 * scale * pxPerPt });
  }
  return out;
}
const plainText = (paras) => paras.map((p) => p.runs.map((r) => (r.br ? "\n" : r.math ? findAll(r.math, "m:t").map(textOf).join("") : r.text || "")).join("")).join("\n").trim();

/* ---- Geometry: group transforms map child coordinates onto the slide -------------------------------- */
const IDENTITY = { sx: 1, sy: 1, tx: 0, ty: 0 };
function boxOf(spPr, t) {
  const x = spPr && kid(spPr, "a:xfrm");
  const off = x && kid(x, "a:off"), ext = x && kid(x, "a:ext");
  if (!off || !ext) return null;
  return { x: +off.attrs.x * t.sx + t.tx, y: +off.attrs.y * t.sy + t.ty, w: +ext.attrs.cx * t.sx, h: +ext.attrs.cy * t.sy };
}
function groupTransform(grpSpPr, t) {
  const x = grpSpPr && kid(grpSpPr, "a:xfrm");
  if (!x) return t;
  const off = kid(x, "a:off"), ext = kid(x, "a:ext"), chOff = kid(x, "a:chOff"), chExt = kid(x, "a:chExt");
  if (!off || !ext || !chOff || !chExt) return t;
  const sx = (+ext.attrs.cx / (+chExt.attrs.cx || 1)), sy = (+ext.attrs.cy / (+chExt.attrs.cy || 1));
  // child -> parent: (c - chOff) * s + off, then the parent's own transform
  return { sx: sx * t.sx, sy: sy * t.sy, tx: (+off.attrs.x - +chOff.attrs.x * sx) * t.sx + t.tx, ty: (+off.attrs.y - +chOff.attrs.y * sy) * t.sy + t.ty };
}

/* ---- Placeholders: positions come from the layout or master when the slide does not set them ---------- */
function placeholderOf(sp) {
  const nvPr = xpath(sp, "p:nvSpPr", "p:nvPr") || xpath(sp, "p:nvPicPr", "p:nvPr") || xpath(sp, "p:nvGraphicFramePr", "p:nvPr");
  const ph = nvPr && kid(nvPr, "p:ph");
  return ph ? { type: ph.attrs.type || "body", idx: ph.attrs.idx ?? null } : null;
}
function placeholderBoxes(zip, part) {
  const xml = zip.text(part);
  if (!xml) return [];
  const out = [];
  for (const sp of findAll(parseXml(xml), "p:sp")) {
    const ph = placeholderOf(sp), b = boxOf(kid(sp, "p:spPr"), IDENTITY);
    if (ph && b) out.push({ ...ph, box: b });
  }
  return out;
}
function inheritBox(ph, layoutPhs, masterPhs) {
  const same = (list) => list.find((p) => ph.idx != null && p.idx === ph.idx) ||
    list.find((p) => p.type === ph.type || (ph.type === "ctrTitle" && p.type === "title") || (ph.type === "subTitle" && p.type === "body"));
  return (same(layoutPhs) || same(masterPhs))?.box || null;
}

/* ---- Shapes ------------------------------------------------------------------------------------------- */
const hasVisibleFill = (sp) => {
  const spPr = kid(sp, "p:spPr");
  if (spPr && kid(spPr, "a:noFill")) return false;
  if (spPr && ["a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill"].some((n) => kid(spPr, n))) return true;
  const fillRef = xpath(sp, "p:style", "a:fillRef");
  return !!fillRef && +fillRef.attrs.idx > 0;
};
const hasVisibleLine = (sp) => {
  const ln = xpath(sp, "p:spPr", "a:ln");
  if (ln && kid(ln, "a:noFill")) return false;
  if (ln && kid(ln, "a:solidFill")) return true;
  const lnRef = xpath(sp, "p:style", "a:lnRef");
  return !!lnRef && +lnRef.attrs.idx > 0;
};

/* groupId: the id of the outermost group a shape is in (an animation of a group moves all its shapes) */
function collectShapes(tree, t, ctx, out, groupId = null) {
  for (const c of tree.children || []) {
    if (!c.name) continue;
    if (c.name === "p:grpSp") {
      if (on(xpath(c, "p:nvGrpSpPr", "p:cNvPr")?.attrs.hidden)) continue;
      collectShapes(c, groupTransform(kid(c, "p:grpSpPr"), t), ctx, out, groupId || xpath(c, "p:nvGrpSpPr", "p:cNvPr")?.attrs.id || null);
      continue;
    }
    if (c.name === "mc:AlternateContent") { const ch = kid(c, "mc:Choice") || kid(c, "mc:Fallback"); if (ch) collectShapes(ch, t, ctx, out, groupId); continue; }
    if (!["p:sp", "p:pic", "p:graphicFrame", "p:cxnSp"].includes(c.name)) continue;
    const ph = placeholderOf(c);
    const spPr = kid(c, "p:spPr") || kid(c, "p:xfrm") && { children: [{ ...kid(c, "p:xfrm"), name: "a:xfrm" }] };
    let box = boxOf(spPr, t);
    if (!box && ph) box = inheritBox(ph, ctx.layoutPhs, ctx.masterPhs);
    const cNvPr = xpath(c, "p:nvSpPr", "p:cNvPr") || xpath(c, "p:nvPicPr", "p:cNvPr") || xpath(c, "p:nvGraphicFramePr", "p:cNvPr") || xpath(c, "p:nvCxnSpPr", "p:cNvPr");
    if (on(cNvPr?.attrs.hidden)) continue;   // hidden in PowerPoint's selection pane
    const s = { tag: c.name.slice(2), id: cNvPr?.attrs.id || null, group: groupId, name: cNvPr?.attrs.name || "", descr: cNvPr?.attrs.descr || "", ph, box };
    if (c.name === "p:sp") {
      s.txBox = xpath(c, "p:nvSpPr", "p:cNvSpPr")?.attrs.txBox === "1";
      s.geom = xpath(c, "p:spPr", "a:prstGeom")?.attrs.prst || (xpath(c, "p:spPr", "a:custGeom") ? "custom" : null);
      s.paras = paragraphsOf(kid(c, "p:txBody"), ctx.rels, { bulletsByDefault: !!ph && ["body", "obj"].includes(ph.type),
        pxPerPt: ctx.pxPerPt, sizes: { inherited: ph ? (["title", "ctrTitle"].includes(ph.type) ? ctx.styles.title : ctx.styles.body) : ctx.styles.other, base: ctx.styles.base } });
      s.filled = hasVisibleFill(c);
      s.lined = hasVisibleLine(c);
    } else if (c.name === "p:pic") {
      const blip = find(c, "a:blip");
      const rel = blip && ctx.rels[blip.attrs[EMBED] || blip.attrs[LINK]];
      s.media = rel && !rel.external ? rel.target : null;
      s.ext = s.media ? path.posix.extname(s.media).slice(1).toLowerCase() : null;
      s.displayable = !!s.ext && BROWSER_IMAGES.has(s.ext);
      s.cropped = !!find(c, "a:srcRect") && Object.keys(find(c, "a:srcRect").attrs).length > 0;
      const nvPr = xpath(c, "p:nvPicPr", "p:nvPr");
      const av = nvPr && (kid(nvPr, "a:audioFile") || kid(nvPr, "a:videoFile"));
      const p14 = nvPr && find(nvPr, "p14:media");
      if (av || p14) {
        const r = ctx.rels[(p14 && p14.attrs[EMBED]) || (av && (av.attrs[LINK] || av.attrs[EMBED]))];
        s.av = { kind: av?.name === "a:videoFile" ? "video" : r && /video|\.(mp4|mov|m4v|webm)$/i.test(r.target) ? "video" : "audio",
          media: r && !r.external ? r.target : null };
      }
    } else if (c.name === "p:graphicFrame") {
      const uri = find(c, "a:graphicData")?.attrs.uri || "";
      s.table = uri.endsWith("/table") ? tableOf(find(c, "a:tbl"), ctx) : null;
      s.chart = uri.endsWith("/chart");
      s.diagram = uri.endsWith("/diagram");
      s.ole = uri.endsWith("/ole");
    }
    if (s.box) s.box = { x: s.box.x / ctx.emu, y: s.box.y / ctx.emu, w: s.box.w / ctx.emu, h: s.box.h / ctx.emu };
    out.push(s);
  }
  return out;
}

/* Tables: rows of cells with their paragraphs; merged cells are marked so they can be left out */
function tableOf(tbl, ctx) {
  if (!tbl) return null;
  const pr = kid(tbl, "a:tblPr");
  const rows = kids(tbl, "a:tr").map((tr) => kids(tr, "a:tc").map((tc) => ({
    paras: paragraphsOf(kid(tc, "a:txBody"), ctx.rels, { bulletsByDefault: false, pxPerPt: ctx.pxPerPt, sizes: { inherited: ctx.styles.other, base: ctx.styles.base } }),
    colspan: +(tc.attrs.gridSpan || 1), rowspan: +(tc.attrs.rowSpan || 1),
    merged: on(tc.attrs.hMerge) || on(tc.attrs.vMerge),
    below: on(tc.attrs.vMerge) && !on(tc.attrs.hMerge),   // under a row-spanning cell (holds its colspan)
  })));
  return { rows, header: on(pr?.attrs.firstRow) };
}

/* ---- Build steps ----------------------------------------------------------------------------------------
   The main sequence of p:timing: each click starts a group; effects "with" or "after" the previous one
   belong to the same click. Returns [{ click, kind: "in" | "out", shape, from, to }] where from/to are
   paragraph numbers when only some paragraphs of a text animate. Effects before the first click play
   when the slide opens (click 0). */
function stepsOf(root) {
  const seq = findAll(find(root, "p:timing"), "p:cTn").find((n) => n.attrs.nodeType === "mainSeq");
  if (!seq) return [];
  const out = [];
  let click = 0;
  for (const group of kids(kid(seq, "p:childTnLst"), "p:par")) {
    const cTn = kid(group, "p:cTn");
    // a click starts the group, unless it plays by itself when the slide opens: then PowerPoint adds
    // an onBegin condition to the "indefinite" one
    const conds = kids(xpath(cTn, "p:stCondLst"), "p:cond");
    if (conds.some((c) => c.attrs.delay === "indefinite") && !conds.some((c) => c.attrs.evt === "onBegin")) click++;
    for (const eff of findAll(group, "p:cTn").filter((n) => n.attrs.presetClass)) {
      const kind = eff.attrs.presetClass === "entr" ? "in" : eff.attrs.presetClass === "exit" ? "out" : null;
      if (!kind) continue;
      const seen = new Set();
      for (const tgt of findAll(eff, "p:spTgt")) {
        const rg = xpath(tgt, "p:txEl", "p:pRg");
        const key = `${tgt.attrs.spid}/${rg ? rg.attrs.st + "-" + rg.attrs.end : ""}`;
        if (seen.has(key)) continue;   // one effect animates its target in several behaviours
        seen.add(key);
        out.push({ click, kind, shape: tgt.attrs.spid, from: rg ? +rg.attrs.st : null, to: rg ? +rg.attrs.end : null });
      }
    }
  }
  return out;
}

/* ---- Presentation ---------------------------------------------------------------------------------------- */
export function readPptx(buf) {
  const zip = readZip(buf);
  const presPart = "ppt/presentation.xml";
  const pres = parseXml(zip.text(presPart) || "");
  const presRels = relsOf(zip, presPart);
  const sz = find(pres, "p:sldSz");
  const cx = +(sz?.attrs.cx || 12192000), cy = +(sz?.attrs.cy || 6858000);
  const emu = cx / 1280;
  const baseSizes = levelSizes(find(pres, "p:defaultTextStyle"));
  const masterStyles = new Map();
  const stylesOf = (part) => {
    if (!part) return {};
    if (!masterStyles.has(part)) {
      const tx = find(parseXml(zip.text(part) || ""), "p:txStyles");
      masterStyles.set(part, { title: levelSizes(kid(tx, "p:titleStyle")), body: levelSizes(kid(tx, "p:bodyStyle")), other: levelSizes(kid(tx, "p:otherStyle")) });
    }
    return masterStyles.get(part);
  };
  const slides = [];
  let n = 0;
  for (const id of findAll(pres, "p:sldId")) {
    const part = presRels[id.attrs[R]]?.target;
    if (!part || !zip.has(part)) continue;
    n++;
    const sld = parseXml(zip.text(part));
    const root = kid(sld, "p:sld");
    const rels = relsOf(zip, part);
    const layoutPart = Object.values(rels).find((r) => r.type === "slideLayout")?.target;
    const layoutXml = layoutPart && zip.text(layoutPart);
    const layoutRoot = layoutXml && kid(parseXml(layoutXml), "p:sldLayout");
    const masterPart = layoutPart && Object.values(relsOf(zip, layoutPart)).find((r) => r.type === "slideMaster")?.target;
    const ctx = { rels, emu, pxPerPt: 1280 / (cx / 12700), styles: { ...stylesOf(masterPart), base: baseSizes }, layoutPhs: layoutPart ? placeholderBoxes(zip, layoutPart) : [], masterPhs: masterPart ? placeholderBoxes(zip, masterPart) : [] };
    const tree = xpath(root, "p:cSld", "p:spTree");
    const shapes = tree ? collectShapes(tree, IDENTITY, ctx, []) : [];

    const isTitlePh = (s) => s.ph && ["title", "ctrTitle"].includes(s.ph.type);
    const titleShape = shapes.find(isTitlePh);
    const titleLines = titleShape ? plainText(titleShape.paras).split(/\n+/).map((l) => l.trim()).filter(Boolean) : [];
    const subShape = shapes.find((s) => s.ph?.type === "subTitle");
    const layoutType = layoutRoot?.attrs.type || "";
    const layoutName = kid(layoutRoot, "p:cSld")?.attrs.name || "";
    // custom layouts have no type; a first slide whose layout is called "Title ..." is the title slide
    const kind = layoutType === "title" || titleShape?.ph.type === "ctrTitle" ||
      (n === 1 && /title|titel/i.test(layoutName) && !/content|inhalt|text|only|nur/i.test(layoutName)) ? "title"
      : layoutType === "secHead" || /^section|abschnitt/i.test(layoutName) ? "section" : "content";

    // notes: the body placeholder of the notes slide
    const notesPart = Object.values(rels).find((r) => r.type === "notesSlide")?.target;
    let notes = "";
    if (notesPart && zip.has(notesPart)) {
      const nx = parseXml(zip.text(notesPart));
      const body = findAll(nx, "p:sp").find((sp) => placeholderOf(sp)?.type === "body");
      if (body) notes = plainText(paragraphsOf(kid(body, "p:txBody"), {}, { bulletsByDefault: false }));
    }

    slides.push({
      n, part, hidden: root?.attrs.show === "0" || root?.attrs.show === "false", layout: layoutType || layoutName, kind,
      // a subtitle placeholder often holds the authors, event and institute too: its first line is the subtitle
      title: titleLines[0] || "", subtitle: subShape ? plainText(subShape.paras.slice(0, 1)).replace(/\s*\n\s*/g, " ") : titleLines.slice(1).join(" "),
      titleParas: titleShape?.paras || [],
      shapes: shapes.filter((s) => !(s.ph && ["dt", "ftr", "sldNum", "hdr"].includes(s.ph.type))),
      steps: stepsOf(root),
      notes,
    });
  }
  return { width: 1280, height: Math.round(1280 * cy / cx), slides, zip };
}

/* Media bytes of a part path (e.g. "ppt/media/image3.png"). */
export const mediaOf = (model, part) => model.zip.read(part);
