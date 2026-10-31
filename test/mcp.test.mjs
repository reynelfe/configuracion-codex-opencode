import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.mjs';

test('MCP negotiates eight tools, validates schemas, and reports actionable tool errors', async t => {
  const manager = new EventEmitter();
  manager.status = async () => ({ available: true, version: 'fixture' });
  manager.prompt = async () => { throw new Error('Session is not attached'); };
  const { server } = createServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8); assert.ok(tools.some(tool => tool.name === 'opencode_session_interrupt'));
  const status = await client.callTool({ name: 'opencode_status', arguments: {} });
  assert.equal(status.isError, false); assert.equal(JSON.parse(status.content[0].text).available, true);
  const invalid = await client.callTool({ name: 'opencode_session_prompt', arguments: { sessionId: 'ses_valid' } });
  assert.equal(invalid.isError, true);
  const unavailable = await client.callTool({ name: 'opencode_session_prompt', arguments: { sessionId: 'ses_valid', prompt: 'hello' } });
  assert.equal(unavailable.isError, true); assert.match(unavailable.content[0].text, /not attached/);
});
