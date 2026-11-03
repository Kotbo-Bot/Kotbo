import { getNodeDef } from '@kotbo/shared';

/**
 * Lecture d'une étape du rejeu : libellés, valeurs, et ce que l'étape a fait
 * (ou aurait fait, pour un essai) sur Discord.
 */

/** Libellé d'une entrée ou d'une sortie, son identifiant à défaut. */
export function portLabel(nodeType: string, portId: string, side: 'inputs' | 'outputs'): string {
  const port = getNodeDef(nodeType)?.[side].find((entry) => entry.id === portId);
  return port?.label || portId;
}

export interface ReadValue {
  /** `mention` se montre en badge, comme dans Discord. */
  kind: 'mention' | 'text' | 'empty';
  text: string;
}

const EMPTY: ReadValue = { kind: 'empty', text: '-' };

export function readValue(value: unknown): ReadValue {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'oui' : 'non' };
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY;
    return { kind: 'text', text: value.map((item) => readValue(item).text).join(', ') };
  }
  if (typeof value === 'object') {
    const tagged = value as { kind?: string; name?: string; displayName?: string; tag?: string; content?: string };
    switch (tagged.kind) {
      case 'Member': return { kind: 'mention', text: `@${tagged.displayName || tagged.tag}` };
      case 'Role': return { kind: 'mention', text: `@${tagged.name}` };
      case 'Channel': return { kind: 'mention', text: `#${tagged.name}` };
      case 'Message': return { kind: 'text', text: tagged.content ?? '' };
      default: return { kind: 'text', text: JSON.stringify(value) };
    }
  }
  return { kind: 'text', text: String(value) };
}

export interface EmbedPreview {
  title: string;
  description: string;
  color: string;
}

export interface MessagePreview {
  channel: string;
  content?: string;
  embed?: EmbedPreview;
}

const DEFAULT_COLOR = '#5865F2';

function text(value: unknown): string {
  const read = readValue(value);
  return read.kind === 'empty' ? '' : read.text;
}

function channelName(value: unknown, fallback: string): string {
  const tagged = value as { kind?: string; name?: string } | null;
  return tagged?.kind === 'Channel' && tagged.name ? tagged.name : fallback;
}

/** Seule une couleur hexadécimale est reprise : elle finit dans un style. */
export function embedColor(raw: unknown): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : DEFAULT_COLOR;
}

/** Message tel que Discord l'a reçu (ou l'aurait reçu), pour les actions qui écrivent. */
export function messagePreviewOf(
  nodeType: string,
  inputs: Record<string, unknown>,
  config: Record<string, unknown> = {},
): MessagePreview | null {
  switch (nodeType) {
    case 'SendMessage':
      return { channel: channelName(inputs.channel, 'salon'), content: text(inputs.text) };
    case 'ReplyToMessage':
      return { channel: 'salon', content: text(inputs.text) };
    case 'SendEmbed':
      return {
        channel: channelName(inputs.channel, 'salon'),
        embed: { title: text(inputs.title), description: text(inputs.description), color: embedColor(config.color) },
      };
    case 'SendLogMessage':
      return { channel: 'logs', embed: { title: '', description: text(inputs.text), color: DEFAULT_COLOR } };
    default:
      return null;
  }
}

export interface RoleChange {
  member: string;
  role: string;
  added: boolean;
}

const ROLE_ACTIONS: Record<string, boolean> = { AddRole: true, AddTemporaryRole: true, RemoveRole: false };

export function roleChangeOf(nodeType: string, inputs: Record<string, unknown>): RoleChange | null {
  if (!(nodeType in ROLE_ACTIONS)) return null;
  const member = readValue(inputs.member);
  const role = readValue(inputs.role);
  if (member.kind !== 'mention' || role.kind !== 'mention') return null;
  return { member: member.text, role: role.text, added: ROLE_ACTIONS[nodeType] };
}

export interface PermissionHint {
  permissions: string[];
  /** Nul quand la permission manque sur tout le serveur. */
  channel: string | null;
}

/**
 * Permission manquante nommée par l'erreur, pour dire quoi faire.
 *
 * Le format est celui du bot (`describeMissingPermissions`) :
 * « il manque au bot « A », « B » dans #salon » ou « … sur le serveur ».
 */
export function permissionHint(error: string | null | undefined): PermissionHint | null {
  const match = error?.match(/il manque au bot (.+) (?:dans #(.+)|sur le serveur)$/);
  if (!match) return null;
  const permissions = [...match[1].matchAll(/« ([^»]+) »/g)].map((entry) => entry[1]);
  return permissions.length > 0 ? { permissions, channel: match[2] ?? null } : null;
}
