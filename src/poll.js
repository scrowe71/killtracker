// Scheduled job: store ESI's hourly kill counts for every system, refresh sovereignty.
import { ensureSchema, getMeta, setMeta } from './db.js';

const ESI = 'https://esi.evetech.net/latest';
const UA = 'EVE Kill Tracker (https://killtracker.crankyape.space)';
export const RETENTION_DAYS = 90;           // hourly rows kept this long; daily rows kept forever
const SOV_EVERY_MS = 6 * 3600e3;

async function esi(path, init = {}, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetchImpl(ESI + path, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
    if (r.ok) return r;
    if (r.status >= 500 || r.status === 420 || r.status === 429) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); continue; }
    throw new Error(`ESI ${r.status} on ${path}`);
  }
  throw new Error(`ESI not responding on ${path}`);
}

const iso = d => new Date(d).toISOString().slice(0, 19) + 'Z';

/** Drops trailing zeros: [12,0,0] -> [12]. Readers treat missing values as 0. */
export const trim = a => { let n = a.length; while (n > 1 && !a[n - 1]) n--; return n === a.length ? a : a.slice(0, n); };

/** Fold one hour into that day's running totals: [npcTotal, npcPeak, hoursWithNpc, shipTotal, podTotal]. */
export function addHourToDay(day, hour) {
  for (const [sid, [npc = 0, ship = 0, pod = 0]] of Object.entries(hour)) {
    const d = day[sid] || [];
    for (let i = d.length; i < 5; i++) d[i] = 0;
    d[0] += npc; if (npc > d[1]) d[1] = npc; if (npc > 0) d[2]++;
    d[3] += ship; d[4] += pod;
    day[sid] = d;
  }
  for (const sid in day) day[sid] = trim(day[sid]);
  return day;
}

/** Store the latest ESI hour if it's new. Returns a short status string. */
export async function pollKills(env, fetchImpl = fetch, { force = false } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const r = await esi('/universe/system_kills/', {}, fetchImpl);
  const lm = r.headers.get('Last-Modified');
  const takenAt = iso(lm ? Date.parse(lm) : Date.now());
  const hour = takenAt.slice(0, 13);
  const last = await getMeta(db, 'last_taken_at');
  if (!force && last === takenAt) return `unchanged (${takenAt})`;
  if (await db.prepare('SELECT 1 FROM hours WHERE hour = ?').bind(hour).first()) {
    await setMeta(db, 'last_taken_at', takenAt).run();
    return `hour ${hour} already stored`;
  }

  const data = {};
  for (const k of await r.json()) {
    if (k.npc_kills || k.ship_kills || k.pod_kills) data[k.system_id] = trim([k.npc_kills || 0, k.ship_kills || 0, k.pod_kills || 0]);
  }
  const dayKey = hour.slice(0, 10);
  const dayRow = await db.prepare('SELECT hours, data FROM days WHERE day = ?').bind(dayKey).first();
  const day = addHourToDay(dayRow ? JSON.parse(dayRow.data) : {}, data);

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString().slice(0, 13);
  await db.batch([
    db.prepare('INSERT INTO hours (hour, taken_at, data) VALUES (?, ?, ?)').bind(hour, takenAt, JSON.stringify(data)),
    db.prepare('INSERT INTO days (day, hours, data) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET hours = excluded.hours, data = excluded.data')
      .bind(dayKey, (dayRow?.hours || 0) + 1, JSON.stringify(day)),
    setMeta(db, 'last_taken_at', takenAt),
    db.prepare('DELETE FROM hours WHERE hour < ?').bind(cutoff),
    db.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()),
  ]);
  return `stored ${hour}: ${Object.keys(data).length} systems`;
}

/** Sovereignty map + alliance names, refreshed every 6 hours. */
export async function pollSov(env, fetchImpl = fetch, { force = false } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const last = Number(await getMeta(db, 'sov_updated') || 0);
  if (!force && Date.now() - last < SOV_EVERY_MS) return 'sov fresh';
  const sov = await (await esi('/sovereignty/map/', {}, fetchImpl)).json();
  const systems = {}, ids = new Set();
  for (const s of sov) if (s.alliance_id) { systems[s.system_id] = s.alliance_id; ids.add(s.alliance_id); }
  const names = {};
  const list = [...ids];
  for (let i = 0; i < list.length; i += 1000) {
    try {
      const res = await (await esi('/universe/names/', { method: 'POST', body: JSON.stringify(list.slice(i, i + 1000)), headers: { 'Content-Type': 'application/json' } }, fetchImpl)).json();
      for (const n of res) names[n.id] = n.name;
    } catch { /* names are cosmetic; ids still work */ }
  }
  const now = Date.now();
  await db.batch([
    setMeta(db, 'sov', JSON.stringify({ updated: now, systems, alliances: names })),
    setMeta(db, 'sov_updated', now),
  ]);
  return `sov: ${Object.keys(systems).length} systems, ${list.length} alliances`;
}

export async function scheduled(env, fetchImpl = fetch) {
  const out = [];
  for (const job of [pollKills, pollSov]) {
    try { out.push(await job(env, fetchImpl)); }
    catch (e) { out.push(`${job.name} failed: ${e.message}`); console.error(job.name, e); }
  }
  console.log(out.join(' | '));
  return out;
}
