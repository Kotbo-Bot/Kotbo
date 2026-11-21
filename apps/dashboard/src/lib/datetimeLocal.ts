/** Valeur d'un `datetime-local`, qui attend l'heure locale sans fuseau. */
export function toLocalInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
