// Central data access for the site build. All JSON lives in /data (versioned,
// the single source of truth), generated from the Sleeper API by
// scripts/pull-sleeper.mjs + scripts/build-data.mjs. See data/SCHEMA.md.

import league from '../../data/league.json';
import managersData from '../../data/managers.json';
import records from '../../data/records.json';
import champions from '../../data/champions.json';
import h2h from '../../data/h2h.json';
import drafts from '../../data/drafts.json';
import transactions from '../../data/transactions.json';

const seasonModules = import.meta.glob('../../data/seasons/*.json', { eager: true });

export interface Standing {
  roster_id: number;
  managerKey: string;
  manager: string;
  team: string;
  w: number; l: number; t: number;
  pf: number; pa: number; ppts?: number; diff?: number;
  rank?: number;
  [k: string]: unknown;
}
export interface WeekRow {
  managerKey: string; points: number; oppKey: string; oppPoints: number;
  result: 'W' | 'L' | 'T'; isPlayoff: boolean;
}
export interface BracketRef { key?: string; roster?: number; fromWinner?: number; fromLoser?: number; }
export interface BracketGame { m: number; r: number; p: number | null; t1: BracketRef | null; t2: BracketRef | null; winner: BracketRef | null; loser: BracketRef | null; }
export interface Season {
  year: number; leagueId: string; status: string; upcoming: boolean;
  teams: number; regularSeasonWeeks: number; playoffWeekStart: number; playoffTeams: number;
  medianGames: boolean;
  champion: { key: string; roster: number; team?: string } | null;
  runnerUp: { key: string; roster: number } | null;
  standings: Standing[];
  playoffs: { winners: BracketGame[]; losers: BracketGame[] };
  weeklyScores: Record<string, WeekRow[]>;
}
export interface Manager {
  key: string; userId: string; display: string; avatar: string | null;
  teamName: string; teamNames: Record<string, string>; seasons: number[];
  titles: number; w: number; l: number; t: number; pf: number; pa: number;
  playoffApps: number; bestFinish: number | null;
}

export const seasons: Season[] = Object.values(seasonModules)
  .map((m: any) => m.default as Season)
  .sort((a, b) => b.year - a.year);

export const seasonByYear = (year: number): Season | undefined => seasons.find((s) => s.year === year);
export const completeSeasons = seasons.filter((s) => !s.upcoming);

export const managers: Manager[] = (managersData as any).managers;
export const managerByKey = (key?: string | null): Manager | undefined =>
  key ? managers.find((m) => m.key === key) : undefined;
export const label = (key?: string | null): string => (key ? (managerByKey(key)?.display ?? key) : '—');
export const teamNameFor = (key?: string | null, year?: number): string => {
  const m = managerByKey(key);
  if (!m) return key ?? '—';
  if (year && m.teamNames[String(year)]) return m.teamNames[String(year)];
  return m.teamName || m.display;
};

// Avatar via Sleeper CDN (thumbnails). Falls back to null.
export const avatarUrl = (key?: string | null): string | null => {
  const m = managerByKey(key);
  return m?.avatar ? `https://sleepercdn.com/avatars/thumbs/${m.avatar}` : null;
};

export { league, records, champions, h2h, drafts, transactions };
