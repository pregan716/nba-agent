export const teamIds = {
  BOS: "1610612738",
  DEN: "1610612743",
  MEM: "1610612763",
  OKC: "1610612760",
  WAS: "1610612764",
} as const;
export const teamNames = {
  BOS: "Boston Celtics",
  DEN: "Denver Nuggets",
  MEM: "Memphis Grizzlies",
  OKC: "Oklahoma City Thunder",
  WAS: "Washington Wizards",
} as const;
export type Team = keyof typeof teamIds;
export const developmentTeams: Team[] = ["BOS", "OKC", "WAS"];
export const teams = Object.keys(teamIds) as Team[];
export function teamCode(id: string) {
  const team = teams.find((t) => teamIds[t] === id);
  if (!team) throw Error("Unknown experiment team: " + id);
  return team;
}
