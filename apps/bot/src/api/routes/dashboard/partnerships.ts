/** Routes dashboard du module Partenariats. */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import type { PartnerApplicationStatus, PartnershipCommitmentState, PartnershipPaymentStatus } from '@prisma/client';
import {
  PARTNERSHIP_BENEFIT_META,
  PARTNERSHIP_COMMITMENT_META,
  PARTNERSHIP_STAGE_META,
  PARTNERSHIP_TIER_META,
  PARTNERSHIP_TYPE_META,
  PARTNERSHIP_PRESETS,
  PARTNER_KIND_META,
  nextPartnershipStages,
  isPartnershipTier,
} from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  getPartnershipSettings,
  updatePartnershipSettings,
} from '../../../services/partnerships/partnershipSettings.js';
import {
  checkPartnershipReadiness,
  createPartnershipFromPreset,
  runPartnershipSetup,
} from '../../../services/partnerships/partnershipSetupService.js';
import {
  PartnershipRuleError,
  approvePartnership,
  changePartnershipStage,
  createPartnership,
  getPartnershipDetail,
  listPartnerships,
  updatePartnership,
} from '../../../services/partnerships/partnershipService.js';
import {
  addPartnerContact,
  createPartner,
  recomputeTrustScore,
  refreshPartnerInvite,
  removePartnerContact,
  setPartnerBlocked,
  updatePartner,
  updatePartnerContact,
  lookupInvite,
} from '../../../services/partnerships/partnerService.js';
import {
  addCommitment,
  removeCommitment,
  setCommitmentManualState,
} from '../../../services/partnerships/partnershipCommitmentService.js';
import {
  applyPartnershipBenefits,
  revokePartnershipBenefits,
} from '../../../services/partnerships/partnershipBenefitService.js';
import {
  checkReciprocity,
  publishPromotion,
  refreshShowcase,
  upsertPromotion,
} from '../../../services/partnerships/partnershipPromotionService.js';
import {
  ensurePartnershipInvite,
  getPartnershipReport,
  recomputeHealthScore,
} from '../../../services/partnerships/partnershipAttributionService.js';
import {
  acceptAgreement,
  createGuestAccess,
  draftAgreement,
  proposeAgreement,
  revokeGuestAccess,
  withdrawAgreement,
} from '../../../services/partnerships/partnershipAgreementService.js';
import {
  addPayment,
  getFinanceSummary,
  removePayment,
  setPaymentStatus,
  settlePayment,
} from '../../../services/partnerships/partnershipFinanceService.js';
import {
  decideApplication,
  listApplications,
  submitApplication,
} from '../../../services/partnerships/partnerApplicationService.js';
import {
  computeMatches,
  dismissMatch,
  ensureShowcaseInvite,
  suggestListingFromGuild,
  listMatches,
  respondToProposal,
  searchDirectory,
  sendProposal,
  upsertListing,
  withdrawProposal,
} from '../../../services/partnerships/partnershipDirectoryService.js';
import {
  blockSubject,
  listBlocklist,
  listOwnReports,
  lookupNetworkSignal,
  reportPartner,
  unblockSubject,
  withdrawReport,
  REPUTATION_REASON_LABELS,
} from '../../../services/partnerships/partnershipReputationService.js';
import {
  confirmBridge,
  findBridgeCandidate,
  findBridgedPartnership,
  proposeBridge,
  removeBridge,
} from '../../../services/partnerships/partnershipBridgeService.js';
import { publicErrorMessage } from '../../../utils/publicError.js';

/** Segments servis par ce routeur. */
const SEGMENTS = new Set(['partnerships', 'partners', 'partner-applications', 'partnership-directory']);

type Body = Record<string, unknown>;

/**
 * Convertit une erreur de règle métier en réponse lisible.
 *
 * Les `PartnershipRuleError` disent précisément ce qui bloque - transition
 * interdite, accord manquant, seconde validation absente. Les renvoyer en 400
 * avec leur message évite au dashboard de réinventer ces explications, et
 * évite surtout qu'elles divergent entre les deux surfaces.
 */
function fail(res: ServerResponse, error: unknown, context: string): void {
  if (error instanceof PartnershipRuleError) {
    json(res, 400, { error: error.message, code: error.code });
    return;
  }
  logger.error('PartenariatsAPI', `Erreur ${context}:`, error);
  json(res, 500, { error: 'Erreur du module Partenariats' });
}

function str(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function optionalDate(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function handlePartnershipRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  const segment = parts[4];
  if (!segment || !SEGMENTS.has(segment)) return false;

  const method = req.method ?? 'GET';

  // Lecture ouverte à qui voit le dashboard ; écriture réservée aux
  // administrateurs, sauf élévation accordée par le centre de gestion - c'est
  // le répartiteur qui l'applique en amont, sur `access.canManageSettings`.
  if (!access.canViewDashboard) {
    json(res, 403, { error: 'Accès refusé' });
    return true;
  }
  if (method !== 'GET' && !access.canManageSettings) {
    json(res, 403, { error: 'Action réservée aux administrateurs du dashboard.' });
    return true;
  }

  const actor = { userId: user.userId, label: user.username ?? `User${user.userId}`, source: 'dashboard' as const };

  try {
    if (segment === 'partnerships') return await handlePartnerships(req, res, parts, url, client, guildId, actor);
    if (segment === 'partners') return await handlePartners(req, res, parts, url, guildId, actor);
    if (segment === 'partner-applications') return await handleApplications(req, res, parts, guildId, actor);
    return await handleDirectory(req, res, parts, url, client, guildId, actor);
  } catch (error) {
    fail(res, error, `${method} ${parts.slice(4).join('/')}`);
    return true;
  }
}

type Actor = { userId: string; label: string; source: 'dashboard' };

// ─── /partnerships ───────────────────────────────────────────────────────────

async function handlePartnerships(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  guildId: string,
  actor: Actor,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // GET /partnerships - liste + référentiel affiché par les formulaires
  if (parts.length === 5 && method === 'GET') {
    const [items, settings, counts] = await Promise.all([
      listPartnerships({
        guildId,
        stages: url.searchParams.get('stage')?.split(',').filter(Boolean),
        types: url.searchParams.get('type')?.split(',').filter(Boolean),
        search: url.searchParams.get('q') ?? undefined,
        take: Number(url.searchParams.get('take') ?? 100),
      }),
      getPartnershipSettings(guildId),
      prisma.partnership.groupBy({ by: ['stage'], where: { guildId }, _count: true }),
    ]);

    json(res, 200, {
      partnerships: items,
      settings,
      counts: Object.fromEntries(counts.map((row) => [row.stage, row._count])),
      catalog: {
        types: PARTNERSHIP_TYPE_META,
        tiers: PARTNERSHIP_TIER_META,
        stages: PARTNERSHIP_STAGE_META,
        benefits: PARTNERSHIP_BENEFIT_META,
        commitments: PARTNERSHIP_COMMITMENT_META,
        kinds: PARTNER_KIND_META,
        presets: PARTNERSHIP_PRESETS,
        reputationReasons: REPUTATION_REASON_LABELS,
      },
    });
    return true;
  }

  // POST /partnerships - ouverture d'un dossier
  if (parts.length === 5 && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const partnership = await createPartnership(
      {
        guildId,
        partnerId: String(body.partnerId ?? ''),
        type: String(body.type ?? ''),
        tier: str(body.tier, 20),
        title: str(body.title, 200) ?? null,
        summary: str(body.summary, 2000) ?? null,
        terms: str(body.terms, 10_000) ?? null,
        startAt: optionalDate(body.startAt) ?? null,
        endAt: optionalDate(body.endAt) ?? null,
        autoRenew: body.autoRenew === true,
        renewDays: typeof body.renewDays === 'number' ? body.renewDays : null,
        ownerUserId: str(body.ownerUserId, 20) ?? null,
        amountCents: typeof body.amountCents === 'number' ? Math.round(body.amountCents) : null,
        amountPeriod: str(body.amountPeriod, 20) ?? null,
        priority: typeof body.priority === 'number' ? body.priority : undefined,
      },
      actor,
    );
    json(res, 201, { partnership });
    return true;
  }

  // POST /partnerships/quick - ajout guide d'un partenaire
  //
  // Fiche, dossier, engagements, avantages et invitation dediee en un geste, a
  // partir d'un prereglage. Tout reste modifiable ensuite depuis la fiche.
  if (parts.length === 6 && parts[5] === 'quick' && method === 'POST') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }

    const body = (await readJsonBody<Body>(req)) ?? {};
    const partner = (body.partner ?? {}) as Body;
    const displayName = str(partner.displayName, 120)?.trim();
    if (!displayName) {
      json(res, 400, { error: 'Donnez un nom au partenaire.' });
      return true;
    }

    const result = await createPartnershipFromPreset(
      guild,
      {
        preset: String(body.preset ?? ''),
        partner: {
          displayName,
          kind: str(partner.kind, 20),
          inviteUrl: str(partner.inviteUrl, 300) ?? null,
          partnerGuildId: str(partner.partnerGuildId, 20) ?? null,
          description: str(partner.description, 4000) ?? null,
          iconUrl: str(partner.iconUrl, 500) ?? null,
          bannerUrl: str(partner.bannerUrl, 500) ?? null,
          memberCount: typeof partner.memberCount === 'number' ? partner.memberCount : null,
        },
        contactUserId: str(body.contactUserId, 20) ?? null,
        endAt: optionalDate(body.endAt) ?? null,
      },
      { userId: actor.userId, label: actor.label },
    );

    json(res, 201, result);
    return true;
  }

  // GET /partnerships/setup - ce qui manque pour que le module serve
  if (parts.length === 6 && parts[5] === 'setup' && method === 'GET') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }
    json(res, 200, { readiness: await checkPartnershipReadiness(guild) });
    return true;
  }

  // POST /partnerships/setup - pose ce qui manque et allume le module
  if (parts.length === 6 && parts[5] === 'setup' && method === 'POST') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }

    const body = (await readJsonBody<Body>(req)) ?? {};
    try {
      const result = await runPartnershipSetup(guild, {
        staffRoleId: str(body.staffRoleId, 20) ?? null,
        auditUser: actor.label,
      });
      json(res, 200, { ...result, readiness: await checkPartnershipReadiness(guild) });
    } catch (error) {
      // Les permissions manquantes sont dites telles quelles : c'est la seule
      // chose que la personne peut corriger elle-meme, et elle doit savoir
      // laquelle.
      json(res, 400, { error: publicErrorMessage(error, 'Mise en service impossible.') });
    }
    return true;
  }

  // GET /partnerships/settings
  if (parts.length === 6 && parts[5] === 'settings' && method === 'GET') {
    json(res, 200, { settings: await getPartnershipSettings(guildId) });
    return true;
  }

  // PATCH /partnerships/settings
  if (parts.length === 6 && parts[5] === 'settings' && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const settings = await updatePartnershipSettings(guildId, sanitizeSettings(body));
    json(res, 200, { settings });
    return true;
  }

  // GET /partnerships/finance
  if (parts.length === 6 && parts[5] === 'finance' && method === 'GET') {
    json(res, 200, { summary: await getFinanceSummary(guildId) });
    return true;
  }

  const partnershipId = parts[5];
  if (!partnershipId) return false;

  // Toutes les routes qui suivent visent un dossier : on vérifie qu'il
  // appartient bien à ce serveur. Sans ce contrôle, un identifiant deviné
  // donnerait accès au dossier d'un autre serveur.
  const owned = await prisma.partnership.findFirst({
    where: { id: partnershipId, guildId },
    select: { id: true },
  });
  if (!owned) {
    json(res, 404, { error: 'Dossier introuvable' });
    return true;
  }

  // Le dossier est à ce serveur, mais le sous-élément visé (accord, engagement, paiement…)
  // doit aussi être à ce dossier : les services le prennent par son seul identifiant, et
  // celui d'un autre serveur se proposait, se réglait ou se supprimait depuis le nôtre.
  const subresourceId = parts.length >= 8 ? parts[7] : undefined;
  if (subresourceId) {
    const belongs = await subresourceBelongsToPartnership(parts[6], subresourceId, partnershipId, parts[8]);
    if (belongs === false) {
      json(res, 404, { error: 'Élément introuvable' });
      return true;
    }
  }

  // GET /partnerships/:id
  if (parts.length === 6 && method === 'GET') {
    const [detail, report, bridged] = await Promise.all([
      getPartnershipDetail(partnershipId),
      getPartnershipReport(partnershipId),
      findBridgedPartnership(partnershipId),
    ]);
    if (!detail) {
      json(res, 404, { error: 'Dossier introuvable' });
      return true;
    }
    json(res, 200, {
      partnership: detail,
      report,
      bridged,
      nextStages: nextPartnershipStages(detail.stage, isPartnershipTier(detail.tier) ? detail.tier : 'PIPELINE'),
    });
    return true;
  }

  // PATCH /partnerships/:id
  if (parts.length === 6 && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const partnership = await updatePartnership(
      partnershipId,
      {
        title: str(body.title, 200),
        summary: str(body.summary, 2000),
        terms: str(body.terms, 10_000),
        startAt: optionalDate(body.startAt),
        endAt: optionalDate(body.endAt),
        autoRenew: typeof body.autoRenew === 'boolean' ? body.autoRenew : undefined,
        renewDays: typeof body.renewDays === 'number' ? body.renewDays : undefined,
        ownerUserId: str(body.ownerUserId, 20),
        amountCents: typeof body.amountCents === 'number' ? Math.round(body.amountCents) : undefined,
        amountPeriod: str(body.amountPeriod, 20),
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        tier: str(body.tier, 20),
      },
      actor,
    );
    json(res, 200, { partnership });
    return true;
  }

  const action = parts[6];

  // POST /partnerships/:id/stage
  if (parts.length === 7 && action === 'stage' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const partnership = await changePartnershipStage({
      partnershipId,
      stage: String(body.stage ?? ''),
      reason: str(body.reason, 1000) ?? null,
      actor,
    });
    json(res, 200, { partnership });
    return true;
  }

  // POST /partnerships/:id/approve
  if (parts.length === 7 && action === 'approve' && method === 'POST') {
    json(res, 200, { partnership: await approvePartnership(partnershipId, actor) });
    return true;
  }

  // POST /partnerships/:id/invite - crée ou retrouve l'invitation dédiée
  if (parts.length === 7 && action === 'invite' && method === 'POST') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }
    json(res, 200, { code: await ensurePartnershipInvite(guild, partnershipId) });
    return true;
  }

  // POST /partnerships/:id/benefits
  if (parts.length === 7 && action === 'benefits' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const benefit = await prisma.partnershipBenefit.create({
      data: {
        partnershipId,
        direction: body.direction === 'RECEIVED' ? 'RECEIVED' : 'GRANTED',
        kind: String(body.kind ?? ''),
        label: str(body.label, 200) ?? null,
        targetRef: str(body.targetRef, 100) ?? null,
        params: (body.params ?? undefined) as never,
      },
    });
    json(res, 201, { benefit });
    return true;
  }

  // DELETE /partnerships/:id/benefits/:benefitId
  if (parts.length === 8 && action === 'benefits' && method === 'DELETE') {
    await prisma.partnershipBenefit.deleteMany({ where: { id: parts[7], partnershipId } });
    json(res, 200, { ok: true });
    return true;
  }

  // POST /partnerships/:id/benefits/apply | /revoke
  if (parts.length === 8 && action === 'benefits' && method === 'POST') {
    if (parts[7] === 'apply') await applyPartnershipBenefits(partnershipId);
    else if (parts[7] === 'revoke') await revokePartnershipBenefits(partnershipId, 'manual');
    else return false;
    json(res, 200, { ok: true });
    return true;
  }

  // POST /partnerships/:id/commitments
  if (parts.length === 7 && action === 'commitments' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const commitment = await addCommitment(partnershipId, {
      party: body.party === 'US' ? 'US' : body.party === 'BOTH' ? 'BOTH' : 'PARTNER',
      kind: String(body.kind ?? ''),
      label: str(body.label, 200) ?? null,
      targetCount: typeof body.targetCount === 'number' ? body.targetCount : null,
      targetPeriod: str(body.targetPeriod, 20) ?? null,
      targetRef: str(body.targetRef, 100) ?? null,
    });
    json(res, 201, { commitment });
    return true;
  }

  // PATCH /partnerships/:id/commitments/:commitmentId - pointage manuel
  if (parts.length === 8 && action === 'commitments' && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const state = typeof body.state === 'string' ? (body.state as PartnershipCommitmentState) : null;
    const commitment = await setCommitmentManualState(parts[7], state, actor.userId, str(body.note, 500));
    json(res, 200, { commitment });
    return true;
  }

  if (parts.length === 8 && action === 'commitments' && method === 'DELETE') {
    await removeCommitment(parts[7]);
    json(res, 200, { ok: true });
    return true;
  }

  // POST /partnerships/:id/promotions
  if (parts.length === 7 && action === 'promotions' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const promotion = await upsertPromotion(partnershipId, {
      id: str(body.id, 40),
      direction: body.direction === 'RECEIVED' ? 'RECEIVED' : 'GRANTED',
      title: str(body.title, 200) ?? null,
      content: str(body.content, 4000) ?? null,
      imageUrl: str(body.imageUrl, 500) ?? null,
      inviteUrl: str(body.inviteUrl, 500) ?? null,
      channelId: str(body.channelId, 20) ?? null,
      remoteChannelId: str(body.remoteChannelId, 20) ?? null,
      autoPublish: body.autoPublish === true,
      repeatHours: typeof body.repeatHours === 'number' ? body.repeatHours : 0,
      replacePrevious: body.replacePrevious !== false,
      active: body.active !== false,
    });
    json(res, 200, { promotion });
    return true;
  }

  // POST /partnerships/:id/promotions/:promotionId/publish
  if (parts.length === 9 && action === 'promotions' && parts[8] === 'publish' && method === 'POST') {
    const published = await publishPromotion(parts[7], client);
    json(res, published ? 200 : 409, published ? { ok: true } : { error: "La publication n'a pas abouti." });
    return true;
  }

  if (parts.length === 8 && action === 'promotions' && method === 'DELETE') {
    await prisma.partnershipPromotion.deleteMany({ where: { id: parts[7], partnershipId } });
    json(res, 200, { ok: true });
    return true;
  }

  // POST /partnerships/:id/showcase | /reciprocity | /health
  if (parts.length === 7 && method === 'POST' && action === 'showcase') {
    await refreshShowcase(partnershipId, client);
    json(res, 200, { ok: true });
    return true;
  }
  if (parts.length === 7 && method === 'POST' && action === 'reciprocity') {
    await checkReciprocity(partnershipId, client);
    const checks = await prisma.partnershipReciprocityCheck.findMany({
      where: { partnershipId },
      orderBy: { checkedAt: 'desc' },
      take: 5,
    });
    json(res, 200, { checks });
    return true;
  }
  if (parts.length === 7 && method === 'POST' && action === 'health') {
    json(res, 200, { healthScore: await recomputeHealthScore(partnershipId) });
    return true;
  }

  // Accords
  if (parts.length === 7 && action === 'agreements' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 201, { agreement: await draftAgreement(partnershipId, String(body.body ?? ''), actor.userId) });
    return true;
  }
  if (parts.length === 9 && action === 'agreements' && method === 'POST') {
    const agreementId = parts[7];
    if (parts[8] === 'propose') {
      json(res, 200, { agreement: await proposeAgreement(agreementId, actor.userId) });
      return true;
    }
    if (parts[8] === 'accept') {
      json(res, 200, { agreement: await acceptAgreement(agreementId, 'us', actor.userId) });
      return true;
    }
    if (parts[8] === 'withdraw') {
      await withdrawAgreement(agreementId, actor.userId);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // Accès invité
  if (parts.length === 7 && action === 'guest-access' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const link = await createGuestAccess(partnershipId, {
      capability: body.capability === 'sign' ? 'sign' : 'view',
      label: str(body.label, 100),
      days: typeof body.days === 'number' ? body.days : undefined,
      actorUserId: actor.userId,
    });
    // Le jeton n'est renvoyé qu'ici, une seule fois : la base n'en garde que
    // l'empreinte.
    json(res, 201, { token: link.token, expiresAt: link.expiresAt, id: link.id });
    return true;
  }
  if (parts.length === 8 && action === 'guest-access' && method === 'DELETE') {
    await revokeGuestAccess(parts[7]);
    json(res, 200, { ok: true });
    return true;
  }

  // Paiements
  if (parts.length === 7 && action === 'payments' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const dueAt = optionalDate(body.dueAt);
    if (!dueAt) {
      json(res, 400, { error: 'Une échéance demande une date.' });
      return true;
    }
    const payment = await addPayment(
      partnershipId,
      {
        direction: body.direction === 'GRANTED' ? 'GRANTED' : 'RECEIVED',
        label: str(body.label, 200) ?? null,
        amountCents: Math.round(Number(body.amountCents ?? 0)),
        currency: str(body.currency, 3),
        dueAt,
        method: str(body.method, 60) ?? null,
        reference: str(body.reference, 100) ?? null,
        note: str(body.note, 1000) ?? null,
      },
      actor.userId,
    );
    json(res, 201, { payment });
    return true;
  }
  if (parts.length === 9 && action === 'payments' && parts[8] === 'settle' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      payment: await settlePayment(parts[7], actor.userId, {
        method: str(body.method, 60),
        reference: str(body.reference, 100),
        settledAt: optionalDate(body.settledAt) ?? undefined,
      }),
    });
    return true;
  }
  if (parts.length === 8 && action === 'payments' && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      payment: await setPaymentStatus(parts[7], String(body.status ?? 'SCHEDULED') as PartnershipPaymentStatus, actor.userId),
    });
    return true;
  }
  if (parts.length === 8 && action === 'payments' && method === 'DELETE') {
    await removePayment(parts[7]);
    json(res, 200, { ok: true });
    return true;
  }

  // Notes et documents
  if (parts.length === 7 && action === 'notes' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const note = await prisma.partnershipNote.create({
      data: {
        partnershipId,
        body: String(body.body ?? '').slice(0, 5000),
        authorUserId: actor.userId,
        pinned: body.pinned === true,
      },
    });
    json(res, 201, { note });
    return true;
  }
  if (parts.length === 8 && action === 'notes' && method === 'DELETE') {
    await prisma.partnershipNote.deleteMany({ where: { id: parts[7], partnershipId } });
    json(res, 200, { ok: true });
    return true;
  }
  if (parts.length === 7 && action === 'documents' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const url = String(body.url ?? '');
    if (!/^https:\/\//i.test(url)) {
      json(res, 400, { error: 'Seules les URL https sont acceptées.' });
      return true;
    }
    const document = await prisma.partnershipDocument.create({
      data: {
        partnershipId,
        label: String(body.label ?? 'Document').slice(0, 200),
        url: url.slice(0, 500),
        category: str(body.category, 20) ?? 'other',
        sharedWithPartner: body.sharedWithPartner === true,
        uploadedByUserId: actor.userId,
      },
    });
    json(res, 201, { document });
    return true;
  }
  if (parts.length === 8 && action === 'documents' && method === 'DELETE') {
    await prisma.partnershipDocument.deleteMany({ where: { id: parts[7], partnershipId } });
    json(res, 200, { ok: true });
    return true;
  }

  // Pont
  if (parts.length === 7 && action === 'bridge' && method === 'GET') {
    json(res, 200, { candidate: await findBridgeCandidate(partnershipId) });
    return true;
  }
  if (parts.length === 7 && action === 'bridge' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const bridge = await proposeBridge({
      localPartnershipId: partnershipId,
      remotePartnershipId: String(body.remotePartnershipId ?? ''),
      syncedFields: Array.isArray(body.syncedFields) ? (body.syncedFields as never) : undefined,
    });
    json(res, 201, { bridge });
    return true;
  }
  if (parts.length === 9 && action === 'bridge' && parts[8] === 'confirm' && method === 'POST') {
    json(res, 200, { bridge: await confirmBridge(parts[7]) });
    return true;
  }
  if (parts.length === 8 && action === 'bridge' && method === 'DELETE') {
    await removeBridge(parts[7]);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ─── /partners ───────────────────────────────────────────────────────────────

/**
 * Vrai si le sous-élément appartient au dossier, faux sinon, null pour une route qui ne
 * désigne pas de sous-élément par identifiant (`benefits/apply`, par exemple).
 *
 * Un pont relie deux dossiers : il appartient aux deux, mais seul le dossier distant le
 * confirme. Le confirmer depuis le dossier qui l'a proposé le rendrait unilatéral.
 */
async function subresourceBelongsToPartnership(
  kind: string | undefined,
  id: string,
  partnershipId: string,
  subAction: string | undefined,
): Promise<boolean | null> {
  const scoped = { id, partnershipId };
  switch (kind) {
    case 'agreements': return (await prisma.partnershipAgreement.count({ where: scoped })) > 0;
    case 'commitments': return (await prisma.partnershipCommitment.count({ where: scoped })) > 0;
    case 'promotions': return (await prisma.partnershipPromotion.count({ where: scoped })) > 0;
    case 'guest-access': return (await prisma.partnershipGuestAccess.count({ where: scoped })) > 0;
    case 'payments': return (await prisma.partnershipPayment.count({ where: scoped })) > 0;
    case 'bridge': {
      const side = subAction === 'confirm'
        ? { remotePartnershipId: partnershipId }
        : { OR: [{ localPartnershipId: partnershipId }, { remotePartnershipId: partnershipId }] };
      return (await prisma.partnershipBridge.count({ where: { id, ...side } })) > 0;
    }
    default: return null;
  }
}

async function handlePartners(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  guildId: string,
  actor: Actor,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (parts.length === 5 && method === 'GET') {
    const partners = await prisma.partner.findMany({
      where: {
        guildId,
        ...(url.searchParams.get('q')
          ? { displayName: { contains: url.searchParams.get('q') as string, mode: 'insensitive' as const } }
          : {}),
      },
      include: { contacts: true, _count: { select: { partnerships: true } } },
      orderBy: { displayName: 'asc' },
      take: 200,
    });
    json(res, 200, { partners });
    return true;
  }

  if (parts.length === 5 && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const partner = await createPartner(
      {
        guildId,
        kind: str(body.kind, 20),
        displayName: String(body.displayName ?? 'Partenaire'),
        shortName: str(body.shortName, 40) ?? null,
        description: str(body.description, 4000) ?? null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        locale: str(body.locale, 10) ?? null,
        timezone: str(body.timezone, 40) ?? null,
        partnerGuildId: str(body.partnerGuildId, 20) ?? null,
        inviteUrl: str(body.inviteUrl, 300) ?? null,
        iconUrl: str(body.iconUrl, 500) ?? null,
        bannerUrl: str(body.bannerUrl, 500) ?? null,
        accentColor: str(body.accentColor, 7) ?? null,
        memberCount: typeof body.memberCount === 'number' ? body.memberCount : null,
        externalAudience: typeof body.externalAudience === 'number' ? body.externalAudience : null,
        links: Array.isArray(body.links) ? (body.links as { label: string; url: string }[]) : undefined,
      },
      actor,
    );
    json(res, 201, { partner });
    return true;
  }

  // POST /partners/lookup-invite
  //
  // Resout une invitation et renvoie ce que Discord en dit, sans rien
  // enregistrer : le formulaire propose le resultat, la personne corrige ce
  // qu'elle veut avant d'enregistrer.
  if (parts.length === 6 && parts[5] === 'lookup-invite' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const lookup = await lookupInvite(String(body.invite ?? ''));
    if (!lookup) {
      json(res, 404, { error: "Cette invitation est introuvable, expiree ou mal formee." });
      return true;
    }
    json(res, 200, { lookup });
    return true;
  }

  const partnerId = parts[5];
  if (!partnerId) return false;

  const owned = await prisma.partner.findFirst({ where: { id: partnerId, guildId }, select: { id: true } });
  if (!owned) {
    json(res, 404, { error: 'Fiche introuvable' });
    return true;
  }

  if (parts.length === 6 && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      partner: await updatePartner(partnerId, {
        kind: str(body.kind, 20),
        displayName: str(body.displayName, 120),
        shortName: str(body.shortName, 40),
        description: str(body.description, 4000),
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
        partnerGuildId: str(body.partnerGuildId, 20),
        inviteUrl: str(body.inviteUrl, 300),
        iconUrl: str(body.iconUrl, 500),
        bannerUrl: str(body.bannerUrl, 500),
        accentColor: str(body.accentColor, 7),
        memberCount: typeof body.memberCount === 'number' ? body.memberCount : undefined,
        externalAudience: typeof body.externalAudience === 'number' ? body.externalAudience : undefined,
        links: Array.isArray(body.links) ? (body.links as { label: string; url: string }[]) : undefined,
      }),
    });
    return true;
  }

  if (parts.length === 6 && method === 'DELETE') {
    // Une fiche liée à un dossier ne se supprime pas : elle porte l'historique
    // qui rend l'ancien dossier lisible.
    const linked = await prisma.partnership.count({ where: { partnerId } });
    if (linked > 0) {
      json(res, 409, { error: 'Cette fiche est rattachée à des dossiers. Bloquez-la plutôt que de la supprimer.' });
      return true;
    }
    await prisma.partner.delete({ where: { id: partnerId } });
    json(res, 200, { ok: true });
    return true;
  }

  const action = parts[6];

  if (parts.length === 7 && action === 'contacts' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 201, {
      contact: await addPartnerContact(partnerId, {
        userId: str(body.userId, 20) ?? null,
        displayName: String(body.displayName ?? 'Contact'),
        role: str(body.role, 40),
        primary: body.primary === true,
        externalContact: str(body.externalContact, 200) ?? null,
        notes: str(body.notes, 2000) ?? null,
        representative: body.representative !== false,
      }),
    });
    return true;
  }
  // Le contact doit appartenir à cette fiche, pas à celle d'un autre serveur.
  if (parts.length === 8 && action === 'contacts'
    && (await prisma.partnerContact.count({ where: { id: parts[7], partnerId } })) === 0) {
    json(res, 404, { error: 'Contact introuvable' });
    return true;
  }
  if (parts.length === 8 && action === 'contacts' && method === 'PATCH') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      contact: await updatePartnerContact(parts[7], {
        userId: str(body.userId, 20),
        displayName: str(body.displayName, 100),
        role: str(body.role, 40),
        primary: typeof body.primary === 'boolean' ? body.primary : undefined,
        externalContact: str(body.externalContact, 200),
        notes: str(body.notes, 2000),
        representative: typeof body.representative === 'boolean' ? body.representative : undefined,
      }),
    });
    return true;
  }
  if (parts.length === 8 && action === 'contacts' && method === 'DELETE') {
    await removePartnerContact(parts[7]);
    json(res, 200, { ok: true });
    return true;
  }

  if (parts.length === 7 && action === 'block' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      partner: await setPartnerBlocked(partnerId, body.blocked !== false, str(body.reason, 500) ?? null),
    });
    return true;
  }

  if (parts.length === 7 && action === 'invite-check' && method === 'POST') {
    json(res, 200, { state: await refreshPartnerInvite(partnerId) });
    return true;
  }

  if (parts.length === 7 && action === 'trust' && method === 'POST') {
    json(res, 200, { trustScore: await recomputeTrustScore(partnerId) });
    return true;
  }

  // Signalements et réseau
  if (parts.length === 7 && action === 'report' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 201, {
      report: await reportPartner({
        reporterGuildId: guildId,
        partnerId,
        reason: String(body.reason ?? 'other'),
        detail: str(body.detail, 2000) ?? null,
        severity: typeof body.severity === 'number' ? body.severity : 1,
        reportedByUserId: actor.userId,
      }),
    });
    return true;
  }
  if (parts.length === 7 && action === 'reputation' && method === 'GET') {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      select: { partnerGuildId: true },
    });
    const signal = partner?.partnerGuildId ? await lookupNetworkSignal(guildId, partner.partnerGuildId) : null;
    json(res, 200, { signal });
    return true;
  }

  return false;
}

// ─── /partner-applications ───────────────────────────────────────────────────

async function handleApplications(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  guildId: string,
  actor: Actor,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (parts.length === 5 && method === 'GET') {
    json(res, 200, { applications: await listApplications(guildId) });
    return true;
  }

  // Saisie manuelle d'une demande reçue ailleurs (message privé, salon).
  if (parts.length === 5 && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const application = await submitApplication({
      guildId,
      source: 'manual',
      applicantUserId: str(body.applicantUserId, 20) ?? null,
      applicantTag: str(body.applicantTag, 60) ?? null,
      projectName: String(body.projectName ?? 'Demande'),
      projectKind: str(body.projectKind, 20),
      projectGuildId: str(body.projectGuildId, 20) ?? null,
      inviteUrl: str(body.inviteUrl, 300) ?? null,
      memberCount: typeof body.memberCount === 'number' ? body.memberCount : null,
      description: str(body.description, 4000) ?? null,
      requestedType: str(body.requestedType, 30) ?? null,
    });
    if (!application) {
      json(res, 409, { error: 'Les candidatures sont fermées sur ce serveur.' });
      return true;
    }
    json(res, 201, { application });
    return true;
  }

  const applicationId = parts[5];
  if (!applicationId) return false;

  const owned = await prisma.partnerApplication.findFirst({
    where: { id: applicationId, guildId },
    select: { id: true },
  });
  if (!owned) {
    json(res, 404, { error: 'Candidature introuvable' });
    return true;
  }

  if (parts.length === 7 && parts[6] === 'decision' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    const status = String(body.status ?? 'REJECTED') as PartnerApplicationStatus;
    json(res, 200, {
      application: await decideApplication(applicationId, status, { ...actor, reason: str(body.reason, 1000) }),
    });
    return true;
  }

  return false;
}

// ─── /partnership-directory ──────────────────────────────────────────────────

async function handleDirectory(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  guildId: string,
  actor: Actor,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (parts.length === 5 && method === 'GET') {
    const [listing, matches, sent, received, blocklist, reports] = await Promise.all([
      prisma.partnershipDirectoryListing.findUnique({ where: { guildId } }),
      listMatches(guildId),
      prisma.partnershipProposal.findMany({ where: { fromGuildId: guildId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.partnershipProposal.findMany({ where: { toGuildId: guildId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      listBlocklist(guildId),
      listOwnReports(guildId),
    ]);
    json(res, 200, {
      listing,
      matches,
      proposals: { sent, received },
      blocklist,
      reports,
      // La page compose une proposition : elle a besoin des types, et les
      // charger par le catalogue complet des partenariats serait payer la
      // liste des dossiers pour une liste deroulante.
      types: PARTNERSHIP_TYPE_META.map((type) => ({ key: type.key, label: type.label })),
    });
    return true;
  }

  if (parts.length === 6 && parts[5] === 'listing' && method === 'PUT') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    json(res, 200, {
      listing: await upsertListing(guildId, {
        displayName: str(body.displayName, 100),
        headline: str(body.headline, 150) ?? null,
        description: str(body.description, 2000) ?? null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        locale: str(body.locale, 10),
        memberCount: typeof body.memberCount === 'number' ? body.memberCount : null,
        iconUrl: str(body.iconUrl, 500) ?? null,
        bannerUrl: str(body.bannerUrl, 500) ?? null,
        inviteUrl: str(body.inviteUrl, 300) ?? null,
        seekingTypes: Array.isArray(body.seekingTypes) ? (body.seekingTypes as string[]) : [],
        minPartnerSize: typeof body.minPartnerSize === 'number' ? body.minPartnerSize : 0,
        openToProposals: body.openToProposals !== false,
        published: body.published === true,
      }),
    });
    return true;
  }

  // GET /partnership-directory/suggest
  //
  // Ce que le serveur dit de lui-meme : nom, presentation, icone, banniere,
  // effectif, langue et pistes de themes. Le formulaire s'en sert pour se
  // remplir, personne n'a a recopier ce que Discord sait deja.
  if (parts.length === 6 && parts[5] === 'suggest' && method === 'GET') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }
    json(res, 200, { suggestion: suggestListingFromGuild(guild) });
    return true;
  }

  // POST /partnership-directory/invite - cree, ou retrouve, l'invitation de vitrine
  if (parts.length === 6 && parts[5] === 'invite' && method === 'POST') {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      json(res, 404, { error: 'Serveur Discord introuvable' });
      return true;
    }

    const url = await ensureShowcaseInvite(guild);
    if (!url) {
      json(res, 409, {
        error: "Aucun salon ne permet de creer une invitation. Verifiez la permission « Creer une invitation ».",
      });
      return true;
    }
    json(res, 200, { inviteUrl: url });
    return true;
  }

  if (parts.length === 6 && parts[5] === 'search' && method === 'GET') {
    json(res, 200, {
      results: await searchDirectory({
        guildId,
        query: url.searchParams.get('q') ?? undefined,
        tags: url.searchParams.get('tags')?.split(',').filter(Boolean),
        locale: url.searchParams.get('locale') ?? undefined,
        sizeBucket: url.searchParams.get('size') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
      }),
    });
    return true;
  }

  if (parts.length === 6 && parts[5] === 'matches' && method === 'POST') {
    json(res, 200, { computed: await computeMatches(guildId) });
    return true;
  }

  if (parts.length === 7 && parts[5] === 'matches' && method === 'DELETE') {
    await dismissMatch(guildId, parts[6], actor.userId);
    json(res, 200, { ok: true });
    return true;
  }

  if (parts.length === 6 && parts[5] === 'proposals' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    try {
      const proposal = await sendProposal({
        fromGuildId: guildId,
        toGuildId: String(body.toGuildId ?? ''),
        type: String(body.type ?? ''),
        message: str(body.message, 1000),
        actorUserId: actor.userId,
      });
      json(res, 201, { proposal });
    } catch (error) {
      json(res, 400, { error: publicErrorMessage(error, 'Proposition refusée.') });
    }
    return true;
  }

  if (parts.length === 8 && parts[5] === 'proposals' && method === 'POST') {
    const proposalId = parts[6];
    const proposal = await prisma.partnershipProposal.findFirst({
      where: { id: proposalId, OR: [{ toGuildId: guildId }, { fromGuildId: guildId }] },
    });
    if (!proposal) {
      json(res, 404, { error: 'Proposition introuvable' });
      return true;
    }

    const body = (await readJsonBody<Body>(req)) ?? {};
    try {
      if (parts[7] === 'accept' || parts[7] === 'decline') {
        // Seul le destinataire répond : l'émetteur ne peut que retirer.
        if (proposal.toGuildId !== guildId) {
          json(res, 403, { error: 'Seul le destinataire peut répondre à cette proposition.' });
          return true;
        }
        json(res, 200, {
          proposal: await respondToProposal(proposalId, parts[7] === 'accept', {
            userId: actor.userId,
            note: str(body.note, 500),
          }),
        });
        return true;
      }
      if (parts[7] === 'withdraw') {
        if (proposal.fromGuildId !== guildId) {
          json(res, 403, { error: 'Seul l\'émetteur peut retirer cette proposition.' });
          return true;
        }
        await withdrawProposal(proposalId);
        json(res, 200, { ok: true });
        return true;
      }
    } catch (error) {
      json(res, 400, { error: publicErrorMessage(error, 'Réponse impossible.') });
      return true;
    }
    return false;
  }

  // Liste de blocage
  if (parts.length === 6 && parts[5] === 'blocklist' && method === 'POST') {
    const body = (await readJsonBody<Body>(req)) ?? {};
    await blockSubject({
      guildId,
      subjectType: (body.subjectType === 'user' || body.subjectType === 'name' ? body.subjectType : 'guild') as
        | 'guild'
        | 'user'
        | 'name',
      subjectRef: String(body.subjectRef ?? ''),
      reason: str(body.reason, 500),
      actorUserId: actor.userId,
    });
    json(res, 201, { ok: true });
    return true;
  }
  if (parts.length === 7 && parts[5] === 'blocklist' && method === 'DELETE') {
    await unblockSubject(parts[6]);
    json(res, 200, { ok: true });
    return true;
  }

  // Signalements émis
  if (parts.length === 7 && parts[5] === 'reports' && method === 'DELETE') {
    await withdrawReport(parts[6]);
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

/**
 * Ne retient des réglages que les champs connus, et borne ceux qui se comptent.
 * Recopier le corps de la requête tel quel laisserait écrire n'importe quelle
 * colonne de la table.
 */
function sanitizeSettings(body: Body) {
  const patch: Record<string, unknown> = {};
  const booleans = [
    'enabled',
    'requireDualApproval',
    'applicationsOpen',
    'autoRejectBelowThreshold',
    'autoPublishAds',
    'reciprocityChecks',
    'autoApplyBenefits',
    'autoBreachOnFailure',
    'trackInvites',
    'trackReferredActivity',
    'notifyStaffChannel',
    'notifyDashboard',
    'notifyOwnerDm',
    'directoryOptIn',
    'directoryAcceptProposals',
    'matchmakingEnabled',
    'reputationShare',
    'reputationConsume',
    'financeEnabled',
  ];
  for (const key of booleans) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }

  const channels = [
    'staffChannelId',
    'showcaseChannelId',
    'adsChannelId',
    'dedicatedCategoryId',
    'partnerRoleId',
    'referredRoleId',
    'digestChannelId',
    'applicationFormId',
    'applicationTicketTypeId',
  ];
  for (const key of channels) {
    if (body[key] === null) patch[key] = null;
    else if (typeof body[key] === 'string') patch[key] = (body[key] as string).slice(0, 40) || null;
  }

  const numbers: Record<string, [number, number]> = {
    minMemberCount: [0, 10_000_000],
    minServerAgeDays: [0, 3650],
    adRotationHours: [0, 24 * 30],
    reciprocityIntervalHours: [1, 24 * 14],
    reciprocityGraceCount: [0, 10],
    renewalNoticeDays: [0, 180],
    autoArchiveAfterDays: [0, 3650],
    retentionWindowDays: [1, 365],
    paymentReminderDays: [0, 30],
  };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) {
      patch[key] = Math.min(max, Math.max(min, Math.round(body[key] as number)));
    }
  }

  if (typeof body.defaultTier === 'string' && isPartnershipTier(body.defaultTier)) {
    patch.defaultTier = body.defaultTier;
  }
  if (body.digestFrequency === 'none' || body.digestFrequency === 'weekly' || body.digestFrequency === 'monthly') {
    patch.digestFrequency = body.digestFrequency;
  }
  if (typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency)) {
    patch.currency = body.currency.toUpperCase();
  }
  if (Array.isArray(body.alertRoleIds)) {
    patch.alertRoleIds = (body.alertRoleIds as unknown[])
      .filter((id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id))
      .slice(0, 10);
  }

  return patch;
}
