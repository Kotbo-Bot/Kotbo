import { EmbedBuilder, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import * as m from '../lib/paraglide/messages.js';
import type { BotLocale } from '../utils/i18n.js';
import { libelleModeEcriture, MODES_ECRITURE, type ModeEcriture } from '../services/features/tempVoiceService.js';
import { autorisesDuSalon, bloquesDuSalon, normaliserVisibilite, type Visibilite } from './tempVoiceVisibilite.js';

/** « Mes réglages » : ce qu'un propriétaire retrouve à chaque nouveau salon (colonne MemberProfile.tempVoiceSavedSettings). */
export interface ReglagesPerso {
  nom: string | null;
  limite: number;
  verrouille: boolean;
  visibilite: Visibilite;
  bloques: string[];
  autorises: string[];
  modeEcriture: ModeEcriture | null;
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^\d{1,25}$/.test(x)))] : [];

/** Frontière de confiance : le JSON en base peut être n'importe quoi ; champ invalide => défaut. */
export function normaliserReglagesPerso(raw: unknown): ReglagesPerso | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const nom = typeof r.nom === 'string' && r.nom.trim() && r.nom.length <= 100 ? r.nom : null;
  const limite = typeof r.limite === 'number' && Number.isInteger(r.limite) && r.limite >= 0 && r.limite <= 99 ? r.limite : 0;
  const bloques = ids(r.bloques);
  return {
    nom,
    limite,
    verrouille: r.verrouille === true,
    visibilite: normaliserVisibilite(r.visibilite),
    bloques,
    autorises: ids(r.autorises).filter((id) => !bloques.includes(id)),
    modeEcriture: MODES_ECRITURE.includes(r.modeEcriture as ModeEcriture) ? (r.modeEcriture as ModeEcriture) : null,
  };
}

export async function lireReglagesPerso(guildId: string, userId: string): Promise<ReglagesPerso | null> {
  try {
    const ligne = await prisma.memberProfile.findUnique({
      where: { guildId_userId: { guildId, userId } },
      select: { tempVoiceSavedSettings: true },
    });
    return normaliserReglagesPerso(ligne?.tempVoiceSavedSettings);
  } catch (err) {
    logger.warn('TempVoice', `Réglages de ${userId} illisibles :`, err);
    return null;
  }
}

export async function enregistrerReglagesPerso(guildId: string, userId: string, r: ReglagesPerso): Promise<void> {
  const data = r as unknown as Prisma.InputJsonValue;
  await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, tempVoiceSavedSettings: data },
    update: { tempVoiceSavedSettings: data },
  });
}

export async function oublierReglagesPerso(guildId: string, userId: string): Promise<void> {
  // updateMany : pas de ligne => rien à oublier, sans en créer une.
  await prisma.memberProfile.updateMany({ where: { guildId, userId }, data: { tempVoiceSavedSettings: Prisma.DbNull } });
}

export function capturerReglages(
  channel: VoiceChannel, proprietaireId: string, visibilite: Visibilite, modeEcriture: ModeEcriture | null,
): ReglagesPerso {
  const verrouille = Boolean(channel.permissionOverwrites.cache.get(channel.guild.id)?.deny?.has(PermissionFlagsBits.Connect));
  return {
    nom: channel.name,
    limite: channel.userLimit ?? 0,
    verrouille,
    visibilite,
    bloques: bloquesDuSalon(channel).filter((id) => id !== proprietaireId),
    autorises: autorisesDuSalon(channel, proprietaireId),
    modeEcriture,
  };
}

const mentions = (l: string[]) => (l.length ? l.map((id) => `<@${id}>`).join(' ').slice(0, 1024) : '—');

export function embedRecapReglages(r: ReglagesPerso, locale: BotLocale): EmbedBuilder {
  const o = { locale };
  const acces = r.verrouille ? m.panel_tempvoice_state_locked({}, o) : m.panel_tempvoice_state_open({}, o);
  const visibilite = m[`panel_tempvoice_visibility_${r.visibilite}`]({}, o);
  return new EmbedBuilder()
    .setTitle(m.panel_tempvoice_saved_recap_title({}, o))
    .addFields(
      { name: m.panel_tempvoice_saved_recap_name({}, o), value: r.nom ?? '—', inline: true },
      { name: m.panel_tempvoice_saved_recap_limit({}, o), value: r.limite > 0 ? String(r.limite) : m.panel_tempvoice_saved_recap_unlimited({}, o), inline: true },
      { name: m.panel_tempvoice_saved_recap_access({}, o), value: acces, inline: true },
      { name: m.panel_tempvoice_saved_recap_visibility({}, o), value: visibilite, inline: true },
      { name: m.panel_tempvoice_saved_recap_blocked({}, o), value: mentions(r.bloques), inline: true },
      { name: m.panel_tempvoice_saved_recap_trusted({}, o), value: mentions(r.autorises), inline: true },
      { name: m.panel_tempvoice_saved_recap_chat({}, o), value: r.modeEcriture ? libelleModeEcriture(r.modeEcriture, locale).libelle : '—', inline: true },
    );
}
