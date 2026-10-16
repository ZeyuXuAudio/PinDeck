import { AgentProcess } from './agent-process.mjs';
import { normalizeModels } from './models.mjs';
import { deckTools } from './agent-tools.mjs';
export const CODEX_CONFIG = {
  'features.shell_tool': false, 'features.unified_exec': false, 'features.js_repl': false,
  'features.apps': false, 'features.plugins': false, 'features.multi_agent': false,
  'features.hooks': false, 'features.memory_tool': false, 'features.shell_snapshot': false,
  'web_search': 'disabled', 'project_doc_max_bytes': 0, 'notify': [],
};
const toml = value => JSON.stringify(value);
const withoutNull = value => Array.isArray(value) ? value.map(withoutNull) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => v != null).map(([k,v]) => [k, withoutNull(v)])) : value;
export class CodexSession {
  constructor(options) { Object.assign(this, options); this.transport = null; this.sessionId = null; this.turnId = null; this.controller = null; }
  get running() { return !!this.transport && !this.transport.closed; }
  async connect() {
    if (this.running) return;
    const transport = new AgentProcess({ binary: process.env.CODEX_BIN || 'codex', cwd: this.cwd,
      args: ['app-server', ...Object.entries(CODEX_CONFIG).flatMap(([k,v]) => ['-c', `${k}=${toml(v)}`])],
      onStderr: this.onStderr,
      onMessage: m => { if (this.transport === transport) this.message(m).catch(e => this.onStderr?.(String(e))); },
      onExit: error => { if (this.transport === transport) { this.controller?.abort(); this.onExit?.(error); } },
    });
    this.transport = transport;
    try {
      await transport.request('initialize', { clientInfo: { name: 'pindeck', version: '3.0.0-beta.1' }, capabilities: { experimentalApi: true } });
      transport.write({ method: 'initialized', params: {} });
      const auth = await transport.request('account/read', { refreshToken: false });
      if (auth.requiresOpenaiAuth && !auth.account) throw new Error('Codex is not signed in. Run codex login, then refresh models.');
      this.models = []; let cursor;
      do { const list = await transport.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        this.models.push(...normalizeModels('codex', list.data)); cursor = list.nextCursor;
      } while (cursor);
    } catch (e) { this.stop(); throw e; }
  }
  async start(resumeId) {
    await this.connect();
    try {
      const { config = {} } = await this.transport.request('config/read', { includeLayers: false, cwd: this.cwd });
      // Disable inherited connectors and hooks before starting any thread. No configuration files are changed.
      const overrides = { ...CODEX_CONFIG };
      overrides.mcp_servers = Object.fromEntries(Object.entries(config.mcp_servers || {}).map(([name, value]) => [name, { ...value, enabled: false }]));
      overrides.plugins = Object.fromEntries(Object.entries(config.plugins || {}).map(([name, value]) => [name, { ...value, enabled: false }]));
      overrides.hooks = Object.fromEntries(Object.entries(config.hooks || {}).map(([name, value]) => [name, Array.isArray(value) ? [] : value]));
      const opts = typeof this.settings === 'function' ? this.settings() : this.settings;
      const params = { cwd: this.cwd, model: opts.model, modelProvider: 'openai',
        approvalPolicy: 'never', sandbox: 'read-only', config: withoutNull(overrides),
        developerInstructions: this.instructions, ...(resumeId ? { threadId: resumeId } : { dynamicTools: deckTools }) };
      const result = await this.transport.request(resumeId ? 'thread/resume' : 'thread/start', params);
      this.sessionId = result.thread.id;
      this.onEvent?.({ type: 'system', subtype: 'init', session_id: this.sessionId, model: result.model || opts.model });
    } catch (e) { this.stop(); throw e; }
  }
  async send(content) {
    if (!this.sessionId || this.controller) throw new Error('Codex is not ready for another turn.');
    const opts = typeof this.settings === 'function' ? this.settings() : this.settings;
    this.controller = new AbortController(); this.turnId = null; this.cancelRequested = false;
    try {
      const result = await this.transport.request('turn/start', { threadId: this.sessionId, input: content,
        model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}),
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
      this.turnId = result.turn.id;
      if (this.cancelRequested) await this.interrupt();
    } catch (e) { this.controller?.abort(); this.controller = null; throw e; }
  }
  async message(m) {
    const p = m.params || {};
    if (m.id !== undefined && m.method) {
      let result;
      if (m.method === 'item/tool/call') {
        try {
          if (!this.controller || this.controller.signal.aborted || p.threadId !== this.sessionId || (this.turnId && p.turnId !== this.turnId)) throw new Error('Inactive turn.');
          const signal = this.controller.signal;
          const items = await this.tools(p.tool, p.arguments, signal);
          signal.throwIfAborted(); result = { success: true, contentItems: items };
        } catch (e) { result = { success: false, contentItems: [{ type: 'inputText', text: e.message }] }; }
      } else if (m.method.includes('requestApproval') && m.method.includes('permissions')) result = { permissions: {}, scope: 'turn' };
      else if (m.method.includes('requestApproval')) result = { decision: 'decline' };
      else if (m.method.includes('elicitation')) result = { action: 'decline', content: null };
      else if (m.method.includes('requestUserInput')) result = { answers: {} };
      else { this.transport?.write({ id: m.id, error: { code: -32601, message: 'Unsupported request' } }); return; }
      if (this.running) this.transport.write({ id: m.id, result });
      return;
    }
    if (p.threadId !== this.sessionId || !this.controller) return;
    const eventTurnId = p.turnId || p.turn?.id;
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) return;
    if (m.method === 'turn/started') this.turnId = p.turn.id;
    const item = p.item;
    if (m.method === 'item/completed' && item?.type === 'agentMessage') this.onEvent?.({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
    if (m.method === 'item/started' && item?.type === 'dynamicToolCall') this.onEvent?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: item.tool, input: item.arguments }] } });
    if (m.method === 'item/completed' && item?.type === 'dynamicToolCall' && item.success === false) this.onEvent?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, is_error: true, content: (item.contentItems || []).map(c => ({ text: c.text || '' })) }] } });
    if (m.method === 'turn/completed') {
      this.controller.abort(); this.controller = null; this.turnId = null;
      this.onEvent?.({ type: 'result', subtype: p.turn.status === 'completed' ? 'success' : 'error',
        is_error: p.turn.status !== 'completed', result: p.turn.error?.message || (p.turn.status === 'interrupted' ? 'Stopped.' : p.turn.status) });
    }
  }
  async interrupt() {
    this.cancelRequested = true; this.controller?.abort();
    if (this.turnId && this.running) await this.transport.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId });
  }
  stop() { this.controller?.abort(); this.controller = null; const t = this.transport; this.transport = null; t?.stop(); }
}
