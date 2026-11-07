// GHIN handicap lookup.
//
// USGA does not publish an open GHIN API; access for software is licensed
// through the USGA / your state golf association. This client talks to the
// same endpoints the GHIN mobile app uses (api2.ghin.com), authenticating
// with a GHIN member login stored in environment variables on the server:
//
//   GHIN_USERNAME   GHIN number or email of the account used for lookups
//   GHIN_PASSWORD   that account's password
//   GHIN_API_BASE   optional, defaults to https://api2.ghin.com/api/v1
//
// Credentials never reach the browser. If your club gets official API access
// from its golf association, only this file needs to change.

import { parseHandicapIndex } from './handicap.js';

const BASE = process.env.GHIN_API_BASE || 'https://api2.ghin.com/api/v1';

let cached = { token: null, expires: 0 };

export function ghinConfigured() {
  return Boolean(process.env.GHIN_USERNAME && process.env.GHIN_PASSWORD);
}

async function request(path, { method = 'GET', body, token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.errors ? JSON.stringify(data.errors) : data?.error || res.statusText;
    const err = new Error(`GHIN ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function login(fetchImpl) {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  if (!ghinConfigured()) throw new Error('GHIN is not configured: set GHIN_USERNAME and GHIN_PASSWORD on the server.');
  const data = await request('/golfer_login.json', {
    method: 'POST',
    fetchImpl,
    body: {
      user: { email_or_ghin: process.env.GHIN_USERNAME, password: process.env.GHIN_PASSWORD, remember_me: true },
      token: 'golf-sweeps',
    },
  });
  const token = data?.golfer_user?.golfer_user_token;
  if (!token) throw new Error('GHIN login succeeded but returned no token.');
  cached = { token, expires: Date.now() + 1000 * 60 * 60 * 6 };
  return token;
}

function normalize(g) {
  return {
    ghin: String(g.ghin ?? g.ghin_number ?? g.id ?? ''),
    firstName: g.first_name ?? '',
    lastName: g.last_name ?? '',
    handicapIndex: parseHandicapIndex(g.handicap_index ?? g.hi_display ?? g.hi_value),
    handicapDisplay: g.handicap_index ?? g.hi_display ?? null,
    lowIndex: parseHandicapIndex(g.low_hi ?? g.low_hi_display),
    revisionDate: g.rev_date ?? g.revision_date ?? null,
    club: g.club_name ?? null,
    state: g.state ?? null,
    status: g.status ?? null,
  };
}

async function search(params, fetchImpl) {
  const qs = new URLSearchParams({ per_page: '25', page: '1', status: 'Active', ...params });
  const call = async (retry) => {
    const token = await login(fetchImpl);
    try {
      return await request(`/golfers/search.json?${qs}`, { token, fetchImpl });
    } catch (e) {
      if (retry && (e.status === 401 || e.status === 403)) {
        cached = { token: null, expires: 0 };
        return call(false);
      }
      throw e;
    }
  };
  const data = await call(true);
  return (data.golfers ?? []).map(normalize);
}

/** Look up one golfer by GHIN number. Returns null when not found. */
export async function lookupGolfer(ghinNumber, { fetchImpl } = {}) {
  const res = await search({ golfer_id: String(ghinNumber).trim() }, fetchImpl);
  return res.find((g) => g.ghin === String(ghinNumber).trim()) ?? res[0] ?? null;
}

/** Search golfers by last name (and optional first name / state). */
export async function searchGolfers({ lastName, firstName, state }, { fetchImpl } = {}) {
  const params = { last_name: lastName };
  if (firstName) params.first_name = firstName;
  if (state) params.state = state;
  return search(params, fetchImpl);
}

/** Test hook. */
export function _resetGhinCache() {
  cached = { token: null, expires: 0 };
}
