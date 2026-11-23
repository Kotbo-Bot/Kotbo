/**
 * Modèles de concours réutilisables.
 *
 * Relancer le même giveaway chaque semaine imposait de ressaisir lot, durée,
 * gagnants et récompenses à l'identique, avec le risque d'un écart d'une fois
 * sur l'autre. Un modèle fige ces valeurs et sert de point de départ à la
 * création, sur Discord comme sur le dashboard.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { normalizeAppearancePatch, type GiveawayAppearance } from './giveawayAppearance.js';
import { normalizeConditions, type GiveawayCondition } from './giveawayConditions.js';

export interface GiveawayTemplate {
  id: string;
  guildId: string;
  name: string;
  prize: string;
  description: string | null;
  winnerCount: number;
  durationMinutes: number;
  channelId: string | null;
  rpgXp: number;
  rpgCoins: number;
  rpgItemId: string | null;
  needValidation: boolean;
  ignoreBonuses: boolean;
  /** `null` = reprendre le filtre du serveur au lancement. */
  conditions: GiveawayCondition[] | null;
  createDiscordEvent: boolean;
  styleOverrides: Partial<GiveawayAppearance>;
  /** Sauvegarde de configuration dont ce modèle est le jumeau. */
  presetId: string | null;
}

export type GiveawayTemplateInput = {
  name: string;
  prize: string;
  description?: string | null;
  winnerCount?: number;
  durationMinutes?: number;
  channelId?: string | null;
  rpgXp?: number;
  rpgCoins?: number;
  rpgItemId?: string | null;
  needValidation?: boolean;
  ignoreBonuses?: boolean;
  conditions?: unknown;
  createDiscordEvent?: boolean;
  styleOverrides?: unknown;
  /**
   * Clef absente : le lien en place est conservé. Corriger un modèle depuis la
   * galerie ne doit pas le détacher de sa sauvegarde, et seul l'enregistrement
   * d'une configuration a de bonnes raisons de le poser ou de le retirer.
   */
  presetId?: string | null;
};

/** Bornes reprises de `createGiveaway` : un modèle ne doit pas créer l'invalide. */
const MAX_DURATION_MINUTES = 525_600;

type TemplateRow = {
  id: string;
  guildId: string;
  name: string;
  prize: string;
  description: string | null;
  winnerCount: number;
  durationMinutes: number;
  channelId: string | null;
  rpgXp: number;
  rpgCoins: number;
  rpgItemId: string | null;
  needValidation: boolean;
  ignoreBonuses: boolean;
  conditions: unknown;
  createDiscordEvent: boolean;
  styleOverrides: unknown;
  presetId: string | null;
};

function toTemplate(row: TemplateRow): GiveawayTemplate {
  return {
    id: row.id,
    guildId: row.guildId,
    name: row.name,
    prize: row.prize,
    description: row.description,
    winnerCount: row.winnerCount,
    durationMinutes: row.durationMinutes,
    channelId: row.channelId,
    rpgXp: row.rpgXp,
    rpgCoins: row.rpgCoins,
    rpgItemId: row.rpgItemId,
    needValidation: row.needValidation,
    ignoreBonuses: row.ignoreBonuses,
    conditions: row.conditions == null ? null : normalizeConditions(row.conditions).conditions,
    createDiscordEvent: row.createDiscordEvent,
    styleOverrides: normalizeAppearancePatch(row.styleOverrides),
    presetId: row.presetId,
  };
}

/**
 * Lien vers la sauvegarde jumelle, seulement quand l'appel s'en mêle.
 *
 * Une clef absente laisse la colonne en place : la galerie renvoie le modèle
 * entier pour en changer une ligne, et ne doit pas le détacher au passage.
 */
function presetLink(input: GiveawayTemplateInput): { presetId?: string | null } {
  if (!('presetId' in input)) return {};
  return { presetId: optionalText(input.presetId, 100) };
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function optionalText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) return null;
  return trimmed;
}

/** Absent ou nul : le modèle suit le filtre du serveur. Une liste invalide est refusée, jamais élargie. */
function normalizedTemplateConditions(raw: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (raw == null) return Prisma.JsonNull;
  const { conditions, rejected } = normalizeConditions(raw);
  if (rejected > 0) throw new Error(`${rejected} condition(s) invalide(s) : vérifie les champs de chaque type.`);
  return conditions as unknown as Prisma.InputJsonValue;
}

/** Valide une saisie de modèle, ou explique pourquoi elle est refusée. */
export function normalizeTemplateInput(input: GiveawayTemplateInput) {
  const name = optionalText(input.name, 80);
  if (!name) throw new Error('Le nom du modèle doit contenir entre 1 et 80 caractères.');

  const prize = optionalText(input.prize, 200);
  if (!prize) throw new Error('Le lot doit contenir entre 1 et 200 caractères.');

  const channelId = typeof input.channelId === 'string' && /^\d{17,20}$/.test(input.channelId)
    ? input.channelId
    : null;

  return {
    name,
    prize,
    description: optionalText(input.description, 2_000),
    winnerCount: boundedInt(input.winnerCount, 1, 1, 20),
    durationMinutes: boundedInt(input.durationMinutes, 1_440, 1, MAX_DURATION_MINUTES),
    channelId,
    rpgXp: boundedInt(input.rpgXp, 0, 0, 1_000_000),
    rpgCoins: boundedInt(input.rpgCoins, 0, 0, 1_000_000),
    rpgItemId: optionalText(input.rpgItemId, 100),
    needValidation: input.needValidation === true,
    ignoreBonuses: input.ignoreBonuses === true,
    conditions: normalizedTemplateConditions(input.conditions),
    createDiscordEvent: input.createDiscordEvent === true,
    styleOverrides: normalizeAppearancePatch(input.styleOverrides),
  };
}

export async function listGiveawayTemplates(guildId: string): Promise<GiveawayTemplate[]> {
  const rows = await prisma.giveawayTemplate.findMany({
    where: { guildId },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => toTemplate(row as unknown as TemplateRow));
}

/** Retrouve un modèle par son nom, saisi sans casse dans la commande Discord. */
export async function findGiveawayTemplateByName(guildId: string, name: string): Promise<GiveawayTemplate | null> {
  const row = await prisma.giveawayTemplate.findFirst({
    where: { guildId, name: { equals: name.trim(), mode: 'insensitive' } },
  });
  return row ? toTemplate(row as unknown as TemplateRow) : null;
}

/**
 * Refuse un objet RPG que le serveur ne pourra pas remettre.
 *
 * L'identifiant se saisit à la main : une faute de frappe passait jusqu'au
 * tirage, où la remise échouait en silence alors que l'annonce avait promis
 * l'objet. Un objet livré de base avec le bot porte `guildId: null` et reste
 * accepté partout.
 *
 * Le contrôle ne porte que sur un objet qui change. Un objet supprimé du module
 * depuis l'enregistrement rendait sinon le modèle intouchable : le renommer
 * échouait sur un message d'objet introuvable, sans rapport avec le geste.
 */
async function assertRpgItemUsable(guildId: string, itemId: string | null): Promise<void> {
  if (!itemId) return;
  const item = await prisma.rpgItem.findFirst({
    where: { id: itemId, OR: [{ guildId: null }, { guildId }] },
    select: { id: true },
  });
  if (!item) throw new Error('Aucun objet RPG ne porte cet identifiant sur ce serveur.');
}

/**
 * Refuse un lien vers une sauvegarde qui n'est pas celle de ce serveur.
 *
 * La clef étrangère accepterait n'importe quel identifiant existant : sans ce
 * contrôle, un appel forgé accrocherait un modèle à la sauvegarde d'un autre
 * serveur, que la page afficherait ensuite comme sa jumelle.
 */
async function assertPresetUsable(guildId: string, presetId: string | null | undefined): Promise<void> {
  if (!presetId) return;
  const preset = await prisma.giveawayConfigPreset.findFirst({
    where: { id: presetId, guildId },
    select: { id: true },
  });
  if (!preset) throw new Error('Aucune sauvegarde de configuration ne porte cet identifiant sur ce serveur.');
}

export async function createGiveawayTemplate(
  guildId: string,
  input: GiveawayTemplateInput,
): Promise<GiveawayTemplate> {
  const data = { ...normalizeTemplateInput(input), ...presetLink(input) };
  await assertRpgItemUsable(guildId, data.rpgItemId);
  await assertPresetUsable(guildId, data.presetId);

  const existing = await prisma.giveawayTemplate.findFirst({
    where: { guildId, name: { equals: data.name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) throw new Error('Un modèle porte déjà ce nom sur ce serveur.');

  const row = await prisma.giveawayTemplate.create({
    data: { guildId, ...data } as Prisma.GiveawayTemplateUncheckedCreateInput,
  });
  return toTemplate(row as unknown as TemplateRow);
}

export async function updateGiveawayTemplate(
  guildId: string,
  templateId: string,
  input: GiveawayTemplateInput,
): Promise<GiveawayTemplate> {
  const data = { ...normalizeTemplateInput(input), ...presetLink(input) };

  const current = await prisma.giveawayTemplate.findFirst({
    where: { id: templateId, guildId },
    select: { id: true, rpgItemId: true, presetId: true },
  });
  if (!current) throw new Error('Modèle introuvable sur ce serveur.');
  if (data.rpgItemId !== current.rpgItemId) await assertRpgItemUsable(guildId, data.rpgItemId);
  if ('presetId' in data && data.presetId !== current.presetId) {
    await assertPresetUsable(guildId, data.presetId);
  }

  const duplicate = await prisma.giveawayTemplate.findFirst({
    where: { guildId, name: { equals: data.name, mode: 'insensitive' }, id: { not: templateId } },
    select: { id: true },
  });
  if (duplicate) throw new Error('Un modèle porte déjà ce nom sur ce serveur.');

  const row = await prisma.giveawayTemplate.update({
    where: { id: templateId },
    data: data as Prisma.GiveawayTemplateUncheckedUpdateInput,
  });
  return toTemplate(row as unknown as TemplateRow);
}

export async function deleteGiveawayTemplate(guildId: string, templateId: string): Promise<boolean> {
  const deleted = await prisma.giveawayTemplate.deleteMany({ where: { id: templateId, guildId } });
  return deleted.count > 0;
}
