import { formatHandicap, strokesOnHole } from '/lib/handicap.js';

const app = document.getElementById('app');
const TIERS = ['A', 'B', 'C', 'D'];
let S = null; // /api/state
let pin = safeGet('adminPin') || '';
let swapPick = null;

// ---------- utilities ----------

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n ? `$${Number(n).toFixed(2).replace(/\.00$/, '')}` : '—');
const toPar = (n) => (n === null || n === undefined ? '' : n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);
const tierBadge = (t, blind) => `<span class="tier ${t}${blind ? ' blind' : ''}" title="${blind ? 'Blind draw' : `${t} player`}">${t}</span>`;
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : null);

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${error ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), error ? 4500 : 2200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S?.pinRequired) {
    await askPin();
    if (pin) return api(method, path, body);
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function askPin() {
  const p = prompt('Admin PIN');
  if (p === null) return;
  pin = p;
  try {
    await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) }).then((r) => { if (!r.ok) throw new Error(); });
    safeSet('adminPin', pin);
    toast('Unlocked');
  } catch {
    pin = '';
    toast('Wrong PIN', true);
  }
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

async function loadState() { S = await api('GET', '/api/state'); }

// ---------- router ----------

async function render() {
  const [, page, id, sub] = location.hash.replace(/^#/, '').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page === 'event' ? 'events' : page || 'events')));
  await loadState();
  const pinBtn = document.getElementById('pinBtn');
  pinBtn.hidden = !S.pinRequired;
  pinBtn.textContent = pin ? '🔓 Admin' : '🔒 Admin';
  if (page === 'players') return renderPlayers();
  if (page === 'courses') return renderCourses(id);
  if (page === 'event' && id) return renderEvent(id, sub || 'setup');
  return renderEvents();
}
window.addEventListener('hashchange', () => guard(render));
document.getElementById('pinBtn').onclick = () => askPin().then(render);

// ---------- events list ----------

function renderEvents() {
  app.innerHTML = `
    <div class="spread"><div><h1>Sweeps</h1><p class="muted">Create an event, pick who’s playing, draw balanced A/B/C/D teams, post scores.</p></div>
      <button id="newEvent">+ New sweeps</button></div>
    ${S.players.length ? '' : `<div class="card">Start by adding your members on the <a href="#/players">Players</a> page, and your scorecard on the <a href="#/courses">Course</a> page.</div>`}
    <div class="card table-wrap"><table>
      <thead><tr><th>Date</th><th>Event</th><th class="num">Players</th><th class="num">Teams</th><th>Status</th></tr></thead>
      <tbody>${S.events.map((e) => `<tr><td>${esc(e.date)}</td><td><a href="#/event/${e.id}">${esc(e.name)}</a></td><td class="num">${e.players}</td><td class="num">${e.teams || '—'}</td><td><span class="badge">${esc(e.status)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No events yet.</td></tr>'}</tbody>
    </table></div>`;
  document.getElementById('newEvent').onclick = () => guard(async () => {
    const e = await api('POST', '/api/events', {});
    location.hash = `#/event/${e.id}`;
  });
}

// ---------- players ----------

function renderPlayers() {
  const players = [...S.players].sort((a, b) => (a.lastName || a.name).localeCompare(b.lastName || b.name));
  app.innerHTML = `
    <div class="spread"><div><h1>Players</h1>
      <p class="muted">${players.length} players · GHIN sync ${S.ghinConfigured ? '<span class="badge">connected</span>' : '<span class="badge warn">not configured</span>'}</p></div>
      <div class="row"><button class="ghost" id="refreshAll" ${S.ghinConfigured ? '' : 'disabled'}>↻ Update all from GHIN</button></div></div>

    <div class="card">
      <h3>Add player</h3>
      <form id="addForm" class="row">
        <label>GHIN #<input name="ghin" inputmode="numeric" /></label>
        <label>First name<input name="firstName" /></label>
        <label>Last name<input name="lastName" /></label>
        <label>Handicap index<input name="handicapIndex" placeholder="e.g. 8.4 or +1.2" /></label>
        <button type="button" class="ghost" id="lookup" ${S.ghinConfigured ? '' : 'disabled'}>Look up GHIN</button>
        <button>Add</button>
      </form>
      <div id="lookupResults"></div>
    </div>

    <div class="card table-wrap"><table>
      <thead><tr><th>Name</th><th>GHIN #</th><th class="num">Index</th><th>Updated</th><th></th></tr></thead>
      <tbody>${players.map((p) => {
        const age = daysAgo(p.handicapUpdated);
        const stale = age === null || age > 14;
        return `<tr data-id="${p.id}">
          <td>${esc(p.name)}${p.active === false ? ' <span class="badge warn">inactive</span>' : ''}</td>
          <td>${esc(p.ghin) || '<span class="muted">—</span>'}</td>
          <td class="num"><strong>${formatHandicap(p.handicapIndex)}</strong></td>
          <td><span class="badge ${stale ? 'warn' : ''}">${p.handicapSource === 'ghin' ? 'GHIN' : 'manual'} · ${age === null ? 'never' : age === 0 ? 'today' : `${age}d ago`}</span></td>
          <td class="num">
            <button class="ghost small" data-act="ghin" ${S.ghinConfigured && p.ghin ? '' : 'disabled'}>↻ GHIN</button>
            <button class="ghost small" data-act="edit">Edit</button>
            <button class="danger small" data-act="del">✕</button>
          </td></tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">No players yet.</td></tr>'}</tbody>
    </table></div>

    <div class="card">
      <h3>Import roster (CSV)</h3>
      <p class="muted small">Columns: <code>first,last,ghin,index</code> (header optional). Existing GHIN numbers are updated, not duplicated.</p>
      <textarea id="csv" placeholder="first,last,ghin,index&#10;Pat,Smith,1234567,8.4"></textarea>
      <button id="importCsv">Import</button>
    </div>`;

  const form = document.getElementById('addForm');
  form.onsubmit = (ev) => guard(async () => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (!body.handicapIndex) delete body.handicapIndex;
    const p = await api('POST', '/api/players', body);
    if (p.ghin && S.ghinConfigured && !body.handicapIndex) await api('POST', `/api/players/${p.id}/ghin`).catch((e) => toast(e.message, true));
    toast(`Added ${p.name}`);
    render();
  });
  document.getElementById('lookup').onclick = () => guard(async () => {
    const f = Object.fromEntries(new FormData(form));
    const q = f.ghin ? `ghin=${encodeURIComponent(f.ghin)}` : `last=${encodeURIComponent(f.lastName)}&first=${encodeURIComponent(f.firstName)}`;
    if (!f.ghin && !f.lastName) return toast('Enter a GHIN # or last name', true);
    const { golfers } = await api('GET', `/api/ghin/search?${q}`);
    const box = document.getElementById('lookupResults');
    box.innerHTML = golfers.length ? `<div class="table-wrap"><table><tbody>${golfers.map((g, i) => `<tr><td>${esc(g.firstName)} ${esc(g.lastName)}</td><td>${esc(g.ghin)}</td><td>${esc(g.club ?? '')} ${esc(g.state ?? '')}</td><td class="num">${formatHandicap(g.handicapIndex)}</td><td><button class="small" data-pick="${i}">Use</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No golfers found.</p>';
    box.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
      const g = golfers[b.dataset.pick];
      form.ghin.value = g.ghin; form.firstName.value = g.firstName; form.lastName.value = g.lastName;
      form.handicapIndex.value = formatHandicap(g.handicapIndex);
      box.innerHTML = '';
    }));
  });
  document.getElementById('refreshAll').onclick = () => guard(async () => {
    toast('Updating from GHIN…');
    const { results } = await api('POST', '/api/ghin/refresh', {});
    const bad = results.filter((r) => !r.ok);
    toast(`Updated ${results.length - bad.length} of ${results.length}${bad.length ? ` — failed: ${bad.map((b) => b.name).join(', ')}` : ''}`, bad.length > 0);
    render();
  });
  document.getElementById('importCsv').onclick = () => guard(async () => {
    const r = await api('POST', '/api/players/import', { csv: document.getElementById('csv').value });
    toast(`Imported ${r.imported} rows (${r.added} new)`);
    render();
  });
  app.querySelectorAll('tr[data-id] button').forEach((b) => (b.onclick = () => guard(async () => {
    const id = b.closest('tr').dataset.id;
    const p = S.players.find((x) => x.id === id);
    if (b.dataset.act === 'del') {
      if (!confirm(`Delete ${p.name}?`)) return;
      await api('DELETE', `/api/players/${id}`);
    } else if (b.dataset.act === 'ghin') {
      const u = await api('POST', `/api/players/${id}/ghin`);
      toast(`${u.name}: ${formatHandicap(u.handicapIndex)}`);
    } else {
      const firstName = prompt('First name', p.firstName ?? ''); if (firstName === null) return;
      const lastName = prompt('Last name', p.lastName ?? ''); if (lastName === null) return;
      const ghin = prompt('GHIN #', p.ghin ?? ''); if (ghin === null) return;
      const idx = prompt('Handicap index (leave unchanged to keep GHIN value)', formatHandicap(p.handicapIndex)); if (idx === null) return;
      const body = { firstName, lastName, ghin };
      if (idx !== formatHandicap(p.handicapIndex)) body.handicapIndex = idx;
      await api('PUT', `/api/players/${id}`, body);
    }
    render();
  })));
}

// ---------- courses ----------

function renderCourses(id) {
  const course = S.courses.find((c) => c.id === id) ?? S.courses[0];
  if (!course) {
    app.innerHTML = `<h1>Course</h1><button id="addCourse">+ Add course</button>`;
  } else {
    const par = course.holes.reduce((s, h) => s + h.par, 0);
    app.innerHTML = `
      <div class="spread"><h1>Course</h1>
        <div class="row">${S.courses.length > 1 ? `<select id="pickCourse">${S.courses.map((c) => `<option value="${c.id}" ${c.id === course.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
        <button class="ghost" id="addCourse">+ Add course</button></div></div>
      <div class="card">
        <label>Course name<input id="cName" value="${esc(course.name)}" /></label>
        <h3>Tees</h3>
        <div id="tees">${course.tees.map((t) => teeRow(t)).join('')}</div>
        <button class="ghost small" id="addTee">+ Add tee</button>
        <h3>Scorecard <span class="muted small">(par ${par})</span></h3>
        <p class="muted small">Stroke index (handicap) — 1 is the hardest hole. Each number 1–18 used once.</p>
        <div class="table-wrap"><table class="scorecard"><tbody>
          <tr><th>Hole</th>${course.holes.map((_, i) => `<th>${i + 1}</th>`).join('')}</tr>
          <tr><td>Par</td>${course.holes.map((h, i) => `<td><input data-par="${i}" value="${h.par}" inputmode="numeric" /></td>`).join('')}</tr>
          <tr><td>S.I.</td>${course.holes.map((h, i) => `<td><input data-si="${i}" value="${h.si}" inputmode="numeric" /></td>`).join('')}</tr>
        </tbody></table></div>
        <div class="row" style="margin-top:1rem"><button id="saveCourse">Save course</button><button class="danger" id="delCourse">Delete</button></div>
      </div>`;
    document.getElementById('pickCourse')?.addEventListener('change', (e) => (location.hash = `#/courses/${e.target.value}`));
    document.getElementById('addTee').onclick = () => document.getElementById('tees').insertAdjacentHTML('beforeend', teeRow({ name: '', rating: '', slope: '' }));
    document.getElementById('tees').onclick = (e) => e.target.matches('[data-rm]') && e.target.closest('.row').remove();
    document.getElementById('saveCourse').onclick = () => guard(async () => {
      const body = {
        name: document.getElementById('cName').value,
        tees: [...document.querySelectorAll('#tees .row')].map((r) => ({ id: r.dataset.id || undefined, name: r.querySelector('[name=tname]').value, rating: r.querySelector('[name=rating]').value, slope: r.querySelector('[name=slope]').value })),
        holes: course.holes.map((_, i) => ({ par: app.querySelector(`[data-par="${i}"]`).value, si: app.querySelector(`[data-si="${i}"]`).value })),
      };
      await api('PUT', `/api/courses/${course.id}`, body);
      toast('Course saved');
      render();
    });
    document.getElementById('delCourse').onclick = () => guard(async () => {
      if (!confirm(`Delete ${course.name}?`)) return;
      await api('DELETE', `/api/courses/${course.id}`);
      location.hash = '#/courses';
    });
  }
  document.getElementById('addCourse').onclick = () => guard(async () => {
    const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, si: i + 1 }));
    const c = await api('POST', '/api/courses', { name: 'New course', holes, tees: [{ name: 'White', rating: 72, slope: 113 }] });
    location.hash = `#/courses/${c.id}`;
  });
}
const teeRow = (t) => `<div class="row" data-id="${esc(t.id ?? '')}" style="margin-bottom:.5rem">
  <label>Tee<input name="tname" value="${esc(t.name)}" /></label>
  <label>Course rating<input name="rating" value="${esc(t.rating)}" inputmode="decimal" /></label>
  <label>Slope<input name="slope" value="${esc(t.slope)}" inputmode="numeric" /></label>
  <button class="danger small" data-rm>✕</button></div>`;

// ---------- event ----------

async function renderEvent(id, tab) {
  const ev = await api('GET', `/api/events/${id}`);
  const drawn = ev.teams?.length > 0;
  const tabs = [['setup', 'Setup'], ['teams', 'Teams'], ['scores', 'Scores'], ['results', 'Leaderboard']];
  app.innerHTML = `
    <div class="spread"><div><h1>${esc(ev.name)}</h1><p class="muted">${esc(ev.date)} · ${esc(ev.course?.name ?? 'No course')} · ${ev.playerIds.length} players · ${money(ev.entryFee)} entry</p></div>
      <button class="ghost no-print" onclick="window.print()">Print</button></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/event/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  const el = document.getElementById('tab');
  if (tab === 'setup') return eventSetup(ev, el);
  if (!drawn) {
    el.innerHTML = `<div class="card">Teams haven’t been drawn yet. Go to <a href="#/event/${id}/setup">Setup</a>, pick the field and press <strong>Draw teams</strong>.</div>`;
    return;
  }
  if (tab === 'teams') return eventTeams(ev, el);
  if (tab === 'scores') return eventScores(ev, el);
  return eventResults(ev, el);
}

function eventSetup(ev, el) {
  const course = ev.course;
  const types = S.gameTypes;
  const players = [...S.players].filter((p) => p.active !== false || ev.playerIds.includes(p.id)).sort((a, b) => (a.lastName || a.name).localeCompare(b.lastName || b.name));
  const sel = new Set(ev.playerIds);
  const potTotal = ev.games.reduce((s, g) => s + (Number(g.potPct) || 0), 0);
  const recommended = [...new Set(ev.games.map((g) => types[g.type]?.allowance))].join('/');

  el.innerHTML = `
    <div class="card">
      <div class="row">
        <label>Event name<input id="eName" value="${esc(ev.name)}" /></label>
        <label>Date<input id="eDate" type="date" value="${esc(ev.date)}" /></label>
        <label>Course<select id="eCourse">${S.courses.map((c) => `<option value="${c.id}" ${c.id === ev.courseId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Tee<select id="eTee">${(course?.tees ?? []).map((t) => `<option value="${t.id}" ${t.id === ev.teeId ? 'selected' : ''}>${esc(t.name)} (${t.rating}/${t.slope})</option>`).join('')}</select></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label>Handicap allowance %<input id="eAllow" type="number" min="0" max="100" value="${ev.allowance}" /></label>
        <label>Entry fee ($ per player)<input id="eFee" type="number" min="0" value="${ev.entryFee}" /></label>
        <label class="inline"><input id="eOffLow" type="checkbox" ${ev.offLow ? 'checked' : ''} /> Play off the low man</label>
      </div>
      <p class="muted small">USGA recommended allowance for the selected games: ${recommended || '—'}%. Total pot: ${money(ev.entryFee * ev.playerIds.length)}.</p>
    </div>

    <div class="card">
      <div class="spread"><h3 style="margin:0">Games</h3><button class="ghost small" id="addGame">+ Add game</button></div>
      <div id="games">${ev.games.map((g) => gameRow(g, types)).join('')}</div>
      <p class="small ${potTotal === 100 ? 'muted' : ''}" style="${potTotal === 100 ? '' : 'color:var(--red)'}">Pot split across games: ${potTotal}%${potTotal === 100 ? '' : ' — should add up to 100%'}</p>
    </div>

    <div class="card">
      <div class="spread"><h3 style="margin:0">Who’s playing <span class="badge" id="count">${sel.size}</span></h3>
        <div class="row"><input id="filter" placeholder="Search…" /><button class="ghost small" id="all">All</button><button class="ghost small" id="none">None</button></div></div>
      <div class="picker" style="margin-top:.5rem">${players.map((p) => `<label data-name="${esc(p.name.toLowerCase())}"><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? 'checked' : ''}/> ${esc(p.name)} <span class="muted small">${formatHandicap(p.handicapIndex)}</span></label>`).join('') || '<p class="muted">Add players first.</p>'}</div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Draw teams</h3>
      <p class="muted small">Players are ranked by playing handicap and split into A (best) → D (worst). Each team gets one of each letter. If the field isn’t a multiple of 4, short teams get a blind-draw D player.</p>
      <div class="row">
        <label class="inline"><input type="radio" name="mode" value="balanced" checked /> Balanced (closest team totals)</label>
        <label class="inline"><input type="radio" name="mode" value="random" /> Random draw by letter</label>
        <label class="inline"><input type="checkbox" id="refreshGhin" ${S.ghinConfigured ? 'checked' : 'disabled'} /> Update handicaps from GHIN first</label>
      </div>
      <div class="row" style="margin-top:.75rem"><button id="save" class="ghost">Save setup</button><button id="draw">${ev.teams?.length ? 'Redraw teams' : 'Draw teams'}</button><button class="danger" id="delEvent">Delete event</button></div>
    </div>`;

  const picker = el.querySelector('.picker');
  const updateCount = () => (document.getElementById('count').textContent = picker.querySelectorAll('input:checked').length);
  picker.onchange = updateCount;
  document.getElementById('filter').oninput = (e) => picker.querySelectorAll('label').forEach((l) => (l.hidden = !l.dataset.name.includes(e.target.value.toLowerCase())));
  document.getElementById('all').onclick = () => { picker.querySelectorAll('label:not([hidden]) input').forEach((i) => (i.checked = true)); updateCount(); };
  document.getElementById('none').onclick = () => { picker.querySelectorAll('input').forEach((i) => (i.checked = false)); updateCount(); };
  document.getElementById('eCourse').onchange = () => guard(async () => {
    const c = S.courses.find((x) => x.id === document.getElementById('eCourse').value);
    await save({ courseId: c.id, teeId: c.tees[0]?.id });
    render();
  });
  document.getElementById('addGame').onclick = () => {
    document.getElementById('games').insertAdjacentHTML('beforeend', gameRow({ type: 'skins', scoring: 'net', potPct: 0, payouts: [] }, types));
  };
  document.getElementById('games').onclick = (e) => e.target.matches('[data-rm]') && e.target.closest('.game-config').remove();
  document.getElementById('games').onchange = (e) => {
    if (e.target.name === 'type') e.target.closest('.game-config').querySelector('.desc').textContent = types[e.target.value].description;
  };

  const collect = () => ({
    name: document.getElementById('eName').value,
    date: document.getElementById('eDate').value,
    courseId: document.getElementById('eCourse').value,
    teeId: document.getElementById('eTee').value,
    allowance: document.getElementById('eAllow').value,
    entryFee: document.getElementById('eFee').value,
    offLow: document.getElementById('eOffLow').checked,
    playerIds: [...picker.querySelectorAll('input:checked')].map((i) => i.value),
    games: [...el.querySelectorAll('.game-config')].map((r) => ({
      id: r.dataset.id || undefined,
      type: r.querySelector('[name=type]').value,
      scoring: r.querySelector('[name=scoring]').value,
      potPct: r.querySelector('[name=potPct]').value,
      payouts: r.querySelector('[name=payouts]').value,
      tiebreak: r.querySelector('[name=tiebreak]').value,
      carryover: r.querySelector('[name=carryover]').checked,
    })),
  });
  const save = (extra = {}) => api('PUT', `/api/events/${ev.id}`, { ...collect(), ...extra });
  document.getElementById('save').onclick = () => guard(async () => { await save(); toast('Saved'); render(); });
  document.getElementById('draw').onclick = () => guard(async () => {
    await save();
    const body = { mode: el.querySelector('[name=mode]:checked').value, refreshGhin: document.getElementById('refreshGhin').checked };
    try {
      await api('POST', `/api/events/${ev.id}/draw`, body);
    } catch (e) {
      if (!/Scores already entered/.test(e.message) || !confirm('Scores have been entered. Redrawing will erase them. Continue?')) throw e;
      await api('POST', `/api/events/${ev.id}/draw`, { ...body, force: true });
    }
    toast('Teams drawn');
    location.hash = `#/event/${ev.id}/teams`;
  });
  document.getElementById('delEvent').onclick = () => guard(async () => {
    if (!confirm('Delete this event?')) return;
    await api('DELETE', `/api/events/${ev.id}`);
    location.hash = '#/';
  });
}

function gameRow(g, types) {
  return `<div class="game-config" data-id="${esc(g.id ?? '')}">
    <label>Game<select name="type">${Object.entries(types).map(([k, t]) => `<option value="${k}" ${k === g.type ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>Scoring<select name="scoring"><option value="net" ${g.scoring !== 'gross' ? 'selected' : ''}>Net</option><option value="gross" ${g.scoring === 'gross' ? 'selected' : ''}>Gross</option></select></label>
    <label>% of pot<input name="potPct" type="number" min="0" max="100" value="${esc(g.potPct)}" /></label>
    <label>Payouts % by place<input name="payouts" value="${esc((g.payouts ?? []).join(' / '))}" placeholder="50 / 30 / 20" /></label>
    <label>Ties<select name="tiebreak"><option value="cardoff">Card-off</option><option value="split" ${g.tiebreak === 'split' ? 'selected' : ''}>Split</option></select>
      <span class="inline small"><input type="checkbox" name="carryover" ${g.carryover ? 'checked' : ''}/> skins carry</span></label>
    <button class="danger small" data-rm>✕</button>
    <div class="desc muted small" style="grid-column:1/-1">${esc(types[g.type]?.description)}</div>
  </div>`;
}

function playerOf(ev, id) { return ev.players.find((p) => p.playerId === id); }

function eventTeams(ev, el) {
  const hasScramble = ev.games.some((g) => g.type === 'scramble');
  const tierStats = TIERS.map((t) => {
    const ps = ev.players.filter((p) => p.tier === t);
    return ps.length ? `${tierBadge(t)} ${ps.length} players, ${Math.min(...ps.map((p) => p.playingHcp))}–${Math.max(...ps.map((p) => p.playingHcp))}` : '';
  }).filter(Boolean).join(' &nbsp; ');
  const totals = ev.teams.map((t) => t.total ?? teamTotal(ev, t));
  el.innerHTML = `
    <div class="card small"><div>${tierStats}</div>
      <div class="muted" style="margin-top:.4rem">Team totals range ${Math.min(...totals)}–${Math.max(...totals)} (playing handicap). Tap two players to swap them.</div></div>
    <div class="teams">${ev.teams.map((t) => {
      const lineup = TIERS.map((tier) => t.members[tier] != null ? { tier, id: t.members[tier] } : (t.blind && t.blind.tier === tier ? { tier, id: t.blind.playerId, blind: true } : null)).filter(Boolean);
      return `<div class="team"><h3><span contenteditable="true" data-team="${t.id}" spellcheck="false">${esc(t.name)}</span><span class="muted small">Σ ${teamTotal(ev, t)}${hasScramble ? ` · scr ${t.scrambleHcp}` : ''}</span></h3>
        ${lineup.map((m) => {
          const p = playerOf(ev, m.id);
          return `<div class="member ${swapPick === m.id && !m.blind ? 'selected' : ''}" ${m.blind ? '' : `data-pid="${m.id}"`}>${tierBadge(m.tier, m.blind)}
            <span class="name">${esc(p?.name)}${m.blind ? ' <span class="muted small">(blind)</span>' : ''}</span>
            <span class="hc" title="Index / course / playing">${formatHandicap(p?.index)} · ${p?.courseHcp} · <strong>${p?.playingHcp}</strong></span></div>`;
        }).join('')}</div>`;
    }).join('')}</div>
    <p class="muted small">Numbers: Handicap Index · Course Handicap · <strong>Playing Handicap</strong> (${ev.allowance}%${ev.offLow ? ', off the low man' : ''}).</p>`;

  el.querySelectorAll('[data-pid]').forEach((m) => (m.onclick = () => guard(async () => {
    const id = m.dataset.pid;
    if (!swapPick) { swapPick = id; return renderEvent(ev.id, 'teams'); }
    if (swapPick === id) { swapPick = null; return renderEvent(ev.id, 'teams'); }
    const a = swapPick; swapPick = null;
    const pa = playerOf(ev, a), pb = playerOf(ev, id);
    if (pa.tier !== pb.tier && !confirm(`${pa.name} is a ${pa.tier} and ${pb.name} is a ${pb.tier}. Swap anyway (they’ll trade letters)?`)) return renderEvent(ev.id, 'teams');
    await api('POST', `/api/events/${ev.id}/swap`, { a, b: id });
    renderEvent(ev.id, 'teams');
  })));
  el.querySelectorAll('[data-team]').forEach((n) => (n.onblur = () => guard(() => api('PUT', `/api/events/${ev.id}/teams/${n.dataset.team}`, { name: n.textContent.trim() }))));
}

function teamTotal(ev, t) {
  return TIERS.reduce((s, tier) => {
    const id = t.members[tier] ?? (t.blind?.tier === tier ? t.blind.playerId : null);
    return s + (id ? playerOf(ev, id)?.playingHcp ?? 0 : 0);
  }, 0);
}

let scoreTeam = null;
function eventScores(ev, el) {
  const course = ev.course;
  const hasScramble = ev.games.some((g) => g.type === 'scramble');
  const onlyScramble = ev.games.every((g) => g.type === 'scramble');
  if (!ev.teams.some((t) => t.id === scoreTeam)) scoreTeam = ev.teams[0].id;
  const team = ev.teams.find((t) => t.id === scoreTeam);
  const holeHead = (from, to) => course.holes.slice(from, to).map((h, i) => `<th>${from + i + 1}<div class="sub">${h.par}·${h.si}</div></th>`).join('');
  const parSum = (from, to) => course.holes.slice(from, to).reduce((s, h) => s + h.par, 0);
  const row = (label, key, scores, hcp) => {
    const cell = (i) => {
      const dots = hcp ? strokesOnHole(hcp, course.holes[i].si) : 0;
      return `<td><span class="dots">${dots > 0 ? '•'.repeat(dots) : dots < 0 ? '+' : ''}</span><input data-key="${key}" data-h="${i}" value="${scores?.[i] ?? ''}" inputmode="numeric" maxlength="2" /></td>`;
    };
    const tot = (a, b) => (scores ?? []).slice(a, b).reduce((s, v) => s + (v || 0), 0) || '';
    return `<tr><td>${label}</td>${[...Array(9).keys()].map(cell).join('')}<td class="tot" data-tot="${key}:0">${tot(0, 9)}</td>${[...Array(9).keys()].map((i) => cell(i + 9)).join('')}<td class="tot" data-tot="${key}:1">${tot(9, 18)}</td><td class="tot" data-tot="${key}:2">${tot(0, 18)}</td></tr>`;
  };
  const lineup = TIERS.filter((t) => team.members[t] != null).map((t) => ({ tier: t, p: playerOf(ev, team.members[t]) }));
  el.innerHTML = `
    <div class="row no-print" style="margin-bottom:.75rem">
      <label>Team<select id="pickTeam">${ev.teams.map((t) => `<option value="${t.id}" ${t.id === scoreTeam ? 'selected' : ''}>${esc(t.name)} — ${TIERS.filter((x) => t.members[x]).map((x) => playerOf(ev, t.members[x])?.name.split(' ').pop()).join(', ')}</option>`).join('')}</select></label>
    </div>
    <div class="card table-wrap"><table class="scorecard">
      <thead><tr><th>Hole<div class="sub">par·S.I.</div></th>${holeHead(0, 9)}<th>Out<div class="sub">${parSum(0, 9)}</div></th>${holeHead(9, 18)}<th>In<div class="sub">${parSum(9, 18)}</div></th><th>Tot<div class="sub">${parSum(0, 18)}</div></th></tr></thead>
      <tbody>
        ${onlyScramble ? '' : lineup.map(({ tier, p }) => row(`${tierBadge(tier)} ${esc(p.name.split(' ').pop())} <span class="muted small">${p.playingHcp}</span>`, `p:${p.playerId}`, ev.scores?.[p.playerId], p.playingHcp)).join('')}
        ${hasScramble ? row(`<strong>Scramble</strong> <span class="muted small">${team.scrambleHcp}</span>`, `t:${team.id}`, ev.teamScores?.[team.id], team.scrambleHcp) : ''}
      </tbody></table>
      <p class="muted small">Enter gross scores. Dots show handicap strokes. Saves automatically.${team.blind ? ` Blind draw: ${esc(playerOf(ev, team.blind.playerId)?.name)}’s scores also count for this team.` : ''}</p>
    </div>`;
  document.getElementById('pickTeam').onchange = (e) => { scoreTeam = Number(e.target.value); eventScores(ev, el); };
  const saveRow = async (key) => {
    const holes = [...el.querySelectorAll(`input[data-key="${key}"]`)].map((i) => i.value.trim() || null);
    const [kind, id] = key.split(':');
    const body = kind === 'p' ? { playerId: id, holes } : { teamId: Number(id), holes };
    const updated = await api('PUT', `/api/events/${ev.id}/scores`, body);
    Object.assign(ev, { scores: updated.scores, teamScores: updated.teamScores });
    const vals = holes.map((v) => Number(v) || 0);
    const s = (a, b) => vals.slice(a, b).reduce((x, y) => x + y, 0) || '';
    el.querySelector(`[data-tot="${key}:0"]`).textContent = s(0, 9);
    el.querySelector(`[data-tot="${key}:1"]`).textContent = s(9, 18);
    el.querySelector(`[data-tot="${key}:2"]`).textContent = s(0, 18);
  };
  el.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.onchange = () => guard(() => saveRow(inp.dataset.key));
    inp.oninput = () => {
      if (/^\d$/.test(inp.value) && inp.value !== '1') {
        const next = el.querySelector(`input[data-key="${inp.dataset.key}"][data-h="${Number(inp.dataset.h) + 1}"]`);
        next?.focus();
      }
    };
    inp.onfocus = () => inp.select();
  });
}

function eventResults(ev, el) {
  const r = ev.results;
  const gameHtml = (g) => {
    const head = `<div class="spread"><h2>${esc(g.name)} <span class="badge">${g.scoring}</span></h2><span class="badge gold">Pot ${money(g.pot)}</span></div>`;
    if (g.kind === 'skins') {
      return `${head}<div class="card table-wrap"><table><thead><tr><th>Player</th><th class="num">Skins</th><th class="num">Payout</th></tr></thead><tbody>
        ${g.winners.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${w.skins}</td><td class="num">${money(w.payout)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No skins yet.</td></tr>'}</tbody></table>
        <p class="small muted">${g.holes.map((h) => `${h.hole}: ${h.winner ? `<strong>${esc(h.winner.name.split(' ').pop())}</strong> (${h.score}${h.value > 1 ? `, ×${h.value}` : ''})` : h.score === null ? '–' : `tie (${h.tiedCount}×${h.score})`}`).join(' · ')}</p></div>`;
    }
    if (g.kind === 'flights') {
      return `${head}<div class="teams">${g.flights.map((f) => `<div class="team"><h3>${tierBadge(f.tier)} Flight</h3><table><tbody>
        ${f.rows.map((row) => `<tr class="${row.position === 1 ? 'leader' : ''}"><td>${row.tied ? 'T' : ''}${row.position}</td><td>${esc(row.name)}</td><td class="num">${toPar(row.toPar)}</td><td class="num muted">${row.thru < 18 ? `thru ${row.thru}` : row.total}</td><td class="num">${money(row.payout)}</td></tr>`).join('') || '<tr><td class="muted">No scores yet.</td></tr>'}
      </tbody></table></div>`).join('')}</div>`;
    }
    return `${head}<div class="card table-wrap"><table><thead><tr><th>Pos</th><th>Team</th><th class="num">${g.higherBetter ? 'Points' : 'To par'}</th><th class="num">Thru</th><th class="num">Payout</th><th class="num">Each</th></tr></thead><tbody>
      ${g.rows.map((row) => {
        const t = ev.teams.find((x) => x.id === row.teamId);
        const names = TIERS.filter((x) => t.members[x]).map((x) => playerOf(ev, t.members[x])?.name.split(' ').pop()).join(', ');
        return `<tr class="${row.position === 1 ? 'leader' : ''}"><td>${row.tied ? 'T' : ''}${row.position}</td><td><strong>${esc(row.name)}</strong> <span class="muted small">${esc(names)}${row.teamHcp != null ? ` · hcp ${row.teamHcp}` : ''}</span></td>
          <td class="num"><strong>${g.higherBetter ? row.total : toPar(row.toPar)}</strong></td><td class="num">${row.thru === 18 ? 'F' : row.thru}</td><td class="num">${money(row.payout)}</td><td class="num">${money(row.perPlayer)}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No completed holes yet.</td></tr>'}</tbody></table></div>`;
  };
  el.innerHTML = `
    <div class="spread no-print"><p class="muted">Pot ${money(r.totalPot)} · ties broken by card-off (back 9, 6, 3, 18th) unless set to split. <a href="#" id="refresh">↻ Refresh</a></p></div>
    ${r.games.map((g) => `<div class="game">${gameHtml(g)}</div>`).join('')}
    <h2>Money list</h2>
    <div class="card table-wrap"><table><thead><tr><th>Player</th><th></th><th class="num">Won</th></tr></thead><tbody>
      ${r.winnings.map((w) => `<tr><td>${esc(w.name)}</td><td>${w.tier ? tierBadge(w.tier) : ''}</td><td class="num"><strong>${money(w.amount)}</strong></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing paid out yet.</td></tr>'}
    </tbody></table></div>`;
  document.getElementById('refresh').onclick = (e) => { e.preventDefault(); renderEvent(ev.id, 'results'); };
}

guard(render);
