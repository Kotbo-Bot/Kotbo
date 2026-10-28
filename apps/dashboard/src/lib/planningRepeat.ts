export type RepeatRule = 'none' | 'weekly' | 'biweekly' | 'monthly';

/** Nombre d'occurrences au plus : chaque reunion cree son evenement Discord. */
export const MAX_REPEAT = 12;

/**
 * Dates de chaque occurrence d'une reunion repetee. Le decalage se fait en
 * heure murale (setDate, setMonth) : une reunion de 21 h reste a 21 h apres un
 * changement d'heure.
 */
export function repeatDates(start: Date, end: Date, rule: RepeatRule, count: number): Array<[Date, Date]> {
  const total = rule === 'none' ? 1 : Math.min(MAX_REPEAT, Math.max(1, Math.floor(count)));
  const result: Array<[Date, Date]> = [];
  for (let i = 0; i < total; i++) {
    const s = new Date(start);
    const e = new Date(end);
    if (rule === 'monthly') {
      s.setMonth(s.getMonth() + i);
      e.setMonth(e.getMonth() + i);
    } else {
      const step = (rule === 'biweekly' ? 14 : 7) * i;
      s.setDate(s.getDate() + step);
      e.setDate(e.getDate() + step);
    }
    result.push([s, e]);
  }
  return result;
}
