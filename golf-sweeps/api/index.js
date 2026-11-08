// Vercel serverless entry point: every /api/* request is rewritten here
// (see vercel.json) and handled by the shared API in lib/app.js.

import { createStoreFromEnv } from '../lib/store.js';
import { createHandler } from '../lib/app.js';

let handler;

export default async function (req, res) {
  try {
    handler ??= createHandler(createStoreFromEnv('/tmp/golf-sweeps.json'));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: e.message }));
  }
  return handler(req, res);
}
