// Golf Sweeps — local server (Node 18+, no dependencies).
//
//   PORT          default 3000
//   DATA_FILE     default ./data/db.json  (ignored when Redis is configured)
//   ADMIN_PIN     optional; when set, every change requires this PIN
//   GHIN_USERNAME / GHIN_PASSWORD   enable GHIN handicap sync (see lib/ghin.js)
//   KV_REST_API_URL / KV_REST_API_TOKEN   use Upstash Redis instead of a file
//
// On Vercel, api/index.js serves the API and public/ is served statically.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreFromEnv } from './lib/store.js';
import { createHandler } from './lib/app.js';
import { ghinConfigured } from './lib/ghin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const store = createStoreFromEnv(path.join(__dirname, 'data', 'db.json'));
const handleApi = createHandler(store);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  // The browser shares the pure handicap math (copied into public/ on Vercel).
  let file = url.pathname === '/lib/handicap.js'
    ? path.join(__dirname, 'lib', 'handicap.js')
    : path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC) && !file.endsWith(path.join('lib', 'handicap.js'))) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Golf Sweeps on http://localhost:${PORT}  (storage: ${store.kind}, GHIN ${ghinConfigured() ? 'enabled' : 'not configured'})`));
}
