#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OpenCodeManager } from './opencode.mjs';

export const instructions = [
  'Use this MCP to delegate authorized work to the locally installed OpenCode CLI.',
  'Check opencode_status, create a session with an explicit absolute cwd, then send prompts.',
  'The default model comes from the user\'s OpenCode configuration; specify provider/model#variant only when needed.',
  'Use agent=build for implementation or agent=plan for planning. These are OpenCode agents, not operating system sandboxes.',
  'Permissions follow OpenCode configuration; autoApprove defaults to false and only --auto approves permissions not explicitly denied.',
  'While state is running, call opencode_session_watch with nextCursor until a terminal state and relay meaningful progress.',
  'Use opencode_session_interrupt to cancel server-side execution or steer it while retaining conversation history.',
  'close detaches the adapter and retains native OpenCode history. Reattach by passing sessionId to create.',
  'Do not assume Antigravity-specific models, commands, tools, media capabilities, or permission modes exist in OpenCode.'
].join(' ');

const id = z.string().min(1).max(200).describe('Native OpenCode session ID returned by create.');
const wait = z.number().int().min(0).max(60000).optional();
const createSchema = {
  cwd: z.string().min(1).describe('Existing absolute workspace directory.'),
  model: z.string().min(1).optional().describe('Optional provider/model#variant; otherwise use configured default.'),
  agent: z.string().min(1).optional().describe('OpenCode agent, defaults to build. Use plan for planning.'),
  sessionId: id.optional().describe('Reattach an existing native session in this directory.'),
  autoApprove: z.boolean().optional().describe('Defaults to false. Pass true only for authorized autonomous work; explicit denies remain effective.'),
  title: z.string().min(1).max(200).optional()
};
const promptSchema = {
  sessionId: id,
  prompt: z.string().min(1).max(200000),
  timeoutMs: z.number().int().min(1000).max(1800000).optional().describe('Turn deadline; cancels execution if exceeded. Defaults to 10 minutes.'),
  waitMs: wait.describe('Observation window, default 20 seconds. Returns while the turn continues.')
};

function result(data) {
  const failed = data?.state === 'error' || Boolean(data?.error);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: failed };
}

export function createServer(manager = new OpenCodeManager()) {
  const server = new McpServer({ name: 'codex-opencode', version: '1.0.0' }, {
    capabilities: { logging: {} }, instructions
  });
  const register = (name, description, schema, fn, readOnly = false) => {
    server.registerTool(name, {
      description: `${description}\n\n${instructions}`,
      inputSchema: schema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true }
    }, async args => {
      try { return result(await fn(args)); }
      catch (error) { return result({ state: 'error', error: error instanceof Error ? error.message : String(error) }); }
    });
  };

  register('opencode_status', 'Check CLI version, service readiness, model IDs, and connected provider names without exposing credentials.', {}, () => manager.status(), true);
  register('opencode_session_create', 'Create or reattach a persistent native OpenCode session in an explicit workspace.', createSchema, args => manager.create(args));
  register('opencode_session_list', 'List sessions managed by this MCP process, with their live state and cursors.', {}, () => manager.list(), true);
  register('opencode_session_prompt', 'Start one turn and observe up to waitMs; running turns continue in the background.', promptSchema, args => manager.prompt(args));
  register('opencode_session_watch', 'Read new activity after cursor; wait up to 60 seconds and repeat until the turn finishes.', {
    sessionId: id, cursor: z.number().int().min(0).optional(), waitMs: wait,
    returnOnStep: z.boolean().optional().describe('Default true: return as soon as new activity arrives.')
  }, args => manager.watch(args), true);
  register('opencode_session_interrupt', 'Interrupt server-side execution, preserving history; optionally start a steering prompt after cancellation.', {
    sessionId: id, steerPrompt: z.string().min(1).max(200000).optional(), waitMs: wait
  }, args => manager.interrupt(args));
  register('opencode_session_close', 'Stop an active managed turn and detach the session. Native OpenCode history is retained.', { sessionId: id }, args => manager.close(args));
  register('opencode_run', 'Create a session and start one isolated task. If still running, continue with watch. The returned sessionId remains resumable.', {
    ...createSchema, prompt: promptSchema.prompt, timeoutMs: promptSchema.timeoutMs, waitMs: wait
  }, async args => {
    const session = await manager.create(args);
    return manager.prompt({ ...args, sessionId: session.sessionId });
  });

  manager.on('activity', event => {
    void server.sendLoggingMessage({ level: 'info', logger: 'opencode', data: event }).catch(() => {});
  });
  return { server, manager };
}

async function main() {
  const { server, manager } = createServer();
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 12000);
    deadline.unref();
    try { await manager.dispose(); await server.close(); }
    finally { clearTimeout(deadline); }
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await server.connect(new StdioServerTransport());
  const previousClose = server.server.onclose;
  server.server.onclose = () => { previousClose?.(); void shutdown(); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
