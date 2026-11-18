// EVE Kill Tracker: front end. All number crunching happens here in the browser;
// the Worker only hands over stored hourly/daily snapshots.
export const APP_VERSION = '2.0.1';
const IMG = 'https://images.evetech.net';

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('en-US');
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString('en-US');
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').append(el); setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(data?.error || `Server error ${r.status}`), { status: r.status });
  return data;
}
const evetime = ts => ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '—';
const ago = ts => {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const dayStr = d => d.toISOString().slice(0, 10);
const daysAgo = n => dayStr(new Date(Date.now() - n * 86400e3));

// EVE shows true-sec rounded to 1 decimal, except 0.0-0.05 shows as 0.1
const secShown = s => (s > 0 && s < 0.05) ? 0.1 : Math.round(s * 10) / 10;
const SEC_COLORS = ['#8f2f6a', '#722020', '#bc1113', '#ce440f', '#e16a0b', '#d1a52d', '#71e554', '#57edaa', '#60d9ef', '#4cbcff', '#2c74e0'];
const secColor = s => SEC_COLORS[Math.max(0, Math.min(10, Math.round(secShown(s) * 10)))] || SEC_COLORS[0];
const secBadge = s => `<span class="sec" style="color:${secColor(s)}">${secShown(s).toFixed(1)}</span>`;

// ---------------------------------------------------------------- state
const state = {
  SYS: {}, REG: {},              // static: systemId -> [name, regionId, sec], regionId -> name
  meta: null, sov: { systems: {}, alliances: {} }, me: { logged_in: false },
  pins: new Map(),               // systemId -> note
  hours: null, hoursN: 0,        // most recent hourly snapshots [{h, t, d}] (24, or 72 after a 72h export)
  days: {},                      // day -> {n, d}
  daysLoaded: null,              // earliest day fetched
  tab: ls.get('kt.tab', 'live'),
  f: ls.get('kt.filters', { region: 'all', sov: 'all', alliance: null, sec: 'all' }),
  ui: { liveQ: '', liveAll: false, rTf: '7d', rQ: '', luTf: '24h', luSec: -0.75, luQ: '', pinTf: '24h', sort: {} },
  charts: {},
};
const isWH = id => id >= 31000000 && id < 32000000;
const sysName = id => state.SYS[id]?.[0] || `System ${id}`;
const sysRegion = id => state.REG[state.SYS[id]?.[1]] || '';
const sysSec = id => state.SYS[id]?.[2] ?? 0;
const holder = id => state.sov.systems[id] || null;
const allianceName = id => state.sov.alliances[id] || `Alliance ${id}`;

/** Does a system pass the sidebar filters? */
function inScope(id) {
  const s = state.SYS[id];
  if (!s) return false;
  const f = state.f;
  if (f.region !== 'all' && String(s[1]) !== String(f.region)) return false;
  if (f.sec !== 'all') {
    const sec = secShown(s[2]);
    if (f.sec === 'wh' ? !isWH(id) : isWH(id)) return false;
    if (f.sec === 'hs' && sec < 0.5) return false;
    if (f.sec === 'ls' && (sec < 0.1 || sec >= 0.5)) return false;
    if (f.sec === 'ns' && sec > 0) return false;
  }
  if (f.sov === 'nosov' && holder(id)) return false;
  if ((f.sov === 'held' || f.sov === 'notheld') && f.alliance) {
    const held = holder(id) === f.alliance;
    if (f.sov === 'held' ? !held : held) return false;
  }
  return true;
}
const scopeLabel = () => {
  const f = state.f, bits = [];
  if (f.region !== 'all') bits.push(state.REG[f.region]);
  if (f.sec !== 'all') bits.push({ hs: 'high-sec', ls: 'low-sec', ns: 'null-sec', wh: 'wormholes' }[f.sec]);
  if (f.sov === 'nosov') bits.push('no player sov');
  if ((f.sov === 'held' || f.sov === 'notheld') && f.alliance) bits.push(`${f.sov === 'held' ? 'held by' : 'not held by'} ${allianceName(f.alliance)}`);
  return bits.length ? bits.join(' · ') : 'all of New Eden';
};

// ---------------------------------------------------------------- data loading
async function loadHours(n = 24) {
  state.hours = await api(`/api/hours?n=${n}`, { cache: 'no-cache' });
  state.hoursN = n;
}
async function ensureDays(fromDay) {
  if (state.daysLoaded && (fromDay === null ? state.daysLoaded === 'all' : state.daysLoaded === 'all' || state.daysLoaded <= fromDay)) return;
  const rows = await api(`/api/days${fromDay ? `?from=${fromDay}` : ''}`);
  for (const r of rows) state.days[r.day] = { n: r.n, d: r.d };
  state.daysLoaded = fromDay || 'all';
}
const latest = () => state.hours?.[state.hours.length - 1] || null;
const lastHours = n => (state.hours || []).slice(-n);

/** Sum hourly snapshots into per-system totals. */
function sumHours(list) {
  const out = {};
  for (const h of list) for (const id of Object.keys(h.d)) {
    const [npc = 0, ship = 0, pod = 0] = h.d[id];
    const s = out[id] ||= { npc: 0, ship: 0, pod: 0, peak: 0, active: 0 };
    s.npc += npc; s.ship += ship; s.pod += pod; if (npc > s.peak) s.peak = npc; if (npc) s.active++;
  }
  return { totals: out, hours: list.length };
}
/** Sum daily rows (from a day, inclusive) into per-system totals. */
function sumDays(fromDay) {
  const out = {}; let hours = 0, days = 0;
  for (const [day, { n, d }] of Object.entries(state.days)) {
    if (fromDay && day < fromDay) continue;
    hours += n; days++;
    for (const [id, [npc = 0, peak = 0, act = 0, ship = 0, pod = 0]] of Object.entries(d)) {
      const s = out[id] ||= { npc: 0, ship: 0, pod: 0, peak: 0, active: 0 };
      s.npc += npc; s.ship += ship; s.pod += pod; if (peak > s.peak) s.peak = peak; s.active += act;
    }
  }
  return { totals: out, hours, days };
}
const TF = {
  '1h': { label: 'last hour', hours: 1 },
  '24h': { label: 'last 24 hours', hours: 24 },
  '7d': { label: 'last 7 days', from: () => daysAgo(6) },
  '30d': { label: 'last 30 days', from: () => daysAgo(29) },
  '90d': { label: 'last 90 days', from: () => daysAgo(89) },
  all: { label: 'all time', from: () => null },
};
const SHORT = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time' };
async function totalsFor(tf) {
  const t = TF[tf];
  if (t.hours) return sumHours(lastHours(t.hours));
  const from = t.from();
  await ensureDays(from);
  return sumDays(from);
}

// ---------------------------------------------------------------- tables
function sortRows(key, rows, defaultCol, defaultDir = -1) {
  const s = state.ui.sort[key] ||= { col: defaultCol, dir: defaultDir };
  const v = r => r[s.col];
  return rows.sort((a, b) => (typeof v(a) === 'string' ? v(a).localeCompare(v(b)) : (v(a) - v(b))) * s.dir || a.name.localeCompare(b.name));
}
const th = (key, col, label, cls = '') => {
  const s = state.ui.sort[key];
  const on = s?.col === col;
  return `<th class="sortable ${cls} ${on ? 'on' : ''}" data-sort="${key}:${col}">${label}${on ? (s.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
};
const star = id => `<button class="star ${state.pins.has(Number(id)) ? 'on' : ''}" data-pin="${id}" title="${state.pins.has(Number(id)) ? 'Unpin' : 'Pin'} system">${state.pins.has(Number(id)) ? '★' : '☆'}</button>`;
const sysCell = id => `<td class="sys">${star(id)}<a href="https://evemaps.dotlan.net/system/${encodeURIComponent(sysName(id).replace(/ /g, '_'))}" target="_blank" rel="noopener" title="Open in Dotlan">${esc(sysName(id))}</a></td>`;
const sovCell = id => { const a = holder(id); return `<td class="dim sov">${a ? `<img src="${IMG}/alliances/${a}/logo?size=32" alt="" width="16" height="16" loading="lazy">${esc(allianceName(a))}` : ''}</td>`; };
const match = (id, q) => !q || sysName(id).toLowerCase().includes(q) || sysRegion(id).toLowerCase().includes(q);

// ---------------------------------------------------------------- charts
function lineChart(key, canvas, labels, series, opts = {}) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<p class="dim">Chart library did not load.</p>'; return; }
  state.charts[key]?.destroy();
  const palette = ['#e8a33d', '#4fb3d9', '#6cc28a', '#c084fc', '#f2696b', '#9aa7b5', '#f0d264', '#5ad1c6'];
  state.charts[key] = new Chart(canvas, {
    type: opts.type || 'line',
    data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length] + (opts.type === 'bar' ? 'cc' : '33'), tension: .25, pointRadius: 0, borderWidth: 2, fill: false, stack: opts.stacked ? 's' : undefined })) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#c9d3de', boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: '#7f8c9a', maxTicksLimit: 12 }, grid: { color: '#1b2430' }, stacked: !!opts.stacked },
        y: { ticks: { color: '#7f8c9a' }, grid: { color: '#1b2430' }, beginAtZero: true, stacked: !!opts.stacked },
      },
    },
  });
}

// ---------------------------------------------------------------- views
const VIEWS = { live: viewLive, reports: viewReports, least: viewLeast, pinned: viewPinned, data: viewData };
async function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#pinCount').textContent = state.pins.size ? state.pins.size : '';
  sideStats();
  const v = $('#view');
  try { await VIEWS[state.tab](v); }
  catch (e) { console.error(e); v.innerHTML = `<div class="empty big warn">${esc(e.message)}</div>`; }
}

function sideStats() {
  const m = state.meta;
  $('#sideStats').innerHTML = m ? `
    <div class="kv"><span>Latest ESI hour</span><b>${m.last_taken_at ? `${evetime(m.last_taken_at).slice(11)} <small class="dim">${ago(m.last_taken_at)}</small>` : '—'}</b></div>
    <div class="kv"><span>Hourly history</span><b>${m.hours} h</b></div>
    <div class="kv"><span>Daily history</span><b>${m.days} days</b></div>
    <div class="kv"><span>Sovereignty</span><b>${m.sov_updated ? ago(m.sov_updated) : '—'}</b></div>` : '';
}

// ---- Live
async function viewLive(v) {
  const L = latest();
  if (!L) { v.innerHTML = '<div class="empty big"><h2>Waiting for the first hour of data</h2><p>The tracker checks ESI every 15 minutes. The first snapshot appears shortly after it goes live.</p></div>'; return; }
  const q = state.ui.liveQ.toLowerCase();
  const rows = Object.entries(L.d).filter(([id]) => inScope(id)).map(([id, [npc = 0, ship = 0, pod = 0]]) => ({ id, name: sysName(id), npc, ship, pod, sec: sysSec(id), region: sysRegion(id) }));
  const total = rows.reduce((n, r) => n + r.npc, 0), ships = rows.reduce((n, r) => n + r.ship, 0);
  const active = rows.filter(r => r.npc > 0);
  const hot = [...active].sort((a, b) => b.npc - a.npc)[0];
  const shown = sortRows('live', rows.filter(r => match(r.id, q)), 'npc');
  const limit = state.ui.liveAll ? shown.length : 100;
  v.innerHTML = `
    <section class="stats">
      <div class="stat"><span>NPC kills this hour</span><b>${fmt(total)}</b><small>${esc(scopeLabel())}</small></div>
      <div class="stat"><span>Systems ratting</span><b>${fmt(active.length)}</b><small>with NPC kills this hour</small></div>
      <div class="stat"><span>Hottest system</span><b>${hot ? esc(hot.name) : '—'}</b><small>${hot ? `${fmt(hot.npc)} NPC kills · ${esc(hot.region)}` : ''}</small></div>
      <div class="stat"><span>Ship kills this hour</span><b>${fmt(ships)}</b><small>players killed in scope</small></div>
    </section>
    <section class="panel chart-panel">
      <div class="panel-head"><h3>Top 5 systems right now · NPC kills per hour, last 24 hours</h3><span class="dim">ESI hour ending ${evetime(L.t).slice(11)} EVE</span></div>
      <div class="chart-box"><canvas id="liveChart"></canvas></div>
    </section>
    <div class="toolbar">
      <input type="search" id="liveQ" placeholder="Search system or region…" value="${esc(state.ui.liveQ)}" autocomplete="off">
      <span class="dim">${fmt(shown.length)} systems with kills this hour</span>
    </div>
    <div class="scroll-x"><table class="data">
      <thead><tr>${th('live', 'name', 'System')}${th('live', 'sec', 'Sec', 'num')}${th('live', 'region', 'Region')}<th>Sovereignty</th>${th('live', 'npc', 'NPC', 'num')}${th('live', 'ship', 'Ships', 'num')}${th('live', 'pod', 'Pods', 'num')}</tr></thead>
      <tbody>${shown.slice(0, limit).map(r => `<tr>${sysCell(r.id)}<td class="num">${secBadge(r.sec)}</td><td class="dim">${esc(r.region)}</td>${sovCell(r.id)}<td class="num"><b>${fmt(r.npc)}</b></td><td class="num ${r.ship ? 'warn' : 'dim'}">${r.ship || ''}</td><td class="num dim">${r.pod || ''}</td></tr>`).join('')}</tbody>
    </table></div>
    ${shown.length > limit ? `<button class="link" id="liveAll">Show all ${fmt(shown.length)}</button>` : ''}`;
  const top = [...active].sort((a, b) => b.npc - a.npc).slice(0, 5);
  const hrs = lastHours(24);
  lineChart('live', $('#liveChart'), hrs.map(h => h.h.slice(11) + ':00'), top.map(r => ({ label: r.name, data: hrs.map(h => h.d[r.id]?.[0] || 0) })));
}

// ---- Reports
async function viewReports(v) {
  const tf = state.ui.rTf;
  v.innerHTML = '<div class="empty">Loading…</div>';
  const { totals, hours, days } = await totalsFor(tf);
  const q = state.ui.rQ.toLowerCase();
  const rows = Object.entries(totals).filter(([id]) => inScope(id)).map(([id, s]) => ({ id, name: sysName(id), sec: sysSec(id), region: sysRegion(id), ...s, avg: s.active ? s.npc / s.active : 0 }));
  const total = rows.reduce((n, r) => n + r.npc, 0);
  const active = rows.filter(r => r.npc > 0);
  const top = [...active].sort((a, b) => b.npc - a.npc)[0];
  const byRegion = {};
  for (const r of active) byRegion[r.region] = (byRegion[r.region] || 0) + r.npc;
  const regionsTop = Object.entries(byRegion).sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);
  const shown = sortRows('rep', rows.filter(r => r.npc > 0 && match(r.id, q)), 'npc');

  v.innerHTML = `
    <div class="toolbar">
      <span class="seg">${Object.keys(TF).filter(k => k !== '1h').map(k => `<button data-rtf="${k}" class="${k === tf ? 'on' : ''}">${SHORT[k]}</button>`).join('')}</span>
      <span class="dim">${esc(scopeLabel())} · ${TF[tf].hours ? `${hours} hourly snapshots` : `${days} day${days === 1 ? '' : 's'} (${fmt(hours)} hourly snapshots)`}</span>
    </div>
    <section class="stats">
      <div class="stat"><span>NPC kills</span><b>${fmt(total)}</b><small>${TF[tf].label}</small></div>
      <div class="stat"><span>Systems ratted</span><b>${fmt(active.length)}</b><small>at least 1 NPC kill</small></div>
      <div class="stat"><span>Busiest system</span><b>${top ? esc(top.name) : '—'}</b><small>${top ? `${fmt(top.npc)} kills · ${esc(top.region)}` : ''}</small></div>
      <div class="stat"><span>Average per hour</span><b>${hours ? fmt(total / hours) : '—'}</b><small>NPC kills across scope</small></div>
    </section>
    <section class="panel chart-panel">
      <div class="panel-head"><h3>NPC kills by region · ${TF[tf].hours ? 'per hour' : 'per day'}</h3><span class="dim">top ${regionsTop.length} regions in scope</span></div>
      <div class="chart-box"><canvas id="repChart"></canvas></div>
    </section>
    <div class="toolbar">
      <input type="search" id="rQ" placeholder="Search system or region…" value="${esc(state.ui.rQ)}" autocomplete="off">
      <span class="dim">${fmt(shown.length)} systems · click a column to sort</span>
    </div>
    <div class="scroll-x"><table class="data">
      <thead><tr><th>#</th>${th('rep', 'name', 'System')}${th('rep', 'sec', 'Sec', 'num')}${th('rep', 'region', 'Region')}<th>Sovereignty</th>${th('rep', 'npc', 'NPC kills', 'num')}${th('rep', 'peak', 'Peak hour', 'num')}${th('rep', 'active', 'Hours active', 'num')}${th('rep', 'avg', 'Avg / active hour', 'num')}${th('rep', 'ship', 'Ship kills', 'num')}</tr></thead>
      <tbody>${shown.slice(0, 300).map((r, i) => `<tr><td class="dim">${i + 1}</td>${sysCell(r.id)}<td class="num">${secBadge(r.sec)}</td><td class="dim">${esc(r.region)}</td>${sovCell(r.id)}<td class="num"><b>${fmt(r.npc)}</b></td><td class="num">${fmt(r.peak)}</td><td class="num dim">${fmt(r.active)}</td><td class="num">${fmt1(r.avg)}</td><td class="num ${r.ship ? 'warn' : 'dim'}">${r.ship ? fmt(r.ship) : ''}</td></tr>`).join('')}</tbody>
    </table></div>
    ${shown.length > 300 ? '<p class="hint">Showing the top 300. Use search or filters to narrow down, or export everything from Data &amp; export.</p>' : ''}`;

  // chart series
  const regionOf = id => sysRegion(id);
  if (TF[tf].hours) {
    const hrs = lastHours(TF[tf].hours);
    lineChart('rep', $('#repChart'), hrs.map(h => h.h.slice(5).replace('T', ' ') + 'h'), regionsTop.map(reg => ({
      label: reg, data: hrs.map(h => Object.entries(h.d).reduce((n, [id, k]) => n + (regionOf(id) === reg && inScope(id) ? k[0] : 0), 0)),
    })));
  } else {
    const from = TF[tf].from();
    const dayList = Object.keys(state.days).filter(d => !from || d >= from).sort();
    lineChart('rep', $('#repChart'), dayList.map(d => d.slice(5)), regionsTop.map(reg => ({
      label: reg, data: dayList.map(d => Object.entries(state.days[d].d).reduce((n, [id, k]) => n + (regionOf(id) === reg && inScope(id) ? k[0] : 0), 0)),
    })));
  }
}

// ---- Least used
async function viewLeast(v) {
  const ui = state.ui, f = state.f;
  const alliance = f.alliance;
  const allianceOpts = Object.entries(state.sov.alliances).sort((a, b) => a[1].localeCompare(b[1]));
  const head = `
    <div class="toolbar">
      <label class="inline">Alliance <input id="luAlliance" list="allianceList" value="${esc(alliance ? allianceName(alliance) : '')}" placeholder="Pick an alliance…" autocomplete="off"></label>
      <label class="inline">True-sec at or below <select id="luSec">${[[-0.45, '-0.5'], [-0.65, '-0.7'], [-0.75, '-0.8'], [-0.85, '-0.9'], [-0.95, '-1.0'], [1.1, 'any']].map(([v2, l]) => `<option value="${v2}" ${ui.luSec === v2 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="seg">${['1h', '24h', '7d', '30d'].map(k => `<button data-lutf="${k}" class="${k === ui.luTf ? 'on' : ''}">${SHORT[k]}</button>`).join('')}</span>
    </div>`;
  if (!alliance) {
    v.innerHTML = `${head}<div class="empty big"><h2>Least-used systems for an alliance</h2><p>Pick an alliance above (${allianceOpts.length} hold sovereignty right now). You'll see the systems it holds with the fewest NPC kills, so you can find quiet places to rat.</p></div>`;
    return;
  }
  const { totals, hours } = await totalsFor(ui.luTf);
  const q = ui.luQ.toLowerCase();
  const held = Object.entries(state.sov.systems).filter(([id, a]) => a === alliance && state.SYS[id] && sysSec(id) <= ui.luSec && (f.region === 'all' || String(state.SYS[id][1]) === String(f.region)));
  const rows = held.map(([id]) => { const s = totals[id] || { npc: 0, peak: 0, active: 0, ship: 0 }; return { id, name: sysName(id), sec: sysSec(id), region: sysRegion(id), ...s }; });
  const shown = sortRows('least', rows.filter(r => match(r.id, q)), 'npc', 1);
  const zero = rows.filter(r => !r.npc).length;
  v.innerHTML = `${head}
    <section class="stats">
      <div class="stat"><span>Systems held</span><b>${fmt(rows.length)}</b><small>${esc(allianceName(alliance))}, matching true-sec${f.region !== 'all' ? ` in ${esc(state.REG[f.region])}` : ''}</small></div>
      <div class="stat"><span>No NPC kills</span><b class="good">${fmt(zero)}</b><small>${TF[ui.luTf].label}</small></div>
      <div class="stat"><span>NPC kills</span><b>${fmt(rows.reduce((n, r) => n + r.npc, 0))}</b><small>across these systems</small></div>
      <div class="stat"><span>Ship kills</span><b class="${rows.some(r => r.ship) ? 'warn' : ''}">${fmt(rows.reduce((n, r) => n + r.ship, 0))}</b><small>players killed here</small></div>
    </section>
    <div class="toolbar">
      <input type="search" id="luQ" placeholder="Search system or region…" value="${esc(ui.luQ)}" autocomplete="off">
      <span class="dim">Fewest NPC kills first · ${hours ? `${fmt(hours)} hours of data` : ''}</span>
    </div>
    <div class="scroll-x"><table class="data">
      <thead><tr><th>#</th>${th('least', 'name', 'System')}${th('least', 'sec', 'True-sec', 'num')}${th('least', 'region', 'Region')}${th('least', 'npc', 'NPC kills', 'num')}${th('least', 'peak', 'Peak hour', 'num')}${th('least', 'active', 'Hours active', 'num')}${th('least', 'ship', 'Ship kills', 'num')}</tr></thead>
      <tbody>${shown.map((r, i) => `<tr><td class="dim">${i + 1}</td>${sysCell(r.id)}<td class="num">${secBadge(r.sec)} <small class="dim">${r.sec.toFixed(2)}</small></td><td class="dim">${esc(r.region)}</td><td class="num"><b class="${r.npc ? '' : 'good'}">${fmt(r.npc)}</b></td><td class="num">${fmt(r.peak)}</td><td class="num dim">${fmt(r.active)}</td><td class="num ${r.ship ? 'warn' : 'dim'}">${r.ship ? fmt(r.ship) : ''}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// ---- Pinned
async function viewPinned(v) {
  if (!state.me.logged_in) {
    v.innerHTML = '<div class="empty big"><h2>Pin the systems you care about</h2><p>Log in with EVE Online to keep a list of pinned systems with notes. It follows your character to any device.</p><a class="btn primary big" href="/auth/login">Log in with EVE Online</a></div>';
    return;
  }
  if (!state.pins.size) { v.innerHTML = '<div class="empty big"><h2>No pinned systems yet</h2><p>Click ☆ next to any system on the Live, Reports or Least used tabs.</p></div>'; return; }
  await ensureDays(daysAgo(29));
  if (state.hoursN < 48) await loadHours(48);
  const h1 = sumHours(lastHours(1)).totals, h24 = sumHours(lastHours(24)).totals, d7 = sumDays(daysAgo(6)).totals, d30 = sumDays(daysAgo(29)).totals;
  const ids = [...state.pins.keys()];
  const rows = sortRows('pins', ids.map(id => ({ id, name: sysName(id), sec: sysSec(id), region: sysRegion(id), note: state.pins.get(id), h1: h1[id]?.npc || 0, h24: h24[id]?.npc || 0, d7: d7[id]?.npc || 0, d30: d30[id]?.npc || 0, ship24: h24[id]?.ship || 0 })), 'name', 1);
  v.innerHTML = `
    <section class="panel chart-panel">
      <div class="panel-head"><h3>Pinned systems · NPC kills per hour, last 48 hours</h3><span class="dim">first 8 pins</span></div>
      <div class="chart-box"><canvas id="pinChart"></canvas></div>
    </section>
    <div class="scroll-x"><table class="data">
      <thead><tr>${th('pins', 'name', 'System')}${th('pins', 'sec', 'Sec', 'num')}${th('pins', 'region', 'Region')}<th>Sovereignty</th>${th('pins', 'h1', 'Last hour', 'num')}${th('pins', 'h24', '24 hours', 'num')}${th('pins', 'd7', '7 days', 'num')}${th('pins', 'd30', '30 days', 'num')}${th('pins', 'ship24', 'Ship kills 24h', 'num')}<th>Note</th></tr></thead>
      <tbody>${rows.map(r => `<tr>${sysCell(r.id)}<td class="num">${secBadge(r.sec)}</td><td class="dim">${esc(r.region)}</td>${sovCell(r.id)}<td class="num"><b>${fmt(r.h1)}</b></td><td class="num">${fmt(r.h24)}</td><td class="num">${fmt(r.d7)}</td><td class="num">${fmt(r.d30)}</td><td class="num ${r.ship24 ? 'warn' : 'dim'}">${r.ship24 || ''}</td>
        <td><input class="note" data-note="${r.id}" value="${esc(r.note)}" placeholder="Add a note…" maxlength="200"></td></tr>`).join('')}</tbody>
    </table></div>`;
  const hrs = lastHours(48);
  lineChart('pins', $('#pinChart'), hrs.map(h => h.h.slice(5).replace('T', ' ') + 'h'), ids.slice(0, 8).map(id => ({ label: sysName(id), data: hrs.map(h => h.d[id]?.[0] || 0) })));
}

// ---- Data & export
async function viewData(v) {
  const m = state.meta;
  v.innerHTML = `
    <div class="two-col">
      <section class="panel">
        <h3>What's stored</h3>
        <div class="kv"><span>Hourly snapshots</span><b>${fmt(m.hours)}</b></div>
        <div class="kv"><span>First / latest hour</span><b>${m.first_hour ? `${m.first_hour.replace('T', ' ')}:00 → ${m.last_hour.replace('T', ' ')}:00` : '—'}</b></div>
        <div class="kv"><span>Daily summaries</span><b>${fmt(m.days)} ${m.first_day ? `<small class="dim">(${m.first_day} → ${m.last_day})</small>` : ''}</b></div>
        <div class="kv"><span>Latest ESI data</span><b>${evetime(m.last_taken_at)} EVE</b></div>
        <div class="kv"><span>Sovereignty updated</span><b>${m.sov_updated ? ago(m.sov_updated) : '—'}</b></div>
        <p class="hint">Hourly data is kept for ${m.retention_days} days. Daily totals per system are kept forever. ESI publishes new numbers about once an hour and the tracker checks every 15 minutes.</p>
        ${state.me.logged_in ? '<button id="pollNow">Check ESI now</button>' : ''}
      </section>
      <section class="panel">
        <h3>Export CSV <small class="dim">(uses the filters on the left: ${esc(scopeLabel())})</small></h3>
        <div class="kv"><span>Hourly, last 24 hours</span><button data-export="h24">Download</button></div>
        <div class="kv"><span>Hourly, last 72 hours</span><button data-export="h72">Download</button></div>
        <div class="kv"><span>Daily, last 30 days</span><button data-export="d30">Download</button></div>
        <div class="kv"><span>Daily, all time</span><button data-export="dall">Download</button></div>
        <p class="hint">Hourly files have one row per system per hour with NPC, ship and pod kills. Daily files add the peak hour and how many hours had NPC kills.</p>
      </section>
    </div>`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvQ = s => `"${String(s).replace(/"/g, '""')}"`;
async function exportCsv(kind) {
  const lines = [];
  if (kind.startsWith('h')) {
    if (kind === 'h72' && state.hoursN < 72) await loadHours(72);
    lines.push('hour_utc,system_id,system,region,true_sec,sov_alliance,npc_kills,ship_kills,pod_kills');
    for (const h of lastHours(kind === 'h24' ? 24 : 72)) for (const [id, [npc = 0, ship = 0, pod = 0]] of Object.entries(h.d)) {
      if (!inScope(id)) continue;
      lines.push([h.h + ':00', id, csvQ(sysName(id)), csvQ(sysRegion(id)), sysSec(id).toFixed(3), csvQ(holder(id) ? allianceName(holder(id)) : ''), npc, ship, pod].join(','));
    }
  } else {
    const from = kind === 'd30' ? daysAgo(29) : null;
    await ensureDays(from);
    lines.push('day_utc,hours_recorded,system_id,system,region,true_sec,sov_alliance,npc_kills,npc_peak_hour,hours_with_npc_kills,ship_kills,pod_kills');
    for (const day of Object.keys(state.days).sort()) {
      if (from && day < from) continue;
      const { n, d } = state.days[day];
      for (const [id, [npc = 0, peak = 0, act = 0, ship = 0, pod = 0]] of Object.entries(d)) {
        if (!inScope(id)) continue;
        lines.push([day, n, id, csvQ(sysName(id)), csvQ(sysRegion(id)), sysSec(id).toFixed(3), csvQ(holder(id) ? allianceName(holder(id)) : ''), npc, peak, act, ship, pod].join(','));
      }
    }
  }
  download(`eve_kills_${kind}_${dayStr(new Date())}.csv`, lines.join('\n') + '\n');
  toast(`Exported ${fmt(lines.length - 1)} rows.`);
}

// ---------------------------------------------------------------- filters
function fillFilters() {
  const regs = Object.entries(state.REG).filter(([id]) => Object.values(state.SYS).some(s => String(s[1]) === id));
  const kspace = regs.filter(([id]) => Number(id) < 11000000).sort((a, b) => a[1].localeCompare(b[1]));
  const wspace = regs.filter(([id]) => Number(id) >= 11000000 && Number(id) < 12000000).sort((a, b) => a[1].localeCompare(b[1]));
  $('#fRegion').innerHTML = `<option value="all">All regions</option>
    <optgroup label="Known space">${kspace.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</optgroup>
    ${wspace.length ? `<optgroup label="Wormhole space">${wspace.map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</optgroup>` : ''}`;
  $('#allianceList').innerHTML = Object.values(state.sov.alliances).sort().map(n => `<option value="${esc(n)}">`).join('');
  const f = state.f;
  $('#fRegion').value = f.region; $('#fSov').value = f.sov; $('#fSec').value = f.sec;
  $('#fAlliance').value = f.alliance ? allianceName(f.alliance) : '';
  $('#allianceBox').hidden = !(f.sov === 'held' || f.sov === 'notheld');
}
const allianceByName = name => {
  const n = name.trim().toLowerCase();
  const hit = Object.entries(state.sov.alliances).find(([, v]) => v.toLowerCase() === n);
  return hit ? Number(hit[0]) : null;
};
function saveFilters() { ls.set('kt.filters', state.f); render(); }

// ---------------------------------------------------------------- events
document.addEventListener('click', async e => {
  const t = e.target;
  const tab = t.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; ls.set('kt.tab', state.tab); return render(); }
  const so = t.closest('[data-sort]');
  if (so) {
    const [key, col] = so.dataset.sort.split(':');
    const s = state.ui.sort[key] ||= { col, dir: -1 };
    if (s.col === col) s.dir *= -1; else { s.col = col; s.dir = ['name', 'region'].includes(col) ? 1 : -1; }
    return render();
  }
  const rtf = t.closest('[data-rtf]');
  if (rtf) { state.ui.rTf = rtf.dataset.rtf; return render(); }
  const lutf = t.closest('[data-lutf]');
  if (lutf) { state.ui.luTf = lutf.dataset.lutf; return render(); }
  const pin = t.closest('[data-pin]');
  if (pin) {
    if (!state.me.logged_in) { toast('Log in with EVE Online (top right) to pin systems.'); return; }
    const id = Number(pin.dataset.pin);
    try {
      if (state.pins.has(id)) { await api(`/api/pins/${id}`, { method: 'DELETE' }); state.pins.delete(id); }
      else { await api(`/api/pins/${id}`, { method: 'PUT', body: JSON.stringify({ note: '' }) }); state.pins.set(id, ''); toast(`Pinned ${sysName(id)}.`); }
      render();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (t.id === 'liveAll') { state.ui.liveAll = true; return render(); }
  if (t.id === 'fReset') { state.f = { region: 'all', sov: 'all', alliance: null, sec: 'all' }; fillFilters(); return saveFilters(); }
  const ex = t.closest('[data-export]');
  if (ex) { ex.disabled = true; try { await exportCsv(ex.dataset.export); } catch (err) { toast(err.message, 'error'); } ex.disabled = false; return; }
  if (t.id === 'pollNow') {
    t.disabled = true;
    try { const r = await api('/api/poll', { method: 'POST' }); toast(r.results.join(' · ')); await refresh(); }
    catch (err) { toast(err.message, 'error'); }
    t.disabled = false;
  }
});

let typing;
document.addEventListener('input', e => {
  const id = e.target.id;
  const keys = { liveQ: 'liveQ', rQ: 'rQ', luQ: 'luQ' };
  if (keys[id]) {
    state.ui[keys[id]] = e.target.value;
    clearTimeout(typing);
    typing = setTimeout(async () => {
      const pos = e.target.selectionStart;
      await render();
      const el = document.getElementById(id); el?.focus(); try { el?.setSelectionRange(pos, pos); } catch { /* ignore */ }
    }, 200);
  }
});

document.addEventListener('change', async e => {
  const t = e.target, f = state.f;
  if (t.id === 'fRegion') { f.region = t.value; return saveFilters(); }
  if (t.id === 'fSec') { f.sec = t.value; return saveFilters(); }
  if (t.id === 'fSov') { f.sov = t.value; $('#allianceBox').hidden = !(f.sov === 'held' || f.sov === 'notheld'); if (f.sov === 'all' || f.sov === 'nosov' || f.alliance) saveFilters(); return; }
  if (t.id === 'fAlliance' || t.id === 'luAlliance') {
    const a = allianceByName(t.value);
    if (!a && t.value.trim()) { toast('Pick an alliance from the list. Only alliances that hold sovereignty are listed.', 'error'); return; }
    f.alliance = a; $('#fAlliance').value = a ? allianceName(a) : '';
    return saveFilters();
  }
  if (t.id === 'luSec') { state.ui.luSec = Number(t.value); return render(); }
  if (t.dataset.note) {
    const id = Number(t.dataset.note);
    try { await api(`/api/pins/${id}`, { method: 'PUT', body: JSON.stringify({ note: t.value }) }); state.pins.set(id, t.value); toast('Note saved.'); }
    catch (err) { toast(err.message, 'error'); }
  }
});

// ---------------------------------------------------------------- boot
function renderWho() {
  const me = state.me;
  $('#who').innerHTML = me.logged_in
    ? `<span class="me"><img src="${IMG}/characters/${me.character_id}/portrait?size=64" alt="" width="26" height="26">${esc(me.character_name)} <a href="/auth/logout" class="dim">log out</a></span>`
    : '<a class="btn primary" href="/auth/login">Log in with EVE</a>';
}

async function refresh() {
  const [meta, sov] = await Promise.all([api('/api/meta', { cache: 'no-cache' }), api('/api/sov', { cache: 'no-cache' })]);
  state.meta = meta; state.sov = { systems: {}, alliances: {}, ...sov };
  for (const k of Object.keys(state.sov.systems)) state.sov.systems[k] = Number(state.sov.systems[k]);
  await loadHours();
  state.days = {}; state.daysLoaded = null;
  $('#status').textContent = meta.last_taken_at ? `ESI data ${ago(meta.last_taken_at)}` : 'Waiting for first data';
  fillFilters();
  await render();
}

async function boot() {
  $('#version').textContent = `v${APP_VERSION}`;
  const tick = () => { $('#evetime').textContent = new Date().toISOString().slice(11, 16); };
  tick(); setInterval(tick, 10_000);
  if (new URLSearchParams(location.search).has('login_error')) { toast('EVE login did not complete. Please try again.', 'error'); history.replaceState(null, '', '/'); }
  const [sys, me] = await Promise.all([fetch('/data/systems.json').then(r => r.json()), api('/api/me').catch(() => ({ logged_in: false }))]);
  state.SYS = sys.systems; state.REG = sys.regions; state.me = me;
  renderWho();
  if (me.logged_in) {
    try { for (const p of await api('/api/pins')) state.pins.set(p.system_id, p.note); } catch { /* ignore */ }
  }
  await refresh();
  setInterval(() => refresh().catch(() => {}), 10 * 60e3);   // pick up new hours while the page is open
}

boot().catch(e => { console.error(e); $('#view').innerHTML = `<div class="empty big warn">Could not load: ${esc(e.message)}</div>`; });
