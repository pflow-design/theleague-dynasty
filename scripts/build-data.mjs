// Transform raw Sleeper data (data/raw/) into clean, versioned JSON the site
// builds from. Run `node scripts/pull-sleeper.mjs` first.
//
// Key league facts (auto-detected, but worth knowing):
//  · 10-team dynasty, seasons 2022 (startup) → 2026 (upcoming).
//  · `league_average_match = 1`: each week you also play the league MEDIAN, so
//    official W-L (roster.settings.wins/losses) counts two games per week.
//    Standings use that official record; head-to-head/streaks/records use the
//    ACTUAL opponent matchups (weeks 1..playoff_week_start-1 = regular season).
//
// Outputs:
//  data/league.json, data/managers.json, data/champions.json, data/records.json,
//  data/h2h.json, data/drafts.json, data/transactions.json,
//  data/seasons/{year}.json, and static/boxscores/{year}.json (client-fetched).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const DATA = path.join(ROOT, 'data');
const SEASONS_DIR = path.join(DATA, 'seasons');
const BOX_DIR = path.join(ROOT, 'static', 'boxscores');

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const round2 = (n) => Math.round(n * 100) / 100;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function pts(settings, key) {
  // Sleeper stores points split into integer + `_decimal` (hundredths).
  const whole = settings[key] || 0;
  const dec = settings[`${key}_decimal`] || 0;
  return round2(whole + dec / 100);
}

async function main() {
  const chain = await readJson(path.join(RAW, 'chain.json'));
  const state = await readJson(path.join(RAW, 'state-nfl.json'));
  const players = await readJson(path.join(RAW, 'players-nfl.json'));
  const years = chain.map((c) => Number(c.season)).sort((a, b) => a - b);

  const raw = {};
  for (const y of years) raw[y] = await readJson(path.join(RAW, `season-${y}.json`));

  const playerName = (id) => (players[id]?.name) || (isNaN(id) ? id : `#${id}`); // DST come as team codes
  const playerPos = (id) => players[id]?.pos || (isNaN(id) ? 'DEF' : null);

  // ---- Franchises (stable dynasty identity = Sleeper user_id) ----
  const franchises = new Map(); // userId -> franchise
  for (const y of years) {
    const s = raw[y];
    const byId = Object.fromEntries(s.users.map((u) => [u.user_id, u]));
    for (const r of s.rosters) {
      const u = byId[r.owner_id];
      if (!u) continue;
      let f = franchises.get(r.owner_id);
      if (!f) {
        f = { userId: r.owner_id, key: slug(u.display_name), display: u.display_name,
              avatar: u.avatar || null, teamNames: {}, seasons: [] };
        franchises.set(r.owner_id, f);
      }
      f.display = u.display_name;
      if (u.avatar) f.avatar = u.avatar;
      const tn = u.metadata?.team_name;
      if (tn) f.teamNames[y] = tn;
      if (!f.seasons.includes(y)) f.seasons.push(y);
    }
  }
  const userToKey = new Map([...franchises.values()].map((f) => [f.userId, f.key]));
  // roster_id -> franchise key, per season
  const rosterKey = {};
  for (const y of years) {
    rosterKey[y] = {};
    for (const r of raw[y].rosters) rosterKey[y][r.roster_id] = userToKey.get(r.owner_id) || `roster-${r.roster_id}`;
  }
  const teamNameFor = (key, year) => {
    const f = [...franchises.values()].find((x) => x.key === key);
    if (!f) return key;
    return f.teamNames[year] || f.teamNames[Math.max(...Object.keys(f.teamNames).map(Number))] || f.display;
  };

  // ---- Bracket resolution ----
  // Sleeper bracket rows: {m,r,t1,t2,w,l,p}. t1/t2 may be a roster_id or a ref
  // {w:matchId}/{l:matchId}. p = final placement game (1 = championship).
  function resolveBracket(bracket, year) {
    if (!Array.isArray(bracket)) return [];
    const byM = Object.fromEntries(bracket.map((g) => [g.m, g]));
    const ref = (t) => {
      if (t == null) return null;
      if (typeof t === 'number') return { key: rosterKey[year][t], roster: t };
      if (t.w) return { fromWinner: t.w };
      if (t.l) return { fromLoser: t.l };
      return null;
    };
    return bracket.map((g) => ({
      m: g.m, r: g.r, p: g.p ?? null,
      t1: ref(g.t1), t2: ref(g.t2),
      winner: g.w != null ? { key: rosterKey[year][g.w], roster: g.w } : null,
      loser: g.l != null ? { key: rosterKey[year][g.l], roster: g.l } : null,
    }));
  }
  function championOf(year) {
    const wb = raw[year].winners_bracket;
    if (!Array.isArray(wb) || !wb.length) return null;
    let finalGame = wb.find((g) => g.p === 1);
    if (!finalGame) { const maxR = Math.max(...wb.map((g) => g.r)); finalGame = wb.find((g) => g.r === maxR); }
    if (!finalGame || finalGame.w == null) return null;
    return { key: rosterKey[year][finalGame.w], roster: finalGame.w };
  }
  function runnerUpOf(year) {
    const wb = raw[year].winners_bracket;
    if (!Array.isArray(wb) || !wb.length) return null;
    let finalGame = wb.find((g) => g.p === 1);
    if (!finalGame) { const maxR = Math.max(...wb.map((g) => g.r)); finalGame = wb.find((g) => g.r === maxR); }
    if (!finalGame || finalGame.l == null) return null;
    return { key: rosterKey[year][finalGame.l], roster: finalGame.l };
  }

  // ---- Per-season build ----
  await mkdir(SEASONS_DIR, { recursive: true });
  await mkdir(BOX_DIR, { recursive: true });

  const seasonsOut = [];
  const boxscores = {};      // year -> weeks
  const h2h = {};            // "keyA|keyB" -> agg
  const weeklyByKey = {};    // key -> [{year,week,points,oppPoints,result,isPlayoff}]
  const seasonPFByKey = {};  // `${key}|${year}` -> pf total (reg season actual)

  const addH2H = (a, b, aPts, bPts, year, week, isPlayoff) => {
    const id = [a, b].sort().join('|');
    if (!h2h[id]) h2h[id] = { a: [a, b].sort()[0], b: [a, b].sort()[1], games: 0, aWins: 0, bWins: 0, ties: 0, aPts: 0, bPts: 0, playoffGames: 0, meetings: [] };
    const H = h2h[id];
    const [x] = [a, b].sort();
    const first = x === a ? { p: aPts, o: bPts, self: a } : { p: bPts, o: aPts, self: b };
    H.games++;
    if (isPlayoff) H.playoffGames++;
    H.aPts += H.a === a ? aPts : bPts;
    H.bPts += H.b === a ? aPts : bPts;
    if (aPts > bPts) { if (a === H.a) H.aWins++; else H.bWins++; }
    else if (bPts > aPts) { if (b === H.a) H.aWins++; else H.bWins++; }
    else H.ties++;
    H.meetings.push({ year, week, aKey: H.a, bKey: H.b, aPts: H.a === a ? aPts : bPts, bPts: H.b === a ? aPts : bPts, isPlayoff });
  };

  for (const y of years) {
    const s = raw[y];
    const set = s.league.settings;
    const playoffStart = set.playoff_week_start || 15;
    const regWeeks = playoffStart - 1;
    const isUpcoming = s.league.status !== 'complete' && !Object.keys(s.matchups).some((w) => s.matchups[w].some((m) => m.points > 0));

    // Standings from official roster settings (includes median games)
    let standings = s.rosters.map((r) => {
      const key = rosterKey[y][r.roster_id];
      return {
        roster_id: r.roster_id, managerKey: key, manager: (franchises.get(r.owner_id)?.display) || key,
        team: teamNameFor(key, y),
        w: r.settings.wins || 0, l: r.settings.losses || 0, t: r.settings.ties || 0,
        pf: pts(r.settings, 'fpts'), pa: pts(r.settings, 'fpts_against'), ppts: pts(r.settings, 'ppts'),
      };
    });
    standings.forEach((x) => (x.diff = round2(x.pf - x.pa)));
    if (!isUpcoming) {
      standings.sort((a, b) => (b.w - a.w) || (b.pf - a.pf));
      standings.forEach((x, i) => (x.rank = i + 1));
    } else {
      standings.sort((a, b) => a.team.localeCompare(b.team));
    }

    // Weekly actual matchups (pair by matchup_id)
    const weeklyScores = {};
    const boxWeeks = {};
    for (const w of Object.keys(s.matchups).map(Number).sort((a, b) => a - b)) {
      const entries = s.matchups[w];
      if (!entries.some((m) => m.points > 0)) continue;
      const isPlayoff = w >= playoffStart;
      const byMatch = {};
      for (const m of entries) (byMatch[m.matchup_id] = byMatch[m.matchup_id] || []).push(m);
      const rows = [];
      const box = [];
      for (const pair of Object.values(byMatch)) {
        const [m1, m2] = pair;
        const mk = (m) => rosterKey[y][m.roster_id];
        if (m1 && m2) {
          const r1 = m1.points > m2.points ? 'W' : m1.points < m2.points ? 'L' : 'T';
          const r2 = r1 === 'W' ? 'L' : r1 === 'L' ? 'W' : 'T';
          rows.push({ managerKey: mk(m1), points: round2(m1.points), oppKey: mk(m2), oppPoints: round2(m2.points), result: r1, isPlayoff });
          rows.push({ managerKey: mk(m2), points: round2(m2.points), oppKey: mk(m1), oppPoints: round2(m1.points), result: r2, isPlayoff });
          if (!isPlayoff) addH2H(mk(m1), mk(m2), m1.points, m2.points, y, w, isPlayoff);
          else addH2H(mk(m1), mk(m2), m1.points, m2.points, y, w, isPlayoff);
        }
        for (const m of pair) {
          if (!m) continue;
          box.push({
            managerKey: mk(m), points: round2(m.points),
            starters: (m.starters || []).map((pid) => ({ id: pid, name: playerName(pid), pos: playerPos(pid), pts: round2((m.players_points || {})[pid] || 0) })),
          });
        }
      }
      weeklyScores[w] = rows;
      boxWeeks[w] = { isPlayoff, teams: box };
      // track per-key weekly (regular season only) for streaks/records
      if (!isPlayoff) {
        for (const row of rows) {
          (weeklyByKey[row.managerKey] = weeklyByKey[row.managerKey] || []).push({ year: y, week: w, points: row.points, oppPoints: row.oppPoints, result: row.result });
          const pk = `${row.managerKey}|${y}`;
          seasonPFByKey[pk] = round2((seasonPFByKey[pk] || 0) + row.points);
        }
      }
    }
    boxscores[y] = boxWeeks;

    const champion = isUpcoming ? null : championOf(y);
    const runnerUp = isUpcoming ? null : runnerUpOf(y);
    if (champion) champion.team = teamNameFor(champion.key, y);

    const seasonObj = {
      year: y, leagueId: s.leagueId, status: s.league.status, upcoming: isUpcoming,
      teams: s.league.total_rosters, regularSeasonWeeks: regWeeks, playoffWeekStart: playoffStart,
      playoffTeams: set.playoff_teams || 6, medianGames: set.league_average_match === 1,
      champion, runnerUp,
      standings,
      playoffs: { winners: resolveBracket(s.winners_bracket, y), losers: resolveBracket(s.losers_bracket, y) },
      weeklyScores,
    };
    await writeFile(path.join(SEASONS_DIR, `${y}.json`), JSON.stringify(seasonObj, null, 2));
    await writeFile(path.join(BOX_DIR, `${y}.json`), JSON.stringify({ year: y, weeks: boxWeeks }));
    seasonsOut.push({ year: y, upcoming: isUpcoming, champion });
  }

  // ---- Champions ----
  const titlesByManager = {};
  const byYear = [];
  for (const so of seasonsOut) {
    if (so.champion) {
      byYear.push({ year: so.year, champion: so.champion.key, team: so.champion.team });
      titlesByManager[so.champion.key] = (titlesByManager[so.champion.key] || 0) + 1;
    }
  }
  await writeFile(path.join(DATA, 'champions.json'), JSON.stringify({ byYear, titlesByManager }, null, 2));

  // ---- Managers (career aggregates, regular season actual + official) ----
  const completeYears = seasonsOut.filter((s) => !s.upcoming).map((s) => s.year);
  const managers = [...franchises.values()].map((f) => {
    const titles = titlesByManager[f.key] || 0;
    return { key: f.key, userId: f.userId, display: f.display, avatar: f.avatar,
             teamName: f.teamNames[Math.max(...Object.keys(f.teamNames).map(Number) )] || f.display,
             teamNames: f.teamNames, seasons: f.seasons.sort(), titles };
  });
  // fill career records from season files
  for (const m of managers) { m.w = 0; m.l = 0; m.t = 0; m.pf = 0; m.pa = 0; m.playoffApps = 0; m.bestFinish = null; }
  for (const y of completeYears) {
    const s = await readJson(path.join(SEASONS_DIR, `${y}.json`));
    for (const st of s.standings) {
      const m = managers.find((x) => x.key === st.managerKey);
      if (!m) continue;
      m.w += st.w; m.l += st.l; m.t += st.t; m.pf = round2(m.pf + st.pf); m.pa = round2(m.pa + st.pa);
      if (st.rank <= s.playoffTeams) m.playoffApps++;
    }
    // best finish via champion / bracket placement (champion only for now)
    if (s.champion) { const m = managers.find((x) => x.key === s.champion.key); if (m) m.bestFinish = 1; }
  }
  managers.sort((a, b) => (b.titles - a.titles) || (b.w - a.w) || (b.pf - a.pf));
  await writeFile(path.join(DATA, 'managers.json'), JSON.stringify({ managers, seasons: years, currentSeason: Number(state.season) }, null, 2));

  // ---- H2H aggregates (finalize) ----
  const h2hOut = Object.values(h2h).map((H) => {
    H.aPts = round2(H.aPts); H.bPts = round2(H.bPts);
    H.meetings.sort((x, y) => (x.year - y.year) || (x.week - y.week));
    const last = H.meetings[H.meetings.length - 1];
    return { ...H, lastMeeting: last ? { year: last.year, week: last.week } : null };
  });
  await writeFile(path.join(DATA, 'h2h.json'), JSON.stringify({ pairs: h2hOut }, null, 2));

  // ---- Records (regular season, actual matchups) ----
  const rec = { highWeek: null, lowWeek: null, blowout: null, nailbiter: null, highSeason: null, mostWins: null, longestWinStreak: null, longestLossStreak: null, bestPlayerWeek: null };
  const seasonFiles = {};
  for (const y of completeYears) seasonFiles[y] = await readJson(path.join(SEASONS_DIR, `${y}.json`));

  for (const y of completeYears) {
    const s = seasonFiles[y];
    for (const w of Object.keys(s.weeklyScores)) {
      for (const row of s.weeklyScores[w]) {
        if (row.isPlayoff) continue;
        if (!rec.highWeek || row.points > rec.highWeek.value) rec.highWeek = { key: row.managerKey, value: row.points, year: y, week: +w };
        if (!rec.lowWeek || row.points < rec.lowWeek.value) rec.lowWeek = { key: row.managerKey, value: row.points, year: y, week: +w };
        const margin = round2(row.points - row.oppPoints);
        if (margin > 0 && (!rec.blowout || margin > rec.blowout.value)) rec.blowout = { key: row.managerKey, oppKey: row.oppKey, value: margin, year: y, week: +w, score: `${row.points}–${row.oppPoints}` };
        if (margin > 0 && (!rec.nailbiter || margin < rec.nailbiter.value)) rec.nailbiter = { key: row.managerKey, oppKey: row.oppKey, value: margin, year: y, week: +w, score: `${row.points}–${row.oppPoints}` };
      }
    }
    // season PF + wins leaders (official)
    for (const st of s.standings) {
      if (!rec.highSeason || st.pf > rec.highSeason.value) rec.highSeason = { key: st.managerKey, value: st.pf, year: y };
      if (!rec.mostWins || st.w > rec.mostWins.value) rec.mostWins = { key: st.managerKey, value: st.w, year: y };
    }
  }
  // streaks from weeklyByKey (chronological, regular season)
  for (const [key, games] of Object.entries(weeklyByKey)) {
    games.sort((a, b) => (a.year - b.year) || (a.week - b.week));
    let ws = 0, ls = 0;
    for (const g of games) {
      if (g.result === 'W') { ws++; ls = 0; } else if (g.result === 'L') { ls++; ws = 0; } else { ws = 0; ls = 0; }
      if (!rec.longestWinStreak || ws > rec.longestWinStreak.value) rec.longestWinStreak = { key, value: ws, year: g.year, week: g.week };
      if (!rec.longestLossStreak || ls > rec.longestLossStreak.value) rec.longestLossStreak = { key, value: ls, year: g.year, week: g.week };
    }
  }
  // best single-player week from box scores (regular season)
  for (const y of completeYears) {
    const box = boxscores[y];
    for (const w of Object.keys(box)) {
      if (box[w].isPlayoff) continue;
      for (const team of box[w].teams) {
        for (const p of team.starters) {
          if (!rec.bestPlayerWeek || p.pts > rec.bestPlayerWeek.value) rec.bestPlayerWeek = { key: team.managerKey, player: p.name, pos: p.pos, value: p.pts, year: y, week: +w };
        }
      }
    }
  }
  await writeFile(path.join(DATA, 'records.json'), JSON.stringify(rec, null, 2));

  // ---- Drafts ----
  const draftsOut = [];
  for (const y of years) {
    for (const d of raw[y].drafts) {
      draftsOut.push({
        year: y, draftId: d.draft_id, type: d.type, rounds: d.settings?.rounds,
        startTime: d.start_time || null, status: d.status,
        kind: (d.settings?.rounds || 0) > 10 ? 'startup' : 'rookie',
        picks: (d.picks || []).map((p) => ({
          round: p.round, pick_no: p.pick_no, managerKey: rosterKey[y][p.roster_id] || null,
          player: p.metadata ? `${p.metadata.first_name || ''} ${p.metadata.last_name || ''}`.trim() : playerName(p.player_id),
          pos: p.metadata?.position || playerPos(p.player_id), nflTeam: p.metadata?.team || null,
          isKeeper: !!p.is_keeper,
        })),
      });
    }
  }
  draftsOut.sort((a, b) => b.year - a.year);
  await writeFile(path.join(DATA, 'drafts.json'), JSON.stringify({ drafts: draftsOut }, null, 2));

  // ---- Transactions (trades) ----
  const trades = [];
  for (const y of years) {
    for (const w of Object.keys(raw[y].transactions)) {
      for (const t of raw[y].transactions[w]) {
        if (t.type !== 'trade' || t.status !== 'complete') continue;
        const sides = {}; // managerKey -> { adds:[], drops:[], picks:[] }
        const ensure = (rid) => { const k = rosterKey[y][rid]; sides[k] = sides[k] || { managerKey: k, adds: [], picks: [] }; return sides[k]; };
        for (const rid of t.roster_ids || []) ensure(rid);
        for (const [pid, rid] of Object.entries(t.adds || {})) ensure(rid).adds.push({ id: pid, name: playerName(pid), pos: playerPos(pid) });
        for (const p of t.draft_picks || []) {
          const to = rosterKey[y][p.owner_id] ?? null;
          const s = sides[to] || ensure(p.owner_id);
          s.picks.push({ season: p.season, round: p.round, from: rosterKey[y][p.previous_owner_id] ?? null });
        }
        trades.push({ year: y, week: Number(w), date: t.status_updated ? new Date(t.status_updated).toISOString().slice(0, 10) : null, sides: Object.values(sides) });
      }
    }
  }
  trades.sort((a, b) => (b.year - a.year) || (b.week - a.week));
  await writeFile(path.join(DATA, 'transactions.json'), JSON.stringify({ trades }, null, 2));

  // ---- League summary ----
  const currentComplete = completeYears.length ? Math.max(...completeYears) : null;
  const upcoming = seasonsOut.find((s) => s.upcoming);
  await writeFile(path.join(DATA, 'league.json'), JSON.stringify({
    name: raw[years[0]].league.name, sport: 'nfl', teams: raw[years[years.length - 1]].league.total_rosters,
    seasons: years, firstSeason: Math.min(...years), latestComplete: currentComplete,
    upcomingSeason: upcoming ? upcoming.year : null, medianGames: true,
  }, null, 2));

  console.log('Built clean data for seasons:', years.join(', '));
  console.log('Franchises:', managers.length, '| Champions:', byYear.map((c) => `${c.year}:${c.champion}`).join(', '));
  console.log('H2H pairs:', h2hOut.length, '| Trades:', trades.length, '| Drafts:', draftsOut.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
