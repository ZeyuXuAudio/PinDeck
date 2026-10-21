/* The Linux tools behind PDF and PowerPoint pictures and audio waveforms: Poppler (pdfinfo, pdftoppm),
   LibreOffice (soffice) and ffmpeg. Each test runs where its tool is installed (CI installs them on Linux)
   and is skipped elsewhere. process.platform is set to "linux" during a test, so on macOS they check the
   Linux code path with the Mac's own copies of the tools. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findExecutable } from "../lib/capabilities.mjs";
import { pdfInfo, renderJobs, exportPdf, renderAvailable } from "../lib/pptx-render.mjs";
import { waveformSvg } from "../lib/waveform.mjs";

const has = (name) => !!findExecutable(name).path;
const POPPLER = has("pdftoppm") && has("pdfinfo");
const SOFFICE = has("soffice") || has("libreoffice");

function asLinux(t) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", real));
}
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pindeck tools "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* A PDF with pages of the given sizes (points) and content streams */
function makePdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + 2 * i} 0 R`).join(" ")}] >>`];
  pages.forEach(([w, h, content]) => {
    const n = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${n + 1} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

/* A PNG's size and pixels (8-bit grey, RGB or RGBA, not interlaced): enough to check what was rendered */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let i = 8, w, h, type, idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), kind = buf.toString("latin1", i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; assert.equal(data[8], 8); }
    if (kind === "IDAT") idat.push(data);
    i += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[type], raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  return { w, h, grey: (x, y) => px[y * stride + x * bpp] };   // first channel is enough for black or white
}

test("Poppler: page sizes, whole pages to a width, and boxes cut exactly where PDFKit cuts them",
  { skip: !POPPLER && "Poppler (pdftoppm, pdfinfo) not installed" }, async (t) => {
  asLinux(t);
  const dir = tmp(t), pdf = path.join(dir, "paper.pdf");
  // page 1: 400 x 200 pt, black in the top-left quarter (PDF y runs upwards); page 2: 300 x 300 pt, white
  fs.writeFileSync(pdf, makePdf([[400, 200, "0 0 0 rg 0 100 200 100 re f"], [300, 300, ""]]));
  assert.deepEqual(await pdfInfo(pdf, dir), { pages: 2, sizes: [[400, 200], [300, 300]] });

  const whole = path.join(dir, "p1.png"), tl = path.join(dir, "tl.png"), bl = path.join(dir, "bl.png");
  const pages = await renderJobs(pdf, [
    { page: 1, out: whole, width: 800 },
    { page: 1, out: tl, box: [0, 0, 200, 100], scale: 2 },     // top-left quarter, in points (slideWidth = 400)
    { page: 1, out: bl, box: [0, 100, 200, 100], scale: 2 },   // bottom-left quarter
    { page: 9, out: path.join(dir, "none.png"), width: 100 },  // no such page: skipped, as PDFKit does
  ], dir, { slideWidth: 400 });
  assert.equal(pages, 2);
  const w = readPng(whole);
  assert.deepEqual([w.w, w.h], [800, 400]);
  assert.equal(w.grey(100, 50), 0, "black at the top left");
  assert.equal(w.grey(700, 350), 255, "white at the bottom right");
  const a = readPng(tl), b = readPng(bl);
  assert.deepEqual([a.w, a.h, b.w, b.h], [400, 200, 400, 200]);
  assert.equal(a.grey(5, 5) + a.grey(395, 195), 0, "the top-left box is all black");
  assert.equal(b.grey(5, 5) + b.grey(395, 195), 510, "the bottom-left box is all white");
  assert.equal(fs.existsSync(path.join(dir, "none.png")), false);
});

test("LibreOffice: a PowerPoint file to PDF with its hidden slide, then pictures of the slides",
  { skip: !(SOFFICE && POPPLER) && "LibreOffice and Poppler not both installed", timeout: 300000 }, async (t) => {
  asLinux(t);
  assert.equal(renderAvailable(), true);
  const dir = tmp(t);
  // a two-slide presentation, the second hidden, written as flat ODP and turned into .pptx by LibreOffice
  const fodp = path.join(dir, "talk.fodp");
  fs.writeFileSync(fodp, `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:style style:name="hidden" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>
 </office:automatic-styles>
 <office:body><office:presentation>
  <draw:page draw:name="One"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="12cm" svg:height="3cm"><draw:text-box><text:p>Slide one</text:p></draw:text-box></draw:frame></draw:page>
  <draw:page draw:name="Two" draw:style-name="hidden"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="12cm" svg:height="3cm"><draw:text-box><text:p>Hidden slide</text:p></draw:text-box></draw:frame></draw:page>
 </office:presentation></office:body>
</office:document>`);
  const soffice = findExecutable("soffice").path || findExecutable("libreoffice").path;
  execFileSync(soffice, ["--headless", "--norestore", `-env:UserInstallation=${pathToFileURL(path.join(dir, "profile")).href}`,
    "--convert-to", "pptx", "--outdir", dir, fodp], { timeout: 240000 });
  const pptx = path.join(dir, "talk.pptx");
  assert.ok(fs.existsSync(pptx), "LibreOffice made the .pptx");

  const { pdf, app } = await exportPdf(pptx, dir);
  assert.equal(app, "LibreOffice");
  const info = await pdfInfo(pdf, dir);
  assert.equal(info.pages, 2, "the hidden slide is exported too, so page n is slide n");
  const outs = [1, 2].map((n) => path.join(dir, `thumb-${n}.png`));
  await renderJobs(pdf, outs.map((out, i) => ({ page: i + 1, out, width: 320 })), dir);
  for (const out of outs) assert.equal(readPng(out).w, 320);
});

test("ffmpeg: a waveform for audio other than WAV", { skip: !has("ffmpeg") && "ffmpeg not installed" }, async (t) => {
  asLinux(t);
  const dir = tmp(t), mp3 = path.join(dir, "tone.mp3");
  execFileSync(findExecutable("ffmpeg").path, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", mp3]);
  const svg = await waveformSvg(fs.readFileSync(mp3), "mp3");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 1000 120"/);
  assert.ok((svg.match(/<rect /g) || []).length > 10);
  assert.equal(await waveformSvg(Buffer.from("not audio"), "mp3"), null);
});

test("PDFKit (macOS) and Poppler (Linux) render the same jobs alike",
  { skip: !(process.platform === "darwin" && POPPLER) && "needs macOS with Poppler installed" }, async (t) => {
  const dir = tmp(t), pdf = path.join(dir, "paper.pdf");
  fs.writeFileSync(pdf, makePdf([[400, 200, "0 0 0 rg 0 100 200 100 re f 0.5 g 300 0 100 50 re f"]]));
  const jobs = (tag) => [
    { page: 1, out: path.join(dir, `${tag}-whole.png`), width: 400 },
    { page: 1, out: path.join(dir, `${tag}-box.png`), box: [150, 50, 200, 100], scale: 2 },
  ];
  assert.deepEqual(await pdfInfo(pdf, dir), { pages: 1, sizes: [[400, 200]] });
  await renderJobs(pdf, jobs("kit"), dir, { slideWidth: 400 });
  {
    asLinux(t);
    assert.deepEqual(await pdfInfo(pdf, dir), { pages: 1, sizes: [[400, 200]] });
    await renderJobs(pdf, jobs("pop"), dir, { slideWidth: 400 });
  }
  for (const kind of ["whole", "box"]) {
    const a = readPng(path.join(dir, `kit-${kind}.png`)), b = readPng(path.join(dir, `pop-${kind}.png`));
    assert.deepEqual([a.w, a.h], [b.w, b.h], kind);
    // the same picture: compare a grid of points away from the edges of shapes (anti-aliasing may differ)
    for (let y = 3; y < a.h; y += Math.floor(a.h / 7)) for (let x = 3; x < a.w; x += Math.floor(a.w / 9))
      assert.ok(Math.abs(a.grey(x, y) - b.grey(x, y)) < 40, `${kind} at ${x},${y}: ${a.grey(x, y)} vs ${b.grey(x, y)}`);
  }
});
