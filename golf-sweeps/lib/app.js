// JSON API shared by the local server (server.js) and Vercel (api/index.js).

import { newId } from './store.js';
import { courseHandicap, playingHandicap, parseHandicapIndex } from './handicap.js';
import { drawTeams, TIERS } from './teams.js';
import { GAME_TYPES, scoreEvent, scrambleHandicap } from './games.js';
import { ghinConfigured, lookupGolfer, searchGolfers } from './ghin.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- helpers ----------

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

/** Freeze each player's handicap for the event. */
function snapshotPlayers(db, event) {
  const course = find(db.courses, event.courseId, 'Course');
  const tee = course.tees.find((t) => t.id === event.teeId) ?? course.tees[0];
  if (!tee) throw new HttpError(400, 'Course has no tees');
  const teeInfo = { slope: tee.slope, rating: tee.rating, par: coursePar(course) };
  const missing = [];
  const players = (event.playerIds ?? []).map((id) => {
    const p = find(db.players, id, 'Player');
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

export function parseCsv(text) {
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
    if (!firstName && !lastName && row.name) {
      const parts = row.name.split(' ');
      firstName = parts.shift();
      lastName = parts.join(' ');
    }
    return { firstName, lastName, ghin: row.ghin ?? row.ghinnumber ?? '', handicapIndex: row.index ?? row.handicap ?? row.handicapindex ?? row.hi };
  });
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, open });
};

async function eventView(store, db, event) {
  const course = db.courses.find((c) => c.id === event.courseId);
  const { scores, teamScores } = await store.getScores(event.id);
  const full = { ...event, scores, teamScores };
  const out = { ...full, course };
  if (course && event.teams?.length) {
    out.results = scoreEvent(full, course);
    out.teams = event.teams.map((t) => ({ ...t, scrambleHcp: scrambleHandicap(t, full) }));
  }
  return out;
}

route('GET', '/api/state', ({ db }) => ({
  players: db.players,
  courses: db.courses,
  events: db.events.map(({ id, name, date, status, playerIds, teams }) => ({ id, name, date, status, players: playerIds?.length ?? 0, teams: teams?.length ?? 0 })),
  gameTypes: Object.fromEntries(Object.entries(GAME_TYPES).map(([k, v]) => [k, { name: v.name, kind: v.kind, description: v.description, allowance: v.allowance }])),
  ghinConfigured: ghinConfigured(),
  pinRequired: Boolean(process.env.ADMIN_PIN),
}), { open: true });

route('POST', '/api/auth', ({ body }) => {
  if (process.env.ADMIN_PIN && body.pin !== process.env.ADMIN_PIN) throw new HttpError(401, 'Wrong PIN');
  return { ok: true };
}, { open: true });

// Players
route('POST', '/api/players', async ({ db, body, save }) => {
  const p = cleanPlayer(body, { id: newId(), active: true });
  db.players.push(p);
  await save();
  return p;
});
route('PUT', '/api/players/:id', async ({ db, params, body, save }) => {
  const i = db.players.findIndex((p) => p.id === params.id);
  if (i < 0) throw new HttpError(404, 'Player not found');
  db.players[i] = cleanPlayer(body, db.players[i]);
  await save();
  return db.players[i];
});
route('DELETE', '/api/players/:id', async ({ db, params, save }) => {
  db.players = db.players.filter((p) => p.id !== params.id);
  await save();
  return { ok: true };
});
route('POST', '/api/players/import', async ({ db, body, save }) => {
  const rows = parseCsv(body.csv);
  let added = 0;
  for (const r of rows) {
    const existing = r.ghin && db.players.find((p) => p.ghin && p.ghin === r.ghin);
    if (existing) Object.assign(existing, cleanPlayer(r, existing));
    else {
      db.players.push(cleanPlayer(r, { id: newId(), active: true }));
      added++;
    }
  }
  await save();
  return { imported: rows.length, added };
});
route('POST', '/api/players/:id/ghin', async ({ db, params, save }) => {
  const p = find(db.players, params.id, 'Player');
  await refreshFromGhin(p);
  await save();
  return p;
});
route('POST', '/api/ghin/refresh', async ({ db, body, save }) => {
  const ids = Array.isArray(body.playerIds) ? body.playerIds : db.players.filter((p) => p.ghin).map((p) => p.id);
  const results = [];
  for (const id of ids) {
    const p = db.players.find((x) => x.id === id);
    if (!p) continue;
    try {
      const before = p.handicapIndex;
      await refreshFromGhin(p);
      results.push({ id, name: p.name, ok: true, before, after: p.handicapIndex });
    } catch (e) {
      results.push({ id, name: p.name, ok: false, error: e.message });
    }
  }
  await save();
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
route('POST', '/api/courses', async ({ db, body, save }) => {
  const c = cleanCourse(body, { id: newId(), holes: [], tees: [] });
  db.courses.push(c);
  await save();
  return c;
});
route('PUT', '/api/courses/:id', async ({ db, params, body, save }) => {
  const i = db.courses.findIndex((c) => c.id === params.id);
  if (i < 0) throw new HttpError(404, 'Course not found');
  db.courses[i] = cleanCourse(body, db.courses[i]);
  await save();
  return db.courses[i];
});
route('DELETE', '/api/courses/:id', async ({ db, params, save }) => {
  if (db.events.some((e) => e.courseId === params.id)) throw new HttpError(400, 'Course is used by an event');
  db.courses = db.courses.filter((c) => c.id !== params.id);
  await save();
  return { ok: true };
});

// Events
route('POST', '/api/events', async ({ db, body, save, view }) => {
  const course = db.courses[0];
  const e = cleanEvent(body, {
    id: newId(), name: 'Saturday Sweeps', date: new Date().toISOString().slice(0, 10),
    courseId: course?.id, teeId: course?.tees[0]?.id, allowance: 90, entryFee: 20, offLow: false,
    status: 'setup', playerIds: [], games: [DEFAULT_GAME()], players: [], teams: [],
  });
  db.events.unshift(e);
  await save();
  return view(e);
});
route('GET', '/api/events/:id', ({ db, params, view }) => view(find(db.events, params.id, 'Event')), { open: true });
route('PUT', '/api/events/:id', async ({ db, params, body, save, view }) => {
  const i = db.events.findIndex((e) => e.id === params.id);
  if (i < 0) throw new HttpError(404, 'Event not found');
  db.events[i] = cleanEvent(body, db.events[i]);
  await save();
  return view(db.events[i]);
});
route('DELETE', '/api/events/:id', async ({ db, params, save, store }) => {
  db.events = db.events.filter((e) => e.id !== params.id);
  await save();
  await store.clearScores(params.id);
  return { ok: true };
});
route('POST', '/api/events/:id/draw', async ({ db, params, body, save, store, view }) => {
  const e = find(db.events, params.id, 'Event');
  const existing = await store.getScores(e.id);
  if ((Object.keys(existing.scores).length || Object.keys(existing.teamScores).length) && !body.force) {
    throw new HttpError(409, 'Scores already entered — redraw anyway?');
  }
  if ((e.playerIds ?? []).length < 2) throw new HttpError(400, 'Pick at least 2 players');
  if (body.refreshGhin && ghinConfigured()) {
    for (const id of e.playerIds) {
      const p = db.players.find((x) => x.id === id);
      if (p?.ghin) await refreshFromGhin(p).catch(() => {});
    }
  }
  e.players = snapshotPlayers(db, e);
  const teams = drawTeams(e.players.map((p) => ({ id: p.playerId, name: p.name, hcp: p.playingHcp })), { mode: body.mode === 'random' ? 'random' : 'balanced' });
  const tierOf = new Map();
  teams.forEach((t) => TIERS.forEach((tier) => t.members[tier] != null && tierOf.set(t.members[tier], tier)));
  e.players.forEach((p) => (p.tier = tierOf.get(p.playerId)));
  e.teams = teams.map(({ total, ...t }) => t);
  e.status = 'drawn';
  await store.clearScores(e.id);
  await save();
  return view(e);
});
route('POST', '/api/events/:id/swap', async ({ db, params, body, save, view }) => {
  // Swap two players' places (any letters). Each takes over the other's slot.
  const e = find(db.events, params.id, 'Event');
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
  await save();
  return view(e);
});
route('PUT', '/api/events/:id/teams/:teamId', async ({ db, params, body, save, view }) => {
  const e = find(db.events, params.id, 'Event');
  const t = e.teams.find((x) => String(x.id) === params.teamId);
  if (!t) throw new HttpError(404, 'Team not found');
  if (body.name) t.name = String(body.name).slice(0, 40);
  await save();
  return view(e);
});
route('PUT', '/api/events/:id/scores', async ({ db, params, body, save, store, view }) => {
  const e = find(db.events, params.id, 'Event');
  const holes = Array.from({ length: 18 }, (_, i) => {
    const v = body.holes?.[i];
    if (v === '' || v === null || v === undefined) return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new HttpError(400, `Bad score on hole ${i + 1}`);
    return n;
  });
  let field;
  if (body.playerId) {
    if (!e.players.some((p) => p.playerId === body.playerId)) throw new HttpError(404, 'Player not in event');
    field = `p:${body.playerId}`;
  } else if (body.teamId != null) {
    if (!e.teams.some((t) => String(t.id) === String(body.teamId))) throw new HttpError(404, 'Team not in event');
    field = `t:${body.teamId}`;
  } else throw new HttpError(400, 'playerId or teamId required');
  await store.setScore(e.id, field, holes);
  if (e.status === 'drawn') {
    e.status = 'live';
    await save();
  }
  return view(e);
});

// ---------- request handling ----------

async function readBody(req) {
  // Vercel pre-parses the body; a plain Node server leaves it on the stream.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body ?? {};
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Work out the API path, including when Vercel rewrites to /api?route=… */
function apiPath(url) {
  const r = url.searchParams.get('route');
  if (r !== null && !url.pathname.startsWith('/api/')) return `/api/${r}`.replace(/\/$/, '');
  return url.pathname.replace(/\/$/, '');
}

export function createHandler(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = apiPath(url);
    const send = (status, data) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(data));
    };
    try {
      for (const r of routes) {
        const m = r.method === req.method && pathname.match(r.re);
        if (!m) continue;
        if (!r.open && process.env.ADMIN_PIN && req.headers['x-admin-pin'] !== process.env.ADMIN_PIN) {
          throw new HttpError(401, 'Admin PIN required');
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let body = {};
        if (['POST', 'PUT'].includes(req.method)) {
          try { body = await readBody(req); } catch { throw new HttpError(400, 'Invalid JSON'); }
        }
        const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'route'));
        const db = await store.getDb();
        const ctx = {
          db, params, body, query, store,
          save: () => store.saveDb(ctx.db),
          view: (event) => eventView(store, ctx.db, event),
        };
        return send(200, await r.handler(ctx));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!e.status) console.error(e);
      send(e.status || 500, { error: e.message });
    }
  };
}
