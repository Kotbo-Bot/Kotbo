import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type Client, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import prisma from '../../utils/db.js';
import { Prisma } from '@prisma/client';
import { kotboEventBus } from '@kotbo/core';
import { logger } from '../../utils/logger.js';
import { handleFormTrigger } from './autoResponseService.js';
import { labelFormAnswers } from './customFormAnswers.js';
import { syncRecruitmentFormAvailability } from '../staff/recruitmentPanelService.js';


// ============================================================================
// TYPES
// ============================================================================

export type CustomFormField = {
  id: string;
  type: 'short_text' | 'paragraph' | 'multiple_choice' | 'checkboxes' | 'dropdown' | 'email' | 'number' | 'date' | 'discord_connect';
  label: string;
  description?: string;
  required: boolean;
  options?: string[];
};

export type CustomFormStructure = {
  title: string;
  description?: string;
  fields: CustomFormField[];
};

// ============================================================================
// CRUD FORMULAIRES
// ============================================================================

export async function createCustomForm(
  guildId: string,
  data: {
    name: string;
    description?: string;
    structure: CustomFormStructure;
    isRecruitment?: boolean;
    requiresDiscordAuth?: boolean;
    theme?: object | null;
    customCss?: string | null;
    hierarchyId?: string | null;
  }
) {
  return prisma.customForm.create({
    data: {
      guildId,
      name: data.name,
      description: data.description,
      structure: data.structure as unknown as Prisma.InputJsonValue,
      isActive: true,
      isRecruitment: data.isRecruitment ?? false,
      requiresDiscordAuth: data.requiresDiscordAuth ?? false,
      theme: data.theme ? (data.theme as Prisma.InputJsonValue) : undefined,
      customCss: data.customCss ?? undefined,
      hierarchyId: data.hierarchyId ?? undefined,
    },
  });
}

export async function getCustomForms(guildId: string, includeStructure = false) {
  if (!includeStructure) {
    return prisma.customForm.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        guildId: true,
        name: true,
        description: true,
        isActive: true,
        isRecruitment: true,
        requiresDiscordAuth: true,
        hierarchyId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { submissions: true, events: true } },
        hierarchy: { select: { id: true, name: true, color: true, icon: true } },
      },
    });
  }

  return prisma.customForm.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { submissions: true, events: true },
      },
      hierarchy: { select: { id: true, name: true, color: true, icon: true } },
    },
  });
}

export async function getCustomForm(formId: string, guildId: string) {
  return prisma.customForm.findFirst({
    where: { id: formId, guildId },
    include: {
      events: { select: { id: true, title: true, status: true } },
      _count: { select: { submissions: true } },
      hierarchy: { select: { id: true, name: true, color: true, icon: true } },
    },
  });
}

export async function updateCustomForm(
  formId: string,
  guildId: string,
  data: { name?: string; description?: string; structure?: CustomFormStructure; isActive?: boolean; isRecruitment?: boolean; requiresDiscordAuth?: boolean; hierarchyId?: string | null }
) {
  const { structure, ...rest } = data;
  return prisma.customForm.updateMany({
    where: { id: formId, guildId },
    data: {
      ...rest,
      ...(structure !== undefined && { structure: structure as unknown as Prisma.InputJsonValue }),
    },
  });
}

export async function deleteCustomForm(formId: string, guildId: string) {
  // Détacher les événements liés avant de supprimer
  await prisma.event.updateMany({
    where: { formId, guildId },
    data: { formId: null },
  });

  return prisma.customForm.deleteMany({
    where: { id: formId, guildId },
  });
}

// ============================================================================
// SOUMISSIONS
// ============================================================================

export async function submitCustomForm(
  formId: string,
  guildId: string,
  userId: string,
  username: string | undefined,
  userTag: string | undefined,
  data: Record<string, string>,
  client?: Client,
  /** Vrai quand Discord garantit que `userId` est bien l'auteur (fenêtre Discord, page connectée). */
  identityVerified = false,
) {
  const submission = await prisma.customFormSubmission.create({
    data: {
      formId,
      guildId,
      userId,
      username,
      userTag,
      data: data as unknown as Prisma.InputJsonValue,
    },
  });

  // Les notifications Discord, la candidature liée et les triggers peuvent
  // nécessiter plusieurs appels DB/réseau. La réponse HTTP ne doit pas attendre
  // ces traitements une fois la soumission durablement enregistrée.
  queueMicrotask(() => {
    void processCustomFormSubmissionSideEffects(formId, guildId, userId, username, data, client);
    void publishFormSubmitted(formId, guildId, submission.id, identityVerified ? userId : null, username ?? userTag ?? '', data);
  });

  return submission;
}

async function processCustomFormSubmissionSideEffects(
  formId: string,
  guildId: string,
  userId: string,
  username: string | undefined,
  data: Record<string, string>,
  client?: Client,
): Promise<void> {
  // Si le formulaire autonome est lié au recrutement, on crée également une candidature
  try {
    const form = await prisma.customForm.findUnique({
      where: { id: formId },
      select: { isRecruitment: true, name: true },
    });

    if (form?.isRecruitment) {
      const candidature = await prisma.recruitmentCandidature.create({
        data: {
          guildId,
          customFormId: formId,
          discordId: userId || null,
          username: username || null,
          data: data as unknown as Prisma.InputJsonValue,
          status: 'PENDING',
        },
      });
      await syncRecruitmentFormAvailability(formId);

      if (client) {
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { recruitmentLogChannelId: true },
        });

        if (guildConfig?.recruitmentLogChannelId) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          const channel = discordGuild?.channels.cache.get(guildConfig.recruitmentLogChannelId);
          if (channel?.isSendable()) {
            await channel.send({
              embeds: [{
                title: '📋 Nouvelle candidature reçue (Formulaire Autonome)',
                description: `Formulaire: **${form.name}**\n\nDiscord: ${userId ? `<@${userId}>` : 'Non renseigné'}\nNom: ${username || 'Non renseigné'}`,
                color: 0x6366f1,
                timestamp: new Date().toISOString(),
                footer: { text: `Candidature ID: ${candidature.id}` },
              }],
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error('CustomFormService', 'Error processing recruitment link for custom form:', err);
  }

  if (client) {
    await handleFormTrigger(guildId, userId, formId, data, client).catch((err) => {
      logger.error('CustomFormService', `Error executing trigger for form ${formId}:`, err);
    });
  }
}

async function publishFormSubmitted(
  formId: string,
  guildId: string,
  submissionId: string,
  userId: string | null,
  authorName: string,
  data: Record<string, string>,
): Promise<void> {
  try {
    const form = await prisma.customForm.findUnique({
      where: { id: formId },
      select: { name: true, structure: true },
    });
    if (!form) return;

    kotboEventBus.publish('form:submitted', {
      guildId,
      formId,
      formName: form.name,
      submissionId,
      userId: userId || null,
      authorName,
      answers: labelFormAnswers(form.structure, data),
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error('CustomFormService', `Error publishing submission of form ${formId}:`, err);
  }
}

export async function getCustomFormSubmissions(formId: string, guildId: string, limit = 100, offset = 0) {
  return prisma.customFormSubmission.findMany({
    where: { formId, guildId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 250),
    skip: Math.max(offset, 0),
  });
}

// ============================================================================
// MODAL DISCORD POUR FORMULAIRE
// ============================================================================

/**
 * Construit un ModalBuilder Discord depuis une structure de formulaire.
 * Discord limite les modals à 5 champs de texte maximum.
 */
export function buildFormModal(
  formId: string,
  eventId: string,
  structure: CustomFormStructure
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`custom-form-modal:${formId}:${eventId}`)
    .setTitle(structure.title.slice(0, 45));

  // Discord limite à 5 composants de texte par modal
  const textFields = structure.fields
    .filter(f => ['short_text', 'paragraph', 'email', 'number', 'date'].includes(f.type))
    .slice(0, 5);

  for (const field of textFields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label.slice(0, 45))
      .setStyle(field.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required);

    if (field.description) {
      input.setPlaceholder(field.description.slice(0, 100));
    }

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  // Si aucun champ texte, ajouter un champ par défaut
  if (textFields.length === 0) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('default_response')
          .setLabel('Votre message')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      )
    );
  }

  return modal;
}

// ============================================================================
// HANDLER SOUMISSION MODAL
// ============================================================================

export async function handleFormModalSubmit(
  interaction: ModalSubmitInteraction,
  formId: string,
  eventId: string
) {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  // Vérifier si déjà inscrit à l'événement
  if (eventId) {
    const existing = await prisma.customEventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    if (existing) {
      return interaction.reply({
        content: '⚠️ Vous êtes déjà inscrit à cet événement.',
        ephemeral: true,
      });
    }
  }

  // Collecter les réponses du modal
  const formData: Record<string, string> = {};
  for (const fieldId of interaction.fields.fields.keys()) {
    formData[fieldId] = interaction.fields.getTextInputValue(fieldId);
  }

  // Enregistrer la soumission du formulaire
  if (formId !== 'none') {
    await submitCustomForm(
      formId,
      guildId,
      userId,
      interaction.user.username,
      interaction.user.tag,
      formData,
      interaction.client,
      true,
    );
  }

  // Enregistrer l'inscription à l'événement
  if (eventId && eventId !== 'none') {
    await prisma.customEventRegistration.create({
      data: {
        eventId,
        guildId,
        userId,
        username: interaction.user.username,
        userTag: interaction.user.tag,
        formData: formId !== 'none' ? (formData as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  }

  return interaction.reply({
    content: '✅ Votre inscription a bien été enregistrée ! Merci.',
    ephemeral: true,
  });
}

// ============================================================================
// INSCRIPTION DIRECTE (sans formulaire)
// ============================================================================

export async function handleDirectRegistration(
  interaction: ButtonInteraction,
  eventId: string
) {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  try {
    const existing = await prisma.customEventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    if (existing) {
      return interaction.reply({
        content: '⚠️ Vous êtes déjà inscrit à cet événement.',
        ephemeral: true,
      });
    }

    await prisma.customEventRegistration.create({
      data: {
        eventId,
        guildId,
        userId,
        username: interaction.user.username,
        userTag: interaction.user.tag,
      },
    });

    return interaction.reply({
      content: '✅ Vous êtes désormais inscrit à cet événement !',
      ephemeral: true,
    });
  } catch (err) {
    logger.error('CustomFormService', 'Error registering participant:', err);
    return interaction.reply({
      content: "❌ Une erreur est survenue lors de l'inscription.",
      ephemeral: true,
    });
  }
}

// ============================================================================
// GESTION DES INSCRITS
// ============================================================================

export async function getEventRegistrations(eventId: string) {
  return prisma.customEventRegistration.findMany({
    where: { eventId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function removeEventRegistration(eventId: string, userId: string) {
  return prisma.customEventRegistration.deleteMany({
    where: { eventId, userId },
  });
}
