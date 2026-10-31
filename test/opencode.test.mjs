import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpenCodeManager, parseModel } from '../src/opencode.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-mcp-test-'));
  const cwd = path.join(root, 'workspace'); await mkdir(cwd);
  const binary = path.join(root, 'opencode');
  await copyFile(new URL('./fixture-cli.mjs', import.meta.url), binary); await chmod(binary, 0o755);
  const manager = new OpenCodeManager({ binary });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, binary, manager, calls: async () => (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}
async function terminal(manager, sessionId) {
  let result;
  do { result = await manager.watch({ sessionId, waitMs: 1000, returnOnStep: false }); }
  while (result.state === 'running' || result.state === 'interrupting');
  return result;
}

test('parses provider/model variants and rejects malformed model IDs', () => {
  assert.deepEqual(parseModel('provider/model#thinking'), { providerID: 'provider', id: 'model', variant: 'thinking' });
  assert.throws(() => parseModel('invalid'), /provider\/model/);
});

test('status filters saved credential and agent request fields', async t => {
  const { manager } = await fixture(t);
  const result = await manager.status();
  assert.equal(result.available, true); assert.equal(result.serviceReady, true);
  assert.equal(result.defaultModel, 'opencode/flint-40b-free');
  assert.equal(JSON.stringify(result).includes('SENSITIVE_FIXTURE_VALUE'), false);
});

test('status never returns server credentials through failed subprocess messages or URL fragments', async () => {
  const secret = 'SERVER_TEST_SECRET';
  const manager = new OpenCodeManager({ binary: '/usr/bin/false', server: `http://user:${secret}@127.0.0.1:4096?token=${secret}#${secret}` });
  const result = await manager.status();
  assert.equal(result.available, false);
  assert.ok(result.errors.length > 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.server, 'http://127.0.0.1:4096/');
});

test('joins fragmented JSONL, returns terminal response and incremental cursors', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.create({ cwd });
  let result = await manager.prompt({ sessionId: session.sessionId, prompt: 'hello', waitMs: 1000 });
  if (result.state === 'running') result = await terminal(manager, session.sessionId);
  assert.equal(result.state, 'completed'); assert.equal(result.response, 'LISTO-ñ');
  const after = await manager.watch({ sessionId: session.sessionId, cursor: result.nextCursor, waitMs: 0 });
  assert.deepEqual(after.events, []); assert.equal(after.nextCursor, result.nextCursor);
});

test('provider JSON error cannot become success merely because CLI exits zero', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.create({ cwd });
  const result = await manager.prompt({ sessionId: session.sessionId, prompt: 'error', waitMs: 1000 });
  assert.equal(result.state, 'error'); assert.match(result.error, /Provider unavailable/);
});

test('empty zero-exit observer cannot falsely claim generation completed', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.create({ cwd });
  const result = await manager.prompt({ sessionId: session.sessionId, prompt: 'empty', waitMs: 1000 });
  assert.equal(result.state, 'error');
});

test('forwards a hostile-looking prompt as one argv and preserves configured permissions', async t => {
  const { manager, cwd, root, calls } = await fixture(t);
  const session = await manager.create({ cwd });
  const prompt = `$(touch ${root}/SHOULD_NOT_EXIST) ; --auto`;
  await manager.prompt({ sessionId: session.sessionId, prompt, waitMs: 1000 });
  const call = (await calls()).find(c => c.args[0] === 'run');
  assert.equal(call.args.at(-1), prompt); assert.equal(call.args.at(-2), '--');
  assert.equal(call.args.includes('--auto'), false); assert.equal(call.cwd, cwd);
  await assert.rejects(readFile(path.join(root, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
});

test('rejects simultaneous turns and cancels server execution before returning interruption', async t => {
  const { manager, cwd, calls } = await fixture(t);
  const session = await manager.create({ cwd });
  const started = await manager.prompt({ sessionId: session.sessionId, prompt: 'wait', waitMs: 0 });
  assert.equal(started.state, 'running');
  await assert.rejects(manager.prompt({ sessionId: session.sessionId, prompt: 'second' }), /running turn/);
  const interrupted = await manager.interrupt({ sessionId: session.sessionId });
  assert.equal(interrupted.state, 'interrupted');
  assert.ok((await calls()).some(c => c.args[0] === 'api' && c.args[1] === 'POST' && c.args[2].endsWith('/interrupt?resume=false')));
});

test('deadline invokes native API interruption and reports timed_out', async t => {
  const { manager, cwd, calls } = await fixture(t);
  const session = await manager.create({ cwd });
  const result = await manager.prompt({ sessionId: session.sessionId, prompt: 'wait', timeoutMs: 100, waitMs: 1000 });
  assert.equal(result.state, 'timed_out'); assert.match(result.error, /timeout/i);
  assert.ok((await calls()).some(c => c.args[2]?.endsWith('/interrupt?resume=false')));
});

test('close retains native history and allows reattachment in matching cwd', async t => {
  const { manager, cwd, root, calls } = await fixture(t);
  const session = await manager.create({ cwd });
  assert.equal((await manager.close({ sessionId: session.sessionId })).historyRetained, true);
  assert.equal((await manager.create({ cwd, sessionId: session.sessionId })).sessionId, session.sessionId);
  await manager.close({ sessionId: session.sessionId });
  const other = path.join(root, 'other'); await mkdir(other);
  await assert.rejects(manager.create({ cwd: other, sessionId: session.sessionId }), /does not match/);
  assert.equal((await calls()).some(c => c.args[1] === 'DELETE'), false);
});

test('bounds live event history and explicitly reports dropped cursor history', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.create({ cwd });
  const result = await manager.prompt({ sessionId: session.sessionId, prompt: 'many', waitMs: 1000 });
  assert.equal(result.state, 'completed'); assert.equal(result.events.length, 300);
  assert.equal(result.eventsTruncated, true); assert.ok(result.nextCursor > 350);
});

test('failed interruption can be retried without permanently poisoning the session', async t => {
  const { manager, cwd, root } = await fixture(t);
  const session = await manager.create({ cwd });
  await manager.prompt({ sessionId: session.sessionId, prompt: 'wait', waitMs: 0 });
  const stateFile = path.join(root, 'state.json');
  const data = JSON.parse(await readFile(stateFile, 'utf8')); data.failInterruptOnce = true;
  await writeFile(stateFile, JSON.stringify(data));
  await assert.rejects(manager.interrupt({ sessionId: session.sessionId }), /Temporary API failure/);
  const result = await manager.interrupt({ sessionId: session.sessionId });
  assert.equal(result.state, 'interrupted');
});

test('idle interrupt acknowledgment is retried while the CLI still owns an active turn', async t => {
  const { manager, cwd, root, calls } = await fixture(t);
  const session = await manager.create({ cwd });
  await manager.prompt({ sessionId: session.sessionId, prompt: 'wait', waitMs: 0 });
  const stateFile = path.join(root, 'state.json');
  const data = JSON.parse(await readFile(stateFile, 'utf8')); data.falseInterruptOnce = true;
  await writeFile(stateFile, JSON.stringify(data));
  const result = await manager.interrupt({ sessionId: session.sessionId });
  assert.equal(result.state, 'interrupted');
  assert.ok((await calls()).filter(c => c.args[2]?.endsWith('/interrupt?resume=false')).length >= 2);
});

test('unconfirmed upstream cancellation blocks reuse and stays retryable after observer exits', async t => {
  const { manager, cwd } = await fixture(t);
  const session = await manager.create({ cwd });
  await manager.prompt({ sessionId: session.sessionId, prompt: 'wait', waitMs: 0 });
  const nativeApi = manager.api.bind(manager);
  let attempts = 0;
  let recovered = false;
  manager.api = async (method, url, options) => {
    if (url.includes('/interrupt')) {
      attempts++;
      if (recovered) return { interrupted: true };
      if (attempts === 1) { manager.get(session.sessionId).child.kill('SIGTERM'); return { interrupted: false }; }
      throw new Error('Upstream cancellation unavailable');
    }
    return nativeApi(method, url, options);
  };
  await assert.rejects(manager.interrupt({ sessionId: session.sessionId }), /cancellation unavailable/);
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(manager.prompt({ sessionId: session.sessionId, prompt: 'new work' }), /cancel|unconfirmed/i);
  await assert.rejects(manager.close({ sessionId: session.sessionId }), /cancel|unconfirmed/i);
  const before = attempts;
  recovered = true;
  await manager.interrupt({ sessionId: session.sessionId });
  assert.ok(attempts > before, 'Retry must contact OpenCode even after its CLI observer has exited');
  assert.equal((await manager.close({ sessionId: session.sessionId })).state, 'closed');
});
