/**
 * Noyau partage des outils MCP : helpers de reponse, resolution d'entites
 * Discord (membre, salon, forum, staff) et types du contexte d'enregistrement.
 *
 * Extrait de mcpTools.ts, ou il cohabitait avec les 241 definitions d'outils.
 */
import { embedToApiShape, resolveMentionsToText } from '../../services/features/transcriptService.js';
import prisma from '../../utils/db.js';
import { GENERIC_ERROR_MESSAGE, publicErrorMessage } from '../../utils/publicError.js';
import { embedToV2 } from '../../utils/patchV2.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type APIEmbed, ChannelType, Client, ContainerBuilder, ForumChannel, type Guild, type GuildBasedChannel, type Message, type NonThreadGuildBasedChannel, MessageFlags, type NewsChannel, TextChannel, TextDisplayBuilder, ThreadChannel } from 'discord.js';
import { z } from 'zod';
import type { McpKeyPermission } from '@prisma/client';

// Helpers annotés explicitement en `CallToolResult` (le type de retour attendu
// par `registerTool`), plutôt qu'en union de types anonymes inférés. Cela donne
// un point d'ancrage stable au vérificateur ; le vrai gain mémoire vient
// toutefois du wrapper non générique dans `registerMcpTools` (voir plus bas).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpToolHandler = (args: any) => CallToolResult | Promise<CallToolResult>;
export type ToolSecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes: string[] };

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export const err = (msg: string, meta?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});

export { publicErrorMessage };

/**
 * Échec d'un outil : le message brut de l'erreur ne remonte que s'il est écrit
 * pour l'utilisateur (voir utils/publicError.ts) ; sinon un message générique,
 * le détail restant dans les journaux.
 */
export const toolError = (e: unknown, context?: string): CallToolResult => {
  const message = publicErrorMessage(e, GENERIC_ERROR_MESSAGE, 'MCP');
  return err(context ? `${context} : ${message}` : message);
};

// Renvoie une "erreur" structurée listant les candidats possibles quand une
// recherche par nom est ambiguë, pour que l'agent (ou l'utilisateur) puisse
// préciser sans avoir à connaître les IDs à l'avance.
export const ambiguous = (raw: string, kind: string, candidates: unknown[]): CallToolResult => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(
        {
          error: `Plusieurs ${kind} correspondent à « ${raw} ».`,
          hint: "Rappelle le même outil en reprenant le nom exact (ou l'ID) d'un des candidats ci-dessous.",
          candidates,
        },
        null,
        2
      ),
    },
  ],
  isError: true,
});

export const MENTION_USER = /^<@!?(\d+)>$/;
export const MENTION_CHANNEL = /^<#(\d+)>$/;
export const SNOWFLAKE = /^\d{16,20}$/;

export type MemberResolution =
  | { ok: true; userId: string; label: string }
  | { ok: false; response: ReturnType<typeof err> };

// Accepte un ID Discord, une mention <@id>, ou un nom (username / displayName /
// globalName / tag) et le résout vers un userId unique. En cas d'ambiguïté ou
// d'absence de résultat, renvoie une réponse d'erreur exploitable directement.
export async function resolveMember(guildId: string, raw: string): Promise<MemberResolution> {
  const input = raw.trim();

  const mention = input.match(MENTION_USER);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    return { ok: true, userId: directId, label: directId };
  }

  const name = input.replace(/^@/, '');
  const matches = await prisma.memberProfile.findMany({
    where: {
      guildId,
      OR: [
        { username: { contains: name, mode: 'insensitive' } },
        { displayName: { contains: name, mode: 'insensitive' } },
        { globalName: { contains: name, mode: 'insensitive' } },
        { userTag: { contains: name, mode: 'insensitive' } },
      ],
    },
    take: 10,
    orderBy: { lastSeenAt: 'desc' },
    select: { userId: true, username: true, displayName: true, globalName: true, userTag: true },
  });

  const lower = name.toLowerCase();
  const exact = matches.filter(
    (m) =>
      m.username?.toLowerCase() === lower ||
      m.displayName?.toLowerCase() === lower ||
      m.globalName?.toLowerCase() === lower ||
      m.userTag?.toLowerCase() === lower
  );

  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (pick) {
    return { ok: true, userId: pick.userId, label: pick.displayName ?? pick.username ?? pick.userId };
  }

  if (matches.length === 0) {
    return {
      ok: false,
      response: err(`Aucun membre ne correspond à « ${raw} ». Vérifie l'orthographe ou utilise search_members.`),
    };
  }

  return {
    ok: false,
    response: ambiguous(
      raw,
      'membres',
      matches.map((m) => ({
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
      }))
    ),
  };
}

export type ChannelResolution =
  | { ok: true; channel: TextChannel | NewsChannel }
  | { ok: false; response: ReturnType<typeof err> };

export type GuildChannelResolution =
  | { ok: true; channel: NonThreadGuildBasedChannel }
  | { ok: false; response: ReturnType<typeof err> };

function findChannel<T extends GuildBasedChannel>(
  guildId: string,
  client: Client,
  raw: string,
  accepts: (c: GuildBasedChannel) => c is T,
  rejected: string,
): { ok: true; channel: T } | { ok: false; response: ReturnType<typeof err> } {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, response: err('Serveur Discord introuvable') };

  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const ch = guild.channels.cache.get(directId);
    if (!ch) return { ok: false, response: err('Salon introuvable') };
    if (!accepts(ch)) return { ok: false, response: err(rejected) };
    return { ok: true, channel: ch };
  }

  const name = input.replace(/^#/, '').toLowerCase();
  const candidates = guild.channels.cache.filter(accepts);

  let matches = candidates.filter((c) => c.name.toLowerCase() === name);
  if (matches.size === 0) matches = candidates.filter((c) => c.name.toLowerCase().includes(name));

  if (matches.size === 0) {
    return { ok: false, response: err(`Aucun salon ne correspond à « ${raw} ».`) };
  }
  if (matches.size > 1) {
    return {
      ok: false,
      response: ambiguous(
        raw,
        'salons',
        matches.map((c) => ({ id: c.id, name: c.name })).slice(0, 10)
      ),
    };
  }

  return { ok: true, channel: matches.first()! };
}

// Accepte un ID de salon, une mention <#id>, ou un nom de salon (avec ou sans #)
// et le résout vers un salon textuel unique.
export function resolveChannel(guildId: string, client: Client, raw: string): ChannelResolution {
  return findChannel(
    guildId,
    client,
    raw,
    (c): c is TextChannel | NewsChannel => c.isTextBased(),
    "Ce salon n'est pas un salon textuel",
  );
}

/**
 * Comme `resolveChannel`, mais pour tout salon qui porte ses propres réglages et
 * permissions : forums, catégories, vocaux... Les fils en sont exclus, ils
 * héritent de leur salon parent.
 */
export function resolveGuildChannel(guildId: string, client: Client, raw: string): GuildChannelResolution {
  return findChannel(
    guildId,
    client,
    raw,
    (c): c is NonThreadGuildBasedChannel => !c.isThread(),
    'Un fil hérite des permissions de son salon parent : modifie plutôt le salon parent.',
  );
}

export type ForumResolution =
  | { ok: true; forum: ForumChannel }
  | { ok: false; response: ReturnType<typeof err> };

export function resolveForum(guildId: string, client: Client, raw: string): ForumResolution {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, response: err('Serveur Discord introuvable') };

  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const channel = guild.channels.cache.get(directId);
    if (!channel) return { ok: false, response: err('Forum introuvable') };
    if (channel.type !== ChannelType.GuildForum) {
      return { ok: false, response: err("Ce salon n'est pas un forum Discord") };
    }
    return { ok: true, forum: channel };
  }

  const name = input.replace(/^#/, '').toLowerCase();
  const forums = guild.channels.cache.filter((channel): channel is ForumChannel => channel.type === ChannelType.GuildForum);
  let matches = forums.filter((forum) => forum.name.toLowerCase() === name);
  if (matches.size === 0) matches = forums.filter((forum) => forum.name.toLowerCase().includes(name));

  if (matches.size === 0) return { ok: false, response: err(`Aucun forum ne correspond à « ${raw} ».`) };
  if (matches.size > 1) {
    return {
      ok: false,
      response: ambiguous(raw, 'forums', matches.map((forum) => ({ id: forum.id, name: forum.name })).slice(0, 10)),
    };
  }
  return { ok: true, forum: matches.first()! };
}

export type ForumPostResolution =
  | { ok: true; post: ThreadChannel }
  | { ok: false; response: ReturnType<typeof err> };

export async function resolveForumPost(forum: ForumChannel, raw: string): Promise<ForumPostResolution> {
  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const post = await forum.threads.fetch(directId).catch(() => null);
    if (!post || post.parentId !== forum.id) return { ok: false, response: err('Article de forum introuvable') };
    return { ok: true, post };
  }

  const [active, archived] = await Promise.all([
    forum.threads.fetchActive().catch(() => null),
    forum.threads.fetchArchived({ limit: 100 }).catch(() => null),
  ]);
  const posts = new Map<string, ThreadChannel>();
  for (const post of active?.threads.values() ?? []) posts.set(post.id, post);
  for (const post of archived?.threads.values() ?? []) posts.set(post.id, post);

  const name = input.toLowerCase();
  let matches = [...posts.values()].filter((post) => post.name.toLowerCase() === name);
  if (matches.length === 0) matches = [...posts.values()].filter((post) => post.name.toLowerCase().includes(name));
  if (matches.length === 0) return { ok: false, response: err(`Aucun article ne correspond à « ${raw} ».`) };
  if (matches.length > 1) {
    return {
      ok: false,
      response: ambiguous(raw, 'articles de forum', matches.slice(0, 10).map((post) => ({ id: post.id, name: post.name }))),
    };
  }
  return { ok: true, post: matches[0]! };
}

export function resolveForumTagIds(forum: ForumChannel, values: string[]):
  | { ok: true; ids: string[] }
  | { ok: false; response: ReturnType<typeof err> } {
  const ids: string[] = [];
  for (const raw of values) {
    const input = raw.trim();
    const byId = forum.availableTags.find((tag) => tag.id === input);
    const exact = forum.availableTags.filter((tag) => tag.name.toLowerCase() === input.toLowerCase());
    const tag = byId ?? (exact.length === 1 ? exact[0] : null);
    if (!tag) {
      return {
        ok: false,
        response: err(`Tag de forum introuvable : « ${raw} ».`, {
          availableTags: forum.availableTags.map((item) => ({ id: item.id, name: item.name })),
        }),
      };
    }
    if (!ids.includes(tag.id)) ids.push(tag.id);
  }
  return { ok: true, ids };
}

export const mcpEmbedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  color: z.number().int().min(0).max(0xffffff).optional().describe('Couleur décimale entre 0 et 16777215'),
  url: z.string().url().optional(),
  thumbnail_url: z.string().url().optional(),
  image_url: z.string().url().optional(),
  footer: z.string().max(2048).optional(),
  fields: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().default(false),
  })).max(25).optional(),
}).superRefine((embed, context) => {
  const totalCharacters =
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.length ?? 0) +
    (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (totalCharacters > 6000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Discord limite le total title + description + fields + footer à 6000 caractères par message.',
    });
  }
  if (totalCharacters === 0 && !embed.url && !embed.thumbnail_url && !embed.image_url) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Un embed doit contenir au moins un texte, une URL, une miniature ou une image.',
    });
  }
});

export type McpEmbedInput = z.infer<typeof mcpEmbedSchema>;

export function buildApiEmbed(input: McpEmbedInput): APIEmbed {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.thumbnail_url !== undefined ? { thumbnail: { url: input.thumbnail_url } } : {}),
    ...(input.image_url !== undefined ? { image: { url: input.image_url } } : {}),
    ...(input.footer !== undefined ? { footer: { text: input.footer } } : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
  };
}

export function buildV2MessageComponents(content: string | null | undefined, embed: McpEmbedInput | null | undefined) {
  const components: Array<TextDisplayBuilder | ContainerBuilder> = [];
  if (content) components.push(new TextDisplayBuilder().setContent(content));
  if (embed) components.push(embedToV2(buildApiEmbed(embed)));
  return components;
}

export function serializeDiscordMessage(message: Message, guild?: Guild) {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    content: message.content ? resolveMentionsToText(message.content, guild) : '',
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    format: message.flags.has(MessageFlags.IsComponentsV2) ? 'v2' : 'v1',
    embeds: message.embeds.map((embed) => embedToApiShape(embed, guild)),
    components: message.components.map((component) => component.toJSON()),
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

export type StaffMemberResolution =
  | { ok: true; staffMember: { id: string; userId: string; label: string } }
  | { ok: false; response: ReturnType<typeof err> };

export async function resolveStaffMemberRecord(guildId: string, client: Client, raw: string): Promise<StaffMemberResolution> {
  const resolved = await resolveMember(guildId, raw);
  if (!resolved.ok) return resolved;

  const staffMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId: resolved.userId } },
    select: { id: true, userId: true, username: true, displayName: true },
  });

  if (!staffMember) {
    return { ok: false, response: err('Membre du staff introuvable') };
  }

  return {
    ok: true,
    staffMember: {
      id: staffMember.id,
      userId: staffMember.userId,
      label: staffMember.displayName ?? staffMember.username ?? staffMember.userId,
    },
  };
}

export const oauthSecuritySchemes = [
  { type: 'oauth2', scopes: ['mcp'] },
] satisfies ToolSecurityScheme[];

// Forme du `config` accepté par `registerTool`, sans les génériques du SDK.
export type McpToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** Tout ce qu'un module d'outils recoit de l'orchestrateur. */
export type McpToolContext = {
  server: { registerTool: (name: string, config: McpToolConfig, cb: McpToolHandler) => unknown };
  guildId: string;
  client: Client;
  permissions: McpKeyPermission[];
  has: (p: McpKeyPermission) => boolean;
  shouldRegister: (p: McpKeyPermission) => boolean;
  guard: (permission: McpKeyPermission, handler: McpToolHandler) => McpToolHandler;
  audit: (keyName: string | undefined, action: string, context: string, details: string) => Promise<unknown>;
  toolMeta: { securitySchemes: ToolSecurityScheme[] };
  /**
   * Compte Discord au nom duquel la cle agit, quand elle en declare un.
   *
   * Les outils du quotidien n'en ont pas besoin : une cle est un jeton
   * d'integration, elle vaut par ses permissions. Seuls les gestes qui
   * reecrivent les droits du dashboard redemandent qui est derriere, pour ne
   * pas laisser une permission d'ecriture ordinaire redistribuer les acces.
   *
   * Nul pour les cles distribuees avant que ce champ existe.
   */
  ownerId: string | null;
};

/**
 * Redistribuer les droits du dashboard : la cle ne suffit pas.
 *
 * L'outil qui reecrit la matrice du centre de gestion est range sous
 * `WRITE_MEMBERS`, la meme permission que renommer un membre ou lui poser une
 * note. Une cle remise pour du travail courant pouvait donc s'accorder Voir,
 * Moderer, Configurer et Supprimer sur toutes les sections, y compris celles
 * que le serveur venait de fermer, et rien ne bornait ce geste.
 *
 * On redemande donc le niveau du proprietaire de la cle au moment de l'appel.
 *
 * Le pendant Discord - donner Administrator a un role, en creer un qui le
 * porte - n'est pas traite ici : le verrou administrateur d'AutoMod s'en
 * charge deja, en transformant la demande en approbation a valider, et sans
 * jamais laisser un appel MCP le contourner. Poser une seconde regle par
 * dessus doublerait leur mecanisme avec une autre logique.
 *
 * Une cle sans proprietaire est refusee : ce sont celles distribuees avant que
 * ce champ existe, et il n'y a personne dont on puisse verifier le niveau.
 */
export async function requireOwnerIsDashboardAdmin(
  ctx: Pick<McpToolContext, 'client' | 'guildId' | 'ownerId'>,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!ctx.ownerId) {
    return {
      allowed: false,
      reason:
        "Cette cle MCP n'est rattachee a aucun compte Discord : elle ne peut pas modifier les droits du dashboard. Recreez-la depuis le centre de gestion pour lui donner un proprietaire.",
    };
  }

  const { resolveDashboardAccess } = await import('../shared/core.js');
  const access = await resolveDashboardAccess(ctx.client, ctx.guildId, ctx.ownerId);
  if (!access.canManageSettings) {
    return {
      allowed: false,
      reason:
        "Le proprietaire de cette cle MCP n'est pas administrateur du dashboard : modifier les droits par role lui est refuse.",
    };
  }

  return { allowed: true };
}
