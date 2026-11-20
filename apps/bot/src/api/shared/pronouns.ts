// Discord ne donne pas les pronoms aux bots : on lit les rôles de pronoms
// (modèle « Tes pronoms » ou rôles du serveur nommés « il/lui », « they/them »…).
const PRONOUN_ROLE = /^\s*(il|elle|iel|ielle|ils|elles|he|she|they|xe|ze)(\s*\/\s*\p{L}+)*\s*$/iu;

export function pronounsFromRoles(roles: Array<{ name: string }>): string | null {
  const names = roles.map((role) => role.name.trim()).filter((name) => PRONOUN_ROLE.test(name));
  return names.length ? names.join(', ') : null;
}
