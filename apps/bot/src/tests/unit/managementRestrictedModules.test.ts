/**
 * Un module confidentiel (cellule bien-être) décide seul de son accès : le
 * Centre de gestion ne doit ni le lister, ni lui écrire de règle, ni le
 * compter dans les droits d'un membre.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relative: string) => readFileSync(path.resolve(import.meta.dir, '../..', relative), 'utf8');

describe('Centre de gestion et modules confidentiels', () => {
  test('les routes des droits par rôle et par clé refusent un module confidentiel avant toute écriture', () => {
    const source = read('api/routes/dashboard/modules/management.ts');
    for (const writer of ['updateRoleAccess(', 'updateKeyAccess(']) {
      const call = source.indexOf(writer);
      const guard = source.lastIndexOf('isRestrictedModule(featureKey)', call);
      expect(call).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(-1);
    }
  });

  test('listes, préréglages et droits calculés passent par le même filtre', () => {
    const service = read('services/core/dashboardManagementService.ts');
    expect(service.match(/withoutRestrictedModules\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read('api/shared/guildState.ts')).toContain('withoutRestrictedModules(');
  });
});
