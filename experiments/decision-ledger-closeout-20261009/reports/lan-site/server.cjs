const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const host = process.argv[2];
const port = Number(process.argv[3]);
if (!host || !Number.isInteger(port)) throw new Error('LAN address and port are required');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  if (!['/', '/argus-closeout', '/argus-closeout/'].includes(url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'));
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Content-Length':html.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(req.method === 'HEAD' ? undefined : html);
}).listen(port, host, () => console.log(`Report available at http://${host}:${port}/argus-closeout/`));
