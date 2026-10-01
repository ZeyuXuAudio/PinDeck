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
      ...this.args, ...(resumeId ? ["--resume", resumeId] : [])];
    const proc = spawn(process.env.CLAUDE_BIN || "claude", args, {
      cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) this.sessionId = ev.session_id;
      this.onEvent(ev);
    });
    proc.stderr.on("data", (d) => this.onStderr?.(String(d)));
    proc.on("error", (err) => this.onStderr?.(String(err)));
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      this.onExit(code, signal);
    });
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
