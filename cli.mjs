#!/usr/bin/env node
/* PinDeck command line: the assistant's self-checks (need the PinDeck server running) and git setup.

   node cli.mjs layout <slide>...   measured layout and issues of one or more slides
                                    (add --issues for the issues only: layout 9 10 11 --issues)
   node cli.mjs shot <slide>...     screenshots with pin markers; prints the PNG paths
   node cli.mjs slides              slide numbers and ids
   node cli.mjs pdf handout         PDF with one page per slide (build steps in their final state)
   node cli.mjs pdf presentation    PDF with one page per build step
                                    (add "all" to include hidden slides: pdf handout all)
   node cli.mjs pdf-figure <pdf> <page> [x,y,w,h] [figures/name.png] [--width 1600]
                                    a page of an attached PDF, or a box of it (fractions of the page
                                    from the top left), as PNG: without a name in the screenshots
                                    folder to look at, with one saved into the deck

   node cli.mjs git-setup [deck]    keep PinDeck's data-eid ids out of git (no server needed)

   <slide> is a slide id (data-eid), a slide number (1-based) or "current". */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest[0];

/* git-setup: a git "clean" filter strips PinDeck's data-eid attributes whenever git reads the deck's
   HTML, so ids never reach a commit and id-only changes do not show in `git status`. The ids stay in
   the file on disk, where PinDeck and the assistant need them. The filter is plain sed, so it does not depend
   on where PinDeck is installed; git config is per clone, so run this once in each clone. */
if (cmd === "git-setup") {
  const FILTER = `sed 's/ data-eid="[^"]*"//g'`;
  const deck = path.resolve(arg || ".");
  const git = (...a) => execFileSync("git", ["-C", deck, ...a], { encoding: "utf8" }).trim();
  let root;
  try { root = git("rev-parse", "--show-toplevel"); }
  catch { console.error(`${deck} is not inside a git repository.`); process.exit(1); }
  git("config", "filter.pindeck-ids.clean", FILTER);
  const rel = path.relative(root, deck).split(path.sep).join("/");
  const pattern = `${rel ? rel + "/" : ""}*.html`;
  const attrFile = path.join(root, ".gitattributes");
  const attrs = fs.existsSync(attrFile) ? fs.readFileSync(attrFile, "utf8") : "";
  const line = `${pattern} filter=pindeck-ids`;
  const added = !attrs.split("\n").some((l) => l.trim() === line);
  if (added) fs.writeFileSync(attrFile, attrs + (attrs && !attrs.endsWith("\n") ? "\n" : "") + line + "\n");
  console.log(`Git filter "pindeck-ids" configured in ${root} (local git config).`);
  console.log(added ? `Added "${line}" to .gitattributes; commit that file.` : `.gitattributes already has "${line}".`);
  process.exit(0);
}
const issuesOnly = cmd === "layout" && rest.includes("--issues");
const slides = rest.filter((a) => a !== "--issues");
if (!["layout", "shot", "slides", "pdf", "pdf-figure"].includes(cmd)) {
  console.error("Usage: node cli.mjs layout|shot <slide>... [--issues]  |  node cli.mjs slides  |  node cli.mjs pdf handout|presentation  |  " +
    "node cli.mjs pdf-figure <pdf> <page> [x,y,w,h] [figures/name.png] [--width px]  |  node cli.mjs git-setup [deck]");
  process.exit(2);
}
/* pdf-figure: the box and the output name are told apart by their form, so their order does not matter */
function figureQuery(args) {
  const w = args.indexOf("--width"), width = w >= 0 ? args.splice(w, 2)[1] : "";
  const [file = "", page = "1", ...more] = args;
  return { file: file && path.resolve(file), page, width,
    box: more.find((a) => /^[\d.]+(,[\d.]+){3}$/.test(a)) || "", out: more.find((a) => /\.png$/i.test(a)) || "" };
}

let url = process.env.DECK_EDITOR_URL, token = process.env.DECK_EDITOR_TOKEN;
if (!url || !token) {
  try {
    const home = process.env.PINDECK_HOME || path.join(os.homedir(), ".pindeck-v3");
    const s = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
    url = s.url; token = s.token;
  } catch {}
}
if (!url) { console.error("The PinDeck server is not running (start it with: pindeck <deck-folder>)."); process.exit(1); }

/* layout and shot take several slides, so the assistant needs no shell loop or pipe (which PinDeck refuses) */
const queries = cmd === "pdf-figure" ? [figureQuery([...rest])]
  : cmd === "pdf" ? [{ slide: rest[0] || "handout", ...(rest[1] === "all" ? { all: "1" } : {}) }]
  : cmd === "slides" ? [{}] : (slides.length ? slides : ["current"]).map((slide) => ({ slide }));
let ok = true;
for (const q of queries) {
  let res, out;
  try {
    res = await fetch(`${url}/api/${cmd}?` + new URLSearchParams(q), { headers: { "x-editor-token": token } });
    out = await res.text();
  } catch {
    console.error("Cannot reach the PinDeck server at " + url + ". Is it running?");
    process.exit(1);
  }
  if (res.ok && issuesOnly) {
    const lines = out.split("\n"), i = lines.findIndex((l) => l.startsWith("Issues"));
    out = [lines[0], ...lines.slice(i)].join("\n");
  }
  (res.ok ? console.log : console.error)(out);
  ok &&= res.ok;
}
process.exit(ok ? 0 : 1);
