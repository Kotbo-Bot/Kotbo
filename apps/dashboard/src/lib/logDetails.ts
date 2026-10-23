/**
 * Rendu des details d'un evenement journalise.
 *
 * `details` transporte du texte ecrit par les membres (contenu d'un message
 * supprime, motif d'une sanction) et se termine dans un `{@html}` : tout ce qui
 * en sort doit donc etre echappe. L'echappement precede la reecriture des
 * mentions, qui travaille sur la forme deja echappee (`&lt;#123&gt;`) et
 * echappe a son tour les noms de salons et de roles.
 *
 * Deux niveaux de sortie, a ne pas confondir :
 *  - `key` est du texte brut, insere par les gabarits via `{...}` (Svelte
 *    l'echappe lui-meme) ; les mentions y sont resolues sans balise ;
 *  - `value` est du HTML deja sur, insere via `{@html}`.
 *
 * Les pages Journaux et Activite portaient chacune leur copie de ces fonctions,
 * a une chaine de traduction pres ; aucune des deux n'echappait quoi que ce soit.
 */
import { escapeHtml } from './emojiParser';
import { authStore } from './stores/auth.svelte';
import { dashboardStore } from './stores/dashboard.svelte';

export interface MentionLabels {
  unknownChannel: string;
  unknownRole: string;
  /**
   * Pseudos connus par identifiant. Une mention `<@id>` trouvee ici est nommee,
   * les autres restent masquees derriere `@utilisateur`.
   */
  userNames?: Record<string, string>;
}

export interface LogDetailsLabels extends MentionLabels {
  /** Intitule donne a un bloc de details sans cle explicite. */
  details: string;
}

export interface LogDetailsBadge {
  /** Texte brut. */
  key: string | null;
  /** HTML sur. */
  value: string;
}

export type LogDetailsBlockTone = 'message' | 'before' | 'after';

export interface LogDetailsBlock {
  /** Texte brut. */
  key: string;
  /** HTML sur. */
  value: string;
  /**
   * `message` : texte ecrit par le membre, deja annonce par l'action ;
   * `before`/`after` : les deux versions d'une modification.
   */
  tone?: LogDetailsBlockTone;
}

export interface LogDetailsStructure {
  badges: LogDetailsBadge[];
  blocks: LogDetailsBlock[];
  /** Liens http(s) des pieces jointes, a inserer en attribut `href`. */
  attachments: string[];
  /** Identifiant du message quand le journal decrit un message. */
  messageId: string | null;
}

const LONG_VALUE_THRESHOLD = 50;

const BLOCK_KEYS = [
  'contenu',
  'raison',
  'description',
  'reason',
  "contenu d'origine",
  'nouveau contenu',
  'arguments',
  'avant',
  'après',
];

const BLOCK_TONES: Record<string, LogDetailsBlockTone> = {
  contenu: 'message',
  avant: 'before',
  "contenu d'origine": 'before',
  'après': 'after',
  'nouveau contenu': 'after',
};

const ATTACHMENT_KEYS = ['pièces jointes', 'pièce jointe', 'attachments'];
const HTTP_URL = /^https?:\/\/\S+$/i;
/** Valeur ecrite par le bot pour un message sans texte (piece jointe seule). */
const EMPTY_CONTENT = '_vide_';

const CHANNEL_MENTION = /<#(\d{15,25})>/g;
const ROLE_MENTION = /<@&(\d{15,25})>/g;
/** `<#123>` et `<@&123>` une fois passes par `escapeHtml`. */
const ESCAPED_CHANNEL_MENTION = /&lt;#(\d{15,25})&gt;/g;
const ESCAPED_ROLE_MENTION = /&lt;@&amp;(\d{15,25})&gt;/g;

export function extractUserIdFromText(value: string | null | undefined): string | null {
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

function channelName(channelId: string, labels: MentionLabels): string {
  const channel = dashboardStore.state.discordChannels.find((entry) => entry.id === channelId);
  return channel ? channel.name : labels.unknownChannel;
}

function roleName(roleId: string, labels: MentionLabels): string {
  const role = dashboardStore.state.discordRoles.find((entry) => entry.id === roleId);
  return role ? role.name : labels.unknownRole;
}

/** Mentions resolues sans balise, pour les emplacements rendus en texte. */
export function renderLogPlainText(value: string, labels: MentionLabels): string {
  return hideUserIds(value, labels.userNames)
    .replace(CHANNEL_MENTION, (_match, channelId: string) => `#${channelName(channelId, labels)}`)
    .replace(ROLE_MENTION, (_match, roleId: string) => `@${roleName(roleId, labels)}`);
}

/** Fragment de journal pret a etre insere dans un `{@html}`. */
export function renderLogHtml(value: string, labels: MentionLabels): string {
  return escapeHtml(hideUserIds(value, labels.userNames))
    .replace(ESCAPED_CHANNEL_MENTION, (_match, channelId: string) => {
      const name = escapeHtml(channelName(channelId, labels));
      const guildId = encodeURIComponent(authStore.selectedGuildId ?? '');
      return `<a href="https://discord.com/channels/${guildId}/${channelId}" target="_blank" rel="noopener noreferrer" class="mention-link">#${name}</a>`;
    })
    .replace(ESCAPED_ROLE_MENTION, (_match, roleId: string) => {
      return `<span class="mention">@${escapeHtml(roleName(roleId, labels))}</span>`;
    });
}

function stripKnownPrefixes(details: string): string {
  let clean = details;
  const userMatch = clean.match(/^([^|]+?\(<@!?\d{15,25}>\))/);
  if (userMatch) {
    clean = clean.replace(userMatch[0], '').trim();
  }
  clean = clean.replace(/\|?\s*Salon:\s*<#\d+>\s*/gi, '');
  return clean.replace(/^\|\s*/, '').trim();
}

export function parseDetailsMetadata(
  details: string,
  user: string | undefined,
  labels: LogDetailsLabels,
) {
  const userMatch = details.match(/^([^|]+?\(<@!?\d{15,25}>\))/);
  const userIdMatch = extractUserIdFromText(details) ?? extractUserIdFromText(user);
  const channelMatch = details.match(/Salon:\s*<#(\d+)>/i);

  const cleanDetails = stripKnownPrefixes(details).replace(/\s*\|\s*/g, ' | ').trim();

  return {
    extractedUser: userMatch?.[1]?.trim() ?? null,
    extractedUserId: userIdMatch,
    extractedChannelId: channelMatch?.[1] ?? null,
    /** HTML sur. */
    cleanDetails: renderLogHtml(cleanDetails, labels),
  };
}

export function parseDetailsStructure(
  details: string,
  labels: LogDetailsLabels,
): LogDetailsStructure {
  const empty: LogDetailsStructure = { badges: [], blocks: [], attachments: [], messageId: null };
  if (!details) return empty;

  // Les pieces jointes sont jointes par le meme ` | ` que les champs : une URL
  // nue qui suit appartient a la liste, et son `https:` ne doit pas etre lu
  // comme une cle.
  const fields: Array<{ key: string | null; value: string }> = [];
  const attachments: string[] = [];
  for (const part of stripKnownPrefixes(details).split(/\s*\|\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (HTTP_URL.test(trimmed)) {
      attachments.push(trimmed);
      continue;
    }
    const colIndex = trimmed.indexOf(':');
    if (colIndex === -1) {
      fields.push({ key: null, value: trimmed });
      continue;
    }
    const key = trimmed.slice(0, colIndex).trim();
    const value = trimmed.slice(colIndex + 1).trim();
    if (ATTACHMENT_KEYS.includes(key.toLowerCase()) && HTTP_URL.test(value)) {
      attachments.push(value);
      continue;
    }
    fields.push({ key, value });
  }

  // `ID` ne designe un message que dans les journaux de message ; ailleurs
  // (role, salon, sanction) il reste un badge comme les autres.
  const describesMessage = fields.some((field) => field.key?.toLowerCase() === 'contenu');
  let messageId: string | null = null;

  const badges: LogDetailsBadge[] = [];
  const blocks: LogDetailsBlock[] = [];

  // Longueur et vacuite se mesurent sur la forme lisible, jamais sur le HTML :
  // les entites d'echappement et le balisage des mentions gonflent la chaine et
  // basculaient en bloc des valeurs courtes, quand un fragment reduit a un
  // identifiant masque paraissait encore non vide.
  for (const { key, value } of fields) {
    if (key === null) {
      const plain = renderLogPlainText(value, labels);
      if (!plain.trim()) continue;
      const html = renderLogHtml(value, labels);
      if (plain.length > LONG_VALUE_THRESHOLD) {
        blocks.push({ key: labels.details, value: html });
      } else {
        badges.push({ key: null, value: html });
      }
      continue;
    }

    const lowerKey = key.toLowerCase();
    if (describesMessage && lowerKey === 'id' && /^\d{15,25}$/.test(value)) {
      messageId = value;
      continue;
    }
    if (lowerKey === 'contenu' && value === EMPTY_CONTENT) continue;

    const entry = {
      key: renderLogPlainText(key, labels),
      value: renderLogHtml(value, labels),
    };
    const plainValue = renderLogPlainText(value, labels);
    if (BLOCK_KEYS.includes(lowerKey) || plainValue.length > LONG_VALUE_THRESHOLD) {
      blocks.push({ ...entry, tone: BLOCK_TONES[lowerKey] });
    } else {
      badges.push(entry);
    }
  }

  return { badges, blocks, attachments, messageId };
}
