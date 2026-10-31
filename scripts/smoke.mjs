import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.SMOKE_ENTRY || join(root, 'src/index.mjs');
const cwd = process.env.SMOKE_CWD || await mkdtemp(join(tmpdir(), 'codex-opencode-smoke-'));
const model = process.env.SMOKE_MODEL || 'opencode/flint-40b-free';
const client = new Client({ name: 'codex-opencode-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const report = { entry, cwd, model, checks: [] };
let sessionId;
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 70000 });
  const value = JSON.parse(response.content.find(c => c.type === 'text').text);
  if (response.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
async function complete(value) {
  const started = Date.now();
  while (['running', 'interrupting'].includes(value.state)) {
    if (Date.now() - started > 180000) throw new Error('Smoke turn exceeded observation deadline');
    value = await call('opencode_session_watch', { sessionId, cursor: value.nextCursor, waitMs: 15000 });
    console.log(JSON.stringify({ state: value.state, events: value.events.map(e => ({ type: e.type, summary: e.summary })) }));
  }
  assert.equal(value.state, 'completed', value.error || value.stateDetail);
  return value;
}
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  report.checks.push('MCP stdio handshake and 8 tools');
  const status = await call('opencode_status');
  assert.equal(status.available, true); assert.equal(status.serviceReady, true);
  assert.ok(status.models.includes(model));
  report.version = status.version; report.configuredDefault = status.defaultModel;
  report.checks.push('CLI readiness and model discovery');
  await writeFile(join(cwd, 'probe.txt'), 'MCP-ORBITA-6482\n');
  ({ sessionId } = await call('opencode_session_create', { cwd, model, autoApprove: true, title: 'Codex MCP integration smoke' }));
  let turn = await complete(await call('opencode_session_prompt', { sessionId, prompt: 'Usa la herramienta read para leer probe.txt en este directorio. Recuerda el token que contiene y responde solo con ese token.', waitMs: 1000 }));
  assert.match(turn.response, /MCP-ORBITA-6482/);
  report.checks.push('Real inference and file read');
  turn = await complete(await call('opencode_session_prompt', { sessionId, prompt: 'Sin volver a leer archivos, ¿cuál fue el token de la instrucción anterior? Responde solo con el token.', waitMs: 1000 }));
  assert.match(turn.response, /MCP-ORBITA-6482/);
  report.checks.push('Native conversation memory across turns');
  turn = await complete(await call('opencode_session_prompt', { sessionId, prompt: 'Crea un archivo mcp-created.txt en el directorio actual cuyo contenido exacto sea OPENCODE-MCP-OK seguido de un salto de línea. Hazlo con tus herramientas y responde HECHO.', waitMs: 1000 }));
  assert.equal(await readFile(join(cwd, 'mcp-created.txt'), 'utf8'), 'OPENCODE-MCP-OK\n');
  report.checks.push('Real file creation through MCP');
  await call('opencode_session_close', { sessionId });
  await call('opencode_session_create', { cwd, sessionId, autoApprove: true });
  turn = await complete(await call('opencode_session_prompt', { sessionId, prompt: 'Sin leer archivos, repite solamente el token MCP-ORBITA de nuestra conversación anterior.', waitMs: 1000 }));
  assert.match(turn.response, /MCP-ORBITA-6482/);
  report.checks.push('Close and reattach retain conversation');
  turn = await call('opencode_session_prompt', { sessionId, prompt: 'Enumera lentamente cien ideas para organizar un proyecto de software. No uses herramientas.', waitMs: 0 });
  assert.equal(turn.state, 'running');
  turn = await call('opencode_session_interrupt', { sessionId });
  assert.equal(turn.state, 'interrupted');
  let native = JSON.parse(execFileSync(process.env.OPENCODE_BIN || 'opencode', ['api', 'GET', `/api/session/${sessionId}`], { encoding: 'utf8' })).data;
  assert.equal(native.outcome, 'interrupted');
  assert.ok(native.time.idle >= native.time.busy);
  report.checks.push('Immediate interruption confirmed idle in native OpenCode service');
  turn = await complete(await call('opencode_session_interrupt', { sessionId, steerPrompt: 'Responde solamente con el token MCP-ORBITA que recuerdas de nuestra conversación.', waitMs: 1000 }));
  assert.match(turn.response, /MCP-ORBITA-6482/);
  report.checks.push('Steering resumes after interruption with conversation intact');
  native = JSON.parse(execFileSync(process.env.OPENCODE_BIN || 'opencode', ['api', 'GET', `/api/session/${sessionId}`], { encoding: 'utf8' })).data;
  report.reportedSessionCostUSD = native.cost;
  report.sessionId = sessionId;
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.message;
  throw error;
} finally {
  if (sessionId) await call('opencode_session_close', { sessionId }).catch(() => {});
  await client.close();
  console.log(JSON.stringify(report, null, 2));
  if (process.env.SMOKE_REPORT) await writeFile(process.env.SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
}
