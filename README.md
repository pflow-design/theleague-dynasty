# The League — dyNASTY Edition

A history site for **"The League - dyNASTY Edition"** — a 10-team Sleeper dynasty
league. Standings, playoff brackets, weekly box scores, the record book, drafts,
trades, and an interactive head-to-head tool for every season.

Built as a **data-driven static site** (Astro) and hosted on **GitHub Pages** at
**https://theleague.patrickflower.com**. Sibling site to the Yahoo-based
[Go Cougs](https://ff.patrickflower.com) league history — same architecture,
recolored, but powered by the free public **Sleeper API** instead of scraping.

## How it works

1. **`npm run data:pull`** → `scripts/pull-sleeper.mjs` walks the dynasty league
   chain (via `previous_league_id`) from the current season back to the 2022
   startup, pulling league settings, users, rosters, weekly matchups, playoff
   brackets, drafts, and transactions. Raw dumps land in `data/raw/` (gitignored).
2. **`npm run data:build`** → `scripts/build-data.mjs` transforms the raw dumps
   into clean, **versioned** JSON in `data/` (the site's source of truth) plus
   per-season box scores in `static/boxscores/`.
3. **`npm run build`** → Astro generates the static site from `data/` into
   `public/` (gitignored), which GitHub Actions deploys to Pages.

`npm run data:all` does steps 1–2. Run it after a season (or any time) and commit
the updated `data/` to refresh the site — no credentials required.

## Repo structure

```
.
├── README.md
├── data/                  ← clean versioned JSON (source of truth) + SCHEMA.md
│   ├── seasons/*.json      ·  per-season standings, brackets, weekly scores
│   ├── managers.json       ·  franchises + career records
│   ├── records.json, champions.json, h2h.json, drafts.json, transactions.json
│   └── raw/                ·  raw Sleeper dumps (gitignored, regenerable)
├── scripts/               ← pull-sleeper.mjs, build-data.mjs
├── src/                   ← Astro layouts, components, pages
├── static/                ← committed assets: CNAME, favicon, boxscores/*.json
└── .github/workflows/     ← Pages deploy
```

## Key league quirk

This league uses Sleeper's **median bonus game** (`league_average_match`): each
week you play your head-to-head opponent *and* the league median, so official
records count two games per week (e.g. an 18–10 season over 14 weeks). Standings
use that official record; head-to-head, streaks and single-game records use the
**actual opponent matchups** (regular season = weeks 1 to `playoff_week_start-1`).

## Local dev

```
npm install
npm run dev        # http://localhost:4321
npm run build      # static output to ./public
```

Data is non-sensitive (fantasy scores) and safe to publish. The Sleeper read API
is public, so there are no tokens or secrets anywhere in this repo.
