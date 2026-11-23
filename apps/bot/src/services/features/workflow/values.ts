/**
 * Valeurs manipulées par le moteur de workflows.
 *
 * Toutes les valeurs sont des objets simples sérialisables en JSON : c'est ce
 * qui permet à une exécution suspendue par un nœud « Attendre » de reprendre
 * après un redémarrage du bot, en rechargeant son contexte depuis la base
 * plutôt qu'en réinterrogeant Discord sur un état qui a pu changer.
 */

export interface MemberValue {
  kind: 'Member';
  id: string;
  tag: string;
  displayName: string;
  isBot: boolean;
  roleIds: string[];
  /** Timestamp de création du compte Discord */
  accountCreatedAt: number | null;
  /** Timestamp d'arrivée sur le serveur */
  joinedAt: number | null;
  /** Photo de profil personnalisée (faux : avatar par défaut de Discord). Absent = inconnu, compté comme présent. */
  hasAvatar?: boolean;
}

export interface RoleValue {
  kind: 'Role';
  id: string;
  name: string;
}

export interface ChannelValue {
  kind: 'Channel';
  id: string;
  name: string;
  categoryName: string | null;
}

export interface MessageValue {
  kind: 'Message';
  id: string;
  content: string;
  channelId: string;
  authorId: string;
}

export type WorkflowValue =
  | MemberValue
  | RoleValue
  | ChannelValue
  | MessageValue
  | string
  | number
  | boolean
  | null
  | WorkflowValue[];

function isTagged(value: unknown, kind: string): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: string }).kind === kind;
}

export const isMember = (v: unknown): v is MemberValue => isTagged(v, 'Member');
export const isRole = (v: unknown): v is RoleValue => isTagged(v, 'Role');
export const isChannel = (v: unknown): v is ChannelValue => isTagged(v, 'Channel');
export const isMessage = (v: unknown): v is MessageValue => isTagged(v, 'Message');

/**
 * Conversion implicite vers du texte, seule coercition autorisée par le
 * système de types. Chaque entité est rendue sous sa forme la plus lisible
 * pour un humain qui lira le message produit.
 */
export function coerceToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(coerceToString).join(', ');
  if (isMember(value)) return value.displayName || value.tag;
  if (isRole(value)) return value.name;
  if (isChannel(value)) return value.name;
  if (isMessage(value)) return value.content;
  return '';
}

export function coerceToNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function coerceToBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

export function coerceToList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

const MS_PER_DAY = 86_400_000;

export function daysSince(timestamp: number | null, now: number): number {
  if (!timestamp) return 0;
  return Math.floor((now - timestamp) / MS_PER_DAY);
}
