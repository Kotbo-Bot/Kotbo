import { expect, test } from 'bun:test';
import type { Guild } from 'discord.js';
import { RestoreInProgressError, restoreBackup, type RestoreOptions } from '../../services/system/restoreService.js';
import type { BackupData } from '../../services/system/backupService.js';
import { publicErrorMessage } from '../../utils/publicError.js';

test('une seule restauration à la fois par serveur, le verrou tombe à la fin', async () => {
  const guild = { id: 'g', name: 'Serveur' } as unknown as Guild;
  const nothing: RestoreOptions = {
    fullRestore: false, includeRoles: false, includeChannels: false, includeMembers: false,
    includeEmojis: false, includeStickers: false, includeMessages: false, conflictResolution: 'ignore',
  };
  const first = restoreBackup(guild, {} as BackupData, nothing);
  await expect(restoreBackup(guild, {} as BackupData, nothing)).rejects.toBeInstanceOf(RestoreInProgressError);
  await first;
  await restoreBackup(guild, {} as BackupData, nothing);
});

test('/backup montre ce refus tel quel à l’utilisateur', () => {
  expect(publicErrorMessage(new RestoreInProgressError(), 'Erreur inconnue')).toBe('Une restauration est déjà en cours sur ce serveur');
});
