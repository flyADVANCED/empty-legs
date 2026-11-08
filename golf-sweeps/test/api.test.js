import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRedisStore, createFileStore } from '../lib/store.js';
import { createHandler } from '../lib/app.js';

/** In-memory stand-in for the Upstash REST API (GET/SET/HSET/HGETALL/DEL). */
function fakeUpstash() {
  const kv = new Map();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer secret');
    const [cmd, key, ...rest] = JSON.parse(opts.body);
    calls.push(cmd);
    let result = null;
    if (cmd === 'GET') result = kv.get(key) ?? null;
    else if (cmd === 'SET') {
      if (!(rest[1] === 'NX' && kv.has(key))) kv.set(key, rest[0]);
      result = 'OK';
    } else if (cmd === 'HSET') {
      const h = kv.get(key) ?? new Map();
      h.set(rest[0], rest[1]);
      kv.set(key, h);
      result = 1;
    } else if (cmd === 'HGETALL') result = [...(kv.get(key) ?? new Map())].flat();
    else if (cmd === 'DEL') result = kv.delete(key) ? 1 : 0;
    return { ok: true, json: async () => ({ result }) };
  };
  return { fetchImpl, kv, calls };
}

/** Run the API handler like Vercel would: body pre-parsed, path rewritten. */
async function vercelCall(handle, method, route, body) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => (headers[k] = v),
      end: (s) => resolve({ status: res.statusCode, data: JSON.parse(s) }),
    };
    handle({ method, url: `/api?route=${route}`, headers: {}, body }, res);
  });
}

test('Redis store: seeds a course, saves, keeps scores per player', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://x.upstash.io', token: 'secret', fetchImpl: fake.fetchImpl });
  const db = await store.getDb();
  assert.equal(db.courses.length, 1);
  db.players.push({ id: 'p1', name: 'Pat' });
  await store.saveDb(db);
  assert.equal((await store.getDb()).players[0].name, 'Pat');
  await store.setScore('e1', 'p:p1', [4, 5]);
  await store.setScore('e1', 't:2', [3]);
  assert.deepEqual(await store.getScores('e1'), { scores: { p1: [4, 5] }, teamScores: { 2: [3] } });
  await store.clearScores('e1');
  assert.deepEqual(await store.getScores('e1'), { scores: {}, teamScores: {} });
});

test('full sweeps flow through the Vercel-style handler on Redis', async () => {
  const fake = fakeUpstash();
  const handle = createHandler(createRedisStore({ url: 'https://x.upstash.io', token: 'secret', fetchImpl: fake.fetchImpl }));
  const csv = 'first,last,ghin,index\n' + Array.from({ length: 10 }, (_, i) => `F${i},L${i},${100 + i},${i * 3}`).join('\n');
  assert.equal((await vercelCall(handle, 'POST', 'players/import', { csv })).data.added, 10);
  const state = (await vercelCall(handle, 'GET', 'state')).data;
  const ev = (await vercelCall(handle, 'POST', 'events', {})).data;
  await vercelCall(handle, 'PUT', `events/${ev.id}`, { playerIds: state.players.map((p) => p.id) });
  const drawn = (await vercelCall(handle, 'POST', `events/${ev.id}/draw`, { mode: 'balanced' })).data;
  assert.equal(drawn.teams.length, 3);
  assert.equal(drawn.teams.filter((t) => t.blind).length, 2);
  // Two scorers posting at once must not clobber each other.
  const [a, b] = drawn.players;
  await Promise.all([
    vercelCall(handle, 'PUT', `events/${ev.id}/scores`, { playerId: a.playerId, holes: Array(18).fill(4) }),
    vercelCall(handle, 'PUT', `events/${ev.id}/scores`, { playerId: b.playerId, holes: Array(18).fill(5) }),
  ]);
  const view = (await vercelCall(handle, 'GET', `events/${ev.id}`)).data;
  assert.deepEqual(Object.keys(view.scores).sort(), [a.playerId, b.playerId].sort());
  const redraw = await vercelCall(handle, 'POST', `events/${ev.id}/draw`, {});
  assert.equal(redraw.status, 409);
  assert.equal((await vercelCall(handle, 'GET', 'nope')).status, 404);
});

test('local server path: JSON file store over real HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));
  const handle = createHandler(createFileStore(path.join(dir, 'db.json')));
  const srv = http.createServer(handle).listen(0);
  const base = `http://localhost:${srv.address().port}`;
  try {
    const r = await fetch(`${base}/api/players`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Sam', lastName: 'Lee', handicapIndex: '+0.8' }) });
    const p = await r.json();
    assert.equal(p.handicapIndex, -0.8);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.players[0].name, 'Sam Lee');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).players.length === 1);
  } finally {
    srv.close();
  }
});
