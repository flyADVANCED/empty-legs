// A/B/C/D tiering and balanced 4-player team building.

export const TIERS = ['A', 'B', 'C', 'D'];

/**
 * Split players into A/B/C/D tiers by handicap (best → worst).
 * players: [{ id, hcp }]  — hcp is the number used for ranking (playing
 * handicap for the day). Returns { teamCount, tiers: { A: [...], ... } }.
 *
 * Number of teams = ceil(n / 4). A, B and C are filled with one player per
 * team first; D gets whatever is left. If the field isn't a multiple of 4,
 * the short teams get a "blind draw" D player (see drawTeams).
 */
export function assignTiers(players) {
  const sorted = [...players].sort((a, b) => a.hcp - b.hcp || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
  const teamCount = Math.max(1, Math.ceil(sorted.length / 4));
  const tiers = { A: [], B: [], C: [], D: [] };
  sorted.forEach((p, i) => {
    const t = TIERS[Math.min(3, Math.floor(i / teamCount))];
    tiers[t].push(p);
  });
  return { teamCount, tiers };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Strength of a team for balancing: sum of handicaps, blind counted. */
export function teamTotal(team, hcpOf) {
  let total = 0;
  for (const t of TIERS) {
    const id = team.members[t] ?? team.blind?.playerId;
    if (team.members[t] != null) total += hcpOf(team.members[t]);
    else if (t === 'D' && id != null) total += hcpOf(id);
  }
  return total;
}

function spread(totals) {
  const mean = totals.reduce((s, x) => s + x, 0) / totals.length;
  return totals.reduce((s, x) => s + (x - mean) ** 2, 0);
}

/**
 * Build teams with exactly one A, B, C and (where available) D player.
 *
 * mode 'balanced' (default): snake-seed the tiers, then repeatedly swap
 *   players of the same tier between teams while it makes team handicap
 *   totals closer together. Every team keeps one player of each letter.
 * mode 'random': classic blind draw — one random player from each tier.
 *
 * Teams short a D player are given a blind draw: a random D player from
 * another team whose scores also count for the short team.
 */
export function drawTeams(players, { mode = 'balanced', rng = Math.random } = {}) {
  const { teamCount, tiers } = assignTiers(players);
  const hcp = new Map(players.map((p) => [p.id, p.hcp]));
  const hcpOf = (id) => hcp.get(id) ?? 0;

  // order[t][k] = player id in tier t on team k (or undefined)
  const order = {};
  TIERS.forEach((t, ti) => {
    let ids = tiers[t].map((p) => p.id);
    if (mode === 'random') ids = shuffle(ids, rng);
    else if (ti % 2 === 1) ids = ids.reverse(); // snake: B and D go worst→best
    const slots = new Array(teamCount).fill(undefined);
    if (mode === 'random' || ids.length === teamCount) {
      ids.forEach((id, k) => (slots[k] = id));
    } else {
      // Short tier (only D can be short): give D players to the teams with
      // the lowest totals so far, i.e. the strongest teams.
      const partial = slots.map((_, k) => TIERS.slice(0, ti).reduce((s, tt) => s + hcpOf(order[tt][k]), 0));
      const teamsByStrength = [...partial.keys()].sort((a, b) => partial[a] - partial[b]);
      const worstFirst = [...tiers[t]].sort((a, b) => b.hcp - a.hcp).map((p) => p.id);
      worstFirst.forEach((id, i) => (slots[teamsByStrength[i]] = id));
    }
    order[t] = slots;
  });

  const dIds = tiers.D.map((p) => p.id);
  const avgD = dIds.length ? dIds.reduce((s, id) => s + hcpOf(id), 0) / dIds.length : 0;
  const totalAt = (k) => TIERS.reduce((s, t) => s + (order[t][k] === undefined ? (t === 'D' ? avgD : 0) : hcpOf(order[t][k])), 0);

  if (mode === 'balanced' && teamCount > 1) {
    // Pairwise swap hill-climb within each tier.
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 1000) {
      improved = false;
      for (const t of TIERS) {
        for (let i = 0; i < teamCount; i++) {
          for (let j = i + 1; j < teamCount; j++) {
            const before = spread([...Array(teamCount).keys()].map(totalAt));
            [order[t][i], order[t][j]] = [order[t][j], order[t][i]];
            const after = spread([...Array(teamCount).keys()].map(totalAt));
            if (after + 1e-9 < before) improved = true;
            else [order[t][i], order[t][j]] = [order[t][j], order[t][i]];
          }
        }
      }
    }
  }

  const teams = [...Array(teamCount).keys()].map((k) => {
    const members = {};
    TIERS.forEach((t) => {
      if (order[t][k] !== undefined) members[t] = order[t][k];
    });
    return { id: k + 1, name: `Team ${k + 1}`, members };
  });

  // Blind draws for teams missing a D player.
  const shortTeams = teams.filter((tm) => tm.members.D === undefined && Object.keys(tm.members).length > 0);
  if (shortTeams.length && dIds.length) {
    let pool = shuffle(dIds, rng);
    for (const tm of shortTeams) {
      if (!pool.length) pool = shuffle(dIds, rng);
      tm.blind = { tier: 'D', playerId: pool.pop() };
    }
  }

  return teams.map((tm) => ({ ...tm, total: teamTotal(tm, hcpOf) }));
}
