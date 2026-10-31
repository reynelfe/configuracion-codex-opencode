import { cp, copyFile, readFile, mkdir, mkdtemp, rename, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
const target = join(base, 'codex-opencode-mcp');
const codexDir = process.env.CODEX_HOME || join(homedir(), '.codex');
const config = join(codexDir, 'config.toml');
const node = await realpath(process.execPath);
const binary = process.env.OPENCODE_BIN || execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim();
execFileSync(binary, ['--version'], { stdio: 'pipe' });
await mkdir(base, { recursive: true });
const staging = await mkdtemp(join(base, '.codex-opencode-mcp-'));
let previous;
try {
  await cp(source, staging, { recursive: true, filter: path => !path.split('/').includes('node_modules') && !path.split('/').includes('.git') });
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: staging, stdio: 'inherit' });
  if (existsSync(target)) {
    previous = `${target}.previous-${Date.now()}`;
    await rename(target, previous);
  }
  await rename(staging, target);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  if (previous && !existsSync(target)) await rename(previous, target);
  throw error;
}
await mkdir(codexDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${config}.pre-opencode-${stamp}.bak`;
if (!existsSync(config)) throw new Error('Codex config.toml was not found; runtime is installed but registration was skipped.');
await copyFile(config, backup);
const saved = await readFile(backup);
if (!(await readFile(config)).equals(saved)) throw new Error('Codex configuration changed during installation; registration was skipped.');
execFileSync('codex', ['mcp', 'add', 'opencode', '--env', `OPENCODE_BIN=${binary}`, '--', node, join(target, 'src/index.mjs')], { stdio: 'inherit' });
execFileSync('python3', [join(source, 'scripts/preserve-config.py'), backup, config], { stdio: 'inherit' });
console.log(JSON.stringify({ installed: target, server: 'opencode', configBackup: backup, unrelatedConfigurationPreserved: true }, null, 2));
