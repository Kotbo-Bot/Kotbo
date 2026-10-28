import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';

const calls: Array<{ model: string; args: any }> = [];
const fakeDelegate = (model: string) => ({
  upsert: async (args: unknown) => { calls.push({ model, args }); },
  update: async (args: unknown) => { calls.push({ model, args }); },
});
mock.module('../../utils/db.js', () => ({
  default: new Proxy({}, { get: (_t, key) => fakeDelegate(String(key)) }),
  prisma: {},
  prismaRead: {},
}));

const { KOTBO_LIST_MODELS, KOTBO_SINGLETON_MODELS, restoreKotboConfig } = await import('../../services/system/kotboConfigBackup');

const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/database/prisma');
const schema = readdirSync(schemaDir).filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(path.join(schemaDir, f), 'utf8')).join('\n');
const modelBlock = (name: string) => schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? '';

describe('kotboConfigBackup', () => {
  test('les tables à une ligne sont bien uniques par guildId', () => {
    for (const model of KOTBO_SINGLETON_MODELS) {
      expect({ model, ok: /^\s+guildId\s+String\s+.*@(id|unique)/m.test(modelBlock(model)) }).toEqual({ model, ok: true });
    }
  });

  test('les tables à plusieurs lignes ont un id et un guildId', () => {
    const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.map((f) => f.name)]));
    for (const model of KOTBO_LIST_MODELS) {
      const fields = models.get(model) ?? [];
      expect({ model, ok: fields.includes('id') && fields.includes('guildId') }).toEqual({ model, ok: true });
      expect({ model, ok: /^\s+id\s+String\s+@id/m.test(modelBlock(model)) }).toEqual({ model, ok: true });
    }
  });

  test('la restauration remappe les ids Discord et force le serveur', async () => {
    calls.length = 0;
    const oldRole = '111111111111111111';
    const newRole = '222222222222222222';
    const result = await restoreKotboConfig('999999999999999999', {
      guild: { moderatorRoleId: oldRole },
      singletons: { LevelConfig: { id: 'cfg', guildId: '333333333333333333', announceRoleId: oldRole } },
      lists: { AutoResponse: [{ id: 'ar1', guildId: '333333333333333333', response: `<@&${oldRole}>`, metadata: null }] },
    }, new Map([[oldRole, newRole]]));

    expect(result).toEqual({ restored: 3, failed: 0 });
    expect(calls[0].args.data.moderatorRoleId).toBe(newRole);
    expect(calls[1].args.where).toEqual({ guildId: '999999999999999999' });
    expect(calls[1].args.create.id).toBeUndefined();
    expect(calls[1].args.create.announceRoleId).toBe(newRole);
    expect(calls[2].args.where).toEqual({ id: 'ar1' });
    expect(calls[2].args.create.guildId).toBe('999999999999999999');
    expect(calls[2].args.create.response).toBe(`<@&${newRole}>`);
  });
});
