import { afterEach, describe, expect, test } from 'bun:test';
import { SHARDING_ENV_KEYS, withoutShardingEnv } from '../../utils/shardingEnv.js';

const saved = Object.fromEntries(SHARDING_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of SHARDING_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('construction hors du sharding', () => {
  test('les variables posées par le ShardingManager sont absentes pendant l\'appel', () => {
    process.env.SHARDING_MANAGER = 'true';
    process.env.SHARDING_MANAGER_MODE = 'process';
    process.env.SHARDS = '0';
    process.env.SHARD_COUNT = '2';

    const seen = withoutShardingEnv(() => SHARDING_ENV_KEYS.map((key) => process.env[key]));
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('elles sont rendues après, pour les shards encore à lancer', () => {
    process.env.SHARDING_MANAGER = 'true';
    process.env.SHARDING_MANAGER_MODE = 'process';
    withoutShardingEnv(() => null);
    expect(process.env.SHARDING_MANAGER).toBe('true');
    expect(process.env.SHARDING_MANAGER_MODE).toBe('process');
  });

  test('rendues aussi quand l\'appel échoue', () => {
    process.env.SHARDING_MANAGER = 'true';
    expect(() => withoutShardingEnv(() => { throw new Error('boom'); })).toThrow('boom');
    expect(process.env.SHARDING_MANAGER).toBe('true');
  });

  test('une variable absente avant le reste après', () => {
    delete process.env.SHARDS;
    withoutShardingEnv(() => null);
    expect('SHARDS' in process.env).toBe(false);
  });

  test('rend la valeur de l\'appel', () => {
    expect(withoutShardingEnv(() => 42)).toBe(42);
  });
});
