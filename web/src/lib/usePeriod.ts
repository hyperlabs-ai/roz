import { useState } from 'react';
import { defaultPeriod, presetRange, type PeriodState } from './period';

// El período seleccionado se comparte entre pantallas y sobrevive recargas (persistido en
// localStorage). Antes vivía en useState por página, así que cambiar de pestaña lo reseteaba.
const KEY = 'roz.period';

function load(): PeriodState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPeriod();
    const s = JSON.parse(raw) as PeriodState;
    if (!s?.preset || !s?.range?.from || !s?.range?.to) return defaultPeriod();
    // Los presets se recalculan a la fecha de hoy (para que "Este mes" siga siendo el mes vigente
    // aunque el valor guardado sea de días atrás). Los rangos "custom" se respetan tal cual.
    if (s.preset !== 'custom') return { ...s, range: presetRange(s.preset) };
    return s;
  } catch {
    return defaultPeriod();
  }
}

/** Igual que useState<PeriodState> pero compartido entre páginas (persistido en localStorage). */
export function usePeriod(): [PeriodState, (p: PeriodState) => void] {
  const [period, setPeriodState] = useState<PeriodState>(load);
  const setPeriod = (p: PeriodState) => {
    setPeriodState(p);
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* almacenamiento no disponible: se mantiene solo en memoria */
    }
  };
  return [period, setPeriod];
}
