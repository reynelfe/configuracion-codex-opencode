import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const exec = promisify(execFile);
const MAX_EVENTS = 300;
const MAX_RESPONSE = 100_000;
const MAX_LINE = 2_000_000;
const activeStates = new Set(['running', 'interrupting']);
const clip = (value, length = 1500) => String(value ?? '').slice(0, length);
const message = error => clip(error?.stderr || error?.message || error, 4000);
const modelString = value => typeof value === 'string' ? value : value?.providerID && value?.id ? `${value.providerID}/${value.id}${value.variant ? `#${value.variant}` : ''}` : undefined;
const publicServer = value => {
  if (!value) return 'OpenCode shared local service';
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return 'Configured OpenCode server'; }
};

export function parseModel(value) {
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('model must use provider/model#variant format');
  const providerID = value.slice(0, slash);
  const [id, variant] = value.slice(slash + 1).split('#');
  if (!id) throw new Error('model ID is empty');
  return { providerID, id, ...(variant ? { variant } : {}) };
}

/** Native OpenCode v2 sessions; no shell interpolation or credential copying. */
export class OpenCodeManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binary = options.binary || process.env.OPENCODE_BIN || 'opencode';
    this.server = options.server || process.env.OPENCODE_SERVER_URL;
    this.defaultModel = options.defaultModel || process.env.OPENCODE_DEFAULT_MODEL;
    this.maxSessions = options.maxSessions || 3;
    this.sessions = new Map();
    this.creating = 0;
    this.disposed = false;
  }

  args(args) { return this.server ? [...args, '--server', this.server] : args; }

  async command(args, cwd, timeout = 20_000) {
    try {
      const { stdout } = await exec(this.binary, this.args(args), {
        cwd, timeout, maxBuffer: 4_000_000, encoding: 'utf8', windowsHide: true,
        env: process.env,
      });
      return stdout.trim();
    } catch (error) {
      // execFile's default Error.message includes argv, which may contain a
      // server credential. Report stderr or exit metadata without that command.
      let detail = String(error?.stderr || `OpenCode command failed (${error?.code || error?.signal || 'execution error'})`);
      detail = detail.replace(/https?:\/\/[^\s"'<>]+/g, url => publicServer(url));
      throw new Error(clip(detail, 4000));
    }
  }

  async api(method, path, { cwd, data } = {}) {
    const args = ['api', method, path];
    if (data !== undefined) args.push('--data', JSON.stringify(data));
    const result = await this.command(args, cwd);
    return result ? JSON.parse(result) : null;
  }

  async status() {
    const results = await Promise.allSettled([
      exec(this.binary, ['--version'], { timeout: 5000, encoding: 'utf8' }),
      this.command(['models']),
      this.command(['auth', 'list', '--format', 'json']),
      this.api('GET', '/api/model/default'),
      this.api('GET', '/api/agent'),
    ]);
    const version = results[0].status === 'fulfilled' ? results[0].value.stdout.trim() : undefined;
    let providers = [];
    if (results[2].status === 'fulfilled') {
      try { providers = JSON.parse(results[2].value).map(provider => ({ id: provider.id, name: provider.name, connections: provider.connections?.length || 0 })); } catch {}
    }
    const defaultInfo = results[3].status === 'fulfilled' ? results[3].value?.data : null;
    const agents = results[4].status === 'fulfilled' ? results[4].value?.data : [];
    return {
      available: Boolean(version), version, binary: this.binary, server: publicServer(this.server),
      defaultModel: this.defaultModel || modelString(defaultInfo),
      models: results[1].status === 'fulfilled' ? results[1].value.split('\n').filter(Boolean) : [],
      providers, agents: Array.isArray(agents) ? agents.filter(a => !a.hidden).map(a => ({ id: a.id, name: a.name, mode: a.mode })) : [],
      serviceReady: results[3].status === 'fulfilled',
      maxSessions: this.maxSessions,
      errors: results.map((r, i) => r.status === 'rejected' ? `${['version', 'models', 'authentication', 'default model', 'agents'][i]}: ${message(r.reason)}` : null).filter(Boolean),
    };
  }

  async create({ cwd, model, agent, sessionId, autoApprove = false, title } = {}) {
    if (this.disposed) throw new Error('OpenCode manager is closed');
    if (!cwd || !isAbsolute(cwd)) throw new Error('cwd must be an existing absolute directory');
    cwd = await realpath(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd is not a directory');
    if (sessionId && this.sessions.has(sessionId)) {
      const s = this.sessions.get(sessionId);
      if (s.cwd !== cwd) throw new Error('The session is already attached in another directory');
      return this.snapshot(s);
    }
    if (this.sessions.size + this.creating >= this.maxSessions) throw new Error(`Maximum ${this.maxSessions} attached sessions; close an idle session first`);
    this.creating++;
    try {
      let info;
      if (sessionId) {
        this.validateID(sessionId);
        info = (await this.api('GET', `/api/session/${encodeURIComponent(sessionId)}`, { cwd }))?.data;
        if (info?.location?.directory && await realpath(info.location.directory) !== cwd) throw new Error('cwd does not match the existing OpenCode session directory');
      } else {
        model ||= this.defaultModel;
        info = (await this.api('POST', '/api/session', {
          cwd, data: { location: { directory: cwd }, ...(title ? { title } : {}), ...(agent ? { agent } : {}), ...(model ? { model: parseModel(model) } : {}) },
        }))?.data;
      }
      if (!info?.id) throw new Error('OpenCode did not return a native session ID');
      const s = {
        id: info.id, cwd, model: model || modelString(info.model), agent: agent || info.agent || 'build',
        autoApprove, state: 'idle', stateDetail: 'Ready for a prompt', events: [], seq: 0,
        response: '', error: null, child: null, turn: null, createdAt: new Date().toISOString(),
      };
      this.sessions.set(s.id, s);
      this.activity(s, 'session', sessionId ? 'Reattached to existing OpenCode conversation' : 'Created native OpenCode conversation');
      return this.snapshot(s);
    } finally { this.creating--; }
  }

  validateID(id) { if (!/^ses[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('Invalid OpenCode session ID'); }
  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session is not attached: ${id}. Use session_create with its cwd and sessionId to resume it.`);
    return s;
  }
  list() { return [...this.sessions.values()].map(s => this.snapshot(s, s.seq)); }

  activity(s, type, summary, extra = {}) {
    const event = { seq: ++s.seq, at: new Date().toISOString(), type, summary: clip(summary), ...extra };
    s.events.push(event);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    s.stateDetail = event.summary;
    this.emit('activity', { sessionId: s.id, ...event });
    this.emit(`update:${s.id}`);
  }

  snapshot(s, cursor = 0) {
    return {
      sessionId: s.id, cwd: s.cwd, model: s.model || 'OpenCode configured default', agent: s.agent,
      autoApprove: s.autoApprove, state: s.state, stateDetail: s.stateDetail,
      cancellationUnconfirmed: Boolean(s.cancellationUnconfirmed),
      cursor: s.seq, nextCursor: s.seq, events: s.events.filter(e => e.seq > cursor),
      eventsTruncated: cursor < (s.events[0]?.seq || 1) - 1,
      ...(!activeStates.has(s.state) ? { response: s.response, error: s.error } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    };
  }

  consume(s, turn, line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { this.activity(s, 'output', clip(line)); return; }
    const type = event.type || event.event || 'event';
    const part = event.part || event.properties?.part || {};
    if (type === 'text' || part.type === 'text') {
      const text = event.text ?? part.text ?? event.data?.text;
      if (typeof text === 'string' && text) {
        s.response = (s.response + text).slice(-MAX_RESPONSE);
        this.activity(s, 'text', clip(text, 600));
      }
    } else if (type === 'error' || type === 'session.error') {
      const error = event.error || event.properties?.error || event;
      s.error = clip(error?.data?.message || error?.message || JSON.stringify(error), 4000);
      turn.failed = true;
      this.activity(s, 'error', s.error);
    } else if (/tool/.test(type) || part.type === 'tool') {
      const tool = part.tool || event.tool || event.name || 'tool';
      const state = part.state || event.state || {};
      const details = state.input?.command || state.input?.filePath || state.input?.path || state.title || state.status || '';
      const toolError = state.error ? clip(typeof state.error === 'string' ? state.error : JSON.stringify(state.error), 1000) : '';
      this.activity(s, toolError ? (/permission|rejected|denied/i.test(toolError) ? 'attention' : 'tool_error') : 'tool', `${tool}${details ? `: ${clip(typeof details === 'string' ? details : JSON.stringify(details), 900)}` : ''}${toolError ? ` — ${toolError}` : ''}`);
    } else if (/permission|question|form/.test(type)) {
      this.activity(s, 'attention', `${type}: ${clip(event.message || JSON.stringify(event), 900)}`);
    } else if (type === 'step_finish' || type === 'step_start' || type === 'finish') {
      if (type === 'finish' || (type === 'step_finish' && part.reason === 'stop')) turn.sawFinish = true;
      this.activity(s, type, type === 'step_finish' ? `Step finished${part.reason ? ` (${part.reason})` : ''}` : type === 'finish' ? 'OpenCode finished generation' : 'OpenCode started a step');
    } else {
      this.activity(s, type, clip(event.summary || event.message || `${type}: ${JSON.stringify(event)}`, 900));
    }
  }

  async prompt({ sessionId, prompt, timeoutMs = 600_000, waitMs = 20_000 } = {}) {
    const s = this.get(sessionId);
    if (this.disposed) throw new Error('OpenCode manager is closed');
    if (s.cancellationUnconfirmed) throw new Error('Previous cancellation is unconfirmed. Retry session_interrupt before sending another prompt.');
    if (activeStates.has(s.state) || s.turn) throw new Error('This session already has a running turn');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must not be empty');
    const cursor = s.seq;
    const args = ['run', '--format', 'json', '--session', s.id, '--agent', s.agent];
    if (s.model) args.push('--model', s.model);
    if (s.autoApprove) args.push('--auto');
    if (this.server) args.push('--server', this.server);
    args.push('--', prompt);
    s.response = ''; s.error = null; s.state = 'running'; s.startedAt = new Date().toISOString(); delete s.endedAt;
    const turn = { failed: false, stopReason: null, buffer: '', stderr: '', settled: false, sawFinish: false };
    s.turn = turn;
    let finish;
    turn.done = new Promise(resolve => { finish = resolve; });
    turn.observerDone = new Promise(resolve => { turn.observerFinished = resolve; });
    const child = spawn(this.binary, args, { cwd: s.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    s.child = child;
    this.activity(s, 'start', 'OpenCode is processing the prompt');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      turn.buffer += chunk;
      let boundary;
      while ((boundary = turn.buffer.indexOf('\n')) !== -1) {
        const line = turn.buffer.slice(0, boundary); turn.buffer = turn.buffer.slice(boundary + 1);
        this.consume(s, turn, line);
      }
      if (turn.buffer.length > MAX_LINE) { turn.buffer = ''; turn.failed = true; s.error = 'OpenCode JSON event exceeded the adapter size limit'; }
    });
    child.stderr.on('data', chunk => { turn.stderr = (turn.stderr + chunk).slice(-8000); });
    const settle = async (code, signal, spawnError) => {
      if (turn.settled) return; turn.settled = true;
      clearTimeout(turn.timer);
      if (turn.buffer.trim()) this.consume(s, turn, turn.buffer);
      turn.observerExited = true;
      turn.observerFinished();
      if (turn.cancelBarrier) await turn.cancelBarrier;
      if (spawnError) { turn.failed = true; s.error = message(spawnError); }
      if (!turn.stopReason && !turn.failed && code === 0) {
        try {
          const info = (await this.api('GET', `/api/session/${encodeURIComponent(s.id)}`, { cwd: s.cwd }))?.data;
          if (info?.model) s.model = modelString(info.model);
          if (info?.outcome === 'failed') { turn.failed = true; s.error ||= 'OpenCode reported a failed session outcome'; }
          if (info?.outcome === 'interrupted') turn.stopReason = 'interrupted';
          if (!turn.sawFinish && info?.outcome !== 'interrupted') { turn.failed = true; s.error ||= 'OpenCode exited without a confirmed final generation event'; }
        } catch (error) { turn.failed = true; s.error = `Cannot confirm OpenCode completion: ${message(error)}`; }
      }
      s.state = s.cancellationUnconfirmed ? 'error' : turn.stopReason === 'timeout' ? 'timed_out' : turn.stopReason ? 'interrupted' : turn.failed || code !== 0 ? 'error' : 'completed';
      if (s.state === 'error') s.error ||= clip(turn.stderr || `OpenCode exited with code ${code}, signal ${signal || 'none'}`, 4000);
      if (s.state === 'timed_out') s.error = 'Turn exceeded timeout and was interrupted in OpenCode';
      s.endedAt = new Date().toISOString(); s.child = null; s.turn = null;
      this.activity(s, s.state, s.error || (s.state === 'completed' ? 'OpenCode completed the turn' : 'OpenCode execution interrupted; conversation retained'));
      finish();
    };
    child.once('error', error => { void settle(null, null, error); });
    child.once('close', (code, signal) => { void settle(code, signal); });
    turn.timer = setTimeout(() => {
      void this.stop(s, 'timeout').catch(error => { turn.failed = true; s.error = `Timeout cancellation failed: ${message(error)}`; this.activity(s, 'error', s.error); });
    }, timeoutMs);
    return this.watch({ sessionId, cursor, waitMs, returnOnStep: false });
  }

  async watch({ sessionId, cursor = 0, waitMs = 15_000, returnOnStep = true } = {}) {
    const s = this.get(sessionId);
    if (waitMs > 0 && activeStates.has(s.state) && !(returnOnStep && s.seq > cursor)) {
      await new Promise(resolve => {
        const listener = () => { if (!activeStates.has(s.state) || (returnOnStep && s.seq > cursor)) done(); };
        const timer = setTimeout(done, Math.min(waitMs, 60_000));
        const self = this;
        function done() { clearTimeout(timer); self.off(`update:${s.id}`, listener); resolve(); }
        this.on(`update:${s.id}`, listener);
        listener();
      });
    }
    return this.snapshot(s, cursor);
  }

  async stop(s, reason) {
    const turn = s.turn;
    if (!turn) {
      if (s.cancellationUnconfirmed) return this.reconcileCancellation(s);
      return;
    }
    if (turn.stopping) return turn.stopping;
    let releaseCancel;
    turn.cancelBarrier = new Promise(resolve => { releaseCancel = resolve; });
    const stopping = (async () => {
      turn.stopReason = reason;
      s.state = 'interrupting';
      this.activity(s, 'interrupting', reason === 'timeout' ? 'Timeout reached; cancelling execution in OpenCode' : 'Cancelling execution in OpenCode');
      try {
        const deadline = Date.now() + 15_000;
        let acknowledged = false;
        while (!acknowledged && !turn.observerExited && Date.now() < deadline) {
          const result = await this.api('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt?resume=false`, { cwd: s.cwd });
          acknowledged = result?.interrupted === true || result?.data?.interrupted === true;
          if (!acknowledged && !turn.observerExited) await new Promise(resolve => setTimeout(resolve, 150));
        }
        // Killing the observer happens only after repeated upstream cancellation, or
        // before a final reconciliation when the CLI has not begun a generation.
        if (!turn.observerExited) {
          let timer;
          await Promise.race([turn.observerDone, new Promise(resolve => { timer = setTimeout(resolve, acknowledged ? 4000 : 0); })]);
          clearTimeout(timer);
          if (!turn.observerExited) s.child?.kill('SIGTERM');
          let killTimer;
          await Promise.race([turn.observerDone, new Promise(resolve => { killTimer = setTimeout(resolve, 1500); })]);
          clearTimeout(killTimer);
          if (!turn.observerExited) s.child?.kill('SIGKILL');
          await turn.observerDone;
        }
        // A run started after an initial interrupted:false must also be cancelled.
        // The CLI is now closed and cannot submit a subsequent prompt.
        if (!acknowledged) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = await this.api('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt?resume=false`, { cwd: s.cwd });
            acknowledged ||= result?.interrupted === true || result?.data?.interrupted === true;
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          const info = (await this.api('GET', `/api/session/${encodeURIComponent(s.id)}`, { cwd: s.cwd }))?.data;
          const active = (await this.api('GET', '/api/session/active', { cwd: s.cwd }))?.data;
          const busy = info?.time?.busy;
          if (!info || !active || active[s.id] || (busy && (!info.time.idle || info.time.idle < busy))) throw new Error('Could not verify that OpenCode execution is idle after cancellation');
        }
        s.cancellationUnconfirmed = false;
      } catch (error) {
        turn.stopReason = null;
        s.cancellationUnconfirmed = true;
        s.state = turn.observerExited ? 'error' : 'running';
        s.error = `Could not confirm cancellation of upstream execution: ${message(error)}. Retry session_interrupt.`;
        this.activity(s, 'error', s.error);
        throw error;
      } finally { releaseCancel(); }
      await turn.done;
    })();
    turn.stopping = stopping;
    try { return await stopping; }
    catch (error) { if (turn.stopping === stopping) turn.stopping = null; throw error; }
  }

  async reconcileCancellation(s) {
    if (s.reconciling) return s.reconciling;
    const reconcile = (async () => {
      try {
        this.activity(s, 'interrupting', 'Retrying cancellation and verifying upstream OpenCode execution');
        await this.api('POST', `/api/session/${encodeURIComponent(s.id)}/interrupt?resume=false`, { cwd: s.cwd });
        const info = (await this.api('GET', `/api/session/${encodeURIComponent(s.id)}`, { cwd: s.cwd }))?.data;
        const active = (await this.api('GET', '/api/session/active', { cwd: s.cwd }))?.data;
        const busy = info?.time?.busy;
        if (!info || !active || active[s.id] || (busy && (!info.time.idle || info.time.idle < busy))) throw new Error('OpenCode has not confirmed an idle session');
        s.cancellationUnconfirmed = false;
        s.state = 'interrupted'; s.error = null;
        this.activity(s, 'interrupted', 'Upstream cancellation verified; conversation retained');
      } catch (error) {
        s.cancellationUnconfirmed = true; s.state = 'error';
        s.error = `Cancellation remains unconfirmed: ${message(error)}. Retry session_interrupt.`;
        this.activity(s, 'error', s.error);
        throw error;
      }
    })();
    s.reconciling = reconcile;
    try { return await reconcile; }
    finally { if (s.reconciling === reconcile) s.reconciling = null; }
  }

  async interrupt({ sessionId, steerPrompt, waitMs = 20_000 } = {}) {
    const s = this.get(sessionId);
    await this.stop(s, 'interrupted');
    if (steerPrompt) return this.prompt({ sessionId, prompt: steerPrompt, waitMs });
    return this.snapshot(s);
  }

  async close({ sessionId } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return { sessionId, state: 'closed', historyRetained: true };
    if (s.cancellationUnconfirmed) throw new Error('Cancellation is unconfirmed; retry session_interrupt before closing this session.');
    await this.stop(s, 'closed');
    this.sessions.delete(sessionId);
    return { sessionId, state: 'closed', historyRetained: true, cwd: s.cwd };
  }

  async dispose() {
    this.disposed = true;
    return Promise.allSettled([...this.sessions.keys()].map(sessionId => this.close({ sessionId })));
  }
}
