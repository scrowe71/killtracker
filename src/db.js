// D1 schema. Created automatically on first use, so there is nothing to run by hand.
// Kill data is stored compactly: one row per hour and one row per day, each a JSON
// object keyed by system id. That keeps writes to a handful per hour, well inside
// Cloudflare's free limits, even though it covers every system in EVE.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hours (
     hour     TEXT PRIMARY KEY,           -- 'YYYY-MM-DDTHH' (UTC), from ESI's Last-Modified
     taken_at TEXT NOT NULL,              -- exact ESI Last-Modified time
     data     TEXT NOT NULL               -- {"systemId":[npc,ship,pod], ...}, trailing zeros dropped
   )`,
  `CREATE TABLE IF NOT EXISTS days (
     day   TEXT PRIMARY KEY,              -- 'YYYY-MM-DD' (UTC)
     hours INTEGER NOT NULL,              -- hourly snapshots folded in
     data  TEXT NOT NULL                  -- {"systemId":[npcTotal,npcPeak,hoursWithNpc,shipTotal,podTotal], ...}, trailing zeros dropped
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, character_id INTEGER NOT NULL, character_name TEXT NOT NULL, expires INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS characters (
     character_id INTEGER PRIMARY KEY, character_name TEXT NOT NULL, last_login TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS pins (
     character_id INTEGER NOT NULL, system_id INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', pinned_at TEXT NOT NULL,
     PRIMARY KEY (character_id, system_id)
   )`,
];

let ready = null;
export function ensureSchema(db) {
  return (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
}

export async function getMeta(db, key) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
