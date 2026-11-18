// EVE Kill Tracker: Cloudflare Worker.
//   * scheduled():  every 15 min, stores the newest hourly ESI kill counts and (every 6h) sovereignty
//   * /auth/*:      EVE SSO login (PKCE, no client secret), sessions in D1
//   * /api/*:       kill data, sovereignty, per-character pinned systems
//   * everything else: static files in /public
import { ensureSchema, getMeta } from './db.js';
import { scheduled, RETENTION_DAYS } from './poll.js';
import { verifyEveToken } from './jwt.js';

const SSO = 'https://login.eveonline.com/v2/oauth';
const SESSION_DAYS = 30;

// ---------------------------------------------------------------- helpers
const json = (data, status = 200, headers = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const fail = (status, error) => json({ error }, status);
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const cookies = req => Object.fromEntries((req.headers.get('Cookie') || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const cookie = (name, value, { maxAge, path = '/' } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
const redirect = (to, setCookies = []) => {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store' });
  for (const c of setCookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const validSystem = id => Number.isInteger(id) && id >= 30000000 && id < 33000000;

/** Joins stored JSON strings without parsing them (keeps CPU time tiny). */
const hourRows = rows => `[${rows.map(r => `{"h":"${r.hour}","t":"${r.taken_at}","d":${r.data}}`).join(',')}]`;
const dayRows = rows => `[${rows.map(r => `{"day":"${r.day}","n":${r.hours},"d":${r.data}}`).join(',')}]`;

async function currentUser(req, env) {
  const sid = cookies(req).kt_sess;
  if (!sid) return null;
  const row = await env.DB.prepare('SELECT character_id, character_name, expires FROM sessions WHERE id = ?').bind(sid).first();
  if (!row || row.expires < Date.now()) return null;
  return { id: row.character_id, name: row.character_name, sid };
}

// ---------------------------------------------------------------- auth
const callbackUrl = (req, env) => env.EVE_CALLBACK_URL || `${new URL(req.url).origin}/auth/callback`;

async function authLogin(req, env) {
  if (!env.EVE_CLIENT_ID) return new Response('EVE_CLIENT_ID is not set in wrangler.toml', { status: 500 });
  const verifier = randomId(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomId(16);
  const p = new URLSearchParams({
    response_type: 'code', redirect_uri: callbackUrl(req, env), client_id: env.EVE_CLIENT_ID,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  return redirect(`${SSO}/authorize?${p}`, [cookie('kt_oauth', `${state}.${verifier}`, { maxAge: 600, path: '/auth' })]);
}

async function authCallback(req, env, fetchImpl = fetch) {
  const url = new URL(req.url);
  const clear = cookie('kt_oauth', '', { maxAge: 0, path: '/auth' });
  const [state, verifier] = (cookies(req).kt_oauth || '').split('.');
  if (url.searchParams.get('error') || !state || state !== url.searchParams.get('state')) return redirect('/?login_error=1', [clear]);
  try {
    const r = await fetchImpl(`${SSO}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', client_id: env.EVE_CLIENT_ID, code_verifier: verifier }),
    });
    if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const who = await verifyEveToken((await r.json()).access_token, { CLIENT_ID: env.EVE_CLIENT_ID }, fetchImpl);
    const sid = randomId(32);
    await ensureSchema(env.DB);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO sessions (id, character_id, character_name, expires) VALUES (?, ?, ?, ?)').bind(sid, who.id, who.name, Date.now() + SESSION_DAYS * 86400e3),
      env.DB.prepare(`INSERT INTO characters (character_id, character_name, last_login) VALUES (?, ?, ?)
        ON CONFLICT(character_id) DO UPDATE SET character_name = excluded.character_name, last_login = excluded.last_login`).bind(who.id, who.name, new Date().toISOString()),
    ]);
    return redirect('/', [clear, cookie('kt_sess', sid, { maxAge: SESSION_DAYS * 86400 })]);
  } catch (e) {
    console.error('login failed', e);
    return redirect('/?login_error=1', [clear]);
  }
}

async function authLogout(req, env) {
  const u = await currentUser(req, env);
  if (u) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(u.sid).run();
  return redirect('/', [cookie('kt_sess', '', { maxAge: 0 })]);
}

// ---------------------------------------------------------------- api
async function api(req, env, path, fetchImpl) {
  const db = env.DB;
  const q = new URL(req.url).searchParams;
  const m = req.method;

  if (path === '/api/me' && m === 'GET') {
    const u = await currentUser(req, env);
    return json(u ? { logged_in: true, character_id: u.id, character_name: u.name } : { logged_in: false });
  }

  if (path === '/api/meta' && m === 'GET') {
    const [h, d, last, sovUpd] = await Promise.all([
      db.prepare('SELECT MIN(hour) AS first, MAX(hour) AS last, COUNT(*) AS n FROM hours').first(),
      db.prepare('SELECT MIN(day) AS first, MAX(day) AS last, COUNT(*) AS n FROM days').first(),
      getMeta(db, 'last_taken_at'), getMeta(db, 'sov_updated'),
    ]);
    return json({ first_hour: h.first, last_hour: h.last, hours: h.n, first_day: d.first, last_day: d.last, days: d.n,
      last_taken_at: last, sov_updated: sovUpd ? Number(sovUpd) : null, retention_days: RETENTION_DAYS }, 200, { 'Cache-Control': 'public, max-age=60' });
  }

  if (path === '/api/latest' && m === 'GET') {
    const row = await db.prepare('SELECT hour, taken_at, data FROM hours ORDER BY hour DESC LIMIT 1').first();
    return json(row ? hourRows([row]).slice(1, -1) : 'null', 200, { 'Cache-Control': 'public, max-age=120' });
  }

  // last N hours (max 72), newest data for the live view and 24h/48h charts
  if (path === '/api/hours' && m === 'GET') {
    const n = Math.min(72, Math.max(1, Number(q.get('n')) || 24));
    const { results } = await db.prepare('SELECT hour, taken_at, data FROM (SELECT * FROM hours ORDER BY hour DESC LIMIT ?) ORDER BY hour ASC').bind(n).all();
    return json(hourRows(results), 200, { 'Cache-Control': 'public, max-age=120' });
  }

  // every hour of one UTC day; past days never change, so they can be cached for good
  const dh = path.match(/^\/api\/day-hours\/(\d{4}-\d{2}-\d{2})$/);
  if (dh && m === 'GET') {
    const { results } = await db.prepare('SELECT hour, taken_at, data FROM hours WHERE hour >= ? AND hour <= ? ORDER BY hour').bind(`${dh[1]}T00`, `${dh[1]}T23`).all();
    const done = dh[1] < today();
    return json(hourRows(results), 200, { 'Cache-Control': done ? 'public, max-age=31536000, immutable' : 'public, max-age=120' });
  }

  if (path === '/api/days' && m === 'GET') {
    const from = q.get('from'), to = q.get('to') || today();
    if (from && !DAY_RE.test(from) || !DAY_RE.test(to)) return fail(400, 'from/to must be YYYY-MM-DD');
    const { results } = from
      ? await db.prepare('SELECT day, hours, data FROM days WHERE day >= ? AND day <= ? ORDER BY day').bind(from, to).all()
      : await db.prepare('SELECT day, hours, data FROM days WHERE day <= ? ORDER BY day').bind(to).all();
    return json(dayRows(results), 200, { 'Cache-Control': to < today() ? 'public, max-age=86400' : 'public, max-age=120' });
  }

  if (path === '/api/sov' && m === 'GET') {
    return json((await getMeta(db, 'sov')) || '{"updated":null,"systems":{},"alliances":{}}', 200, { 'Cache-Control': 'public, max-age=600' });
  }

  // ---- logged-in only
  const user = await currentUser(req, env);
  if (path === '/api/pins' && m === 'GET') {
    if (!user) return fail(401, 'Log in with EVE to see your pinned systems');
    const { results } = await db.prepare('SELECT system_id, note, pinned_at FROM pins WHERE character_id = ? ORDER BY pinned_at').bind(user.id).all();
    return json(results);
  }
  const pin = path.match(/^\/api\/pins\/(\d+)$/);
  if (pin) {
    if (!user) return fail(401, 'Log in with EVE to pin systems');
    const sid = Number(pin[1]);
    if (!validSystem(sid)) return fail(400, 'Not a solar system id');
    if (m === 'PUT') {
      let body = {};
      try { body = await req.json(); } catch { /* no body */ }
      const note = String(body.note ?? '').slice(0, 200);
      const count = await db.prepare('SELECT COUNT(*) AS n FROM pins WHERE character_id = ?').bind(user.id).first();
      if (count.n >= 200) return fail(400, 'Pin limit (200) reached');
      await db.prepare(`INSERT INTO pins (character_id, system_id, note, pinned_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(character_id, system_id) DO UPDATE SET note = excluded.note`).bind(user.id, sid, note, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await db.prepare('DELETE FROM pins WHERE character_id = ? AND system_id = ?').bind(user.id, sid).run();
      return json({ ok: true });
    }
  }

  // manual "check ESI now" (the schedule does this anyway every 15 minutes)
  if (path === '/api/poll' && m === 'POST') {
    if (!user) return fail(401, 'Log in first');
    const last = Number(await getMeta(db, 'manual_poll') || 0);
    if (Date.now() - last < 5 * 60e3) return fail(429, 'Checked less than 5 minutes ago');
    await db.prepare("INSERT INTO meta (key, value) VALUES ('manual_poll', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
    return json({ results: await scheduled(env, fetchImpl) });
  }

  return fail(404, 'Not found');
}

// ---------------------------------------------------------------- entry
export async function handle(req, env, fetchImpl = fetch) {
  const path = new URL(req.url).pathname;
  try {
    if (path.startsWith('/auth/') || path.startsWith('/api/')) await ensureSchema(env.DB);
    if (path === '/auth/login') return authLogin(req, env);
    if (path === '/auth/callback') return authCallback(req, env, fetchImpl);
    if (path === '/auth/logout') return authLogout(req, env);
    if (path.startsWith('/api/')) return await api(req, env, path, fetchImpl);
  } catch (e) {
    console.error(e);
    return fail(500, 'Server error');
  }
  return env.ASSETS.fetch(req);
}

export default {
  fetch: (req, env) => handle(req, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(scheduled(env)),
};
