// Desk sandbox: runs [[shell]] commands for OpenDots desks. Deployed as its own container with NO env_file,
// no docker socket and no app data; only /desk-work (rw) and /desk-files (ro). The process environment of
// every command is built here from scratch, so no service key can leak into it.
// POST /exec {desk, command, timeoutMs} -> text/plain "<output>\nexit=<code>". Reachable only on the
// internal sandbox-control network.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 4330);
const WORK = process.env.DESK_WORK_ROOT || '/desk-work';
const MAX_OUT = 64 * 1024;
const MAX_PARALLEL = 4;
let running = 0;

function run(desk, command, timeoutMs) {
  return new Promise((resolve) => {
    const cwd = `${WORK}/${desk}`;
    mkdirSync(cwd, { recursive: true });
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', TERM: 'dumb', USER: 'node' },
    });
    let out = '';
    let truncated = false;
    let timedOut = false;
    const take = (chunk) => {
      if (out.length < MAX_OUT) out += chunk.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      kill();
      resolve(
        `${out.slice(0, MAX_OUT)}${truncated ? '\n[output truncated]' : ''}${timedOut ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s]` : ''}\nexit=${code ?? 'killed'}`,
      );
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(`could not start: ${error.message}\nexit=127`);
    });
  });
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method !== 'POST' || req.url !== '/exec') return res.writeHead(404).end();
    let body = '';
    req.on('data', (chunk) => {
      if (body.length < 100_000) body += chunk;
    });
    req.on('end', async () => {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return res.writeHead(400).end('bad json');
      }
      const { desk, command } = input;
      const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 120000, 1000), 120000);
      if (typeof desk !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(desk) || typeof command !== 'string' || !command.trim() || command.length > 8000)
        return res.writeHead(400).end('bad request');
      if (running >= MAX_PARALLEL) return res.writeHead(429).end('sandbox busy');
      running++;
      try {
        const text = await run(desk, command, timeoutMs);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
      } finally {
        running--;
      }
    });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`desk-sandbox listening on ${PORT}`));
