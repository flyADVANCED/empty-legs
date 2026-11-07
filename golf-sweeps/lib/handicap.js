// Handicap math (World Handicap System).
//
// Handicap Index values are stored as numbers where a "plus" handicap is
// negative (GHIN shows "+1.2", we store -1.2).

/** Parse a handicap index as GHIN displays it ("12.4", "+1.2", "NH"). */
export function parseHandicapIndex(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().toUpperCase();
  if (!s || s === 'NH' || s === 'WD' || s === 'R') return null;
  const plus = s.startsWith('+');
  const n = parseFloat(s.replace(/^[+]/, '').replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return plus ? -n : n;
}

/** Format a stored index the way golfers expect ("+1.2", "12.4"). */
export function formatHandicap(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'NH';
  if (value < 0) return '+' + Math.abs(value).toFixed(digits);
  return value.toFixed(digits);
}

/**
 * WHS Course Handicap = Index × (Slope / 113) + (Course Rating − Par), rounded.
 * tee: { slope, rating, par }  (par = total par for the 18 holes)
 */
export function courseHandicap(index, tee) {
  if (index === null || index === undefined) return null;
  const slope = Number(tee?.slope) || 113;
  const rating = Number(tee?.rating);
  const par = Number(tee?.par);
  const adj = Number.isFinite(rating) && Number.isFinite(par) ? rating - par : 0;
  return Math.round(index * (slope / 113) + adj);
}

/** Playing Handicap = Course Handicap × allowance (e.g. 0.85 for 4-ball). */
export function playingHandicap(courseHcp, allowancePct = 100) {
  if (courseHcp === null || courseHcp === undefined) return null;
  return Math.round(courseHcp * (allowancePct / 100));
}

/**
 * Strokes received on a hole given a playing handicap and the hole's stroke
 * index (1 = hardest). Plus handicaps give strokes back starting on the
 * easiest hole (stroke index 18).
 */
export function strokesOnHole(hcp, strokeIndex, holes = 18) {
  if (!hcp) return 0;
  if (hcp > 0) {
    const base = Math.floor(hcp / holes);
    return base + (strokeIndex <= hcp % holes ? 1 : 0);
  }
  const p = -hcp;
  const base = Math.floor(p / holes);
  const back = base + (strokeIndex > holes - (p % holes) ? 1 : 0);
  return back ? -back : 0;
}

/** Net score for a hole (null when no gross score entered). */
export function netScore(gross, hcp, strokeIndex) {
  if (gross === null || gross === undefined || gross === '') return null;
  return Number(gross) - strokesOnHole(hcp, strokeIndex);
}

/** Stableford points from a (net) score and the hole par. */
export function stablefordPoints(score, par) {
  if (score === null || score === undefined) return null;
  return Math.max(0, 2 + par - score);
}
