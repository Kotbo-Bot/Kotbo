/**
 * Noyau du module Partenariats : les dossiers et leur cycle de vie.
 *
 * Une règle gouverne tout le fichier : **une étape ne change jamais sans
 * passer par `changePartnershipStage`**. C'est là que sont réunies les quatre
 * choses qui doivent aller ensemble et qu'un `update` direct dissocierait -
 * la transition autorisée, la trace, les avantages, l'alerte. Un dossier passé
 * en actif par une écriture directe aurait un partenaire sans rôle, sans salon
 * et sans personne au courant.
 *
 * Les avantages sont appliqués et retirés par `partnershipBenefitService`, que
 * ce fichier appelle mais qui ne le rappelle jamais : le sens de la dépendance
 * est à sens unique, pour qu'appliquer un rôle ne puisse pas relancer une
 * transition.
 */
import { kotboEventBus } from '@kotbo/core';
import type { Partnership, Prisma } from '@prisma/client';
import {
  getPartnershipTier,
  getPartnershipType,
  isLivePartnershipStage,
  isPartnershipStage,
  isPartnershipTier,
  isPartnershipType,
  nextPartnershipStages,
  type PartnershipStage,
  type PartnershipTier,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getPartnershipSettings } from './partnershipSettings.js';
import { recordPartnershipEvent, sendPartnershipAlert, auditPartnershipAction } from './partnershipEvents.js';
import { applyPartnershipBenefits, revokePartnershipBenefits } from './partnershipBenefitService.js';
import { UserFacingError } from '../../utils/userFacingError.js';

export interface PartnershipActor {
  userId: string;
  /** Libellé affiché dans le journal d'activité. */
  label?: string;
  source?: 'dashboard' | 'discord' | 'bot' | 'guest_portal' | 'bridge';
}

export class PartnershipRuleError extends UserFacingError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PartnershipRuleError';
  }
}

// ─── Création ────────────────────────────────────────────────────────────────

export interface CreatePartnershipInput {
  guildId: string | null;
  partnerId: string;
  type: string;
  tier?: string;
  title?: string | null;
  summary?: string | null;
  terms?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  autoRenew?: boolean;
  renewDays?: number | null;
  ownerUserId?: string | null;
  amountCents?: number | null;
  amountPeriod?: string | null;
  priority?: number;
}

/**
 * Ouvre un dossier, toujours à l'étape `LEAD`.
 *
 * Jamais directement actif, même quand tout est déjà convenu par ailleurs :
 * l'activation applique des rôles et des exemptions, elle doit rester un geste
 * explicite. Le passage de `LEAD` à `ACTIVE` est autorisé en un coup pour les
 * dossiers simples, ce qui rend ce détour indolore.
 */
export async function createPartnership(
  input: CreatePartnershipInput,
  actor: PartnershipActor,
): Promise<Partnership> {
  if (!isPartnershipType(input.type)) {
    throw new PartnershipRuleError(`Type de partenariat inconnu : ${input.type}`, 'unknown_type');
  }

  const partner = await prisma.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner) throw new PartnershipRuleError('Fiche partenaire introuvable.', 'unknown_partner');
  if (partner.blocked) {
    throw new PartnershipRuleError(
      `Cette fiche est bloquée : ${partner.blockedReason ?? 'sans motif enregistré'}.`,
      'partner_blocked',
    );
  }

  const tier = await resolveTier(input.guildId, input.type, input.tier);

  const partnership = await prisma.partnership.create({
    data: {
      scope: input.guildId ? 'GUILD' : 'PLATFORM',
      guildId: input.guildId,
      partnerId: input.partnerId,
      type: input.type,
      tier,
      stage: 'LEAD',
      title: input.title?.slice(0, 200) ?? null,
      summary: input.summary?.slice(0, 2000) ?? null,
      terms: input.terms?.slice(0, 10_000) ?? null,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      autoRenew: input.autoRenew ?? false,
      renewDays: input.renewDays ?? null,
      ownerUserId: input.ownerUserId ?? actor.userId,
      amountCents: input.amountCents ?? null,
      amountPeriod: input.amountPeriod ?? null,
      priority: clampPriority(input.priority),
      createdByUserId: actor.userId,
    },
  });

  await recordPartnershipEvent({
    partnershipId: partnership.id,
    kind: 'created',
    summary: `Dossier ouvert avec ${partner.displayName}.`,
    payload: { type: input.type, tier },
    actorUserId: actor.userId,
    source: actor.source,
  });

  if (input.guildId) {
    auditPartnershipAction({
      guildId: input.guildId,
      user: actor.label ?? actor.userId,
      action: 'Partenariat cree',
      details: `${partner.displayName} - ${input.type} (${tier})`,
    });
  }

  return partnership;
}

/**
 * Niveau de formalisme retenu : celui demandé s'il est valide, sinon celui que
 * le type impose par nature - un sponsor n'a pas à être suivi comme un échange
 * de pubs - sinon le réglage du serveur.
 */
async function resolveTier(guildId: string | null, type: string, requested?: string): Promise<PartnershipTier> {
  if (requested && isPartnershipTier(requested)) return requested;

  const typeMeta = getPartnershipType(type);
  if (typeMeta) return typeMeta.defaultTier;

  if (guildId) {
    const settings = await getPartnershipSettings(guildId);
    if (isPartnershipTier(settings.defaultTier)) return settings.defaultTier;
  }
  return 'PIPELINE';
}

function clampPriority(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0, Math.floor(value)));
}

// ─── Modification ────────────────────────────────────────────────────────────

export interface UpdatePartnershipInput {
  title?: string | null;
  summary?: string | null;
  terms?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  autoRenew?: boolean;
  renewDays?: number | null;
  ownerUserId?: string | null;
  amountCents?: number | null;
  amountPeriod?: string | null;
  priority?: number;
  tier?: string;
  customFields?: Prisma.InputJsonValue;
}

/**
 * Met à jour un dossier hors changement d'étape.
 *
 * `stage` n'est volontairement pas modifiable ici : c'est la seule garantie
 * que le graphe de transitions ne soit pas contourné par un formulaire trop
 * générique.
 */
export async function updatePartnership(
  partnershipId: string,
  input: UpdatePartnershipInput,
  actor: PartnershipActor,
): Promise<Partnership> {
  const existing = await requirePartnership(partnershipId);

  const data: Prisma.PartnershipUpdateInput = {};
  if (input.title !== undefined) data.title = input.title?.slice(0, 200) ?? null;
  if (input.summary !== undefined) data.summary = input.summary?.slice(0, 2000) ?? null;
  if (input.terms !== undefined) data.terms = input.terms?.slice(0, 10_000) ?? null;
  if (input.startAt !== undefined) data.startAt = input.startAt;
  if (input.endAt !== undefined) data.endAt = input.endAt;
  if (input.autoRenew !== undefined) data.autoRenew = input.autoRenew;
  if (input.renewDays !== undefined) data.renewDays = input.renewDays;
  if (input.ownerUserId !== undefined) data.ownerUserId = input.ownerUserId;
  if (input.amountCents !== undefined) data.amountCents = input.amountCents;
  if (input.amountPeriod !== undefined) data.amountPeriod = input.amountPeriod;
  if (input.priority !== undefined) data.priority = clampPriority(input.priority);
  if (input.customFields !== undefined) data.customFields = input.customFields;

  if (input.tier !== undefined) {
    if (!isPartnershipTier(input.tier)) {
      throw new PartnershipRuleError(`Niveau de formalisme inconnu : ${input.tier}`, 'unknown_tier');
    }
    // Redescendre de niveau ne supprime rien : les accords et engagements déjà
    // saisis restent en base, ils cessent seulement d'être exigés.
    data.tier = input.tier;
  }

  const updated = await prisma.partnership.update({ where: { id: partnershipId }, data });

  const changed = Object.keys(data);
  if (changed.length > 0) {
    await recordPartnershipEvent({
      partnershipId,
      kind: 'updated',
      summary: `Dossier modifié (${changed.join(', ')}).`,
      payload: { fields: changed },
      actorUserId: actor.userId,
      source: actor.source,
    });
  }

  if (existing.ownerUserId !== updated.ownerUserId && updated.ownerUserId && updated.guildId) {
    await sendPartnershipAlert({
      guildId: updated.guildId,
      title: 'Dossier partenariat réassigné',
      description: `Vous êtes désormais responsable du dossier « ${await describe(updated)} ».`,
      tone: 'info',
      ownerUserId: updated.ownerUserId,
      link: `/partnerships/${updated.id}`,
    });
  }

  return updated;
}

// ─── Transitions ─────────────────────────────────────────────────────────────

export interface ChangeStageInput {
  partnershipId: string;
  stage: string;
  /** Obligatoire pour une rupture : c'est ce qui nourrit la réputation. */
  reason?: string | null;
  actor: PartnershipActor;
}

/**
 * Fait avancer un dossier, et tire toutes les conséquences de ce mouvement.
 *
 * Refuse trois choses : une étape inconnue, une transition absente du graphe
 * (`nextPartnershipStages`), et une activation qui n'a pas réuni les
 * validations exigées par le niveau du dossier. Le reste - avantages, journal,
 * alerte, dates - suit automatiquement.
 */
export async function changePartnershipStage(input: ChangeStageInput): Promise<Partnership> {
  const partnership = await requirePartnership(input.partnershipId);
  const { stage: target, actor } = { stage: input.stage, actor: input.actor };

  if (!isPartnershipStage(target)) {
    throw new PartnershipRuleError(`Étape inconnue : ${target}`, 'unknown_stage');
  }
  if (target === partnership.stage) return partnership;

  const tier: PartnershipTier = isPartnershipTier(partnership.tier) ? partnership.tier : 'PIPELINE';
  const allowed = nextPartnershipStages(partnership.stage, tier);
  if (!allowed.includes(target)) {
    throw new PartnershipRuleError(
      `Transition refusée : ${partnership.stage} → ${target}. Étapes possibles : ${allowed.join(', ') || 'aucune'}.`,
      'illegal_transition',
    );
  }

  if (target === 'BREACHED' && !input.reason?.trim()) {
    throw new PartnershipRuleError('Une rupture demande un motif.', 'reason_required');
  }

  if (target === 'ACTIVE') await assertActivable(partnership, tier);

  const data: Prisma.PartnershipUpdateInput = { stage: target };

  if (target === 'ACTIVE' && !partnership.startAt) data.startAt = new Date();
  if (target === 'ENDED' || target === 'BREACHED') {
    data.endedAt = new Date();
    data.endedByUserId = actor.userId;
    data.endReason = input.reason?.slice(0, 1000) ?? null;
  }

  const updated = await prisma.partnership.update({ where: { id: input.partnershipId }, data });

  await recordPartnershipEvent({
    partnershipId: updated.id,
    kind: 'stage_changed',
    summary: `Étape : ${partnership.stage} → ${target}.`,
    payload: { from: partnership.stage, to: target, reason: input.reason ?? null },
    actorUserId: actor.userId,
    source: actor.source,
  });

  await syncBenefitsForStage(updated, partnership.stage, target).catch((error) => {
    logger.error('Partenariats : avantages non synchronises apres transition', {
      error,
      partnershipId: updated.id,
      from: partnership.stage,
      to: target,
    });
  });

  await publishStageEvent(updated, partnership.stage, target, input.reason ?? null);
  await announceTransition(updated, partnership.stage, target, input.reason ?? null);

  if (updated.guildId) {
    auditPartnershipAction({
      guildId: updated.guildId,
      user: actor.label ?? actor.userId,
      action: `Partenariat : ${target}`,
      details: `${await describe(updated)} - ${partnership.stage} vers ${target}${input.reason ? ` (${input.reason})` : ''}`,
    });
  }

  return updated;
}

/**
 * Vérifie qu'un dossier a le droit de devenir actif.
 *
 * Le niveau contractuel exige un accord accepté des deux côtés et, quand le
 * serveur l'a demandé, une seconde validation. Sans ce contrôle, « accord
 * signé » ne serait qu'une case cochée dans une interface, et le module
 * n'apporterait rien de plus qu'un bloc-notes.
 */
async function assertActivable(partnership: Partnership, tier: PartnershipTier): Promise<void> {
  const tierMeta = getPartnershipTier(tier);
  if (!tierMeta) return;

  if (tierMeta.agreement) {
    const accepted = await prisma.partnershipAgreement.findFirst({
      where: { partnershipId: partnership.id, state: 'ACCEPTED', acceptedByUs: true, acceptedByPartner: true },
      select: { id: true },
    });
    if (!accepted) {
      throw new PartnershipRuleError(
        "Ce dossier est contractuel : il demande un accord accepté par les deux parties avant d'être activé.",
        'agreement_required',
      );
    }
  }

  const settings = partnership.guildId ? await getPartnershipSettings(partnership.guildId) : null;
  const needsDual = tierMeta.dualApproval || settings?.requireDualApproval === true;
  if (needsDual && !partnership.secondApprovedByUserId) {
    throw new PartnershipRuleError(
      'Ce dossier demande une seconde validation avant activation.',
      'second_approval_required',
    );
  }
}

/**
 * Applique ou retire les avantages selon que le dossier entre ou sort de la
 * vie active. Une pause retire les avantages : c'est le sens d'une pause, et
 * les laisser en place rendrait la reprise indétectable.
 */
async function syncBenefitsForStage(
  partnership: Partnership,
  from: PartnershipStage | string,
  to: PartnershipStage,
): Promise<void> {
  if (!partnership.guildId) return;

  const settings = await getPartnershipSettings(partnership.guildId);
  if (!settings.autoApplyBenefits) return;

  const wasLive = isLivePartnershipStage(from);
  const isLive = isLivePartnershipStage(to);

  if (!wasLive && isLive) await applyPartnershipBenefits(partnership.id);
  else if (wasLive && !isLive) {
    await revokePartnershipBenefits(partnership.id, to === 'PAUSED' ? 'paused' : 'partnership_ended');
  }
}

/**
 * Diffuse le changement d'etape sur le bus, pour les workflows et tout ce qui
 * voudra reagir plus tard.
 *
 * Publie apres la synchronisation des avantages : un workflow declenche par
 * l'activation trouve ainsi le role deja pose, et non une seconde avant. Ne
 * leve jamais - un abonne en echec ne doit pas annuler la transition.
 */
async function publishStageEvent(
  partnership: Partnership,
  from: string,
  to: PartnershipStage,
  reason: string | null,
): Promise<void> {
  if (!partnership.guildId) return;

  const partner = await prisma.partner.findUnique({
    where: { id: partnership.partnerId },
    select: { displayName: true, partnerGuildId: true },
  });

  try {
    kotboEventBus.publish('partnership:stage', {
      guildId: partnership.guildId,
      partnershipId: partnership.id,
      partnerId: partnership.partnerId,
      partnerName: partner?.displayName ?? 'Partenaire',
      partnerGuildId: partner?.partnerGuildId ?? null,
      type: partnership.type,
      fromStage: from,
      toStage: to,
      reason,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.warn('Partenariats : evenement de bus non publie', { partnershipId: partnership.id, error });
  }
}

async function announceTransition(
  partnership: Partnership,
  from: string,
  to: PartnershipStage,
  reason: string | null,
): Promise<void> {
  if (!partnership.guildId) return;

  const label = await describe(partnership);
  const tone = to === 'BREACHED' ? 'danger' : to === 'ACTIVE' ? 'success' : to === 'REJECTED' ? 'warning' : 'info';

  await sendPartnershipAlert({
    guildId: partnership.guildId,
    title: `Partenariat ${to === 'ACTIVE' ? 'activé' : to === 'BREACHED' ? 'rompu' : 'mis à jour'}`,
    description: `${label} : ${from} → ${to}.`,
    tone,
    fields: reason ? [{ name: 'Motif', value: reason }] : undefined,
    ownerUserId: partnership.ownerUserId,
    link: `/partnerships/${partnership.id}`,
  });
}

// ─── Validations ─────────────────────────────────────────────────────────────

/**
 * Pose une validation sur le dossier. La seconde ne peut pas venir de la même
 * personne : une double validation qu'une seule personne peut poser deux fois
 * ne valide rien.
 */
export async function approvePartnership(
  partnershipId: string,
  actor: PartnershipActor,
): Promise<Partnership> {
  const partnership = await requirePartnership(partnershipId);

  if (!partnership.approvedByUserId) {
    const updated = await prisma.partnership.update({
      where: { id: partnershipId },
      data: { approvedByUserId: actor.userId, approvedAt: new Date() },
    });
    await recordPartnershipEvent({
      partnershipId,
      kind: 'approved',
      summary: 'Première validation posée.',
      actorUserId: actor.userId,
      source: actor.source,
    });
    return updated;
  }

  if (partnership.approvedByUserId === actor.userId) {
    throw new PartnershipRuleError(
      'La seconde validation doit venir de quelqu\'un d\'autre.',
      'same_approver',
    );
  }

  if (partnership.secondApprovedByUserId) return partnership;

  const updated = await prisma.partnership.update({
    where: { id: partnershipId },
    data: { secondApprovedByUserId: actor.userId, secondApprovedAt: new Date() },
  });
  await recordPartnershipEvent({
    partnershipId,
    kind: 'approved_second',
    summary: 'Seconde validation posée.',
    actorUserId: actor.userId,
    source: actor.source,
  });
  return updated;
}

// ─── Lecture ─────────────────────────────────────────────────────────────────

export interface PartnershipFilters {
  guildId?: string | null;
  stages?: string[];
  types?: string[];
  partnerId?: string;
  ownerUserId?: string;
  /** Texte cherché dans le titre du dossier et le nom du partenaire. */
  search?: string;
  /** Dossiers vivants uniquement. */
  liveOnly?: boolean;
  take?: number;
  skip?: number;
}

export async function listPartnerships(filters: PartnershipFilters) {
  const where: Prisma.PartnershipWhereInput = {};

  if (filters.guildId !== undefined) where.guildId = filters.guildId;
  if (filters.partnerId) where.partnerId = filters.partnerId;
  if (filters.ownerUserId) where.ownerUserId = filters.ownerUserId;
  if (filters.types?.length) where.type = { in: filters.types };

  if (filters.liveOnly) where.stage = { in: ['ACTIVE', 'RENEWAL'] };
  else if (filters.stages?.length) where.stage = { in: filters.stages };

  if (filters.search?.trim()) {
    const search = filters.search.trim().slice(0, 100);
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { partner: { displayName: { contains: search, mode: 'insensitive' } } },
    ];
  }

  return prisma.partnership.findMany({
    where,
    include: { partner: { select: { id: true, displayName: true, kind: true, iconUrl: true, trustScore: true } } },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    take: Math.min(filters.take ?? 50, 200),
    skip: filters.skip ?? 0,
  });
}

/** Le dossier complet, tel que la fiche du dashboard l'affiche. */
export async function getPartnershipDetail(partnershipId: string) {
  return prisma.partnership.findUnique({
    where: { id: partnershipId },
    include: {
      partner: { include: { contacts: true } },
      agreements: { orderBy: { version: 'desc' } },
      commitments: { include: { periods: { orderBy: { periodStart: 'desc' }, take: 6 } } },
      benefits: { include: { grants: { where: { revokedAt: null } } } },
      promotions: { include: { posts: { orderBy: { postedAt: 'desc' }, take: 5 } } },
      payments: { orderBy: { dueAt: 'asc' } },
      documents: { orderBy: { createdAt: 'desc' } },
      notes: { orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 50 },
      events: { orderBy: { createdAt: 'desc' }, take: 100 },
      checks: { orderBy: { checkedAt: 'desc' }, take: 10 },
      links: true,
    },
  });
}

export async function requirePartnership(partnershipId: string): Promise<Partnership> {
  const partnership = await prisma.partnership.findUnique({ where: { id: partnershipId } });
  if (!partnership) throw new PartnershipRuleError('Dossier introuvable.', 'unknown_partnership');
  return partnership;
}

/** Libellé court d'un dossier, pour les journaux et les alertes. */
async function describe(partnership: Partnership): Promise<string> {
  if (partnership.title) return partnership.title;
  const partner = await prisma.partner.findUnique({
    where: { id: partnership.partnerId },
    select: { displayName: true },
  });
  return partner?.displayName ?? 'Partenariat';
}
