// Golf Sweeps — zero-dependency Node server (Node 18+).
//
//   PORT          default 3000
//   DATA_FILE     default ./data/db.json
//   ADMIN_PIN     optional; when set, every change requires this PIN
//   GHIN_USERNAME / GHIN_PASSWORD   enable GHIN handicap sync (see lib/ghin.js)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, newId } from './lib/store.js';
import { courseHandicap, playingHandicap, parseHandicapIndex } from './lib/handicap.js';
import { drawTeams, TIERS } from './lib/teams.js';
import { GAME_TYPES, scoreEvent, scrambleHandicap } from './lib/games.js';
import { ghinConfigured, lookupGolfer, searchGolfers } from './lib/ghin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const store = createStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'));
const PUBLIC = path.join(__dirname, 'public');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- helpers ----------

const db = () => store.data;
const find = (list, id, what) => {
  const item = list.find((x) => x.id === id);
  if (!item) throw new HttpError(404, `${what} not found`);
  return item;
};
const coursePar = (course) => course.holes.reduce((s, h) => s + h.par, 0);

function playerName(p) {
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || 'Unnamed';
}

function cleanPlayer(input, existing = {}) {
  const p = { ...existing };
  for (const k of ['firstName', 'lastName', 'ghin', 'email', 'phone']) if (k in input) p[k] = String(input[k] ?? '').trim();
  if ('handicapIndex' in input) {
    p.handicapIndex = parseHandicapIndex(input.handicapIndex);
    p.handicapSource = 'manual';
    p.handicapUpdated = new Date().toISOString();
  }
  if ('active' in input) p.active = Boolean(input.active);
  p.name = playerName(p);
  return p;
}

function cleanCourse(input, existing = {}) {
  const c = { ...existing, name: String(input.name ?? existing.name ?? '').trim() || 'Course' };
  if (Array.isArray(input.holes)) {
    if (input.holes.length !== 18) throw new HttpError(400, 'A course needs 18 holes');
    c.holes = input.holes.map((h) => ({ par: Number(h.par) || 4, si: Number(h.si) || 1 }));
    const sis = new Set(c.holes.map((h) => h.si));
    if (sis.size !== 18) throw new HttpError(400, 'Stroke indexes must be 1–18, each used once');
  }
  if (Array.isArray(input.tees)) {
    c.tees = input.tees.map((t) => ({ id: t.id || newId(), name: String(t.name || 'Tee'), rating: Number(t.rating), slope: Number(t.slope) }));
  }
  return c;
}

const DEFAULT_GAME = () => ({ id: newId(), type: 'best2', scoring: 'net', potPct: 100, payouts: [50, 30, 20], tiebreak: 'cardoff' });

function cleanEvent(input, existing = {}) {
  const e = { ...existing };
  for (const k of ['name', 'date', 'courseId', 'teeId', 'notes']) if (k in input) e[k] = input[k];
  if ('allowance' in input) e.allowance = Math.max(0, Math.min(100, Number(input.allowance) || 100));
  if ('entryFee' in input) e.entryFee = Math.max(0, Number(input.entryFee) || 0);
  if ('offLow' in input) e.offLow = Boolean(input.offLow);
  if ('status' in input) e.status = input.status;
  if (Array.isArray(input.playerIds)) e.playerIds = [...new Set(input.playerIds)];
  if (Array.isArray(input.games)) {
    e.games = input.games.map((g) => {
      if (!GAME_TYPES[g.type]) throw new HttpError(400, `Unknown game type ${g.type}`);
      return {
        id: g.id || newId(),
        type: g.type,
        label: g.label || '',
        scoring: g.scoring === 'gross' ? 'gross' : 'net',
        potPct: Number(g.potPct) || 0,
        payouts: (Array.isArray(g.payouts) ? g.payouts : String(g.payouts || '').split(/[ ,/]+/)).map(Number).filter((n) => n > 0),
        tiebreak: g.tiebreak === 'split' ? 'split' : 'cardoff',
        carryover: Boolean(g.carryover),
      };
    });
  }
  return e;
}

/** Freeze each player's handicap for the event and assign A/B/C/D tiers. */
function snapshotPlayers(event) {
  const course = find(db().courses, event.courseId, 'Course');
  const tee = course.tees.find((t) => t.id === event.teeId) ?? course.tees[0];
  if (!tee) throw new HttpError(400, 'Course has no tees');
  const teeInfo = { slope: tee.slope, rating: tee.rating, par: coursePar(course) };
  const missing = [];
  const players = (event.playerIds ?? []).map((id) => {
    const p = find(db().players, id, 'Player');
    if (p.handicapIndex === null || p.handicapIndex === undefined) missing.push(p.name);
    const ch = courseHandicap(p.handicapIndex ?? 0, teeInfo);
    return {
      playerId: p.id, name: p.name, ghin: p.ghin, index: p.handicapIndex ?? null,
      handicapUpdated: p.handicapUpdated ?? null, courseHcp: ch,
      playingHcp: playingHandicap(ch, event.allowance ?? 100),
    };
  });
  if (missing.length) throw new HttpError(400, `No handicap index for: ${missing.join(', ')}`);
  if (event.offLow && players.length) {
    const low = Math.min(...players.map((p) => p.playingHcp));
    players.forEach((p) => (p.playingHcp -= low));
  }
  return players;
}

function eventView(event) {
  const course = db().courses.find((c) => c.id === event.courseId);
  const out = { ...event, course };
  if (course && event.teams?.length) {
    out.results = scoreEvent(event, course);
    out.teams = event.teams.map((t) => ({ ...t, scrambleHcp: scrambleHandicap(t, event) }));
  }
  return out;
}

async function refreshFromGhin(player) {
  if (!player.ghin) throw new HttpError(400, `${player.name} has no GHIN number`);
  const g = await lookupGolfer(player.ghin);
  if (!g) throw new HttpError(404, `GHIN ${player.ghin} not found`);
  player.handicapIndex = g.handicapIndex;
  player.handicapDisplay = g.handicapDisplay;
  player.lowIndex = g.lowIndex;
  player.ghinRevision = g.revisionDate;
  player.club = g.club ?? player.club;
  if (!player.firstName && !player.lastName) {
    player.firstName = g.firstName;
    player.lastName = g.lastName;
    player.name = playerName(player);
  }
  player.handicapSource = 'ghin';
  player.handicapUpdated = new Date().toISOString();
  return player;
}

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => l.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const hasHeader = header.some((h) => ['first', 'firstname', 'last', 'lastname', 'name', 'ghin', 'index', 'handicap', 'handicapindex'].includes(h));
  const cols = hasHeader ? header : ['firstname', 'lastname', 'ghin', 'index'];
  return (hasHeader ? lines.slice(1) : lines).map((l) => {
    const v = split(l);
    const row = {};
    cols.forEach((c, i) => (row[c] = v[i]));
    let firstName = row.firstname ?? row.first;
    let lastName = row.lastname ?? row.last;
    if (!firstName && !lastName && row.name) [firstName, ...lastName] = row.name.split(' '), (lastName = lastName.join(' '));
    return { firstName, lastName, ghin: row.ghin ?? row.ghinnumber ?? '', handicapIndex: row.index ?? row.handicap ?? row.handicapindex ?? row.hi };
  });
}

// ---------- routing ----------

const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, open });
};

route('GET', '/api/state', () => ({
  players: db().players,
  courses: db().courses,
  events: db().events.map(({ id, name, date, status, playerIds, teams }) => ({ id, name, date, status, players: playerIds?.length ?? 0, teams: teams?.length ?? 0 })),
  gameTypes: Object.fromEntries(Object.entries(GAME_TYPES).map(([k, v]) => [k, { name: v.name, kind: v.kind, description: v.description, allowance: v.allowance }])),
  ghinConfigured: ghinConfigured(),
  pinRequired: Boolean(process.env.ADMIN_PIN),
}), { open: true });

route('POST', '/api/auth', ({ body }) => {
  if (process.env.ADMIN_PIN && body.pin !== process.env.ADMIN_PIN) throw new HttpError(401, 'Wrong PIN');
  return { ok: true };
}, { open: true });

// Players
route('POST', '/api/players', ({ body }) => {
  const p = cleanPlayer(body, { id: newId(), active: true });
  db().players.push(p);
  store.save();
  return p;
});
route('PUT', '/api/players/:id', ({ params, body }) => {
  const list = db().players;
  const i = list.findIndex((p) => p.id === params.id);
  if (i < 0) throw new HttpError(404, 'Player not found');
  list[i] = cleanPlayer(body, list[i]);
  store.save();
  return list[i];
});
route('DELETE', '/api/players/:id', ({ params }) => {
  db().players = db().players.filter((p) => p.id !== params.id);
  store.save();
  return { ok: true };
});
route('POST', '/api/players/import', ({ body }) => {
  const rows = parseCsv(body.csv);
  const added = [];
  for (const r of rows) {
    const existing = r.ghin && db().players.find((p) => p.ghin && p.ghin === r.ghin);
    if (existing) {
      Object.assign(existing, cleanPlayer(r, existing));
    } else {
      const p = cleanPlayer(r, { id: newId(), active: true });
      db().players.push(p);
      added.push(p);
    }
  }
  store.save();
  return { imported: rows.length, added: added.length };
});
route('POST', '/api/players/:id/ghin', async ({ params }) => {
  const p = find(db().players, params.id, 'Player');
  await refreshFromGhin(p);
  store.save();
  return p;
});
route('POST', '/api/ghin/refresh', async ({ body }) => {
  const ids = Array.isArray(body.playerIds) ? body.playerIds : db().players.filter((p) => p.ghin).map((p) => p.id);
  const results = [];
  for (const id of ids) {
    const p = db().players.find((x) => x.id === id);
    if (!p) continue;
    try {
      const before = p.handicapIndex;
      await refreshFromGhin(p);
      results.push({ id, name: p.name, ok: true, before, after: p.handicapIndex });
    } catch (e) {
      results.push({ id, name: p.name, ok: false, error: e.message });
    }
  }
  store.save();
  return { results };
});
route('GET', '/api/ghin/search', async ({ query }) => {
  if (query.ghin) {
    const g = await lookupGolfer(query.ghin);
    return { golfers: g ? [g] : [] };
  }
  if (!query.last) throw new HttpError(400, 'Provide a GHIN number or last name');
  return { golfers: await searchGolfers({ lastName: query.last, firstName: query.first, state: query.state }) };
});

// Courses
route('POST', '/api/courses', ({ body }) => {
  const c = cleanCourse(body, { id: newId(), holes: [], tees: [] });
  db().courses.push(c);
  store.save();
  return c;
});
route('PUT', '/api/courses/:id', ({ params, body }) => {
  const list = db().courses;
  const i = list.findIndex((c) => c.id === params.id);
  if (i < 0) throw new HttpError(404, 'Course not found');
  list[i] = cleanCourse(body, list[i]);
  store.save();
  return list[i];
});
route('DELETE', '/api/courses/:id', ({ params }) => {
  if (db().events.some((e) => e.courseId === params.id)) throw new HttpError(400, 'Course is used by an event');
  db().courses = db().courses.filter((c) => c.id !== params.id);
  store.save();
  return { ok: true };
});

// Events
route('POST', '/api/events', ({ body }) => {
  const course = db().courses[0];
  const e = cleanEvent(body, {
    id: newId(), name: 'Saturday Sweeps', date: new Date().toISOString().slice(0, 10),
    courseId: course?.id, teeId: course?.tees[0]?.id, allowance: 90, entryFee: 20, offLow: false,
    status: 'setup', playerIds: [], games: [DEFAULT_GAME()], players: [], teams: [], scores: {}, teamScores: {},
  });
  db().events.unshift(e);
  store.save();
  return eventView(e);
});
route('GET', '/api/events/:id', ({ params }) => eventView(find(db().events, params.id, 'Event')), { open: true });
route('PUT', '/api/events/:id', ({ params, body }) => {
  const list = db().events;
  const i = list.findIndex((e) => e.id === params.id);
  if (i < 0) throw new HttpError(404, 'Event not found');
  list[i] = cleanEvent(body, list[i]);
  store.save();
  return eventView(list[i]);
});
route('DELETE', '/api/events/:id', ({ params }) => {
  db().events = db().events.filter((e) => e.id !== params.id);
  store.save();
  return { ok: true };
});
route('POST', '/api/events/:id/draw', async ({ params, body }) => {
  const e = find(db().events, params.id, 'Event');
  if (Object.keys(e.scores ?? {}).length && !body.force) throw new HttpError(409, 'Scores already entered — redraw anyway?');
  if (body.refreshGhin && ghinConfigured()) {
    for (const id of e.playerIds ?? []) {
      const p = db().players.find((x) => x.id === id);
      if (p?.ghin) await refreshFromGhin(p).catch(() => {});
    }
  }
  if ((e.playerIds ?? []).length < 2) throw new HttpError(400, 'Pick at least 2 players');
  e.players = snapshotPlayers(e);
  const teams = drawTeams(e.players.map((p) => ({ id: p.playerId, name: p.name, hcp: p.playingHcp })), { mode: body.mode === 'random' ? 'random' : 'balanced' });
  const tierOf = new Map();
  teams.forEach((t) => TIERS.forEach((tier) => t.members[tier] != null && tierOf.set(t.members[tier], tier)));
  e.players.forEach((p) => (p.tier = tierOf.get(p.playerId)));
  e.teams = teams.map(({ total, ...t }) => t);
  e.scores = {};
  e.teamScores = {};
  e.status = 'drawn';
  store.save();
  return eventView(e);
});
route('POST', '/api/events/:id/swap', ({ params, body }) => {
  // Swap two players' places (any tiers). Each takes over the other's slot.
  const e = find(db().events, params.id, 'Event');
  const locate = (pid) => {
    for (const t of e.teams) for (const tier of TIERS) if (t.members[tier] === pid) return { t, tier };
    throw new HttpError(404, 'Player not on a team');
  };
  const a = locate(body.a);
  const b = locate(body.b);
  a.t.members[a.tier] = body.b;
  b.t.members[b.tier] = body.a;
  const pa = e.players.find((p) => p.playerId === body.a);
  const pb = e.players.find((p) => p.playerId === body.b);
  [pa.tier, pb.tier] = [b.tier, a.tier];
  store.save();
  return eventView(e);
});
route('PUT', '/api/events/:id/teams/:teamId', ({ params, body }) => {
  const e = find(db().events, params.id, 'Event');
  const t = e.teams.find((x) => String(x.id) === params.teamId);
  if (!t) throw new HttpError(404, 'Team not found');
  if (body.name) t.name = String(body.name).slice(0, 40);
  store.save();
  return eventView(e);
});
route('PUT', '/api/events/:id/scores', ({ params, body }) => {
  const e = find(db().events, params.id, 'Event');
  const clean = (arr) => Array.from({ length: 18 }, (_, i) => {
    const v = arr?.[i];
    if (v === '' || v === null || v === undefined) return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new HttpError(400, `Bad score on hole ${i + 1}`);
    return n;
  });
  if (body.playerId) {
    if (!e.players.some((p) => p.playerId === body.playerId)) throw new HttpError(404, 'Player not in event');
    e.scores = { ...e.scores, [body.playerId]: clean(body.holes) };
  } else if (body.teamId != null) {
    e.teamScores = { ...e.teamScores, [body.teamId]: clean(body.holes) };
  } else throw new HttpError(400, 'playerId or teamId required');
  if (e.status === 'drawn') e.status = 'live';
  store.save();
  return eventView(e);
});

// ---------- server ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  // Share the pure handicap math with the browser.
  if (url.pathname === '/lib/handicap.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return fs.createReadStream(path.join(__dirname, 'lib', 'handicap.js')).pipe(res);
  }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  try {
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      if (!r.open && process.env.ADMIN_PIN && req.headers['x-admin-pin'] !== process.env.ADMIN_PIN) {
        throw new HttpError(401, 'Admin PIN required');
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      return send(200, await r.handler({ params, body, query }));
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    send(e.status || 500, { error: e.message });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Golf Sweeps running on http://localhost:${PORT}  (GHIN ${ghinConfigured() ? 'enabled' : 'not configured'})`));
}
