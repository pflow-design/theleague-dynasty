// Pull all data for the dynasty league from the public Sleeper API.
//
// Sleeper's read API is free and requires no auth. This script walks the
// dynasty league chain backwards via `previous_league_id`, and for each season
// pulls league settings, users, rosters, every week's matchups, the winners &
// losers playoff brackets, drafts + picks, and transactions. It also caches the
// NFL players catalog (slimmed to id -> name/pos/team) and current NFL state.
//
// Output: raw JSON under data/raw/ (gitignored). `build-data.mjs` turns this
// into the clean, versioned JSON the site builds from.
//
// Usage: node scripts/pull-sleeper.mjs [startLeagueId]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');

const START_LEAGUE_ID = process.argv[2] || '1314370265806835712';
const API = 'https://api.sleeper.app/v1';
const MAX_WEEK = 18; // NFL regular + playoffs upper bound

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(400 * (i + 1));
    }
  }
}

// Pull weekly data (matchups + transactions) for weeks 1..MAX_WEEK, stopping
// after a run of empty weeks so we don't hammer the API past the end of a season.
async function pullWeekly(leagueId) {
  const matchups = {};
  const transactions = {};
  let emptyStreak = 0;
  for (let w = 1; w <= MAX_WEEK; w++) {
    const [m, t] = await Promise.all([
      get(`${API}/league/${leagueId}/matchups/${w}`),
      get(`${API}/league/${leagueId}/transactions/${w}`),
    ]);
    const hasMatchups = Array.isArray(m) && m.some((x) => x && (x.points || (x.starters && x.starters.length)));
    if (hasMatchups) { matchups[w] = m; emptyStreak = 0; }
    else emptyStreak++;
    if (Array.isArray(t) && t.length) transactions[w] = t;
    if (emptyStreak >= 3 && w > 4) break; // past the end of a played season
  }
  return { matchups, transactions };
}

async function pullDrafts(leagueId) {
  const drafts = await get(`${API}/league/${leagueId}/drafts`);
  const out = [];
  for (const d of drafts || []) {
    const picks = await get(`${API}/draft/${d.draft_id}/picks`);
    out.push({ ...d, picks });
  }
  return out;
}

async function pullSeason(leagueId) {
  const league = await get(`${API}/league/${leagueId}`);
  console.log(`  · ${league.season} "${league.name}" (${league.status})`);
  const [users, rosters, winners_bracket, losers_bracket, drafts, weekly] = await Promise.all([
    get(`${API}/league/${leagueId}/users`),
    get(`${API}/league/${leagueId}/rosters`),
    get(`${API}/league/${leagueId}/winners_bracket`).catch(() => null),
    get(`${API}/league/${leagueId}/losers_bracket`).catch(() => null),
    pullDrafts(leagueId),
    pullWeekly(leagueId),
  ]);
  return {
    leagueId,
    season: league.season,
    league,
    users,
    rosters,
    winners_bracket,
    losers_bracket,
    drafts,
    matchups: weekly.matchups,
    transactions: weekly.transactions,
    pulledAt: new Date().toISOString(),
  };
}

// The NFL players catalog is ~5MB; slim it to what the site needs and cache it.
async function pullPlayers() {
  const dest = path.join(RAW, 'players-nfl.json');
  if (existsSync(dest)) {
    const stat = JSON.parse(await readFile(dest, 'utf8'));
    console.log(`  · players catalog cached (${Object.keys(stat).length} players) — delete data/raw/players-nfl.json to refresh`);
    return;
  }
  console.log('  · fetching NFL players catalog (~5MB, one-time)…');
  const all = await get(`${API}/players/nfl`);
  const slim = {};
  for (const [id, p] of Object.entries(all)) {
    if (!p) continue;
    slim[id] = {
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.last_name || id,
      pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || null,
      team: p.team || null,
    };
  }
  // Defenses (DST) come through as team codes, not numeric ids.
  await writeFile(dest, JSON.stringify(slim));
  console.log(`  · saved ${Object.keys(slim).length} players`);
}

async function main() {
  await mkdir(RAW, { recursive: true });

  console.log('Pulling NFL metadata…');
  const state = await get(`${API}/state/nfl`);
  await writeFile(path.join(RAW, 'state-nfl.json'), JSON.stringify(state, null, 2));
  await pullPlayers();

  console.log('Walking dynasty league chain…');
  const chain = [];
  let id = START_LEAGUE_ID;
  while (id) {
    const season = await pullSeason(id);
    chain.push({ season: season.season, leagueId: season.leagueId });
    await writeFile(path.join(RAW, `season-${season.season}.json`), JSON.stringify(season, null, 2));
    id = season.league.previous_league_id;
  }

  await writeFile(path.join(RAW, 'chain.json'), JSON.stringify(chain, null, 2));
  console.log(`\nDone. ${chain.length} seasons: ${chain.map((c) => c.season).join(', ')}`);
  console.log(`Raw data in ${path.relative(ROOT, RAW)}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
