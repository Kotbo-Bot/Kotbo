/**
 * Membre d'une ligne de journal : le nom affiché et l'identifiant de sa fiche.
 *
 * Les deux se lisent à la même source. Les détails citent souvent un autre membre
 * (la cible d'une commande, le membre d'un rôle retiré) : en tirer l'identifiant
 * alors que le nom vient de l'auteur ouvrait la fiche de la cible sous le nom de
 * l'auteur.
 */

/** Membre écrit en tête des détails, sous la forme `Nom (<@id>)`. */
const LEADING_MEMBER = /^([^|]+?)\s*\(<@!?(\d{15,25})>\)/;

function extractUserIdFromText(value: string | null | undefined): string | null {
  if (!value) return null;

  const mentionMatch = value.match(/<@!?(\d{15,25})>/);
  if (mentionMatch?.[1]) return mentionMatch[1];

  const parenthesizedIdMatch = value.match(/\((\d{15,25})\)/);
  if (parenthesizedIdMatch?.[1]) return parenthesizedIdMatch[1];

  return null;
}

/** Retire les identifiants Discord bruts. Texte en entree, texte en sortie. */
export function hideUserIds(value: string, userNames?: Record<string, string>): string {
  return value
    .replace(/\(<@!?\d{15,25}>\)/g, '')
    .replace(/<@!?(\d{15,25})>/g, (_match, userId: string) => {
      const name = userNames?.[userId];
      return name ? `@${name}` : '@utilisateur';
    })
    .replace(/\((\d{15,25})\)/g, '');
}

/**
 * Identifiant écrit à côté de ce pseudo dans les détails (`pseudo (<@id>)`). Les logs
 * avancés ne gardent que le pseudo de l'auteur dans sa colonne, mais le citent ainsi.
 */
function userIdNextToName(details: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return details.match(new RegExp(`(?:^|[\\s:|])${escaped}\\s*\\(<@!?(\\d{15,25})>\\)`))?.[1] ?? null;
}

export function logEntryUser(entry: { user: string; details: string }): { name: string; userId: string | null } {
  const leading = entry.details.match(LEADING_MEMBER);
  const leadingName = leading?.[1]?.trim();
  if (leading && leadingName) return { name: leadingName, userId: leading[2] };
  const name = hideUserIds(entry.user).trim() || entry.user;
  return {
    name,
    userId: extractUserIdFromText(entry.user) ?? userIdNextToName(entry.details, name),
  };
}
