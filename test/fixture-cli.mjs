#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = path.dirname(process.argv[1]);
const store = path.join(root, 'state.json');
const log = path.join(root, 'calls.jsonl');
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const read = () => fs.existsSync(store) ? JSON.parse(fs.readFileSync(store)) : { next: 1, sessions: {} };
const save = data => fs.writeFileSync(store, JSON.stringify(data));
const emit = data => console.log(JSON.stringify(data));
const value = key => args[args.indexOf(key) + 1];
if (args[0] === '--version') console.log('opencode v2.2.4-fixture');
else if (args[0] === 'models') console.log('opencode/flint-40b-free');
else if (args[0] === 'auth') emit([{ id: 'provider', name: 'Provider', connections: [{ token: 'SENSITIVE_FIXTURE_VALUE' }] }]);
else if (args[0] === 'api') {
  const [, method, url] = args;
  const data = read();
  if (url === '/api/model/default') emit({ data: { providerID: 'opencode', id: 'flint-40b-free' } });
  else if (url === '/api/agent') emit({ data: [{ id: 'build', name: 'Build', mode: 'primary', request: { headers: { authorization: 'SENSITIVE_FIXTURE_VALUE' } } }] });
  else if (url === '/api/session/active') emit({ data: {} });
  else if (url === '/api/session' && method === 'POST') {
    const input = JSON.parse(value('--data'));
    const id = `ses_fixture_${data.next++}`;
    data.sessions[id] = { id, location: input.location, model: input.model || { providerID: 'opencode', id: 'flint-40b-free' }, agent: input.agent || 'build', outcome: 'completed' };
    save(data); emit({ data: data.sessions[id] });
  } else if (url.includes('/interrupt')) {
    const id = url.split('/')[3];
    if (data.failInterruptOnce) { delete data.failInterruptOnce; save(data); console.error('Temporary API failure'); process.exitCode = 1; }
    else if (data.falseInterruptOnce) { delete data.falseInterruptOnce; save(data); emit({ interrupted: false }); }
    else { data.sessions[id].interrupted = true; save(data); emit({ interrupted: true }); }
  } else if (method === 'GET' && url.startsWith('/api/session/')) emit({ data: data.sessions[url.split('/')[3]] });
  else { console.error('Unsupported fixture operation'); process.exitCode = 1; }
} else if (args[0] === 'run') {
  const id = value('--session');
  const prompt = args.at(-1);
  const start = { type: 'step_start', part: { type: 'step-start' } };
  emit(start);
  if (prompt === 'error') { emit({ type: 'error', error: { data: { message: 'Provider unavailable' } } }); }
  else if (prompt === 'empty') { /* No provider output or finish marker despite zero exit. */ }
  else if (prompt === 'many') { for (let i = 0; i < 350; i++) emit({ type: 'text', part: { text: `line${i}\n` } }); emit({ type: 'step_finish', part: { reason: 'stop' } }); }
  else if (prompt === 'wait') {
    const timer = setInterval(() => {
      if (read().sessions[id].interrupted) { clearInterval(timer); process.exit(0); }
    }, 15);
  } else {
    const line = JSON.stringify({ type: 'text', part: { text: 'LISTO-ñ' } });
    const bytes = Buffer.from(line + '\n');
    process.stdout.write(bytes.subarray(0, 18));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(18));
      emit({ type: 'step_finish', part: { reason: 'stop' } });
    }, 30);
  }
} else { console.error('Unknown fixture command'); process.exitCode = 1; }
