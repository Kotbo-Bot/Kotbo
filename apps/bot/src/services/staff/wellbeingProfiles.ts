/**
 * Fiches confidentielles : écritures liées à la conservation des notes. Les
 * règles sont dans wellbeingProfilePolicy.ts.
 *
 * Le départ d'une personne est pris en compte de deux façons : tout de suite
 * à son départ (events/wellbeingWatch.ts, module actif), et par un rattrapage
 * horaire qui vérifie la présence des personnes suivies, module actif ou non.
 */
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { departureCap, profileNameChange, shortenedExpiry } from './wellbeingProfilePolicy.js';
import { openWellbeing, sealWellbeing } from './wellbeingCrypto.js';

/** Membres demandés à Discord en une fois. */
const MEMBER_FETCH_CHUNK = 100;

/** La personne a quitté le serveur : la fiche le note et aucune note ne dépasse 3 mois. */
export async function markProfileLeft(profileId: string, now: Date): Promise<void> {
  await prisma.wellbeingProfile.update({ where: { id: profileId }, data: { subjectLeftAt: now } });
  const cap = departureCap(now);
  await prisma.wellbeingProfileNote.updateMany({ where: { profileId, expiresAt: { gt: cap } }, data: { expiresAt: cap } });
}

/** La personne est revenue : les nouvelles notes retrouvent la durée réglée, les autres restent raccourcies. */
export async function markProfileBack(guildId: string, subjectUserId: string): Promise<void> {
  await prisma.wellbeingProfile.updateMany({
    where: { guildId, subjectUserId, subjectLeftAt: { not: null } },
    data: { subjectLeftAt: null },
  });
}

/**
 * Présence des personnes qui ont une fiche, serveur par serveur, et leur
 * pseudo actuel, recopié sur la fiche s'il a changé. Un serveur que le bot ne
 * voit plus, ou une réponse de Discord en échec, ne change rien : l'absence de
 * réponse ne vaut pas départ.
 */
export async function reconcileProfileDepartures(client: Client, now: Date = new Date()): Promise<void> {
  const profiles = await prisma.wellbeingProfile.findMany({ select: { id: true, guildId: true, subjectUserId: true, subjectName: true, subjectLeftAt: true } });
  const byGuild = new Map<string, typeof profiles>();
  for (const profile of profiles) byGuild.set(profile.guildId, [...(byGuild.get(profile.guildId) ?? []), profile]);

  for (const [guildId, items] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      const present = new Map<string, string>();
      for (let i = 0; i < items.length; i += MEMBER_FETCH_CHUNK) {
        const members = await guild.members.fetch({ user: items.slice(i, i + MEMBER_FETCH_CHUNK).map((item) => item.subjectUserId) });
        for (const [id, member] of members) present.set(id, member.displayName);
      }
      for (const item of items) {
        const currentName = present.get(item.subjectUserId);
        if (currentName === undefined) {
          if (!item.subjectLeftAt) await markProfileLeft(item.id, now);
          continue;
        }
        if (item.subjectLeftAt) await markProfileBack(guildId, item.subjectUserId);
        const renamed = profileNameChange(openWellbeing(guildId, item.subjectName), currentName);
        if (renamed) await prisma.wellbeingProfile.update({ where: { id: item.id }, data: { subjectName: sealWellbeing(guildId, renamed) } });
      }
    } catch (error) {
      logger.warn('Wellbeing', `Présence des personnes suivies non vérifiée sur ${guildId} :`, error);
    }
  }
}

/**
 * Le propriétaire a baissé la durée réglée : chaque note du serveur est
 * ramenée à la nouvelle durée, préavis tenu, puis annoncée à nouveau.
 */
export async function applyProfileRetention(guildId: string, retentionMonths: number, now: Date = new Date()): Promise<number> {
  const notes = await prisma.wellbeingProfileNote.findMany({
    where: { profile: { guildId } },
    select: { id: true, createdAt: true, extendedAt: true, expiresAt: true, sensitive: true },
  });
  let changed = 0;
  for (const note of notes) {
    const expiresAt = shortenedExpiry(note, retentionMonths, now);
    if (!expiresAt) continue;
    await prisma.wellbeingProfileNote.update({ where: { id: note.id }, data: { expiresAt, purgeWarnedAt: null } });
    changed += 1;
  }
  return changed;
}
