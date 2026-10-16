#!/usr/bin/env node
// WO-TWIN-01 tailnet-guard: Tailscale-only edge for the OpenDots app (genius-substrates-host).
// Listens ONLY on 127.0.0.1:4320 and the tailnet IP 100.86.225.40:4320 (env TAILNET_IP/APP_EDGE_PORT).
// Refuses (403 + destroy) any source outside 100.64.0.0/10 + loopback; forwards to the
// loopback-only app edge (default 127.0.0.1:4321). Owner bearer token is enforced by the app itself.
import http from 'node:http';

const GUARD_PORT = parseInt(process.env.GUARD_PORT || '4320', 10);
const TAILNET_IP = process.env.TAILNET_IP || '100.86.225.40';
const APP_EDGE_HOST = process.env.APP_EDGE_HOST || '127.0.0.1';
const APP_EDGE_PORT = parseInt(process.env.APP_EDGE_PORT || '4321', 10);

function normIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip.replace(/^::1$/, '127.0.0.1');
}
function ipToLong(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    const v = parseInt(s, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}
const CGNAT = [ipToLong('100.64.0.0'), ipToLong('100.127.255.255')];
function allowed(ip) {
  const n = ipToLong(ip);
  if (n === null) return ip === '127.0.0.1' || ip === '::1';
  if (ip.startsWith('127.')) return true;
  return n >= CGNAT[0] && n <= CGNAT[1];
}

function makeServer(addr) {
  const server = http.createServer((req, res) => {
    const src = normIp(req.socket.remoteAddress);
    if (!allowed(src)) {
      console.log(JSON.stringify({ t: new Date().toISOString(), deny: src, path: req.url }));
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end('Forbidden (tailnet-only)\n', () => req.socket.destroy());
      return;
    }
    const prox = http.request(
      { host: APP_EDGE_HOST, port: APP_EDGE_PORT, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-for': src } },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    prox.on('error', (e) => {
      console.log(JSON.stringify({ t: new Date().toISOString(), upstreamErr: String(e).slice(0, 120) }));
      if (!res.headersSent) res.writeHead(502);
      res.end('bad gateway\n');
    });
    req.pipe(prox);
  });
  server.on('clientError', (_e, s) => s.destroy());
  server.on('connection', (s) => {
    const src = normIp(s.remoteAddress);
    if (!allowed(src)) {
      console.log(JSON.stringify({ t: new Date().toISOString(), deny: src, stage: 'connection' }));
      s.destroy(); // refuse before parsing anything
    }
  });
  server.on('error', (e) => {
    if (String(e).includes('EADDRNOTAVAIL') && addr === TAILNET_IP) {
      console.log('tailnet IP not yet available; retrying in 5s');
      setTimeout(() => server.listen({ host: addr, port: GUARD_PORT }), 5000);
    } else {
      console.error(`guard error on ${addr}: ${e}`);
      process.exit(1);
    }
  });
  server.listen({ host: addr, port: GUARD_PORT }, () =>
    console.log(`tailnet-guard listening on ${addr}:${GUARD_PORT} -> ${APP_EDGE_HOST}:${APP_EDGE_PORT} (allow: 127.0.0.0/8, 100.64.0.0/10)`)
  );
  return server;
}
makeServer('127.0.0.1');
makeServer(TAILNET_IP);
