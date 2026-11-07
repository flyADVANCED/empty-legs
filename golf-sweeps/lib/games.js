// Game formats, scoring, leaderboards and payouts.

import { netScore, stablefordPoints, strokesOnHole } from './handicap.js';
import { TIERS } from './teams.js';

const H = 18;

/**
 * Every game type the app knows how to score.
 *  kind 'count'      — team counts N balls per hole (N may vary by hole)
 *  kind 'stableford' — team counts the N best Stableford point scores per hole
 *  kind 'scramble'   — one team score per hole, team handicap 25/20/15/10 of A/B/C/D
 *  kind 'flights'    — individual stroke play, paid separately in A/B/C/D flights
 *  kind 'skins'      — individual skins across the whole field
 */
export const GAME_TYPES = {
  best1: { name: '1 Best Ball', kind: 'count', balls: () => 1, allowance: 85,
    description: 'Lowest score on the team counts on every hole.' },
  best2: { name: '2 Best Balls', kind: 'count', balls: () => 2, allowance: 90,
    description: 'Two lowest scores on the team count on every hole.' },
  best3: { name: '3 Best Balls', kind: 'count', balls: () => 3, allowance: 95,
    description: 'Three lowest scores count on every hole.' },
  all4: { name: 'All 4 Count', kind: 'count', balls: () => 4, allowance: 100,
    description: 'Every player’s score counts on every hole.' },
  '123': { name: '1-2-3 (Cha-Cha-Cha)', kind: 'count', balls: (h) => (h % 3) + 1, allowance: 90,
    description: '1 ball counts on hole 1, 2 on hole 2, 3 on hole 3, then repeat.' },
  '321': { name: '3-2-1', kind: 'count', balls: (h) => 3 - (h % 3), allowance: 90,
    description: '3 balls count on hole 1, 2 on hole 2, 1 on hole 3, then repeat.' },
  byPar: { name: 'Par Ladder (5s-1, 4s-2, 3s-3)', kind: 'count', balls: (h, par) => (par >= 5 ? 1 : par === 4 ? 2 : 3), allowance: 90,
    description: '1 ball counts on par 5s, 2 on par 4s, 3 on par 3s.' },
  stableford2: { name: 'Stableford – Best 2', kind: 'stableford', balls: () => 2, allowance: 90,
    description: 'Best two Stableford point scores per hole (par = 2, birdie = 3, bogey = 1). Most points wins.' },
  stablefordAll: { name: 'Stableford – All 4', kind: 'stableford', balls: () => 4, allowance: 100,
    description: 'All four players’ Stableford points count. Most points wins.' },
  scramble: { name: '4-Man Scramble', kind: 'scramble', allowance: 100,
    description: 'One team score per hole. Team handicap = 25% A + 20% B + 15% C + 10% D (USGA recommendation).' },
  flights: { name: 'Individual Flights (A/B/C/D)', kind: 'flights', allowance: 100,
    description: 'Individual stroke play; prizes paid separately in each A, B, C and D flight.' },
  skins: { name: 'Skins', kind: 'skins', allowance: 100,
    description: 'Lowest unique score on a hole wins a skin. Pot split by skins won.' },
};

export const SCRAMBLE_PCT = { A: 0.25, B: 0.2, C: 0.15, D: 0.1 };

const sum = (a) => a.reduce((s, x) => s + x, 0);

/** Players whose scores count for a team (members plus any blind draw). */
export function teamLineup(team) {
  const list = TIERS.filter((t) => team.members[t] != null).map((t) => ({ tier: t, playerId: team.members[t], blind: false }));
  if (team.blind?.playerId != null && team.members[team.blind.tier] == null) {
    list.push({ tier: team.blind.tier, playerId: team.blind.playerId, blind: true });
  }
  return list;
}

/** Per-player hole scores (gross or net) for the event. */
function playerHoleScores(event, course, playerId, net) {
  const raw = event.scores?.[playerId] ?? [];
  const ep = event.players.find((p) => p.playerId === playerId);
  const hcp = ep?.playingHcp ?? 0;
  return course.holes.map((hole, h) => {
    const g = raw[h];
    if (g === null || g === undefined || g === '') return null;
    return net ? netScore(g, hcp, hole.si) : Number(g);
  });
}

/** Lower-is-better card-off: back 9, back 6, back 3, 18th hole. */
function cardoffKey(holeValues, higherBetter) {
  const seg = (from) => sum(holeValues.slice(from).map((v) => v ?? 0));
  const key = [seg(9), seg(12), seg(15), seg(17)];
  return higherBetter ? key.map((x) => -x) : key;
}

/**
 * Rank rows {score, holes, thru}. Lower score wins unless higherBetter.
 * Ties are broken by card-off when tiebreak === 'cardoff'; rows still tied
 * share a position.
 */
export function rankRows(rows, { higherBetter = false, tiebreak = 'cardoff' } = {}) {
  const dir = higherBetter ? -1 : 1;
  const keyed = rows.map((r) => ({ ...r, _key: [dir * r.score, ...(tiebreak === 'cardoff' ? cardoffKey(r.holes, higherBetter) : [])] }));
  const cmp = (a, b) => {
    for (let i = 0; i < a._key.length; i++) if (a._key[i] !== b._key[i]) return a._key[i] - b._key[i];
    return 0;
  };
  keyed.sort(cmp);
  let pos = 0;
  keyed.forEach((r, i) => {
    if (i === 0 || cmp(keyed[i - 1], r) !== 0) pos = i + 1;
    r.position = pos;
    r.tied = keyed.some((o) => o !== r && cmp(o, r) === 0);
  });
  keyed.forEach((r) => delete r._key);
  return keyed;
}

/** Attach payouts to ranked rows. Tied rows split the places they occupy. */
export function applyPayouts(ranked, pot, payoutPcts) {
  const byPos = new Map();
  ranked.forEach((r) => {
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position).push(r);
  });
  for (const [pos, group] of byPos) {
    const pct = sum(group.map((_, i) => payoutPcts[pos - 1 + i] ?? 0));
    const each = (pot * pct) / 100 / group.length;
    group.forEach((r) => (r.payout = Math.round(each * 100) / 100));
  }
  return ranked;
}

function scoreCountGame(game, def, event, course) {
  const net = game.scoring !== 'gross';
  const stableford = def.kind === 'stableford';
  return event.teams.map((team) => {
    const lineup = teamLineup(team);
    const cards = lineup.map((m) => playerHoleScores(event, course, m.playerId, net));
    const holes = course.holes.map((hole, h) => {
      const n = def.balls(h, hole.par);
      // A hole counts once every player in the lineup has a score posted.
      if (cards.some((c) => c[h] === null)) return null;
      let vals = cards.map((c) => c[h]);
      if (stableford) vals = vals.map((v) => stablefordPoints(v, hole.par)).sort((a, b) => b - a);
      else vals.sort((a, b) => a - b);
      return sum(vals.slice(0, n));
    });
    const thru = holes.filter((v) => v !== null).length;
    const parFor = sum(course.holes.map((hole, h) => (holes[h] === null ? 0 : def.balls(h, hole.par) * hole.par)));
    const total = sum(holes.filter((v) => v !== null));
    return {
      teamId: team.id, name: team.name, holes, thru, total,
      toPar: stableford ? null : total - parFor,
      score: stableford ? total : total - parFor,
    };
  });
}

export function scrambleHandicap(team, event) {
  const hcpOf = (id) => event.players.find((p) => p.playerId === id)?.courseHcp ?? 0;
  const lineup = teamLineup(team);
  return Math.round(sum(lineup.map((m) => SCRAMBLE_PCT[m.tier] * hcpOf(m.playerId))));
}

function scoreScramble(game, event, course) {
  const net = game.scoring !== 'gross';
  return event.teams.map((team) => {
    const teamHcp = net ? scrambleHandicap(team, event) : 0;
    const raw = event.teamScores?.[team.id] ?? [];
    const holes = course.holes.map((hole, h) => {
      const g = raw[h];
      if (g === null || g === undefined || g === '') return null;
      return Number(g) - strokesOnHole(teamHcp, hole.si);
    });
    const thru = holes.filter((v) => v !== null).length;
    const total = sum(holes.filter((v) => v !== null));
    const parFor = sum(course.holes.map((hole, h) => (holes[h] === null ? 0 : hole.par)));
    return { teamId: team.id, name: team.name, teamHcp, holes, thru, total, toPar: total - parFor, score: total - parFor };
  });
}

function playerRow(event, course, ep, net) {
  const holes = playerHoleScores(event, course, ep.playerId, net);
  const thru = holes.filter((v) => v !== null).length;
  const total = sum(holes.filter((v) => v !== null));
  const parFor = sum(course.holes.map((hole, h) => (holes[h] === null ? 0 : hole.par)));
  return { playerId: ep.playerId, name: ep.name, tier: ep.tier, holes, thru, total, toPar: total - parFor, score: total - parFor };
}

function scoreSkins(game, event, course, pot) {
  const net = game.scoring !== 'gross';
  const rows = event.players.map((ep) => playerRow(event, course, ep, net));
  const holes = course.holes.map((hole, h) => {
    const entries = rows.filter((r) => r.holes[h] !== null).map((r) => ({ playerId: r.playerId, name: r.name, score: r.holes[h] }));
    if (!entries.length) return { hole: h + 1, winner: null, score: null };
    const low = Math.min(...entries.map((e) => e.score));
    const lows = entries.filter((e) => e.score === low);
    return { hole: h + 1, winner: lows.length === 1 ? lows[0] : null, score: low, tiedCount: lows.length > 1 ? lows.length : 0 };
  });
  // Optional carryovers: an unwon hole's skin rolls to the next hole.
  let carry = 0;
  const won = new Map();
  for (const hs of holes) {
    const value = 1 + carry;
    if (hs.winner) {
      hs.value = value;
      won.set(hs.winner.playerId, (won.get(hs.winner.playerId) ?? 0) + value);
      carry = 0;
    } else if (game.carryover && hs.score !== null) {
      carry = value;
    }
  }
  const totalSkins = sum([...won.values()]);
  const perSkin = totalSkins ? pot / totalSkins : 0;
  const winners = [...won.entries()].map(([playerId, skins]) => ({
    playerId, name: event.players.find((p) => p.playerId === playerId)?.name, skins,
    payout: Math.round(perSkin * skins * 100) / 100,
  })).sort((a, b) => b.skins - a.skins);
  return { holes, winners, perSkin: Math.round(perSkin * 100) / 100, totalSkins };
}

/** Score one configured game. Returns a leaderboard object for the UI. */
export function scoreGame(game, event, course) {
  const def = GAME_TYPES[game.type];
  if (!def) throw new Error(`Unknown game type: ${game.type}`);
  const totalPot = (Number(event.entryFee) || 0) * event.players.length;
  const pot = Math.round(totalPot * ((Number(game.potPct) || 0) / 100) * 100) / 100;
  const payouts = game.payouts?.length ? game.payouts : [50, 30, 20];
  const tiebreak = game.tiebreak ?? 'cardoff';
  const base = { gameId: game.id, type: game.type, name: game.label || def.name, kind: def.kind, scoring: game.scoring ?? 'net', pot };

  if (def.kind === 'skins') return { ...base, ...scoreSkins(game, event, course, pot) };

  if (def.kind === 'flights') {
    const flightPot = pot / TIERS.length;
    const flights = TIERS.map((tier) => {
      const rows = event.players.filter((p) => p.tier === tier).map((ep) => playerRow(event, course, ep, game.scoring !== 'gross')).filter((r) => r.thru > 0);
      const ranked = applyPayouts(rankRows(rows, { tiebreak }), flightPot, payouts);
      return { tier, rows: ranked };
    });
    return { ...base, flights };
  }

  const higherBetter = def.kind === 'stableford';
  const rows = (def.kind === 'scramble' ? scoreScramble(game, event, course) : scoreCountGame(game, def, event, course)).filter((r) => r.thru > 0);
  const ranked = applyPayouts(rankRows(rows, { higherBetter, tiebreak }), pot, payouts);
  for (const r of ranked) {
    const team = event.teams.find((t) => t.id === r.teamId);
    const realMembers = TIERS.filter((t) => team.members[t] != null).length || 1;
    r.perPlayer = Math.round((r.payout / realMembers) * 100) / 100;
  }
  return { ...base, higherBetter, rows: ranked };
}

/** Score every game in the event, plus a per-player money summary. */
export function scoreEvent(event, course) {
  const games = (event.games ?? []).map((g) => scoreGame(g, event, course));
  const money = new Map(event.players.map((p) => [p.playerId, 0]));
  const add = (id, amt) => money.set(id, Math.round(((money.get(id) ?? 0) + amt) * 100) / 100);
  for (const g of games) {
    if (g.kind === 'skins') g.winners.forEach((w) => add(w.playerId, w.payout));
    else if (g.kind === 'flights') g.flights.forEach((f) => f.rows.forEach((r) => add(r.playerId, r.payout)));
    else g.rows.forEach((r) => {
      const team = event.teams.find((t) => t.id === r.teamId);
      TIERS.forEach((t) => team.members[t] != null && add(team.members[t], r.perPlayer));
    });
  }
  const winnings = event.players
    .map((p) => ({ playerId: p.playerId, name: p.name, tier: p.tier, amount: money.get(p.playerId) ?? 0 }))
    .filter((w) => w.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  return { games, winnings, totalPot: (Number(event.entryFee) || 0) * event.players.length };
}
