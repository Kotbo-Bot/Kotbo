import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { errorContainer, infoContainer, kotboContainer, successContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { createBackup } from '../../services/system/backupService.js';
import { countKotboConfigRows } from '../../services/system/kotboConfigBackup.js';
import { restoreBackup, RestoreOptions } from '../../services/system/restoreService.js';
import type { BackupData } from '../../services/system/backupService.js';
import { MAX_BACKUP_IMPORT_BYTES, parseBackupImport } from '../../services/system/backupImportValidation.js';
import type { Prisma } from '@prisma/client';
import { extractTrackingInfo, resolveModuleFromCommand } from '../../utils/moduleTracking.js';
import { separator, v2Message } from '@arcscord/components';
import { fetchExternal } from '../../utils/http.js';
import { publicErrorMessage } from '../../utils/publicError.js';

const MAX_BACKUPS_PER_GUILD = 3;

export const data = new SlashCommandBuilder()
  .setName('backup')
  .setDescription('Gère les sauvegardes du serveur (rôles, salons, emojis, stickers et config Kotbo)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Crée une nouvelle sauvegarde du serveur')
      .addStringOption((option) =>
        option.setName('nom').setDescription('Nom de la sauvegarde (défaut: nom du serveur + date)').setRequired(false),
      )
      .addStringOption((option) =>
        option.setName('description').setDescription('Description de la sauvegarde').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_messages').setDescription('Inclure les messages (défaut: false)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_membres').setDescription('Inclure les membres (défaut: true)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_roles').setDescription('Inclure les rôles (défaut: true)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_salons').setDescription('Inclure les salons (défaut: true)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_emojis').setDescription('Inclure les emojis (défaut: true)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_stickers').setDescription('Inclure les stickers (défaut: true)').setRequired(false),
      )
      .addBooleanOption((option) =>
        option.setName('inclure_config').setDescription('Inclure la configuration Kotbo : modules, staff, formulaires… (défaut: true)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Liste toutes les sauvegardes du serveur'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('restore')
      .setDescription('Restaure une sauvegarde')
      .addStringOption((option) =>
        option.setName('id').setDescription('ID de la sauvegarde à restaurer').setRequired(true).setAutocomplete(true),
      )
      .addBooleanOption((option) =>
        option.setName('mode_complet').setDescription('Restauration complète (défaut: false = sélective)').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Supprime une sauvegarde')
      .addStringOption((option) =>
        option.setName('id').setDescription('ID de la sauvegarde à supprimer').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Exporte une sauvegarde en fichier JSON')
      .addStringOption((option) =>
        option.setName('id').setDescription('ID de la sauvegarde à exporter').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('import')
      .setDescription('Importe une sauvegarde depuis un fichier JSON')
      .addAttachmentOption((option) =>
        option.setName('fichier').setDescription('Fichier JSON de la sauvegarde').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('nom').setDescription('Nom de la sauvegarde importée').setRequired(false),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const subcommand = interaction.options.getSubcommand();

  const moduleInfo = resolveModuleFromCommand('backup');
  const trackingInfo = extractTrackingInfo(interaction);

  try {
    switch (subcommand) {
      case 'create':
        await handleCreate(interaction, guildId, moduleInfo, trackingInfo);
        break;
      case 'list':
        await handleList(interaction, guildId);
        break;
      case 'restore':
        await handleRestore(interaction, guildId);
        break;
      case 'delete':
        await handleDelete(interaction, guildId);
        break;
      case 'export':
        await handleExport(interaction, guildId);
        break;
      case 'import':
        await handleImport(interaction, guildId);
        break;
    }
  } catch (error) {
    console.error('Error in backup command:', error);
    await interaction.reply(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer('Erreur', "Une erreur est survenue lors de l'exécution de la commande."),
    ));
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  _moduleInfo: ReturnType<typeof resolveModuleFromCommand>,
  _trackingInfo: ReturnType<typeof extractTrackingInfo>,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild!;
  const customName = interaction.options.getString('nom');
  const description = interaction.options.getString('description');
  const includeMessages = interaction.options.getBoolean('inclure_messages') ?? false;
  const includeMembers = interaction.options.getBoolean('inclure_membres') ?? true;
  const includeRoles = interaction.options.getBoolean('inclure_roles') ?? true;
  const includeChannels = interaction.options.getBoolean('inclure_salons') ?? true;
  const includeEmojis = interaction.options.getBoolean('inclure_emojis') ?? true;
  const includeStickers = interaction.options.getBoolean('inclure_stickers') ?? true;
  const includeKotbo = interaction.options.getBoolean('inclure_config') ?? true;

  // Vérifier le nombre de backups existants
  const existingBackups = await prisma.serverBackup.count({
    where: { guildId, isPreset: false },
  });

  if (existingBackups >= MAX_BACKUPS_PER_GUILD) {
    await interaction.editReply(v2Message(
      errorContainer('Limite atteinte', `Vous avez atteint la limite de ${MAX_BACKUPS_PER_GUILD} sauvegardes. Supprimez une sauvegarde existante avant d'en créer une nouvelle.`),
    ));
    return;
  }

  // Générer le nom par défaut si non fourni
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const defaultName = `${guild.name} - ${dateStr} ${timeStr}`;
  const backupName = customName || defaultName;

  // Créer le backup
  const backup = await createBackup(guild, {
    name: backupName,
    description: description ?? undefined,
    includeMessages,
    includeMembers,
    includeRoles,
    includeChannels,
    includeEmojis,
    includeStickers,
    includeKotbo,
    createdByUserId: interaction.user.id,
    createdByUsername: interaction.user.username,
    createdByTag: interaction.user.discriminator ?? '0000',
  });

  await interaction.editReply(v2Message(
    kotboContainer({
      color: 'success',
      title: `${E.success} Sauvegarde créée`,
      fields: [
        `Sauvegarde **${backupName}** créée avec succès!`,
        separator({ divider: true, spacing: 'small' }),
        `### ${E.stats} Statistiques`,
        [
          `${E.arrow} Rôles: ${backup.rolesCount}`,
          `${E.arrow} Salons: ${backup.channelsCount}`,
          `${E.arrow} Membres: ${backup.membersCount}`,
          `${E.arrow} Messages: ${backup.messagesCount}`,
          `${E.arrow} Emojis: ${backup.emojisCount}`,
          `${E.arrow} Stickers: ${backup.stickersCount}`,
          `${E.arrow} Config Kotbo: ${countKotboConfigRows((backup.data as unknown as BackupData).kotbo)} éléments`,
          `${E.arrow} Taille: ${(backup.sizeBytes / 1024).toFixed(2)} KB`,
        ].join('\n'),
      ],
    }),
  ));
}

async function handleList(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const backups = await prisma.serverBackup.findMany({
    where: { guildId, isPreset: false },
    orderBy: { createdAt: 'desc' },
  });

  if (backups.length === 0) {
    await interaction.editReply(v2Message(
      infoContainer('Aucune sauvegarde', 'Aucune sauvegarde trouvée. Utilisez `/backup create` pour créer une sauvegarde.'),
    ));
    return;
  }

  const lines = backups.map((backup, index) =>
    `**${index + 1}. ${backup.name}**\n` +
    `${E.calendar} ${backup.createdAt.toLocaleDateString('fr-FR')} ${backup.createdAt.toLocaleTimeString('fr-FR')}\n` +
    `${E.profile} Par ${backup.createdByUsername}\n` +
    `${E.stats} ${backup.rolesCount} rôles, ${backup.channelsCount} salons, ${backup.membersCount} membres\n` +
    `${E.dot} \`${backup.id}\``
  );

  await interaction.editReply(v2Message(
    kotboContainer({
      color: 'primary',
      title: `${E.shield} Sauvegardes du serveur`,
      fields: [
        separator({ divider: true, spacing: 'small' }),
        ...lines,
      ],
      footerTitle: `${backups.length}/${MAX_BACKUPS_PER_GUILD} sauvegardes utilisées`,
    }),
  ));
}

async function handleRestore(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const backupId = interaction.options.getString('id', true);
  const fullRestore = interaction.options.getBoolean('mode_complet') ?? false;

  const backup = await prisma.serverBackup.findUnique({
    where: { id: backupId },
  });

  if (!backup) {
    await interaction.editReply(v2Message(
      errorContainer('Introuvable', 'Sauvegarde non trouvée.'),
    ));
    return;
  }

  if (backup.guildId !== guildId) {
    await interaction.editReply(v2Message(
      errorContainer('Accès refusé', "Cette sauvegarde n'appartient pas à ce serveur."),
    ));
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply(v2Message(
      errorContainer('Erreur', 'Serveur non trouvé.'),
    ));
    return;
  }

  // Préparer les options de restauration
  const restoreOptions: RestoreOptions = {
    fullRestore,
    includeRoles: backup.includeRoles,
    includeChannels: backup.includeChannels,
    includeMembers: backup.includeMembers,
    includeEmojis: backup.includeEmojis,
    includeStickers: backup.includeStickers,
    includeMessages: backup.includeMessages,
    // Sûr : la sauvegarde appartient à ce serveur (vérifié plus haut) et un import n'en porte jamais.
    includeKotbo: true,
    conflictResolution: 'ask',
  };

  try {
    await interaction.editReply(v2Message(
      infoContainer(
        'Restauration en cours',
        `Restauration de la sauvegarde **${backup.name}** en cours...\n\nMode: ${fullRestore ? 'Complet' : 'Sélectif'}\n\nCette opération peut prendre plusieurs minutes.`,
      ),
    ));

    await restoreBackup(guild, backup.data as unknown as BackupData, restoreOptions, interaction);

    await interaction.followUp(v2Message(
      { flags: MessageFlags.Ephemeral },
      successContainer('Restauration terminée', `Restauration terminée avec succès!\n\nSauvegarde: **${backup.name}**`),
    ));
  } catch (error) {
    console.error('Erreur lors de la restauration:', error);
    await interaction.followUp(v2Message(
      { flags: MessageFlags.Ephemeral },
      errorContainer('Erreur de restauration', `Erreur lors de la restauration: ${publicErrorMessage(error, 'Erreur inconnue')}`),
    ));
  }
}

async function handleDelete(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const backupId = interaction.options.getString('id', true);

  const backup = await prisma.serverBackup.findUnique({
    where: { id: backupId },
  });

  if (!backup) {
    await interaction.editReply(v2Message(
      errorContainer('Introuvable', 'Sauvegarde non trouvée.'),
    ));
    return;
  }

  if (backup.guildId !== guildId) {
    await interaction.editReply(v2Message(
      errorContainer('Accès refusé', "Cette sauvegarde n'appartient pas à ce serveur."),
    ));
    return;
  }

  await prisma.serverBackup.delete({
    where: { id: backupId },
  });

  await interaction.editReply(v2Message(
    successContainer('Sauvegarde supprimée', `Sauvegarde **${backup.name}** supprimée avec succès.`),
  ));
}

async function handleExport(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const backupId = interaction.options.getString('id', true);

  const backup = await prisma.serverBackup.findUnique({
    where: { id: backupId },
  });

  if (!backup) {
    await interaction.editReply(v2Message(
      errorContainer('Introuvable', 'Sauvegarde non trouvée.'),
    ));
    return;
  }

  if (backup.guildId !== guildId) {
    await interaction.editReply(v2Message(
      errorContainer('Accès refusé', "Cette sauvegarde n'appartient pas à ce serveur."),
    ));
    return;
  }

  // Créer l'objet JSON à exporter
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    backup: {
      name: backup.name,
      description: backup.description,
      serverName: backup.serverName,
      serverIcon: backup.serverIcon,
      createdByUserId: backup.createdByUserId,
      createdByUsername: backup.createdByUsername,
      createdByTag: backup.createdByTag,
      createdAt: backup.createdAt,
      data: backup.data,
      options: {
        includeMessages: backup.includeMessages,
        includeMembers: backup.includeMembers,
        includeRoles: backup.includeRoles,
        includeChannels: backup.includeChannels,
        includeEmojis: backup.includeEmojis,
        includeStickers: backup.includeStickers,
      },
      stats: {
        rolesCount: backup.rolesCount,
        channelsCount: backup.channelsCount,
        membersCount: backup.membersCount,
        messagesCount: backup.messagesCount,
        emojisCount: backup.emojisCount,
        stickersCount: backup.stickersCount,
        sizeBytes: backup.sizeBytes,
      },
    },
  };

  // Convertir en JSON
  const jsonString = JSON.stringify(exportData, null, 2);
  const buffer = Buffer.from(jsonString, 'utf-8');

  // Vérifier la taille (limite Discord: 25MB)
  if (buffer.length > 25 * 1024 * 1024) {
    await interaction.editReply(v2Message(
      errorContainer('Fichier trop volumineux', 'La sauvegarde est trop volumineuse pour être exportée (limite Discord: 25MB).'),
    ));
    return;
  }

  // Envoyer le fichier
  await interaction.editReply(v2Message(
    {
      files: [
        {
          attachment: buffer,
          name: `${backup.name.replace(/[^a-zA-Z0-9]/g, '_')}_backup.json`,
        },
      ],
    },
    infoContainer('Export', `Export de la sauvegarde **${backup.name}**`),
  ));
}

async function handleImport(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment('fichier', true);
  const customName = interaction.options.getString('nom');

  if (!attachment.name.endsWith('.json')) {
    await interaction.editReply(v2Message(
      errorContainer('Format invalide', 'Le fichier doit être au format JSON.'),
    ));
    return;
  }

  if (attachment.size > MAX_BACKUP_IMPORT_BYTES) {
    await interaction.editReply(v2Message(
      errorContainer('Fichier trop volumineux', `Le fichier ne doit pas dépasser ${MAX_BACKUP_IMPORT_BYTES / 1024 / 1024} Mo.`),
    ));
    return;
  }

  // Télécharger le fichier
  let buffer: Buffer;
  try {
    const response = await fetchExternal(attachment.url, {}, 15_000);
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    await interaction.editReply(v2Message(
      errorContainer('Erreur', 'Erreur lors du téléchargement du fichier.'),
    ));
    return;
  }

  let backupData;
  try {
    backupData = parseBackupImport(buffer.toString('utf-8'));
  } catch (error) {
    await interaction.editReply(v2Message(
      errorContainer(
        'Sauvegarde invalide',
        publicErrorMessage(error, 'Le fichier de sauvegarde est invalide.'),
      ),
    ));
    return;
  }

  // Vérifier le nombre de backups existants
  const existingBackups = await prisma.serverBackup.count({
    where: { guildId, isPreset: false },
  });

  if (existingBackups >= MAX_BACKUPS_PER_GUILD) {
    await interaction.editReply(v2Message(
      errorContainer('Limite atteinte', `Vous avez atteint la limite de ${MAX_BACKUPS_PER_GUILD} sauvegardes. Supprimez une sauvegarde existante avant d'en importer une nouvelle.`),
    ));
    return;
  }

  // Générer le nom du backup
  const backupName = customName || backupData.name || `Import - ${backupData.serverName || 'Serveur'} - ${new Date().toLocaleDateString('fr-FR')}`;

  try {
    // Créer le backup dans la base de données
    const _newBackup = await prisma.serverBackup.create({
      data: {
        guildId,
        name: backupName,
        description: backupData.description,
        data: backupData.data as unknown as Prisma.InputJsonValue,
        includeMessages: backupData.options.includeMessages,
        includeMembers: backupData.options.includeMembers,
        includeRoles: backupData.options.includeRoles,
        includeChannels: backupData.options.includeChannels,
        includeEmojis: backupData.options.includeEmojis,
        includeStickers: backupData.options.includeStickers,
        createdByUserId: interaction.user.id,
        createdByUsername: interaction.user.username,
        createdByTag: interaction.user.discriminator ?? '0000',
        serverName: backupData.serverName || 'Importé',
        serverIcon: backupData.serverIcon,
        sizeBytes: backupData.stats.sizeBytes,
        rolesCount: backupData.stats.rolesCount,
        channelsCount: backupData.stats.channelsCount,
        membersCount: backupData.stats.membersCount,
        messagesCount: backupData.stats.messagesCount,
        emojisCount: backupData.stats.emojisCount,
        stickersCount: backupData.stats.stickersCount,
        isPreset: false,
      },
    });

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'success',
        title: `${E.success} Sauvegarde importée`,
        fields: [
          `Sauvegarde importée avec succès!`,
          separator({ divider: true, spacing: 'small' }),
          `**Nom:** ${backupName}`,
          `**Original:** ${backupData.name}`,
          `**Serveur original:** ${backupData.serverName}`,
          `### ${E.stats} Statistiques`,
          [
            `${E.arrow} Rôles: ${backupData.stats?.rolesCount || 0}`,
            `${E.arrow} Salons: ${backupData.stats?.channelsCount || 0}`,
            `${E.arrow} Membres: ${backupData.stats?.membersCount || 0}`,
            `${E.arrow} Emojis: ${backupData.stats?.emojisCount || 0}`,
            `${E.arrow} Stickers: ${backupData.stats?.stickersCount || 0}`,
          ].join('\n'),
        ],
      }),
    ));
  } catch (error) {
    console.error("Erreur lors de l'import:", error);
    await interaction.editReply(v2Message(
      errorContainer('Erreur d\'import', `Erreur lors de l'import: ${publicErrorMessage(error, 'Erreur inconnue')}`),
    ));
  }
}
