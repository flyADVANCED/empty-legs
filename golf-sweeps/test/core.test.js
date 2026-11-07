import test from 'node:test';
import assert from 'node:assert/strict';
import { courseHandicap, playingHandicap, strokesOnHole, parseHandicapIndex, formatHandicap, stablefordPoints } from '../lib/handicap.js';
import { assignTiers, drawTeams, TIERS } from '../lib/teams.js';
import { scoreGame, scoreEvent, rankRows, applyPayouts, scrambleHandicap } from '../lib/games.js';
import { lookupGolfer, _resetGhinCache } from '../lib/ghin.js';

const pars = [4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4];
const sis = [7, 11, 17, 1, 13, 5, 15, 3, 9, 8, 18, 4, 14, 2, 12, 16, 10, 6];
const course = { holes: pars.map((par, i) => ({ par, si: sis[i] })) };

// Seeded RNG for reproducible draws.
const rng = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('handicap parsing and formatting', () => {
  assert.equal(parseHandicapIndex('+1.2'), -1.2);
  assert.equal(parseHandicapIndex('12.4'), 12.4);
  assert.equal(parseHandicapIndex('NH'), null);
  assert.equal(formatHandicap(-1.2), '+1.2');
  assert.equal(formatHandicap(8), '8.0');
});

test('course and playing handicap (WHS)', () => {
  // 10.0 × 131/113 + (72.4 − 72) = 11.99 → 12
  assert.equal(courseHandicap(10, { slope: 131, rating: 72.4, par: 72 }), 12);
  assert.equal(playingHandicap(12, 85), 10);
  assert.equal(courseHandicap(-2, { slope: 113, rating: 72, par: 72 }), -2);
});

test('strokes per hole, including plus handicaps and > 18', () => {
  assert.equal(strokesOnHole(5, 5), 1);
  assert.equal(strokesOnHole(5, 6), 0);
  assert.equal(strokesOnHole(20, 1), 2);
  assert.equal(strokesOnHole(20, 3), 1);
  assert.equal(strokesOnHole(-2, 18), -1);
  assert.equal(strokesOnHole(-2, 17), -1);
  assert.equal(strokesOnHole(-2, 16), 0);
  const total = (h) => Array.from({ length: 18 }, (_, i) => strokesOnHole(h, i + 1)).reduce((a, b) => a + b);
  for (const h of [-3, 0, 7, 18, 25, 36]) assert.equal(total(h), h);
});

test('stableford points', () => {
  assert.equal(stablefordPoints(4, 4), 2);
  assert.equal(stablefordPoints(3, 4), 3);
  assert.equal(stablefordPoints(7, 4), 0);
});

const field = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, hcp: i * 1.3 + (i % 3) }));

test('tiers are A best → D worst', () => {
  const { teamCount, tiers } = assignTiers(field(16));
  assert.equal(teamCount, 4);
  for (const t of TIERS) assert.equal(tiers[t].length, 4);
  assert.ok(Math.max(...tiers.A.map((p) => p.hcp)) <= Math.min(...tiers.B.map((p) => p.hcp)));
  assert.ok(Math.max(...tiers.C.map((p) => p.hcp)) <= Math.min(...tiers.D.map((p) => p.hcp)));
});

test('balanced draw: one of each letter per team and tight totals', () => {
  const players = field(24);
  const teams = drawTeams(players, { mode: 'balanced' });
  assert.equal(teams.length, 6);
  const { tiers } = assignTiers(players);
  for (const tm of teams) {
    for (const t of TIERS) assert.ok(tiers[t].some((p) => p.id === tm.members[t]), `team ${tm.id} ${t}`);
  }
  const used = teams.flatMap((t) => Object.values(t.members));
  assert.equal(new Set(used).size, 24);
  const totals = teams.map((t) => t.total);
  const range = Math.max(...totals) - Math.min(...totals);
  const random = drawTeams(players, { mode: 'random', rng: rng(7) }).map((t) => t.total);
  assert.ok(range <= Math.max(...random) - Math.min(...random));
  assert.ok(range < 3, `range ${range}`);
});

test('odd field: short teams get a blind-draw D player', () => {
  const teams = drawTeams(field(18), { rng: rng(3) });
  assert.equal(teams.length, 5);
  const short = teams.filter((t) => !t.members.D);
  assert.equal(short.length, 2);
  for (const t of short) assert.ok(t.blind?.playerId);
});

function eventWith(scoresFn, extra = {}) {
  const players = field(8).map((p) => ({ playerId: p.id, name: p.name, courseHcp: Math.round(p.hcp), playingHcp: Math.round(p.hcp) }));
  const teams = [
    { id: 1, name: 'Team 1', members: { A: 'p0', B: 'p3', C: 'p4', D: 'p7' } },
    { id: 2, name: 'Team 2', members: { A: 'p1', B: 'p2', C: 'p5', D: 'p6' } },
  ];
  teams.forEach((t) => TIERS.forEach((tier) => (players.find((p) => p.playerId === t.members[tier]).tier = tier)));
  const scores = Object.fromEntries(players.map((p) => [p.playerId, pars.map((par, h) => scoresFn(p, par, h))]));
  return { entryFee: 20, players, teams, scores, teamScores: {}, ...extra };
}

test('best ball and 1-2-3 scoring (gross)', () => {
  // Everyone pars every hole except p0 birdies hole 1.
  const ev = eventWith((p, par, h) => (p.playerId === 'p0' && h === 0 ? par - 1 : par));
  const best1 = scoreGame({ type: 'best1', scoring: 'gross', potPct: 100, payouts: [100] }, ev, course);
  assert.equal(best1.rows[0].teamId, 1);
  assert.equal(best1.rows[0].toPar, -1);
  assert.equal(best1.rows[0].payout, 160);
  assert.equal(best1.rows[0].perPlayer, 40);
  const c123 = scoreGame({ type: '123', scoring: 'gross', potPct: 100 }, ev, course);
  const t2 = c123.rows.find((r) => r.teamId === 2);
  assert.equal(t2.toPar, 0);
  assert.equal(t2.total, pars.reduce((s, par, h) => s + par * ((h % 3) + 1), 0));
});

test('holes only count when the whole lineup has posted', () => {
  const ev = eventWith((p, par, h) => (h < 3 ? par : null));
  delete ev.scores.p7[2];
  ev.scores.p7[2] = null;
  const g = scoreGame({ type: 'best2', scoring: 'gross', potPct: 100 }, ev, course);
  assert.equal(g.rows.find((r) => r.teamId === 1).thru, 2);
  assert.equal(g.rows.find((r) => r.teamId === 2).thru, 3);
});

test('stableford: higher points win', () => {
  const ev = eventWith((p, par) => (p.playerId === 'p1' ? par - 1 : par + 1));
  const g = scoreGame({ type: 'stableford2', scoring: 'gross', potPct: 100 }, ev, course);
  assert.equal(g.rows[0].teamId, 2);
  assert.equal(g.rows[0].total, 18 * (3 + 1));
});

test('net scoring applies strokes by stroke index', () => {
  const ev = eventWith((p, par) => par);
  const flights = scoreGame({ type: 'flights', scoring: 'net', potPct: 100, payouts: [100] }, ev, course);
  const d = flights.flights.find((f) => f.tier === 'D');
  assert.equal(d.rows[0].playerId, 'p7'); // higher handicap, same gross → better net
  assert.equal(d.rows[0].payout, 40); // 160 pot / 4 flights
});

test('scramble team handicap = 25/20/15/10', () => {
  const ev = eventWith(() => null);
  const t = ev.teams[0];
  const h = (id) => ev.players.find((p) => p.playerId === id).courseHcp;
  assert.equal(scrambleHandicap(t, ev), Math.round(0.25 * h('p0') + 0.2 * h('p3') + 0.15 * h('p4') + 0.1 * h('p7')));
  ev.teamScores = { 1: pars.map((p) => p - 1), 2: pars };
  const g = scoreGame({ type: 'scramble', scoring: 'gross', potPct: 100 }, ev, course);
  assert.equal(g.rows[0].teamId, 1);
  assert.equal(g.rows[0].toPar, -18);
});

test('skins: unique low wins, ties wash, optional carryover', () => {
  const ev = eventWith((p, par, h) => (h === 0 && p.playerId === 'p2' ? par - 1 : h === 2 && ['p1', 'p4'].includes(p.playerId) ? par - 1 : h === 3 && p.playerId === 'p5' ? par - 1 : par));
  const g = scoreGame({ type: 'skins', scoring: 'gross', potPct: 50 }, ev, course);
  assert.equal(g.totalSkins, 2);
  assert.equal(g.perSkin, 40);
  const c = scoreGame({ type: 'skins', scoring: 'gross', potPct: 50, carryover: true }, ev, course);
  // hole 2 wash carries to... hole 1 won (1), hole 2 par wash carries, hole 3 tie carries, hole 4 won worth 3
  assert.deepEqual(c.winners.map((w) => [w.playerId, w.skins]), [['p5', 3], ['p2', 1]]);
});

test('card-off tiebreak and split payouts', () => {
  const holesA = Array(18).fill(4); holesA[17] = 3; holesA[0] = 5;
  const holesB = Array(18).fill(4);
  const rows = [{ id: 'b', score: 0, holes: holesB }, { id: 'a', score: 0, holes: holesA }];
  const ranked = rankRows(rows);
  assert.equal(ranked[0].id, 'a');
  const split = applyPayouts(rankRows(rows, { tiebreak: 'split' }), 100, [60, 40]);
  assert.deepEqual(split.map((r) => r.payout), [50, 50]);
});

test('scoreEvent totals per-player winnings', () => {
  const ev = eventWith((p, par, h) => (p.playerId === 'p0' && h === 0 ? par - 1 : par), {
    games: [{ id: 'g1', type: 'best1', scoring: 'gross', potPct: 100, payouts: [100] }],
  });
  const res = scoreEvent(ev, course);
  assert.equal(res.totalPot, 160);
  assert.deepEqual(res.winnings.map((w) => w.amount), [40, 40, 40, 40]);
});

test('GHIN client logs in then searches by GHIN number', async () => {
  process.env.GHIN_USERNAME = 'u';
  process.env.GHIN_PASSWORD = 'p';
  _resetGhinCache();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts]);
    const body = url.includes('golfer_login')
      ? { golfer_user: { golfer_user_token: 'tok' } }
      : { golfers: [{ ghin: 1234567, first_name: 'Pat', last_name: 'Smith', handicap_index: '+1.4', low_hi: '0.2', rev_date: '2026-11-01' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const g = await lookupGolfer('1234567', { fetchImpl });
  assert.equal(g.handicapIndex, -1.4);
  assert.equal(g.lastName, 'Smith');
  assert.match(calls[1][0], /golfer_id=1234567/);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer tok');
});
