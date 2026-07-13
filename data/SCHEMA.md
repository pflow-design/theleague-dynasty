# data/ — schema

Clean, versioned JSON generated from the Sleeper API by `scripts/build-data.mjs`
(after `scripts/pull-sleeper.mjs`). This is the site's single source of truth.
Regenerate with `npm run data:all`; the raw dumps under `data/raw/` are gitignored.

## Conventions

- **Franchise key** (`managerKey`) = a slug of the Sleeper `display_name`. Owners
  (Sleeper `user_id`) are stable across all seasons of this dynasty, so the key
  identifies a franchise for its whole history. `roster_id` is per-season only.
- **Team name** is the Sleeper team name for a given season (it changes year to
  year); helpers fall back to the display name when a season has none.
- **Regular season** = weeks 1 … `playoffWeekStart - 1`. Records, streaks and
  head-to-head exclude playoff weeks unless noted.
- **Median games**: standings W-L come from Sleeper's official roster settings,
  which include the weekly league-median bonus game. Points For/Against are the
  team's actual scores (not doubled).

## Files

| File | Shape |
|------|-------|
| `league.json` | league name, seasons list, first/latest/upcoming season, flags |
| `managers.json` | `{ managers: [{ key, userId, display, avatar, teamName, teamNames, seasons, titles, w,l,t, pf, pa, playoffApps }], seasons, currentSeason }` |
| `seasons/{year}.json` | `{ year, status, upcoming, teams, regularSeasonWeeks, playoffWeekStart, playoffTeams, medianGames, champion, runnerUp, standings[], playoffs{winners[],losers[]}, weeklyScores{week:[{managerKey,points,oppKey,oppPoints,result,isPlayoff}]} }` |
| `champions.json` | `{ byYear:[{year,champion,team}], titlesByManager }` |
| `records.json` | all-time leaders: `highWeek, lowWeek, blowout, nailbiter, highSeason, mostWins, longestWinStreak, longestLossStreak, bestPlayerWeek` |
| `h2h.json` | `{ pairs:[{ a,b, games, aWins,bWins,ties, aPts,bPts, playoffGames, meetings[], lastMeeting }] }` (keys sorted `a < b`) |
| `drafts.json` | `{ drafts:[{ year, kind:'startup'|'rookie', type, rounds, picks:[{round,pick_no,managerKey,player,pos,nflTeam}] }] }` |
| `transactions.json` | `{ trades:[{ year, week, date, sides:[{ managerKey, adds:[{name,pos}], picks:[{season,round,from}] }] }] }` |
| `static/boxscores/{year}.json` | `{ year, weeks:{ week:{ isPlayoff, teams:[{ managerKey, points, starters:[{id,name,pos,pts}] }] } } }` — fetched client-side on season pages |

## Provenance / validation

All data comes from the public Sleeper read API (no auth). The league chain is
walked via `previous_league_id`; the NFL players catalog (`data/raw/players-nfl.json`)
maps player ids to names/positions for box scores, drafts and trades. Re-running
`npm run data:all` fully reproduces every file here from the API.
