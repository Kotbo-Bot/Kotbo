import prisma from './db.js';
import { upsertRetryingRace } from './upsertRetry.js';

let cached: string | null = null;

/**
 * Identifiant persistant et unique de l'installation courante (une ligne
 * `LocalInstanceIdentity` par base de donnees). Sert d'empreinte machine
 * pour le suivi des instances self-host : stocke en base plutot que dans un
 * fichier local, car le Postgres d'un self-host doit deja persister pour que
 * le bot fonctionne — ca survit aux redeploiements Docker sans configuration
 * supplementaire. Si la base est reinitialisee, l'empreinte change ; c'est
 * une limite acceptee (garde-fou sur des instances honnetes, pas un DRM).
 */
export async function getMachineFingerprint(): Promise<string> {
  if (cached) return cached;

  const row = await upsertRetryingRace(() => prisma.localInstanceIdentity.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  }));

  cached = row.machineFingerprint;
  return cached;
}
