/**
 * Salon d'alerte de la cellule de suivi, fermé au MCP.
 *
 * Il garde la trace des accès aux dossiers (accès d'urgence, consultations).
 * Une clé capable de le lire, de vider ses messages ou de changer ses
 * permissions lirait ou effacerait ce qui surveille la cellule. La garde se
 * pose sur tous les outils à la fois : un argument de salon ou de fil qui le
 * désigne fait refuser l'appel, quel que soit l'outil, y compris ceux à venir.
 */
import { err, type McpToolHandler } from './toolResult.js';

export interface ChannelRef {
  id: string;
  name: string | null;
}

/** `channel`, `channel_id`, `log_channel_id`, `allowed_channels`, `thread`... mais pas `channel_type`. */
const CHANNEL_ARG = /(channel|thread)s?(_id)?$/;

export function channelArgValues(args: Record<string, unknown>): string[] {
  return Object.entries(args ?? {})
    .filter(([key]) => CHANNEL_ARG.test(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

/** Même lecture que les outils : id, mention `<#id>`, ou nom avec ou sans `#`. */
export function refersToChannel(raw: string, target: ChannelRef): boolean {
  const value = raw.trim();
  const id = value.match(/^<#(\d+)>$/)?.[1] ?? value;
  if (id === target.id) return true;
  return !!target.name && value.replace(/^#/, '').toLowerCase() === target.name.toLowerCase();
}

export function withWellbeingChannelGuard(
  handler: McpToolHandler,
  loadAlertChannel: () => Promise<ChannelRef | null>,
): McpToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    const values = channelArgValues(args);
    if (values.length > 0) {
      const alert = await loadAlertChannel();
      if (alert && values.some((value) => refersToChannel(value, alert))) {
        return err("Ce salon est celui des alertes de la cellule de suivi : il n'est pas accessible par le MCP ni par l'API.");
      }
    }
    return handler(args);
  };
}
