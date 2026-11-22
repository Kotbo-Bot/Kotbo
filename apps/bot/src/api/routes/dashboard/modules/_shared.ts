/**
 * Contexte et helpers partages par les sous-routeurs de `modules/`.
 *
 * Extraits de modules.ts, ou ils precedaient une fonction de ~5900 lignes.
 */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { type CommandAccessLevel, type DashboardPresetKey, parseDiscordMarkdown, type SeverityLevel } from '../../../shared.js';
import { SanctionType } from '@prisma/client';
import { type Embed, type Guild } from 'discord.js';

export { msgMentionEntities, type MessageEntities } from '../../../../utils/messageEntities.js';

export const PRESET_LABELS: Record<DashboardPresetKey, string> = {
  general: 'Communauté générale',
  gaming: 'Gaming/Esport',
  dev: 'Dev/Tech',
};

export const PRESET_COMMAND_OVERRIDES: Record<DashboardPresetKey, Partial<Record<string, CommandAccessLevel>>> = {
  general: {},
  gaming: {},
  dev: {},
};

export const _DEFAULT_SEVERITY_BY_MODULE = [
  { module: 'auth', level: 'info' as SeverityLevel },
  { module: 'moderation', level: 'attention' as SeverityLevel },
  { module: 'tickets', level: 'info' as SeverityLevel },
  { module: 'system', level: 'critique' as SeverityLevel }
];

export const _DEFAULT_MESSAGE_TEMPLATE = 'Bonjour {user}, ...';

export type DashboardSanctionType = 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';

export function toSanctionType(value: DashboardSanctionType): SanctionType {
  return value as SanctionType;
}

export function normalizeBrokenRulesPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return trimmed;
    }

    const normalized = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;

        const snapshot = entry as Record<string, unknown>;
        const id = typeof snapshot.id === 'string' ? snapshot.id.trim() : '';
        if (!id) return null;

        const title = typeof snapshot.title === 'string'
          ? snapshot.title.trim()
          : typeof snapshot.label === 'string'
            ? snapshot.label.trim()
            : '';

        const description = typeof snapshot.description === 'string'
          ? snapshot.description.trim()
          : typeof snapshot.details === 'string'
            ? snapshot.details.trim()
            : '';

        if (!title || !description) return null;

        const emoji = typeof snapshot.emoji === 'string' && snapshot.emoji.trim() ? snapshot.emoji.trim() : null;
        const sortOrder = typeof snapshot.sortOrder === 'number' && Number.isFinite(snapshot.sortOrder) ? snapshot.sortOrder : 0;

        return {
          id,
          title,
          description,
          emoji,
          sortOrder,
        };
      })
      .filter((entry): entry is { id: string; title: string; description: string; emoji: string | null; sortOrder: number } => !!entry);

    return normalized.length > 0 ? JSON.stringify(normalized) : trimmed;
  } catch {
    return trimmed;
  }
}

export const buildModuleUpdatesForPreset = (presetKey: DashboardPresetKey) => {
  if (presetKey === 'dev') {
    return {
      codePoliceEnabled: false,
      autoNicknameModerationEnabled: false,
      sanctionSyncEnabled: false,
      translationEnabled: false,
    };
  }
  if (presetKey === 'gaming') {
    return {
      codePoliceEnabled: true,
      autoNicknameModerationEnabled: true,
      sanctionSyncEnabled: true,
      translationEnabled: true,
    };
  }
  return {
    codePoliceEnabled: false,
    autoNicknameModerationEnabled: true,
    sanctionSyncEnabled: false,
    translationEnabled: true,
  };
};

// Le builder canonique (et type) vit dans shared/core.ts. En garder une copie
// ici avait fini par produire une forme de regle que
// `normalizeCommandRestrictions` ne relisait pas.
export { buildCommandRestrictionsForPreset } from '../../../shared.js';

/**
 * Verifie la signature binaire (magic bytes) d un fichier televerse, pour ne
 * pas se fier au seul mimeType annonce par le client.
 *
 * Etait declaree au milieu du corps de handleModulesRoutes, en colonne 0.
 */
export function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/gif') {
    return buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
           buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && // RIFF
           buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50; // WEBP
  }
  if (mimeType === 'application/pdf') {
    return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
  }
  if (mimeType === 'video/mp4') {
    return buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70; // ftyp
  }
  if (mimeType === 'video/webm') {
    return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3; // EBML
  }
  if (mimeType === 'video/quicktime') {
    return buffer.length >= 8 && (
      (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) || // ftyp
      (buffer[4] === 0x6d && buffer[5] === 0x6f && buffer[6] === 0x6f && buffer[7] === 0x76) || // moov
      (buffer[4] === 0x6d && buffer[5] === 0x64 && buffer[6] === 0x61 && buffer[7] === 0x74)    // mdat
    );
  }
  return false;
}

export function msgEmbedsMap(embeds: Embed[], guild: Guild | null) {
  return embeds.map(e => ({
    title: e.title,
    description: e.description,
    htmlDescription: e.description ? parseDiscordMarkdown(e.description, guild) : '',
    color: e.hexColor,
    fields: e.fields ? e.fields.map((f) => ({
      name: f.name,
      value: f.value,
      htmlValue: f.value ? parseDiscordMarkdown(f.value, guild) : ''
    })) : [],
    image: e.image ? { url: e.image.url } : null,
    thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
    video: e.video ? { url: e.video.url } : null
  }));
}

/** Composant Discord brut (`toJSON()`), réduit à ce que la conversion lit. */
type RawComponent = {
  type: number;
  components?: RawComponent[];
  content?: string;
  accent_color?: number | null;
  accessory?: RawComponent;
  media?: { url?: string };
  items?: Array<{ media?: { url?: string } }>;
  label?: string;
  url?: string;
  emoji?: { name?: string | null; id?: string | null; animated?: boolean };
  style?: number;
  disabled?: boolean;
};

export type MessageCardButton = { label: string; emoji: string | null; url: string | null; style: number; disabled: boolean };

/** Bouton lisible par le dashboard : libellé, émoji (texte ou image), lien. */
function cardButton(raw: RawComponent): MessageCardButton {
  const emoji = raw.emoji?.id
    ? `https://cdn.discordapp.com/emojis/${raw.emoji.id}.${raw.emoji.animated ? 'gif' : 'png'}?size=32`
    : raw.emoji?.name ?? null;
  return { label: raw.label ?? '', emoji, url: raw.url ?? null, style: raw.style ?? 2, disabled: raw.disabled === true };
}

/**
 * Messages en Components V2 lus comme des embeds.
 *
 * Le bot convertit ses embeds en conteneurs V2 (`utils/patchV2.ts`) : leurs
 * messages arrivent sans `embeds`, et la vue live d'un ticket les montrait
 * vides. Chaque conteneur devient une carte au format d'un embed (texte,
 * couleur, vignette, images), ses boutons en plus. Le texte posé hors de tout
 * conteneur revient séparément, comme le contenu d'un message classique.
 */
export function msgComponentsV2Map(components: Array<{ toJSON(): unknown }>, guild: Guild | null) {
  const cards: Array<ReturnType<typeof msgEmbedsMap>[number] & { images: string[]; buttons: MessageCardButton[] }> = [];
  const looseText: string[] = [];
  const looseButtons: MessageCardButton[] = [];

  const toCard = (texts: string[], color: number | null | undefined, images: string[], thumbnail: string | null, buttons: MessageCardButton[]) => {
    const description = texts.filter((text) => text.trim()).join('\n\n');
    cards.push({
      title: null,
      description,
      htmlDescription: description ? parseDiscordMarkdown(description, guild) : '',
      color: typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : null,
      fields: [],
      image: images[0] ? { url: images[0] } : null,
      images: images.slice(1),
      thumbnail: thumbnail ? { url: thumbnail } : null,
      video: null,
      buttons,
    });
  };

  for (const component of components) {
    const raw = component.toJSON() as RawComponent;
    if (raw.type === 17) {
      const texts: string[] = [];
      const images: string[] = [];
      const buttons: MessageCardButton[] = [];
      let thumbnail: string | null = null;
      const walk = (node: RawComponent) => {
        switch (node.type) {
          case 10: texts.push(node.content ?? ''); break;
          case 9:
            node.components?.forEach(walk);
            if (node.accessory?.type === 11 && node.accessory.media?.url) thumbnail = node.accessory.media.url;
            if (node.accessory?.type === 2) buttons.push(cardButton(node.accessory));
            break;
          case 12: node.items?.forEach((item) => { if (item.media?.url) images.push(item.media.url); }); break;
          case 1: node.components?.filter((child) => child.type === 2).forEach((child) => buttons.push(cardButton(child))); break;
          default: break;
        }
      };
      raw.components?.forEach(walk);
      toCard(texts, raw.accent_color, images, thumbnail, buttons);
    } else if (raw.type === 10) {
      looseText.push(raw.content ?? '');
    } else if (raw.type === 1) {
      const buttons = raw.components?.filter((child) => child.type === 2).map(cardButton) ?? [];
      // Une rangée de boutons sous un conteneur lui appartient visuellement.
      if (cards.length > 0) cards[cards.length - 1].buttons.push(...buttons);
      else looseButtons.push(...buttons);
    } else if (raw.type === 12) {
      toCard([], null, raw.items?.map((item) => item.media?.url).filter((url): url is string => !!url) ?? [], null, []);
    }
  }

  return { cards, text: looseText.filter((text) => text.trim()).join('\n'), buttons: looseButtons };
}

/** Réactions d'un message : émoji (texte ou image) et nombre. */
export function msgReactionsMap(reactions: Iterable<{ emoji: { id: string | null; name: string | null; animated?: boolean | null }; count: number | null }>) {
  return [...reactions].map((reaction) => ({
    emoji: reaction.emoji.id ? null : reaction.emoji.name,
    imageUrl: reaction.emoji.id
      ? `https://cdn.discordapp.com/emojis/${reaction.emoji.id}.${reaction.emoji.animated ? 'gif' : 'png'}?size=32`
      : null,
    name: reaction.emoji.name ?? '',
    count: reaction.count ?? 0,
  }));
}

/**
 * Bascule des statistiques de mots, ecrite depuis deux pages : le panneau
 * « Analytique avancee » l'allume d'un clic, l'onglet Verification de la page
 * Comptes multiples la coche avec le reste de ses reglages. Les deux routes
 * passent par ici pour que l'activation garde son effet de bord : reprendre les
 * messages deja journalises, sans quoi la page reste vide le temps que le suivi
 * en direct accumule.
 */
export async function readWordStatsEnabled(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { wordStatsEnabled: true },
  });
  return guild?.wordStatsEnabled ?? false;
}

export function startWordStatsBackfillIfTurnedOn(
  guildId: string,
  wasEnabled: boolean | null,
  isEnabled: unknown,
  source: string,
): void {
  if (wasEnabled !== false || isEnabled !== true) return;
  void (async () => {
    const { startWordStatsBackfill, backfillMessageMentions } = await import('../../../../services/analytics/wordStatsBackfillService.js');
    await backfillMessageMentions(guildId).catch((err) =>
      logger.error(source, `Backfill des mentions échoué pour ${guildId}:`, err),
    );
    await startWordStatsBackfill(guildId);
  })().catch((err) =>
    logger.error(source, `Lancement du backfill des stats de mots échoué pour ${guildId}:`, err),
  );
}
