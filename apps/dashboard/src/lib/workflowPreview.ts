import { findToken, type ContextToken, type ValueRef } from '@kotbo/shared';

/**
 * Aperçu d'un message d'automatisation, variables remplies par un exemple.
 *
 * Les règles suivent celles du moteur : une entité s'écrit par son nom (un
 * membre par son pseudo, sans mention), et un jeton que le déclencheur ne
 * fournit pas reste tel quel dans le message envoyé.
 */

export interface PreviewSegment {
  text: string;
  /** Vrai pour une variable remplie, à distinguer du texte saisi. */
  filled: boolean;
}

export interface PreviewContext {
  guildName?: string;
}

const EXAMPLE_CHANNEL = 'général';

const ROOT_EXAMPLES: Record<string, string> = {
  Member: 'Alice',
  Channel: EXAMPLE_CHANNEL,
  Role: 'Membre',
  Message: 'Bonjour à tous !',
  Number: '5',
  Boolean: 'oui',
};

const PROPERTY_EXAMPLES: Record<string, string> = {
  displayName: 'Alice',
  tag: 'alice',
  id: '123456789012345678',
  accountAgeDays: '120',
  joinedDaysAgo: '0',
  isBot: 'non',
  roles: 'Membre',
  content: 'Bonjour à tous !',
  author: 'Alice',
  channel: EXAMPLE_CHANNEL,
  length: '16',
  name: EXAMPLE_CHANNEL,
  categoryName: 'Discussion',
  memberCount: '250',
  memberToday: '1',
  memberThisHour: '1',
};

function exampleFor(token: ContextToken, context: PreviewContext): string {
  if (token.path === 'guild.name') return context.guildName || 'Mon serveur';
  if (!token.root) {
    const property = token.path.slice(token.path.lastIndexOf('.') + 1);
    if (PROPERTY_EXAMPLES[property]) return PROPERTY_EXAMPLES[property];
  }
  // Un texte propre au déclencheur (motif, type de sanction) se lit mieux par
  // son libellé que par un exemple inventé.
  return ROOT_EXAMPLES[token.type] ?? token.label;
}

const TOKEN_SPLIT = /(\{[a-zA-Z0-9_.]+\})/;

/** Découpe un texte en morceaux saisis et en variables remplies. */
export function previewTemplate(template: string, triggerType: string, context: PreviewContext = {}): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  for (const piece of template.split(TOKEN_SPLIT)) {
    if (piece === '') continue;
    const token = piece.startsWith('{') ? findToken(triggerType, piece.slice(1, -1)) : undefined;
    const segment = token ? { text: exampleFor(token, context), filled: true } : { text: piece, filled: false };
    const last = segments[segments.length - 1];
    // Un jeton inconnu reste du texte : il rejoint le morceau voisin.
    if (last && !last.filled && !segment.filled) last.text += segment.text;
    else segments.push(segment);
  }
  return segments;
}

export function previewText(segments: PreviewSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** Nom du salon où part le message : celui choisi, sinon un exemple. */
export function previewChannelName(ref: ValueRef | undefined, channels: { id: string; name: string }[]): string {
  if (ref?.from === 'channel') return channels.find((channel) => channel.id === ref.channelId)?.name ?? EXAMPLE_CHANNEL;
  return EXAMPLE_CHANNEL;
}
