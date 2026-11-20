// Editor lifecycle: the state file, the shutdown/restart routes and who may
// call them, the editor's Stop/Restart buttons, and stop-editor.sh.
//
// Starts its own servers on ports 4391-4394 and stops them again; it never
// touches an editor on the default port. Never saves data.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, '.cache');
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateFile = (port) => path.join(CACHE, `editor-${port}.json`);
const readState = (port) => { try { return JSON.parse(fs.readFileSync(stateFile(port), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const up = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/editor/`)).ok; } catch { return false; } };
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(150); }
  return false;
}

// Raw request, so Host and Origin can be set to anything.
function post(port, route, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

const started = [];
function startEditor(port, { supervised = true } = {}) {
  const child = spawn(process.execPath, [supervised ? 'scripts/editor.js' : 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  started.push(child);
  return child;
}

try {
  // --- state file -------------------------------------------------------------
  console.log('--- state file ---');
  const sup = startEditor(4394);
  await until(() => up(4394));
  const st = readState(4394);
  check('a running editor writes its state file', st && st.port === 4394 && alive(st.pid) && st.root === ROOT,
    JSON.stringify(st));

  // --- who may call the routes ------------------------------------------------
  console.log('--- route guard ---');
  const H = { 'X-Portfolio-Editor': '1' };
  let r = await post(4394, '/api/shutdown', {});
  check('shutdown without the editor header is refused', r.status === 403, String(r.status));
  r = await post(4394, '/api/shutdown', { ...H, Origin: 'https://evil.example' });
  check('shutdown from another website is refused', r.status === 403, String(r.status));
  r = await post(4394, '/api/shutdown', { ...H, Host: 'evil.example:4394' });
  check('shutdown via a foreign Host name is refused', r.status === 403, String(r.status));
  check('  and the editor is still running', await up(4394));
  r = await fetch('http://127.0.0.1:4394/api/shutdown');
  check('GET does not shut it down', r.status === 405 && await up(4394), String(r.status));

  // --- restart ----------------------------------------------------------------
  console.log('--- restart ---');
  r = await post(4394, '/api/restart', { ...H, Origin: 'http://127.0.0.1:4394' });
  check('restart is accepted from the editor page', r.status === 200, `${r.status} ${r.body}`);
  const back = await until(async () => (readState(4394)?.pid ?? st.pid) !== st.pid && await up(4394));
  check('the editor comes back as a new process', back && !alive(st.pid), JSON.stringify(readState(4394)));
  check('  under the same supervisor', alive(sup.pid));

  const bare = startEditor(4393, { supervised: false });
  await until(() => up(4393));
  r = await post(4393, '/api/restart', H);
  check('restart without the supervisor is refused, not fatal', r.status === 409 && await up(4393), `${r.status} ${r.body}`);
  bare.kill('SIGTERM');
  await until(async () => !(await up(4393)));
  check('SIGTERM removes the state file', !fs.existsSync(stateFile(4393)));

  // --- the editor's buttons -----------------------------------------------------
  console.log('--- editor buttons ---');
  const puppeteer = (await import('puppeteer-core')).default;
  const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await b.newPage();
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto('http://127.0.0.1:4394/editor/', { waitUntil: 'networkidle0' });
    await sleep(800);
    const pid1 = readState(4394).pid;
    check('the editor has Restart and Stop buttons', await page.evaluate(() =>
      !!document.getElementById('btn-restart') && !!document.getElementById('btn-stop')));

    await page.click('#btn-restart');
    const reloaded = await until(async () => readState(4394)?.pid && readState(4394).pid !== pid1
      && await page.evaluate(() => document.readyState === 'complete' && !!document.getElementById('btn-stop')
        && !document.querySelector('.server-notice:not([hidden])')).catch(() => false), 15000);
    check('Restart brings the editor back and reloads the page', reloaded, JSON.stringify(readState(4394)));

    // Unsaved work: Stop asks first.
    await sleep(800);
    await page.click('.form-pane .field input[type="text"]');
    await page.keyboard.type(' x');
    await sleep(300);
    dialogs.length = 0;
    await page.click('#btn-stop');
    await until(async () => !(await up(4394)), 8000);
    check('Stop warns about unsaved changes', dialogs.some((m) => /unsaved/i.test(m)), dialogs.join(' | '));
    check('Stop shuts the editor down', !(await up(4394)));
    check('  removes the state file', !fs.existsSync(stateFile(4394)));
    await until(() => !alive(sup.pid), 5000);
    check('  and the supervisor exits too', !alive(sup.pid));
    const notice = await page.evaluate(() => document.querySelector('.server-notice:not([hidden])')?.textContent || '');
    check('the page says it has stopped and how to start again', /stopped/i.test(notice) && /npm start|start-editor/.test(notice),
      notice.slice(0, 120));
  } finally {
    await b.close();
  }

  // --- stop-editor.sh ------------------------------------------------------------
  console.log('--- stop script ---');
  const stop = (args, port) => spawnSync('bash', ['stop-editor.sh', ...args],
    { cwd: ROOT, env: { ...process.env, ...(port ? { PORT: String(port) } : {}) }, encoding: 'utf8', timeout: 20000 });

  startEditor(4392);
  await until(() => up(4392));
  let s = stop([], 4392);
  check('stops the editor on PORT', s.status === 0 && !(await up(4392)) && !fs.existsSync(stateFile(4392)),
    `${s.status} ${(s.stdout + s.stderr).trim()}`);

  s = stop([], 4392);
  check('says so when nothing is running there', s.status === 1 && /no editor/i.test(s.stdout + s.stderr), (s.stdout + s.stderr).trim());

  // A hung server: it can't answer, so the script falls back to the PID,
  // after checking it really is this editor.
  startEditor(4391);
  await until(() => up(4391));
  const hung = readState(4391).pid;
  process.kill(hung, 'SIGSTOP');
  s = stop([], 4391);
  check('a hung editor is stopped by its PID', s.status === 0 && !alive(hung) && !fs.existsSync(stateFile(4391)),
    `${s.status} ${(s.stdout + s.stderr).trim()}`);

  // A stale file whose PID now belongs to something else is left alone.
  const other = spawn('sleep', ['30']);
  fs.writeFileSync(stateFile(4390), JSON.stringify({ pid: other.pid, port: 4390, root: ROOT }));
  s = stop([], 4390);
  check('a stale file pointing at another process kills nothing', alive(other.pid) && !fs.existsSync(stateFile(4390)),
    `${s.status} ${(s.stdout + s.stderr).trim()}`);
  other.kill();

  startEditor(4392);
  startEditor(4391);
  await until(async () => (await up(4392)) && (await up(4391)));
  s = stop(['--all']);
  check('--all stops every editor', s.status === 0 && !(await up(4392)) && !(await up(4391)),
    `${s.status} ${(s.stdout + s.stderr).trim()}`);
} finally {
  for (const c of started) { try { c.kill('SIGKILL'); } catch {} }
  for (const p of [4390, 4391, 4392, 4393, 4394]) {
    const st = readState(p);
    if (st?.pid && st.root === ROOT) { try { process.kill(st.pid, 'SIGCONT'); process.kill(st.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(stateFile(p), { force: true });
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
