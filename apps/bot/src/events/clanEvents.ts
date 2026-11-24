import { Client, Events, EmbedBuilder } from 'discord.js';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { resolveEventLogChannel } from '../utils/logDispatch.js';

export function registerClanListener(client: Client) {
  // 1. Sécurité de Clan Unique (guildMemberUpdate)
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      const guildId = newMember.guild.id;

      const config = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { clansEnabled: true, logChannelId: true },
      });

      // L'unicité n'est plus optionnelle : le reste du module ne sait pas
      // représenter un membre à plusieurs clans. L'attribution d'XP retient le
      // premier rôle de clan rencontré, sans règle métier, alors que les
      // effectifs le comptent dans chacun de ses clans - d'où des classements
      // faux. Le réglage `clansUnique` existe encore en base mais n'est plus lu.
      if (!config?.clansEnabled) return;

      const clans = await prisma.clan.findMany({
        where: { guildId },
        select: { id: true, name: true, roleId: true },
      });

      if (clans.length === 0) return;

      const clanRoleIds = clans.map((c) => c.roleId);

      // Trouver quel rôle de clan a été ajouté dans newMember par rapport à oldMember
      const addedRole = newMember.roles.cache.find(
        (r) => clanRoleIds.includes(r.id) && !oldMember.roles.cache.has(r.id)
      );

      if (!addedRole) return;

      // Lister les autres rôles de clans possédés par le membre
      const otherClanRoles = newMember.roles.cache.filter(
        (r) => clanRoleIds.includes(r.id) && r.id !== addedRole.id
      );

      if (otherClanRoles.size === 0) return;

      // Il a plusieurs clans ! On retire les anciens rôles de clans
      const rolesToRemove = [...otherClanRoles.keys()];
      await newMember.roles.remove(rolesToRemove, 'Sécurité : un membre ne peut appartenir qu\'à un seul clan à la fois');

      // Trouver les noms des clans impliqués
      const addedClanName = clans.find((c) => c.roleId === addedRole.id)?.name ?? 'Inconnu';
      const removedClansNames = clans
        .filter((c) => rolesToRemove.includes(c.roleId))
        .map((c) => c.name)
        .join(', ');

      logger.warn(
        'ClansSecurity',
        `Sécurité de clan unique déclenchée pour ${newMember.user.tag} : nouveaux rôles retirés [${removedClansNames}] au profit de [${addedClanName}]`
      );

      // Loguer dans le salon de modération/logs
      {
        const logChannel = await resolveEventLogChannel(newMember.guild, 'automod_clans', 'ClansSecurity');
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setColor(0x3a86c8)
            .setTitle('Sécurité de Clan Unique | Automod')
            .addFields(
              { name: 'Membre', value: `<@${newMember.id}> \`${newMember.user.tag}\``, inline: false },
              { name: 'Nouveau Clan Appliqué', value: `\`${addedClanName}\``, inline: true },
              { name: 'Ancien(s) Clan(s) Retiré(s)', value: `\`${removedClansNames}\``, inline: true }
            )
            .setThumbnail(newMember.displayAvatarURL())
            .setFooter({ text: 'Kotbo Clans Security' })
            .setTimestamp();

          await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
        }
      }

      // Enregistrer dans le journal d'audit du dashboard
      await prisma.dashboardAuditLog.create({
        data: {
          guildId,
          channelId: config.logChannelId ?? null,
          user: 'Automod Clans',
          action: 'Correction automatique de clan',
          context: newMember.guild.name,
          module: 'Clans',
          eventType: 'Sécurité',
          details: `Double clan détecté pour ${newMember.user.tag}. Rôles de [${removedClansNames}] retirés pour conserver [${addedClanName}].`,
          dateIso: new Date(),
        },
      }).catch(() => null);

    } catch (error) {
      logger.error('ClansSecurity', `Erreur lors de la vérification d'unicité de clan pour ${newMember.user.tag}:`, error);
    }
  });

  logger.info('System', 'Écouteur d\'événements Clans enregistré.');
}
