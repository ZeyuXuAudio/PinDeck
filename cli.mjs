#!/usr/bin/env node
/* PinDeck command line for Claude's self-checks (needs the PinDeck server running).

   node cli.mjs layout <slide>   measured layout and issues of one slide
   node cli.mjs shot <slide>     screenshot with pin markers; prints the PNG path
   node cli.mjs slides           slide numbers and ids

   <slide> is a slide id (data-eid), a slide number (1-based) or "current". */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [cmd, slide = "current"] = process.argv.slice(2);
if (!["layout", "shot", "slides"].includes(cmd)) {
  console.error("Usage: node cli.mjs layout|shot <slide>  |  node cli.mjs slides");
  process.exit(2);
}

let url = process.env.DECK_EDITOR_URL, token = process.env.DECK_EDITOR_TOKEN;
if (!url || !token) {
  try {
    const home = process.env.PINDECK_HOME || path.join(os.homedir(), ".pindeck");
    const s = JSON.parse(fs.readFileSync(path.join(home, "server.json"), "utf8"));
    url = s.url; token = s.token;
  } catch {}
}
if (!url) { console.error("The PinDeck server is not running (start it with: pindeck <deck-folder>)."); process.exit(1); }

try {
  const res = await fetch(`${url}/api/${cmd}?` + new URLSearchParams({ slide }), { headers: { "x-editor-token": token } });
  const out = await res.text();
  (res.ok ? console.log : console.error)(out);
  process.exit(res.ok ? 0 : 1);
} catch {
  console.error("Cannot reach the PinDeck server at " + url + ". Is it running?");
  process.exit(1);
}
