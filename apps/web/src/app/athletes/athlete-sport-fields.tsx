'use client';

import { useMemo, useState } from 'react';
import {
  DISCIPLINES_BY_SPORT,
  SPORT_VALUES,
  TRAINING_STATUS_VALUES,
  type AthleteSport,
} from './athlete-options';

type AthleteSportFieldsProps = {
  initialSport?: string;
  initialDiscipline?: string;
  initialTrainingStatus?: string;
};

export function AthleteSportFields({
  initialSport = 'Rudern',
  initialDiscipline = 'Skullen',
  initialTrainingStatus = 'leistungsorientiert',
}: AthleteSportFieldsProps) {
  const normalizedSport = SPORT_VALUES.includes(initialSport as AthleteSport)
    ? (initialSport as AthleteSport)
    : 'Rudern';
  const [sport, setSport] = useState<AthleteSport>(normalizedSport);
  const availableDisciplines = useMemo(() => DISCIPLINES_BY_SPORT[sport], [sport]);
  const normalizedDiscipline = availableDisciplines.includes(initialDiscipline)
    ? initialDiscipline
    : availableDisciplines[0];
  const [discipline, setDiscipline] = useState(normalizedDiscipline);
  const normalizedTrainingStatus = TRAINING_STATUS_VALUES.includes(
    initialTrainingStatus as (typeof TRAINING_STATUS_VALUES)[number],
  )
    ? initialTrainingStatus
    : 'leistungsorientiert';

  function handleSportChange(nextSport: AthleteSport) {
    setSport(nextSport);
    const nextDisciplines = DISCIPLINES_BY_SPORT[nextSport];
    if (!nextDisciplines.includes(discipline)) {
      setDiscipline(nextDisciplines[0]);
    }
  }

  return (
    <>
      <label>
        Hauptsportart
        <select
          name="primarySport"
          required
          value={sport}
          onChange={(event) => handleSportChange(event.target.value as AthleteSport)}
        >
          {SPORT_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>
        Disziplin
        <select
          name="primaryDiscipline"
          required
          value={discipline}
          onChange={(event) => setDiscipline(event.target.value)}
        >
          {availableDisciplines.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>
        Trainingsstatus
        <select name="trainingStatus" required defaultValue={normalizedTrainingStatus}>
          {TRAINING_STATUS_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </>
  );
}
