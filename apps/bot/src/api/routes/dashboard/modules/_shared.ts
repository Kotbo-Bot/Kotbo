/**
 * Contexte et helpers partages par les sous-routeurs de `modules/`.
 *
 * Extraits de modules.ts, ou ils precedaient une fonction de ~5900 lignes.
 */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { type CommandAccessLevel, type DashboardPresetKey, type SeverityLevel } from '../../../shared.js';
import { SanctionType } from '@prisma/client';

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
