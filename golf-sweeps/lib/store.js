// Storage backends.
//
// - Upstash Redis (used on Vercel): set KV_REST_API_URL + KV_REST_API_TOKEN
//   (added automatically by Vercel's Upstash integration) or
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
// - JSON file (local default): DATA_FILE, default ./data/db.json.
//
// The roster, courses and events live in one document. Scores are stored one
// field per player/team so several people can post scores at the same time
// without overwriting each other.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ players: [], courses: [], events: [] });

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

export function sampleCourse() {
  const pars = [4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4];
  const sis = [7, 11, 17, 1, 13, 5, 15, 3, 9, 8, 18, 4, 14, 2, 12, 16, 10, 6];
  return {
    id: newId(),
    name: 'Sample Course (edit me)',
    holes: pars.map((par, i) => ({ par, si: sis[i] })),
    tees: [
      { id: newId(), name: 'Blue', rating: 72.4, slope: 131 },
      { id: newId(), name: 'White', rating: 70.6, slope: 126 },
    ],
  };
}

function seeded() {
  const db = EMPTY();
  db.courses.push(sampleCourse());
  return db;
}

/** Split stored score fields ("p:<playerId>", "t:<teamId>") into maps. */
function splitScores(fields) {
  const out = { scores: {}, teamScores: {} };
  for (const [k, v] of Object.entries(fields ?? {})) {
    const holes = typeof v === 'string' ? JSON.parse(v) : v;
    if (k.startsWith('p:')) out.scores[k.slice(2)] = holes;
    else if (k.startsWith('t:')) out.teamScores[k.slice(2)] = holes;
  }
  return out;
}

export function createFileStore(file) {
  let doc;
  const read = () => {
    if (doc) return doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      doc = { ...seeded(), scores: {} };
      write();
    }
    doc.scores ??= {};
    return doc;
  };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    kind: 'file',
    async getDb() {
      const { scores, ...db } = read();
      return structuredClone(db);
    },
    async saveDb(db) {
      const scores = read().scores;
      doc = { ...structuredClone(db), scores };
      write();
    },
    async getScores(eventId) {
      return splitScores(read().scores[eventId]);
    },
    async setScore(eventId, field, holes) {
      const d = read();
      d.scores[eventId] = { ...d.scores[eventId], [field]: holes };
      write();
    },
    async clearScores(eventId) {
      delete read().scores[eventId];
      write();
    },
  };
}

export function createRedisStore({ url, token, prefix = 'gs', fetchImpl = fetch }) {
  const cmd = async (...args) => {
    const res = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Redis: ${data.error || res.statusText}`);
    return data.result;
  };
  const dbKey = `${prefix}:db`;
  const scoreKey = (id) => `${prefix}:scores:${id}`;
  return {
    kind: 'redis',
    async getDb() {
      const raw = await cmd('GET', dbKey);
      if (raw) return JSON.parse(raw);
      const db = seeded();
      await cmd('SET', dbKey, JSON.stringify(db), 'NX');
      return JSON.parse(await cmd('GET', dbKey));
    },
    async saveDb(db) {
      await cmd('SET', dbKey, JSON.stringify(db));
    },
    async getScores(eventId) {
      const flat = (await cmd('HGETALL', scoreKey(eventId))) ?? [];
      const fields = Array.isArray(flat)
        ? Object.fromEntries(flat.flatMap((v, i) => (i % 2 ? [] : [[v, flat[i + 1]]])))
        : flat;
      return splitScores(fields);
    },
    async setScore(eventId, field, holes) {
      await cmd('HSET', scoreKey(eventId), field, JSON.stringify(holes));
    },
    async clearScores(eventId) {
      await cmd('DEL', scoreKey(eventId));
    },
  };
}

/** Pick a backend from the environment. */
export function createStoreFromEnv(defaultFile) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisStore({ url, token, prefix: process.env.STORE_PREFIX || 'gs' });
  if (process.env.VERCEL) {
    throw new Error('No database configured. In Vercel, add an Upstash Redis database to this project (Storage tab), then redeploy.');
  }
  return createFileStore(process.env.DATA_FILE || defaultFile);
}
