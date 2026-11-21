import type { PrismaClient } from '@prisma/client';
import { GuildRepository, VerificationRepository } from '@kotbo/database';
import type { DiscordPort } from '../ports/discord.port.js';
import crypto from 'node:crypto';

export interface DeployVerificationEmbedInput {
  guildId: string;
  channelId: string;
  dashboardUrl: string;
}

export interface DeployVerificationEmbedResult {
  success: boolean;
  error?: string;
}

export interface CompleteVerificationInput {
  token: string;
  verifiedDiscordId: string;
  ipAddress: string;
  guildId: string;
}

export interface CompleteVerificationResult {
  success: boolean;
  error?: string;
}

export class VerificationService {
  private readonly guilds: GuildRepository;
  private readonly verifications: VerificationRepository;

  constructor(
    private readonly db: PrismaClient,
    private readonly discord: DiscordPort,
  ) {
    this.guilds = new GuildRepository(db);
    this.verifications = new VerificationRepository(db);
  }

  async deployVerificationEmbed(
    input: DeployVerificationEmbedInput,
  ): Promise<DeployVerificationEmbedResult> {
    const config = await this.guilds.getVerificationConfig(input.guildId);
    if (!config) {
      return { success: false, error: 'Serveur introuvable.' };
    }
    if (!config.verificationEnabled) {
      return { success: false, error: "La vérification n'est pas activée sur ce serveur." };
    }

    const result = await this.discord.sendEmbed({
      guildId: input.guildId,
      channelId: input.channelId,
      title: config.verificationEmbedTitle,
      description: config.verificationEmbedDesc,
      color: config.verificationEmbedColor,
      components: [
        {
          type: 'button',
          label: 'Vérifier mon identité',
          style: 'primary',
          customId: `secverif_start_${input.guildId}`,
        },
      ],
    });

    if (!result) {
      return { success: false, error: "Impossible d'envoyer l'embed dans ce salon." };
    }

    return { success: true };
  }

  async initiateVerification(params: {
    guildId: string;
    userId: string;
    ipAddress?: string;
  }) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    return this.verifications.create({
      guildId: params.guildId,
      userId: params.userId,
      token,
      expiresAt,
      ipAddress: params.ipAddress,
    });
  }

  async completeVerification(
    params: CompleteVerificationInput,
  ): Promise<CompleteVerificationResult> {
    const verification = await this.verifications.findByToken(params.token);
    if (!verification || verification.guildId !== params.guildId) {
      return { success: false, error: 'Session invalide ou expirée.' };
    }

    if (verification.userId !== params.verifiedDiscordId) {
      return { success: false, error: "L'identité Discord ne correspond pas." };
    }

    await this.verifications.markCompleted(
      verification.id,
      params.verifiedDiscordId,
      params.ipAddress,
    );

    const config = await this.guilds.getVerificationConfig(params.guildId);
    if (config?.verificationRoleId) {
      await this.discord.addRole(
        params.guildId,
        params.verifiedDiscordId,
        config.verificationRoleId,
      );
    }

    return { success: true };
  }
}
