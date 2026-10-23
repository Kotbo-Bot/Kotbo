import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { isUserFacing, publicErrorMessage, UserFacingError } from '../../utils/publicError';
import { HttpError } from '../../api/shared/core';

const FALLBACK = 'Impossible de créer le salon.';

describe('publicErrorMessage', () => {
  test('laisse passer une erreur de domaine', () => {
    class DungeonError extends UserFacingError {}
    expect(publicErrorMessage(new DungeonError('Ce donjon est fermé.'), FALLBACK)).toBe('Ce donjon est fermé.');
  });

  test('laisse passer un Error nu écrit par notre code', () => {
    expect(publicErrorMessage(new Error('Solde insuffisant.'), FALLBACK)).toBe('Solde insuffisant.');
  });

  test('masque les erreurs natives du moteur', () => {
    expect(publicErrorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), FALLBACK)).toBe(FALLBACK);
    expect(publicErrorMessage(new SyntaxError('Unexpected token < in JSON'), FALLBACK)).toBe(FALLBACK);
  });

  test("masque un Error nu au contenu technique", () => {
    expect(publicErrorMessage(new Error('AEGISAI_API_KEY absente'), FALLBACK)).toBe(FALLBACK);
    expect(publicErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:6379'), FALLBACK)).not.toContain('127.0.0.1');
    expect(publicErrorMessage(new Error('x'.repeat(400)), FALLBACK)).toBe(FALLBACK);
  });

  test('masque une erreur système portant un code', () => {
    const err = Object.assign(new Error('getaddrinfo failed'), { code: 'EAI_AGAIN' });
    expect(publicErrorMessage(err, FALLBACK)).toBe(FALLBACK);
  });

  test('traduit une panne connue plutôt que le message de repli', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`name`)', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(publicErrorMessage(err, FALLBACK)).not.toContain('constraint');
    expect(publicErrorMessage(err, FALLBACK)).not.toBe(FALLBACK);
  });

  test('masque une valeur levée qui n’est pas une erreur', () => {
    expect(publicErrorMessage('boom', FALLBACK)).toBe(FALLBACK);
    expect(publicErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });

  test('HttpError : 4xx affiché, 5xx masqué', () => {
    expect(isUserFacing(new HttpError(400, 'Nom requis.'))).toBe(true);
    expect(isUserFacing(new HttpError(500, 'pool exhausted'))).toBe(false);
  });
});
