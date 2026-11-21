import type { Guild, GuildMember } from 'discord.js';

export type PlaceholderMember = Pick<GuildMember, 'id' | 'displayName'> & {
  user: Pick<GuildMember['user'], 'username'>;
};

export interface PlaceholderContext {
  guild: Guild;
  member?: PlaceholderMember;
  count?: number;
  goal?: number;
  // Pre-computed guild stats (to avoid re-fetching)
  memberCount?: number;
  botCount?: number;
  onlineCount?: number;
  voiceCount?: number;
  channelCount?: number;
  categoryCount?: number;
  boostCount?: number;
  activityCount?: number;
  roleCount?: number;
}

const PLACEHOLDER_MAP: Record<string, (ctx: PlaceholderContext) => string> = {
  // Guild-level
  '{server}': (ctx) => ctx.guild.name,
  '{serveur}': (ctx) => ctx.guild.name,
  '{memberCount}': (ctx) => String(ctx.memberCount ?? ctx.guild.memberCount),
  '{membres}': (ctx) => String(ctx.memberCount ?? ctx.guild.memberCount),
  '{members}': (ctx) => String(ctx.memberCount ?? ctx.guild.memberCount),
  '{botCount}': (ctx) => String(ctx.botCount ?? 0),
  '{bots}': (ctx) => String(ctx.botCount ?? 0),
  '{onlineCount}': (ctx) => String(ctx.onlineCount ?? 0),
  '{online}': (ctx) => String(ctx.onlineCount ?? 0),
  '{enLigne}': (ctx) => String(ctx.onlineCount ?? 0),
  '{voiceCount}': (ctx) => String(ctx.voiceCount ?? 0),
  '{vocal}': (ctx) => String(ctx.voiceCount ?? 0),
  '{channelCount}': (ctx) => String(ctx.channelCount ?? ctx.guild.channels.cache.size),
  '{salons}': (ctx) => String(ctx.channelCount ?? ctx.guild.channels.cache.size),
  '{categoryCount}': (ctx) => String(ctx.categoryCount ?? 0),
  '{categories}': (ctx) => String(ctx.categoryCount ?? 0),
  '{boostCount}': (ctx) => String(ctx.boostCount ?? ctx.guild.premiumSubscriptionCount ?? 0),
  '{boosts}': (ctx) => String(ctx.boostCount ?? ctx.guild.premiumSubscriptionCount ?? 0),
  '{activityCount}': (ctx) => String(ctx.activityCount ?? 0),
  '{actifs}': (ctx) => String(ctx.activityCount ?? 0),
  '{roleCount}': (ctx) => String(ctx.roleCount ?? 0),

  // Stat-specific
  '{count}': (ctx) => String(ctx.count ?? 0),
  '{goal}': (ctx) => String(ctx.goal ?? 0),
  '{objectif}': (ctx) => String(ctx.goal ?? 0),
  '{membreObjectif}': (ctx) => String(ctx.goal ?? ctx.memberCount ?? ctx.guild.memberCount),

  // Member-level
  '{user}': (ctx) => ctx.member ? `<@${ctx.member.id}>` : '',
  '{utilisateur}': (ctx) => ctx.member ? `<@${ctx.member.id}>` : '',
  '{username}': (ctx) => ctx.member?.user.username ?? '',
  '{pseudo}': (ctx) => ctx.member?.user.username ?? '',
  '{displayName}': (ctx) => ctx.member?.displayName ?? '',
  '{nom}': (ctx) => ctx.member?.displayName ?? '',
};

export function resolvePlaceholders(template: string, ctx: PlaceholderContext): string {
  let result = template;
  for (const [placeholder, resolver] of Object.entries(PLACEHOLDER_MAP)) {
    if (result.includes(placeholder)) {
      result = result.replaceAll(placeholder, resolver(ctx));
    }
  }
  return result;
}
