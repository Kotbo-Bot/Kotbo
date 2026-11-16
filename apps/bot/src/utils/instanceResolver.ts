import prisma from './db.js';
import { logger } from './logger.js';
import crypto from 'node:crypto';
import { openSecret } from './secretBox.js';

export interface ResolvedInstance {
  id: string;
  slug: string;
  name: string;
  discordToken: string;
  discordClientId: string;
  discordClientSecret: string;
  discordRedirectUri: string | null;
  dashboardUrl: string;
  dashboardOrigin: string;
  apiPort: number;
  brandName: string;
  brandColor: string;
  brandLogoUrl: string | null;
  brandFaviconUrl: string | null;
  brandFooterText: string | null;
  jwtSecret: string;
  ownerId: string;
  maxGuilds: number;
  isDefault: boolean;
}

const DEFAULT_INSTANCE_ID = '__default__';

const instanceCache = new Map<string, ResolvedInstance>();
const instanceByOrigin = new Map<string, ResolvedInstance>();
const instanceByToken = new Map<string, ResolvedInstance>();

function buildOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, '');
  }
}

function buildDefaultInstance(): ResolvedInstance {
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

  return {
    id: DEFAULT_INSTANCE_ID,
    slug: 'default',
    name: 'Kotbo',
    discordToken: process.env.DISCORD_TOKEN || '',
    discordClientId: process.env.DISCORD_CLIENT_ID || '',
    discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    discordRedirectUri: process.env.DISCORD_REDIRECT_URI || null,
    dashboardUrl,
    dashboardOrigin: buildOrigin(dashboardUrl),
    apiPort: Number(process.env.DASHBOARD_API_PORT ?? 8787),
    brandName: 'Kotbo',
    brandColor: '#5865F2',
    brandLogoUrl: null,
    brandFaviconUrl: null,
    brandFooterText: null,
    jwtSecret,
    ownerId: process.env.DISCORD_CLIENT_OWNER_ID || '',
    maxGuilds: Infinity,
    isDefault: true,
  };
}

export async function loadAllInstances(): Promise<ResolvedInstance[]> {
  instanceCache.clear();
  instanceByOrigin.clear();
  instanceByToken.clear();

  const defaultInstance = buildDefaultInstance();
  instanceCache.set(DEFAULT_INSTANCE_ID, defaultInstance);
  instanceByOrigin.set(defaultInstance.dashboardOrigin, defaultInstance);
  if (defaultInstance.discordToken) {
    instanceByToken.set(defaultInstance.discordToken, defaultInstance);
  }

  try {
    // On lit TOUTES les instances, désactivées comprises : l'attribution d'un
    // port automatique doit donner le même résultat dans le launcher et dans
    // chaque shard worker, et ne pas bouger quand on active/désactive une
    // instance voisine. L'ordre est figé sur (createdAt, id).
    const allInstances = await prisma.whiteLabelInstance.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const takenPorts = new Set<number>([defaultInstance.apiPort]);
    for (const inst of allInstances) {
      if (inst.apiPort !== null) takenPorts.add(inst.apiPort);
    }

    let nextAutoPort = defaultInstance.apiPort + 1;
    const assignedPorts = new Map<string, number>();
    const portsToPersist: Array<{ id: string; apiPort: number }> = [];

    for (const inst of allInstances) {
      if (inst.apiPort !== null) {
        assignedPorts.set(inst.id, inst.apiPort);
        continue;
      }
      while (takenPorts.has(nextAutoPort)) nextAutoPort++;
      takenPorts.add(nextAutoPort);
      assignedPorts.set(inst.id, nextAutoPort);
      portsToPersist.push({ id: inst.id, apiPort: nextAutoPort });
    }

    // Fige le port en base pour qu'il survive à la suppression d'une instance
    // antérieure. Le `apiPort: null` en garde rend l'écriture idempotente : si
    // un autre worker est passé avant, il a calculé la même valeur.
    for (const { id, apiPort } of portsToPersist) {
      try {
        await prisma.whiteLabelInstance.updateMany({
          where: { id, apiPort: null },
          data: { apiPort },
        });
      } catch (error) {
        logger.warn('WhiteLabel', `Impossible de figer le port ${apiPort} de l'instance ${id} en base.`, error);
      }
    }

    const dbInstances = allInstances.filter((inst) => inst.enabled);

    for (const inst of dbInstances) {
      const dashboardUrl = inst.dashboardUrl || defaultInstance.dashboardUrl;
      const dashboardOrigin = inst.dashboardOrigin || buildOrigin(dashboardUrl);
      const apiPort = assignedPorts.get(inst.id)!;

      const resolved: ResolvedInstance = {
        id: inst.id,
        slug: inst.slug,
        name: inst.name,
        // Les instances des bots perso sont scellées ; openSecret rend tel quel un secret en clair.
        discordToken: openSecret(inst.discordToken) ?? '',
        discordClientId: inst.discordClientId,
        discordClientSecret: openSecret(inst.discordClientSecret) ?? '',
        discordRedirectUri: inst.discordRedirectUri,
        dashboardUrl,
        dashboardOrigin,
        apiPort,
        brandName: inst.brandName || inst.name,
        brandColor: inst.brandColor,
        brandLogoUrl: inst.brandLogoUrl,
        brandFaviconUrl: inst.brandFaviconUrl,
        brandFooterText: inst.brandFooterText,
        jwtSecret: (inst.jwtSecret && openSecret(inst.jwtSecret)) || crypto.randomBytes(32).toString('hex'),
        ownerId: inst.ownerId,
        maxGuilds: inst.maxGuilds,
        isDefault: false,
      };

      instanceCache.set(inst.id, resolved);
      instanceByOrigin.set(dashboardOrigin, resolved);
      instanceByToken.set(resolved.discordToken, resolved);

      logger.info('WhiteLabel', `Instance "${inst.name}" (${inst.slug}) chargée - port ${apiPort}`);
    }

    logger.success('WhiteLabel', `${dbInstances.length} instance(s) white-label + instance par défaut chargées.`);
  } catch (error) {
    logger.warn('WhiteLabel', 'Impossible de charger les instances white-label (table manquante ?). Mode single-instance.', error);
  }

  return [...instanceCache.values()];
}

export function getDefaultInstance(): ResolvedInstance {
  return instanceCache.get(DEFAULT_INSTANCE_ID) || buildDefaultInstance();
}

export function getInstanceById(id: string): ResolvedInstance | undefined {
  return instanceCache.get(id);
}

export function getInstanceByOrigin(origin: string): ResolvedInstance | undefined {
  return instanceByOrigin.get(origin);
}

export function getInstanceByToken(token: string): ResolvedInstance | undefined {
  return instanceByToken.get(token);
}

export function getInstanceBySlug(slug: string): ResolvedInstance | undefined {
  for (const inst of instanceCache.values()) {
    if (inst.slug === slug) return inst;
  }
  return undefined;
}

export function getAllInstances(): ResolvedInstance[] {
  return [...instanceCache.values()];
}

export function resolveInstanceFromRequest(origin: string | undefined): ResolvedInstance {
  if (origin) {
    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      normalizedOrigin = origin.replace(/\/$/, '');
    }

    const matched = instanceByOrigin.get(normalizedOrigin);
    if (matched) return matched;
  }

  return getDefaultInstance();
}
