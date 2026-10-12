/* A long-running Claude Code process in stream-json mode.

   One process serves the whole chat: messages are written to stdin as JSON lines,
   events come back on stdout. It runs under the user's normal Claude login. */

import { spawn } from "node:child_process";
import readline from "node:readline";

export class ClaudeSession {
  constructor({ cwd, args, env, onEvent, onExit, onStderr }) {
    Object.assign(this, { cwd, args, env, onEvent, onExit, onStderr });
    this.proc = null;
    this.sessionId = null;
    this.reqId = 0;
  }

  get running() { return !!this.proc; }

  start(resumeId) {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      ...(typeof this.args === "function" ? this.args() : this.args), ...(resumeId ? ["--resume", resumeId] : [])];
    const proc = spawn(process.env.CLAUDE_BIN || "claude", args, {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (this.proc !== proc && this.proc) return;   // a stopped process that is still talking
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) this.sessionId = ev.session_id;
      this.onEvent(ev);
    });
    proc.stderr.on("data", (d) => this.onStderr?.(String(d)));
    proc.stdin.on("error", () => {});   // writing to a process that has died: its exit is reported below
    // a process that could not start (no `claude` on the PATH) reports an error and never exits
    let ended = false;
    const end = (code, signal) => {
      if (ended) return;
      ended = true;
      // stale: a newer process has been started since (model change, new chat); its turn is not ours to end
      const stale = this.proc !== proc && this.proc !== null;
      if (this.proc === proc) this.proc = null;
      this.onExit(code, signal, { stale });
    };
    proc.on("error", (err) => { this.onStderr?.(String(err)); if (proc.pid === undefined) end(null, null); });
    proc.on("exit", end);
  }

  send(content) {
    this.#write({ type: "user", message: { role: "user", content } });
  }

  interrupt() {
    this.#write({ type: "control_request", request_id: `int-${++this.reqId}`, request: { subtype: "interrupt" } });
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.stdin.end();
    setTimeout(() => p.kill("SIGTERM"), 1500);
  }

  #write(obj) {
    if (!this.proc) throw new Error("Claude Code is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
}
