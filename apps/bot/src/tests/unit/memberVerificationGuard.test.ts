/**
 * Demande de vérification forcée depuis la fiche membre, lue sur la source.
 *
 * La demande met le membre en timeout 28 jours. Comme le timeout, l'expulsion et le
 * bannissement, elle doit être refusée quand le bot ne peut pas sanctionner ce membre
 * (rôle au-dessus du sien, propriétaire du serveur) : sinon le timeout échouait sans
 * bruit, le membre recevait quand même le MP et la route répondait « mis en Timeout ».
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MEMBERS = readFileSync(path.resolve(import.meta.dir, '../../api/routes/dashboard/members.ts'), 'utf8');

describe('demande de vérification forcée', () => {
  const start = MEMBERS.indexOf("if (action === 'REQUEST_VERIFICATION')");
  const block = MEMBERS.slice(start, MEMBERS.indexOf("if (action === 'WARN')", start));

  test('refuse un membre que le bot ne peut pas sanctionner, avant toute session', () => {
    const guard = block.indexOf('!targetMember.moderatable');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(block.indexOf('createVerificationSession('));
  });
});
