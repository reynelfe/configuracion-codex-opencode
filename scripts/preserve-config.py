"""Verify the scoped MCP registration and restore empty CLI-normalized argv lists."""
import re
import sys
import tomllib
from pathlib import Path

original = tomllib.loads(Path(sys.argv[1]).read_text())
path = Path(sys.argv[2])
text = path.read_text()
current = tomllib.loads(text)
assert 'opencode' in current.get('mcp_servers', {}), 'OpenCode entry missing'
restore = []
for name, entry in original.get('mcp_servers', {}).items():
    if name == 'opencode':
        continue
    target = current.get('mcp_servers', {}).get(name, {})
    # codex mcp add omits an empty args field while serializing other servers.
    if entry.get('args') == [] and 'args' not in target:
        target['args'] = []
        restore.append(name)
original.get('mcp_servers', {}).pop('opencode', None)
comparison = {**current, 'mcp_servers': {k: v for k, v in current.get('mcp_servers', {}).items() if k != 'opencode'}}
assert original == comparison, 'Unrelated Codex settings changed; inspect configuration backup'
for name in restore:
    header = re.compile(r'^\[mcp_servers\.(?:' + re.escape(name) + r'|"' + re.escape(name) + r'")\][ \t]*$', re.M)
    text, count = header.subn(lambda match: match.group() + '\nargs = []', text)
    assert count == 1, f'Could not preserve empty args for {name}'
assert tomllib.loads(text) == current, 'Preserved TOML does not match the verified configuration'
if restore:
    path.write_text(text)
