import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomic, sameContent, revision } from "../lib/deck-files.mjs";

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pindeck files "));
  t.after(() => { try { fs.chmodSync(d, 0o755); } catch {} fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
const leftovers = (d) => fs.readdirSync(d).filter((f) => f.includes(".pindeck-"));

test("writeAtomic replaces the content and keeps the file's permissions, with no temporary file left", (t) => {
  const d = dir(t), f = path.join(d, "index.html");
  fs.writeFileSync(f, "old");
  fs.chmodSync(f, 0o640);
  writeAtomic(f, "new content");
  assert.equal(fs.readFileSync(f, "utf8"), "new content");
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.deepEqual(leftovers(d), []);
});

test("writeAtomic creates a new file and writes binary data", (t) => {
  const d = dir(t), f = path.join(d, "pic.png");
  const data = Buffer.from([0, 255, 1, 254]);
  writeAtomic(f, data);
  assert.ok(fs.readFileSync(f).equals(data));
});

test("writeAtomic writes through a symlink and keeps it a link", (t) => {
  const d = dir(t), real = path.join(d, "real.html"), link = path.join(d, "index.html");
  fs.writeFileSync(real, "old");
  fs.symlinkSync("real.html", link);
  writeAtomic(link, "new");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "new");
});

test("a failed write leaves the old file and no temporary file", { skip: process.getuid?.() === 0 && "root ignores permissions" }, (t) => {
  const d = dir(t), f = path.join(d, "index.html");
  fs.writeFileSync(f, "old");
  fs.chmodSync(d, 0o555);   // the folder cannot take the temporary file
  assert.throws(() => writeAtomic(f, "new"), /Could not save index\.html/);
  fs.chmodSync(d, 0o755);
  assert.equal(fs.readFileSync(f, "utf8"), "old");
  assert.deepEqual(leftovers(d), []);
});

test("a failed rename (target is a folder) cleans up the temporary file", (t) => {
  const d = dir(t), f = path.join(d, "figures");
  fs.mkdirSync(f);
  fs.writeFileSync(path.join(f, "keep"), "x");
  assert.throws(() => writeAtomic(f, "new"));
  assert.deepEqual(leftovers(d), []);
  assert.ok(fs.statSync(f).isDirectory());
});

test("revision changes with content and with a file appearing or disappearing", (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, "index.html"), "a");
  const r1 = revision(d, ["index.html", "theme.css"]);
  assert.equal(revision(d, ["index.html", "theme.css"]), r1);
  fs.writeFileSync(path.join(d, "theme.css"), "");
  const r2 = revision(d, ["index.html", "theme.css"]);
  assert.notEqual(r2, r1, "an empty file is not a missing one");
  fs.writeFileSync(path.join(d, "index.html"), "b");
  assert.notEqual(revision(d, ["index.html", "theme.css"]), r2);
});

test("sameContent compares bytes; a missing file equals only null", (t) => {
  const d = dir(t), f = path.join(d, "a.svg");
  assert.equal(sameContent(f, null), true);
  assert.equal(sameContent(f, Buffer.from("x")), false);
  fs.writeFileSync(f, "x");
  assert.equal(sameContent(f, Buffer.from("x")), true);
  assert.equal(sameContent(f, "y"), false);
  assert.equal(sameContent(f, null), false);
});
