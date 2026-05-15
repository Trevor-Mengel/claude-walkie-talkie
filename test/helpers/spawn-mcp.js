import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_BIN = join(__dirname, '..', '..', 'bin', 'walkie-talkie-mcp.js');

export function spawnMcp({ projectRoot, tool = 'claude-code', env = {} } = {}) {
  const child = spawn(process.execPath, [MCP_BIN], {
    env: {
      ...process.env,
      WALKIE_PROJECT_ROOT: projectRoot,
      WALKIE_TOOL: tool,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return child;
}
