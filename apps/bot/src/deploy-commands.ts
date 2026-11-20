import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import { REST, Routes } from 'discord.js';
import pLimit from 'p-limit';
import { logger } from './utils/logger.js';
import prisma from './utils/db.js';
import { initRedis } from './infra/redis.js';
import {
  buildGlobalCommandPayload,
  buildGuildCommandPayload,
} from './services/core/commandDeployment.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  logger.error('Déploiement', 'DISCORD_TOKEN et DISCORD_CLIENT_ID sont requis dans .env');
  process.exit(1);
}

// Sans rejectOnRateLimit ni timeout global, un 429 ou une connexion figée
// bloque indéfiniment le démarrage du conteneur avant même le lancement du bot.
const rest = new REST({ timeout: 15_000, rejectOnRateLimit: () => true }).setToken(token);

/**
 * Les commandes vivent désormais au scope guilde, et la liste envoyée dépend des
 * modules activés sur chaque serveur : c'est ce qui permet à un module éteint de
 * faire disparaître ses commandes plutôt que de les laisser visibles et
 * refusées. Ne restent globales que les commandes d'amorçage (un serveur non
 * activé ne reçoit aucune commande de guilde), celles utilisables en message
 * privé, et les menus contextuels, dont le plafond de 5 par type interdit de
 * tous les descendre au scope guilde.
 *
 * Les serveurs non activés sont purgés : ils ne doivent voir que le global.
 *
 * Par défaut, seules les commandes globales sont publiées. Les commandes de
 * guilde sont réconciliées par chaque shard au démarrage du bot
 * (`reconcileGuildCommands`), sur empreinte : les republier ici en plus
 * retardait le démarrage d'un appel Discord par serveur, et un seul serveur en
 * échec faisait sortir le script en erreur, ce qui empêchait le conteneur de
 * lancer le bot. `--guilds` force malgré tout la republication de tous les
 * serveurs, pour rattraper une liste désynchronisée côté Discord.
 */
async function loadActivatedGuildIds(): Promise<Set<string>> {
  const rows = await prisma.guild.findMany({ where: { activated: true }, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

try {
  // ── Commandes globales ────────────────────────────────────────────────
  const globalPayload = buildGlobalCommandPayload();
  logger.info('Déploiement', `Déploiement de ${globalPayload.length} commandes globales...`);
  const globalTimeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Délai dépassé (20s) lors du déploiement des commandes globales.')), 20_000),
  );
  await Promise.race([
    rest.put(Routes.applicationCommands(clientId), { body: globalPayload, signal: AbortSignal.timeout(20_000) }),
    globalTimeout,
  ]);
  logger.success('Déploiement', `✓ ${globalPayload.length} commandes globales déployées.`);

  if (!process.argv.includes('--guilds')) {
    logger.info(
      'Déploiement',
      'Commandes de guilde laissées à la réconciliation du bot au démarrage (--guilds pour forcer leur republication).',
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  // `buildGuildCommandPayload` lit l'état des modules, qui passe par le cache
  // Redis quand il est disponible. Sans connexion, il retombe sur la base :
  // le script fonctionne dans les deux cas.
  await initRedis().catch(() => null);

  const guilds = (await rest.get(Routes.userGuilds())) as { id: string; name: string }[];
  const activated = await loadActivatedGuildIds();

  logger.info('Déploiement', `${guilds.length} serveur(s) rejoint(s), ${activated.size} activé(s) en base.`);

  // ── Commandes de guilde ───────────────────────────────────────────────
  //
  // Cinq serveurs à la fois : chaque charge utile demande une lecture de l'état
  // des modules, et Discord limite les écritures de commandes par serveur.
  const limit = pLimit(5);
  const results = await Promise.allSettled(
    guilds.map((guild) =>
      limit(async () => {
        const body = activated.has(guild.id) ? await buildGuildCommandPayload(guild.id) : [];
        await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body });
        return body.length;
      }),
    ),
  );

  let deployed = 0;
  let commandTotal = 0;
  let cleared = 0;
  let failed = 0;

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value > 0) {
        deployed++;
        commandTotal += result.value;
      } else {
        cleared++;
      }
    } else {
      failed++;
      const guild = guilds[index];
      logger.error('Déploiement', `✗ Échec sur "${guild?.name}" (${guild?.id}) :`, result.reason);
    }
  }

  const average = deployed > 0 ? Math.round(commandTotal / deployed) : 0;
  logger.success(
    'Déploiement',
    `✓ Commandes de guilde : ${deployed} serveur(s) activé(s) (${average} commande(s) en moyenne), ${cleared} purgé(s), ${failed} en échec.`,
  );

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  logger.error('Déploiement', 'Échec du déploiement :', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
}
