// Runs the editor server and starts it again when it asks to be restarted
// (the editor's Restart button). `npm start` and both start scripts go
// through this, so a restart stays attached to the same terminal and Ctrl+C
// still stops everything.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_CODE = 75;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, PORTFOLIO_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE && !stopping) {
      console.log('\n  Restarting the editor…');
      return start();
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Pass stop signals on; the server cleans up and exits, and so do we.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(sig);
    else process.exit(0);
  });
}

start();
