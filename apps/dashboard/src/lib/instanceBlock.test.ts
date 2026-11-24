import { describe, expect, test } from 'bun:test';
import { instanceBlockFromBody } from './instanceBlock';

describe("instance bloquée vue par le dashboard", () => {
  test("le refus de l'API donne le motif", () => {
    expect(instanceBlockFromBody({ code: 'instance_blocked', reason: 'Bail expiré' })).toEqual({ reason: 'Bail expiré' });
    expect(instanceBlockFromBody({ code: 'instance_blocked' })).toEqual({ reason: null });
  });

  test('un autre refus ne bloque pas le dashboard', () => {
    expect(instanceBlockFromBody({ code: 'module_disabled' })).toBeNull();
    expect(instanceBlockFromBody(null)).toBeNull();
    expect(instanceBlockFromBody('texte')).toBeNull();
  });
});
