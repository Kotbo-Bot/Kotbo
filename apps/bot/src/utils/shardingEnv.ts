/**
 * Clients discord.js créés dans le lanceur, hors de tout shard.
 *
 * `new ShardingManager` écrit `SHARDING_MANAGER` et `SHARDING_MANAGER_MODE`
 * dans l'environnement du lanceur lui-même. Un `new Client` créé ensuite (les
 * custom bots) les relit et se croit shard d'un gestionnaire en mode
 * « process » : à son premier `ShardReady`, il appelle `process.send`, qui
 * n'existe pas dans le lanceur, et le process tombe. `SHARDS` et `SHARD_COUNT`
 * sont relus de la même façon.
 *
 * Le constructeur de `Client` est synchrone : retirer ces variables le temps
 * de l'appel ne gêne aucun shard, et elles sont rendues pour ceux qui restent
 * à lancer.
 */
export const SHARDING_ENV_KEYS = ['SHARDING_MANAGER', 'SHARDING_MANAGER_MODE', 'SHARDS', 'SHARD_COUNT'] as const;

export function withoutShardingEnv<T>(build: () => T): T {
  const saved = SHARDING_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of SHARDING_ENV_KEYS) delete process.env[key];
  try {
    return build();
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}
