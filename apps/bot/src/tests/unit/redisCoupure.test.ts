import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import Redis from 'ioredis';
import { initRedis } from '../../infra/redis.js';
import { createDashboardSession } from '../../api/auth/sessionStore.js';
import { resetCurrentInstance, setCurrentInstance } from '../../utils/instanceContext.js';

// Redis coupé, sans réseau : la vraie connexion part en fond vers une socket
// inexistante, pendant que l'initialisation la croit établie.
const redisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = '/nonexistent/redis.sock';
const clients: Redis[] = [];
const connect = Redis.prototype.connect;
const espions = [
  spyOn(Redis.prototype, 'connect').mockImplementation(function (this: Redis) {
    clients.push(this);
    connect.call(this).catch(() => undefined);
    return Promise.resolve();
  }),
  spyOn(Redis.prototype, 'ping').mockImplementation(async () => 'PONG'),
];
setCurrentInstance({ id: 'test', jwtSecret: 'secret-de-test' } as never);

afterAll(() => {
  for (const client of clients) client.disconnect();
  for (const espion of espions) espion.mockRestore();
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  resetCurrentInstance();
});

/** Ce qu'est devenue la commande au bout de 200 ms. */
const issue = (commande: Promise<unknown>) => Promise.race([
  commande.then(() => 'réponse', () => 'échec'),
  Bun.sleep(200).then(() => 'en attente'),
]);

describe('coupure Redis', () => {
  test('une commande de cache échoue aussitôt au lieu d\'attendre la reconnexion', async () => {
    const client = (await initRedis())!;

    expect(await issue(client.get('cle'))).toBe('échec');
  });

  test('une écriture de session attend la reconnexion : un refresh token tourné ne se perd pas', async () => {
    const session = createDashboardSession({
      userId: '1', username: 'membre', avatar: null,
      discordAccessToken: 'acces', discordRefreshToken: 'jeton-tourne', discordExpiresIn: 3600,
    });

    expect(await issue(session)).toBe('en attente');
  });
});
