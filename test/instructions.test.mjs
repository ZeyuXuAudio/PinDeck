/* The deck's CLAUDE.md and AGENTS.md with @path imports: explicit, nested, once each, never from code. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readInstructions } from "../lib/instructions.mjs";

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pindeck instructions "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("an import is included after the file, nested imports after theirs, relative to the importing file", (t) => {
  const root = tree(t, {
    "talks/deck/CLAUDE.md": "# Deck\n\nFollow @../../shared/STYLE.md for wording.\n",
    "shared/STYLE.md": "Use British spelling. Terms: see @terms/list.md\n",
    "shared/terms/list.md": "- beamformer, not beam-former\n",
  });
  const out = readInstructions(path.join(root, "talks/deck/CLAUDE.md"));
  assert.equal(out, [
    "# Deck\n\nFollow ../../shared/STYLE.md (included below) for wording.",
    "### ../../shared/STYLE.md (included by CLAUDE.md)\nUse British spelling. Terms: see terms/list.md (included below)",
    "### terms/list.md (included by STYLE.md)\n- beamformer, not beam-former",
  ].join("\n\n"));
});

test("not imports: e-mail addresses, @mentions, missing files, code spans and code blocks", (t) => {
  const root = tree(t, {
    "CLAUDE.md": [
      "Questions to zeyu@example.org or @zeyu. See @missing.md.",
      "Inline `@STYLE.md` stays, and so does:",
      "```", "@STYLE.md", "```",
      "(but this one counts: @STYLE.md)",
    ].join("\n"),
    "STYLE.md": "Style rules.\n",
  });
  const out = readInstructions(path.join(root, "CLAUDE.md"));
  assert.match(out, /zeyu@example\.org or @zeyu\. See @missing\.md\./);
  assert.match(out, /Inline `@STYLE\.md` stays/);
  assert.match(out, /```\n@STYLE\.md\n```/);
  assert.match(out, /\(but this one counts: STYLE\.md \(included below\)\)/);
  assert.equal(out.match(/Style rules\./g).length, 1);
});

test("each file once (cycles end), at most 5 levels, binary files never", (t) => {
  const files = {
    "CLAUDE.md": "@a.md and again @a.md and itself @CLAUDE.md\n@pic.png",
    "a.md": "A imports @b.md",
    "b.md": "B imports @a.md back",
    "pic.png": "\u0000PNG",
  };
  for (let i = 0; i < 7; i++) files[`d${i}.md`] = `level ${i} @d${i + 1}.md`;
  files["CLAUDE.md"] += "\n@d0.md";
  const root = tree(t, files);
  const out = readInstructions(path.join(root, "CLAUDE.md"));
  assert.equal(out.match(/^A imports/gm).length, 1);
  assert.equal(out.match(/^B imports/gm).length, 1);
  assert.match(out, /again a\.md \(included once, above or below\)/);
  assert.match(out, /itself CLAUDE\.md \(included once, above or below\)/);
  assert.match(out, /a\.md \(included once, above or below\) back/);
  assert.match(out, /^@pic\.png$/m, "binary: left as written");
  assert.match(out, /level 4 d5\.md \(not included: imports nested too deep\)/);
  assert.doesNotMatch(out, /level 5/);
});

test("missing or empty file: null", (t) => {
  const root = tree(t, { "empty.md": "  \n" });
  assert.equal(readInstructions(path.join(root, "nope.md")), null);
  assert.equal(readInstructions(path.join(root, "empty.md")), null);
});
