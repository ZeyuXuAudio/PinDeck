/* Writing deck files safely, and telling whether they changed.

   writeAtomic: the new content goes to a temporary file next to the target, is flushed, gets the target's
   permissions and then replaces the target with one rename. A reader (the browser, Claude, an editor, the
   watcher) sees the old file or the new one, never half of it. A symlinked target is written where the link
   points, so the link stays a link. Each file is atomic on its own; a set of files is not one transaction.

   revision: a hash of the deck's editable files as they are now. The editor sends the revision it shows
   with each change; a different one means someone else changed the files in between (409, nothing written).
   This catches stale edits from the editor. It is not a lock: a program that writes between PinDeck's check
   and its write can still lose its change, so only one writer (PinDeck, Claude, or another tool) at a time. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function writeAtomic(file, data) {
  let target = file, mode = null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.pindeck-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", mode ?? 0o666);   // wx: never reuse an existing file
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    if (mode != null) fs.fchmodSync(fd, mode);   // the umask must not change the file's permissions
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw new Error(`Could not save ${path.basename(file)}: ${e.message}`);
  }
}

/* Same bytes? (a missing file is null) */
export function sameContent(file, data) {
  let now;
  try { now = fs.readFileSync(file); } catch (e) { if (e.code === "ENOENT") return data == null; throw e; }
  return data != null && now.equals(Buffer.isBuffer(data) ? data : Buffer.from(data));
}

export function revision(dir, files) {
  const h = crypto.createHash("sha256");
  for (const f of files) {
    let c = null;
    try { c = fs.readFileSync(path.join(dir, f)); } catch {}
    h.update(f + (c == null ? "\0-" : `\0${c.length}\0`));
    if (c) h.update(c);
  }
  return h.digest("hex").slice(0, 16);
}
