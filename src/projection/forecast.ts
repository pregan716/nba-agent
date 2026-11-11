// Shared wire contract for the V1 producer and V2 validator/scorer.
export const percentiles = [5, 10, 25, 50, 75, 90, 95] as const;
export const quantities = [
  "minutes",
  "points",
  "rebounds",
  "assists",
  "fantasy_points",
] as const;
export type Quantity = (typeof quantities)[number];
export type Range = [number, number, number, number, number, number, number];
export type PlayerForecast = Record<Quantity, Range> & {
  playerId: string;
  p_play: number;
  p_start: number;
};
export interface Forecast {
  version: "forecast-v1";
  gameId: string;
  players: PlayerForecast[];
}
