export const SPORT_VALUES = ['Rudern', 'Radsport', 'Triathlon', 'Laufen', 'Sonstige'] as const;

export type AthleteSport = (typeof SPORT_VALUES)[number];

export const DISCIPLINES_BY_SPORT: Record<AthleteSport, readonly string[]> = {
  Rudern: ['Skullen', 'Riemenrudern', 'Ergometerrudern'],
  Radsport: ['Straßenradsport', 'Zeitfahren', 'Mountainbike', 'Bahnrad'],
  Triathlon: ['Sprint', 'Olympische Distanz', 'Mitteldistanz', 'Langdistanz'],
  Laufen: ['Straßenlauf', 'Bahn', 'Trailrunning'],
  Sonstige: ['Sonstige'],
};

export const DISCIPLINE_VALUES = Object.values(DISCIPLINES_BY_SPORT).flat() as string[];

export const TRAINING_STATUS_VALUES = [
  'Freizeit',
  'ambitioniert',
  'leistungsorientiert',
  'Wettkampf/Elite',
] as const;

export function disciplinesForSport(sport: string): readonly string[] {
  return sport in DISCIPLINES_BY_SPORT
    ? DISCIPLINES_BY_SPORT[sport as AthleteSport]
    : [];
}

export function isValidSportDisciplinePair(sport: string, discipline: string): boolean {
  return disciplinesForSport(sport).includes(discipline);
}
