/* Pictures of PowerPoint slides (macOS): PowerPoint, or else Keynote, exports the deck as a PDF with one
   page per slide, hidden slides included; macOS PDFKit (pdf-render.jxa.js) then renders whole pages
   (thumbnails, references for Claude) and regions (diagrams) to PNG.

   Both apps are sandboxed, so the files go through a folder inside the app's own container, which
   needs no permission dialog. macOS asks once whether PinDeck may control the app. An app that was
   not running before is quit again afterwards. */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JXA = path.join(path.dirname(fileURLToPath(import.meta.url)), "pdf-render.jxa.js");
const APPS = [
  { name: "Microsoft PowerPoint", bundle: "/Applications/Microsoft PowerPoint.app", container: "com.microsoft.Powerpoint" },
  { name: "Keynote", bundle: "/Applications/Keynote.app", container: "com.apple.iWork.Keynote" },
];

const osa = (args, timeout = 240000) => new Promise((resolve, reject) =>
  execFile("osascript", args, { timeout, maxBuffer: 1e7 }, (err, out, errOut) =>
    err ? reject(new Error((errOut || err.message).trim().split("\n").pop())) : resolve(out.trim())));
const q = (s) => JSON.stringify(s);   // AppleScript string literal (same quoting rules for paths)

export function renderAvailable() {
  return process.platform === "darwin" && APPS.some((a) => fs.existsSync(a.bundle));
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
  if (process.platform !== "darwin") throw new Error("Slide pictures need macOS with PowerPoint or Keynote.");
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

/* Renders pages or regions (see pdf-render.jxa.js). Returns the page count. Boxes are in slide px of a
   page slideWidth wide; with slideWidth = the page width in points, they are in PDF points. */
export async function renderJobs(pdf, jobs, workDir, { slideWidth = 1280 } = {}) {
  return +(await runJxa({ pdf, slideWidth, jobs }, workDir));
}

/* Page count and page sizes in points: { pages, sizes: [[w, h], ...] } (macOS only, no other app needed) */
export async function pdfInfo(pdf, workDir) {
  return JSON.parse(await runJxa({ pdf, info: true }, workDir));
}

async function runJxa(spec, workDir) {
  const file = path.join(workDir, `jobs-${crypto.randomBytes(4).toString("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  try { return await osa(["-l", "JavaScript", JXA, file], 120000); }
  finally { fs.rm(file, { force: true }, () => {}); }
}
