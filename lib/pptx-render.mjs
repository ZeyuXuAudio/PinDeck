/* Pictures of PowerPoint slides, and of PDF pages.

   macOS: PowerPoint, or else Keynote, exports the deck as a PDF with one page per slide, hidden slides
   included; macOS PDFKit (pdf-render.jxa.js) then renders whole pages (thumbnails, references for Claude)
   and regions (diagrams, PDF figures) to PNG.
   Linux: LibreOffice (soffice --headless) exports the PDF, and Poppler (pdfinfo, pdftoppm) renders it.
   Both are optional; lib/capabilities.mjs turns the features on when they are found.

   Both apps are sandboxed, so the files go through a folder inside the app's own container, which
   needs no permission dialog. macOS asks once whether PinDeck may control the app. An app that was
   not running before is quit again afterwards. */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findExecutable } from "./capabilities.mjs";

const JXA = path.join(path.dirname(fileURLToPath(import.meta.url)), "pdf-render.jxa.js");
const APPS = [
  { name: "Microsoft PowerPoint", bundle: "/Applications/Microsoft PowerPoint.app", container: "com.microsoft.Powerpoint" },
  { name: "Keynote", bundle: "/Applications/Keynote.app", container: "com.apple.iWork.Keynote" },
];

const osa = (args, timeout = 240000) => new Promise((resolve, reject) =>
  execFile("osascript", args, { timeout, maxBuffer: 1e7 }, (err, out, errOut) =>
    err ? reject(new Error((errOut || err.message).trim().split("\n").pop())) : resolve(out.trim())));
const q = (s) => JSON.stringify(s);   // AppleScript string literal (same quoting rules for paths)

const mac = () => process.platform === "darwin";
const tool = (...names) => names.map((n) => findExecutable(n).path).find(Boolean) || null;
const run = (cmd, args, timeout = 120000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 1e7 }, (err, out, errOut) =>
    err ? reject(new Error(String(errOut || err.message).trim().split("\n").pop())) : resolve(String(out))));
export const popplerAvailable = () => !!(tool("pdftoppm") && tool("pdfinfo"));
export const sofficePath = () => tool("soffice", "libreoffice");

export function renderAvailable() {
  return mac() ? APPS.some((a) => fs.existsSync(a.bundle)) : !!(sofficePath() && popplerAvailable());
}

function exportScript(app, pptx, pdf) {
  if (app.name === "Microsoft PowerPoint") return `
set wasRunning to application "Microsoft PowerPoint" is running
tell application "Microsoft PowerPoint"
  open (POSIX file ${q(pptx)})
  set p to active presentation
  repeat with i from 1 to (count of slides of p)
    set hidden of slide show transition of slide i of p to false
  end repeat
  save p in (POSIX file ${q(pdf)}) as save as PDF
  close p saving no
  if not wasRunning then quit
end tell
return "ok"`;
  return `
set wasRunning to application "Keynote" is running
tell application "Keynote"
  set d to open (POSIX file ${q(pptx)})
  repeat with s in slides of d
    set skipped of s to false
  end repeat
  export d to (POSIX file ${q(pdf)}) as PDF
  close d saving no
  if not wasRunning then quit
end tell
return "ok"`;
}

/* Exports the deck to <workDir>/deck.pdf. Returns { pdf, app }. */
export async function exportPdf(pptxPath, workDir) {
  if (!mac()) return exportPdfLibreOffice(pptxPath, workDir);
  const errors = [];
  for (const app of APPS) {
    if (!fs.existsSync(app.bundle)) continue;
    const box = path.join(os.homedir(), "Library", "Containers", app.container, "Data", "pindeck-import", crypto.randomBytes(6).toString("hex"));
    try {
      fs.mkdirSync(box, { recursive: true });
      const inFile = path.join(box, "deck.pptx"), outFile = path.join(box, "deck.pdf");
      fs.copyFileSync(pptxPath, inFile);
      await osa(["-e", exportScript(app, inFile, outFile)]);
      if (!fs.existsSync(outFile)) throw new Error("no PDF was written");
      const pdf = path.join(workDir, "deck.pdf");
      fs.copyFileSync(outFile, pdf);
      return { pdf, app: app.name };
    } catch (e) {
      errors.push(`${app.name}: ${e.message}`);
    } finally {
      fs.rm(box, { recursive: true, force: true }, () => {});
    }
  }
  throw new Error(errors.length ? errors.join("; ") : "Neither PowerPoint nor Keynote is installed.");
}

/* Linux: LibreOffice exports the deck, hidden slides included (so page n is slide n). Its own profile in
   the work folder, so a LibreOffice the user has open, or a stale lock, does not get in the way. */
async function exportPdfLibreOffice(pptxPath, workDir) {
  const soffice = sofficePath();
  if (!soffice) throw new Error("LibreOffice (soffice) is not installed.");
  const dir = fs.mkdtempSync(path.join(workDir, "libreoffice-"));
  try {
    const inFile = path.join(dir, "deck.pptx");
    fs.copyFileSync(pptxPath, inFile);
    await run(soffice, ["--headless", "--norestore", `-env:UserInstallation=${pathToFileURL(path.join(dir, "profile")).href}`,
      "--convert-to", 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}',
      "--outdir", dir, inFile], 240000);
    const out = path.join(dir, "deck.pdf");
    if (!fs.existsSync(out)) throw new Error("LibreOffice wrote no PDF.");
    const pdf = path.join(workDir, "deck.pdf");
    fs.copyFileSync(out, pdf);
    return { pdf, app: "LibreOffice" };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/* Renders pages or regions (see pdf-render.jxa.js for the jobs). Returns the page count. Boxes are in
   slide px of a page slideWidth wide; with slideWidth = the page width in points, they are in PDF points. */
export async function renderJobs(pdf, jobs, workDir, { slideWidth = 1280 } = {}) {
  if (!mac()) return renderPoppler(pdf, jobs, slideWidth);
  return +(await runJxa({ pdf, slideWidth, jobs }, workDir));
}

/* Page count and page sizes in points: { pages, sizes: [[w, h], ...] } (PDFKit or Poppler, no other app) */
export async function pdfInfo(pdf, workDir) {
  if (!mac()) return popplerInfo(pdf);
  return JSON.parse(await runJxa({ pdf, info: true }, workDir));
}

async function popplerInfo(pdf, exact = false) {
  const pages = +(/^Pages:\s+(\d+)/m.exec(await run(tool("pdfinfo"), [pdf])) || [])[1];
  if (!pages) throw new Error("pdfinfo could not read the PDF.");
  const out = await run(tool("pdfinfo"), ["-f", "1", "-l", String(pages), pdf]);
  const sizes = [...out.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/gm)]
    .sort((a, b) => a[1] - b[1]).map((m) => (exact ? [+m[2], +m[3]] : [Math.round(+m[2]), Math.round(+m[3])]));
  return { pages, sizes };
}

/* The same jobs as pdf-render.jxa.js, with pdftoppm: whole pages scaled to a width, or a box of the page
   (in slide px) at job.scale output px per slide px. White background, as PDFKit's. */
async function renderPoppler(pdf, jobs, slideWidth) {
  const info = await popplerInfo(pdf, true);
  for (const job of jobs) {
    const size = info.sizes[job.page - 1];
    if (!size) continue;
    const [pw, ph] = size;
    const args = ["-f", String(job.page), "-l", String(job.page), "-png", "-singlefile"];
    if (job.box) {
      const [x, y, bw, bh] = job.box, s = job.scale || 2, f = pw / (slideWidth || 1280);   // PDF points per slide px
      args.push("-r", String((s / f) * 72), "-x", String(Math.round(x * s)), "-y", String(Math.round(y * s)),
        "-W", String(Math.max(1, Math.round(bw * s))), "-H", String(Math.max(1, Math.round(bh * s))));
    } else {
      const scale = (job.width || 1280) / pw;
      args.push("-scale-to-x", String(Math.round(pw * scale)), "-scale-to-y", String(Math.round(ph * scale)));
    }
    const prefix = job.out.replace(/\.png$/i, "");   // pdftoppm adds .png
    await run(tool("pdftoppm"), [...args, pdf, prefix]);
  }
  return info.pages;
}

async function runJxa(spec, workDir) {
  const file = path.join(workDir, `jobs-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  try { return await osa(["-l", "JavaScript", JXA, file], 120000); }
  finally { fs.rm(file, { force: true }, () => {}); }
}
