/** Outils MCP - boutique du serveur (lecture READ_ECONOMY, écriture WRITE_MEMBERS). */
import { z } from 'zod';
import { SHOP_OFFER_KINDS } from '@kotbo/shared';
import { type McpToolContext, err, ok } from '../toolkit.js';
import {
  decideShopOrder,
  deleteShopOffer,
  deleteShopPromoCode,
  getShopSettings,
  listShopOffers,
  listShopOrders,
  listShopPromoCodes,
  saveShopOffer,
  saveShopPromoCode,
  saveShopSettings,
  ShopError,
} from '../../../services/shop/shopService.js';

/**
 * La boutique vend en monnaie du bot, sur le site et sur Discord (/boutique) :
 * rôles (permanents ou pour une durée), objets RPG, XP, abonnements prélevés à
 * chaque période et prestations livrées à la main par le staff.
 */

function failure(error: unknown) {
  if (error instanceof ShopError) return err(error.code, { code: error.code });
  return err(error instanceof Error ? error.message : String(error));
}

export function registerShopTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta, ownerId } = ctx;

  if (shouldRegister('READ_ECONOMY')) {
    server.registerTool(
      'get_shop',
      {
        description: 'Boutique du serveur : réglages, offres (avec leurs règles), codes promo, commandes en attente de validation et dernières commandes.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => {
        const [settings, offers, codes, pending, recent] = await Promise.all([
          getShopSettings(guildId),
          listShopOffers(guildId, { includeDisabled: true }),
          listShopPromoCodes(guildId),
          listShopOrders(guildId, { status: 'PENDING', limit: 50 }),
          listShopOrders(guildId, { limit: 30 }),
        ]);
        return ok({ settings, offers, codes, pending, recent });
      }),
    );
  }

  if (!shouldRegister('WRITE_MEMBERS')) return;
  const keyName = z.string().optional().describe('Nom de la clé, pour le journal');

  server.registerTool(
    'save_shop_offer',
    {
      description:
        "Crée ou modifie une offre. kind : ROLE (role_id, duration_days facultatif = rôle temporaire), SUBSCRIPTION (role_id, duration_days = période, prix prélevé à chaque période), ITEM (item_id d'un objet RPG, quantity), XP (quantity = points), CUSTOM (livrée à la main, toujours validée par le staff). En modification, un champ omis garde sa valeur.",
      inputSchema: {
        id: z.string().optional().describe('Offre à modifier ; absent pour en créer une'),
        kind: z.enum(SHOP_OFFER_KINDS).optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        price: z.number().int().min(0).optional(),
        category: z.string().nullable().optional(),
        image_url: z.string().nullable().optional(),
        role_id: z.string().nullable().optional(),
        duration_days: z.number().int().min(1).max(365).nullable().optional(),
        item_id: z.string().nullable().optional(),
        quantity: z.number().int().min(1).optional(),
        stock: z.number().int().min(0).nullable().optional().describe('Exemplaires restants ; null = illimité'),
        per_member_limit: z.number().int().min(1).nullable().optional(),
        required_role_ids: z.array(z.string()).optional().describe("Le bénéficiaire doit avoir l'un de ces rôles"),
        min_level: z.number().int().min(0).optional(),
        requires_approval: z.boolean().optional(),
        giftable: z.boolean().optional(),
        enabled: z.boolean().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_MEMBERS', async (args) => {
      try {
        const raw: Record<string, unknown> = {};
        const map: Array<[keyof typeof args, string]> = [
          ['kind', 'kind'], ['name', 'name'], ['description', 'description'], ['price', 'price'], ['category', 'category'], ['image_url', 'imageUrl'],
          ['role_id', 'roleId'], ['duration_days', 'durationDays'], ['item_id', 'itemId'], ['quantity', 'quantity'], ['stock', 'stock'],
          ['per_member_limit', 'perMemberLimit'], ['required_role_ids', 'requiredRoleIds'], ['min_level', 'minLevel'],
          ['requires_approval', 'requiresApproval'], ['giftable', 'giftable'], ['enabled', 'enabled'],
        ];
        for (const [from, to] of map) if (args[from] !== undefined) raw[to] = args[from];
        const offer = await saveShopOffer(client, guildId, args.id ?? null, raw);
        await audit(args.key_name, args.id ? 'Offre de boutique modifiée (MCP)' : 'Offre de boutique créée (MCP)', offer.name, `${offer.kind} · ${offer.price}`);
        return ok({ offer });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_shop_offer',
    { description: "Retire une offre. Si des abonnements sont en cours, l'offre est seulement retirée de la vente et les abonnés vont au bout de leur période.", inputSchema: { id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_MEMBERS', async ({ id, key_name }) => {
      const result = await deleteShopOffer(guildId, id);
      await audit(key_name, 'Offre de boutique retirée (MCP)', id, result);
      return ok({ result });
    }),
  );

  server.registerTool(
    'save_shop_promo_code',
    {
      description: 'Crée ou modifie un code promo : percent_off OU amount_off, utilisations max, date de fin, offres concernées (vide = toute la boutique). Chaque membre ne peut utiliser un code qu’une fois.',
      inputSchema: {
        id: z.string().optional(),
        code: z.string().optional(),
        percent_off: z.number().int().min(1).max(100).nullable().optional(),
        amount_off: z.number().int().min(1).nullable().optional(),
        max_uses: z.number().int().min(1).nullable().optional(),
        expires_at: z.string().nullable().optional().describe('Date ISO'),
        offer_ids: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_MEMBERS', async (args) => {
      try {
        const code = await saveShopPromoCode(guildId, args.id ?? null, {
          code: args.code,
          percentOff: args.percent_off,
          amountOff: args.amount_off,
          maxUses: args.max_uses,
          expiresAt: args.expires_at,
          offerIds: args.offer_ids,
          enabled: args.enabled,
        });
        await audit(args.key_name, 'Code promo enregistré (MCP)', code.code, code.percentOff ? `${code.percentOff} %` : String(code.amountOff));
        return ok({ code });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'delete_shop_promo_code',
    { description: 'Supprime un code promo.', inputSchema: { id: z.string(), key_name: keyName }, _meta: toolMeta },
    guard('WRITE_MEMBERS', async ({ id, key_name }) => {
      await deleteShopPromoCode(guildId, id);
      await audit(key_name, 'Code promo supprimé (MCP)', id, '');
      return ok({ ok: true });
    }),
  );

  server.registerTool(
    'decide_shop_order',
    {
      description: 'Valide (livraison) ou refuse (remboursement) une commande en attente. Le motif du refus est envoyé au membre.',
      inputSchema: { order_id: z.string(), approve: z.boolean(), reason: z.string().optional(), key_name: keyName },
      _meta: toolMeta,
    },
    guard('WRITE_MEMBERS', async ({ order_id, approve, reason, key_name }) => {
      try {
        const order = await decideShopOrder(client, guildId, order_id, ownerId ?? 'mcp_agent', approve, reason);
        await audit(key_name, approve ? 'Commande validée (MCP)' : 'Commande refusée (MCP)', order.offerName, reason ?? '');
        return ok({ status: order.status });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  server.registerTool(
    'update_shop_settings',
    {
      description: 'Réglages de la boutique : ouverte ou fermée, salon des commandes à valider, salon du journal des ventes, jours de grâce des abonnements impayés.',
      inputSchema: {
        enabled: z.boolean().optional(),
        approval_channel_id: z.string().nullable().optional(),
        log_channel_id: z.string().nullable().optional(),
        grace_days: z.number().int().min(0).max(14).optional(),
        key_name: keyName,
      },
      _meta: toolMeta,
    },
    guard('WRITE_MEMBERS', async (args) => {
      const settings = await saveShopSettings(guildId, {
        enabled: args.enabled,
        approvalChannelId: args.approval_channel_id,
        logChannelId: args.log_channel_id,
        graceDays: args.grace_days,
      });
      await audit(args.key_name, 'Réglages de la boutique (MCP)', guildId, Object.keys(args).filter((k) => k !== 'key_name').join(', '));
      return ok({ settings });
    }),
  );
}
