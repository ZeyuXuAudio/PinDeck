/* The deck's own instructions for Claude (CLAUDE.md, AGENTS.md), with @path imports expanded.

   PinDeck does not load CLAUDE.md files from parent folders the way Claude Code does: those are usually
   written for coding work PinDeck's Claude cannot do (tests, commits, package managers), they change
   with where the deck happens to sit, and on a shared server a parent folder may be writable by others.
   A deck pulls in shared rules explicitly instead: "Follow @../shared/STYLE.md" includes that file.

   An import is "@" followed by a path (relative to the file it is in, absolute, or ~/...), at the start
   of a line or after a space or "(". It is expanded only when that path is a text file: an e-mail address
   or an @mention stays as it is. Imports in code spans and code blocks are left alone. Included files may
   import others, up to 5 levels deep; each file is included once (no cycles), and all included text
   together is limited to 200 KB. The imported text follows the file that imports it. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DEPTH = 5, MAX_BYTES = 200_000;

/* Apply fn to the text outside code: fenced blocks (``` or ~~~) and `code spans` stay as they are */
function outsideCode(text, fn) {
  let fence = null;
  return text.split("\n").map((line) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence ? (fence === f[1] ? null : fence) : f[1]; return line; }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : fn(part))).join("");
  }).join("\n");
}

const resolveRef = (ref, dir) => (ref === "~" || ref.startsWith("~/") ? path.join(os.homedir(), ref.slice(1))
  : path.resolve(dir, ref));

function readText(file) {
  try {
    if (!fs.statSync(file).isFile()) return null;
    const buf = fs.readFileSync(file);
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch { return null; }
}

function expand(file, text, depth, seen, budget) {
  const dir = path.dirname(file), found = [];
  const body = outsideCode(text, (part) => part.replace(/(^|[\s(])@([^\s`()<>"']+)/g, (m, pre, raw) => {
    const ref = raw.replace(/[.,:;!?]+$/, ""), tail = raw.slice(ref.length);   // "see @STYLE.md." ends a sentence
    const abs = resolveRef(ref, dir);
    const content = readText(abs);
    if (content == null) return m;   // not a file: an e-mail address, an @mention, a typo
    let real = abs;
    try { real = fs.realpathSync(abs); } catch {}
    const note = (why) => `${pre}${ref} (${why})${tail}`;
    if (seen.has(real)) return note("included once, above or below");
    if (depth >= MAX_DEPTH) return note("not included: imports nested too deep");
    if (Buffer.byteLength(content) > budget.left) return note("not included: imported files over 200 KB in all");
    budget.left -= Buffer.byteLength(content);
    seen.add(real);
    found.push({ ref, abs, content });
    return note("included below");
  }));
  const parts = [body.trim()];
  for (const imp of found) {
    parts.push(`### ${imp.ref} (included by ${path.basename(file)})\n` + expand(imp.abs, imp.content, depth + 1, seen, budget));
  }
  return parts.filter(Boolean).join("\n\n");
}

/* A deck instruction file with its imports, or null when it is missing or empty */
export function readInstructions(file) {
  const text = readText(file);
  if (text == null || !text.trim()) return null;
  let real = file;
  try { real = fs.realpathSync(file); } catch {}
  return expand(file, text, 0, new Set([real]), { left: MAX_BYTES });
}
