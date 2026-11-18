# EVE Kill Tracker

Hourly NPC, ship and pod kill numbers for **every system in EVE**, at https://killtracker.crankyape.space.

- **Live:** this hour's kills for every system, the hottest systems, and a 24-hour chart of the top 5.
- **Reports:** 24 hours, 7 / 30 / 90 days or all time. Shows NPC kills by region and a sortable leaderboard (total, peak hour, hours active, average per active hour, ship kills).
- **Least used:** pick any alliance that holds sovereignty plus a true-sec limit, and see the systems it holds with the fewest NPC kills, which makes it easy to find quiet ratting spots.
- **Pinned:** log in with EVE and pin systems, with notes. Pins are stored on the server, so they follow your character to any device.
- **Data & export:** CSV downloads, hourly (24 or 72 hours) or daily (30 days or all time).
- **Filters** apply to every tab: region, sovereignty (all space / held by an alliance / not held by it / no player sov) and true-sec band (high, low, null, wormholes).

## How it works
- One **Cloudflare Worker** serves the pages in `public/` and a small API.
- A **schedule** (every 15 minutes) reads ESI `/universe/system_kills/`. Each new hour is stored once, keyed by ESI's `Last-Modified` time. Sovereignty is refreshed every 6 hours.
- **D1 database:** one row per hour (kept 90 days) and one row per day (kept forever), each holding every system's numbers. That's only a few writes per hour, well inside Cloudflare's free limits. Tables are created automatically.
- **Login** uses EVE SSO with PKCE, so **there is no client secret** to store. It only proves which character you are, and asks for no ESI scopes.
- `public/data/systems.json` (8,490 systems with region and true-sec) is built from ESI by `tools/gen_systems.py`.

## Setup (one time)
1. **EVE application:** at https://developers.eveonline.com/applications, edit your old kill tracker app or create one named *EVE Kill Tracker*.
   - Connection type: **Authentication Only**, with no scopes.
   - Callback URL: `https://killtracker.crankyape.space/auth/callback`
   - Copy the **Client ID** into `wrangler.toml` as `EVE_CLIENT_ID`. The secret key is not used.
2. **Database:** in Cloudflare, go to **Storage & Databases → D1 → Create**, name it `killtracker`, and copy its **Database ID** into `wrangler.toml` as `database_id`.
3. **Push** this folder to GitHub (`scrowe71/killtracker`).
4. **Deploy:** go to **Workers & Pages → Create → Import a repository** and pick `killtracker`. Keep the defaults: no build command, deploy command `npx wrangler deploy`. Cloudflare reads everything else from `wrangler.toml`, including the schedule and the database.
5. **Domain:** open the Worker, go to **Settings → Domains & Routes → Add → Custom domain**, and enter `killtracker.crankyape.space`.

The first hour of data appears within 15 minutes of deploying. To trigger it straight away, log in, then use **Data & export → Check ESI now**.

## Notes
- Each hourly run uses about 3 ms of CPU, under the free plan's 10 ms limit. If Cloudflare ever reports "exceeded CPU" on the schedule, the $5/month Workers Paid plan removes the limit.
- To rebuild the system list after CCP adds systems, run `python tools/gen_systems.py public/data` and commit.
