/**
 * Reconnaissance des limites Discord qui mettent un ticket en file d'attente.
 *
 * Les erreurs sont de vraies instances de `DiscordAPIError`, construites avec
 * le corps que Discord renvoie : la categorie pleine n'a pas de code propre et
 * ne se lit que dans le detail du champ `parent_id`.
 */
import { describe, expect, test } from 'bun:test';
import { DiscordAPIError } from 'discord.js';
import {
  classifyTicketCapacityError,
  guardTicketCapacity,
  TicketCapacityError,
  ticketCapacityScope,
} from '../../services/features/ticketCapacity.js';

function erreurDiscord(code: number, message: string, errors?: unknown): DiscordAPIError {
  return new DiscordAPIError(
    { code, message, ...(errors ? { errors } : {}) } as never,
    code,
    400,
    'POST',
    '/guilds/1/channels',
    { body: undefined, files: undefined },
  );
}

const categoriePleine = () => erreurDiscord(50035, 'Invalid Form Body', {
  parent_id: { _errors: [{ code: 'CHANNEL_PARENT_MAX_CHANNELS', message: 'Maximum number of channels in category reached (50)' }] },
});

describe('classifyTicketCapacityError', () => {
  test('serveur plein (500 salons)', () => {
    expect(classifyTicketCapacityError(erreurDiscord(30013, 'Maximum number of guild channels reached (500)'))).toBe('GUILD_CHANNELS');
  });

  test('trop de fils actifs', () => {
    expect(classifyTicketCapacityError(erreurDiscord(160006, 'Maximum number of active threads reached'))).toBe('ACTIVE_THREADS');
  });

  test('categorie pleine, lue dans le detail du corps invalide', () => {
    expect(classifyTicketCapacityError(categoriePleine())).toBe('CATEGORY_CHANNELS');
  });

  test("un autre corps invalide n'est pas une limite", () => {
    const err = erreurDiscord(50035, 'Invalid Form Body', { name: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Too long' }] } });
    expect(classifyTicketCapacityError(err)).toBeNull();
  });

  test("droits manquants et erreurs hors Discord ne sont pas des limites", () => {
    expect(classifyTicketCapacityError(erreurDiscord(50013, 'Missing Permissions'))).toBeNull();
    expect(classifyTicketCapacityError(new Error('boom'))).toBeNull();
  });
});

describe('ticketCapacityScope', () => {
  test('une categorie pleine bloque cette categorie seulement', () => {
    expect(ticketCapacityScope('CATEGORY_CHANNELS', { guildId: 'g', categoryId: 'c' })).toBe('CATEGORY_CHANNELS:c');
  });

  test('sans categorie connue, la limite retombe sur le serveur', () => {
    expect(ticketCapacityScope('CATEGORY_CHANNELS', { guildId: 'g' })).toBe('GUILD_CHANNELS:g');
  });

  test('les fils actifs se comptent par serveur', () => {
    expect(ticketCapacityScope('ACTIVE_THREADS', { guildId: 'staff' })).toBe('ACTIVE_THREADS:staff');
  });
});

describe('guardTicketCapacity', () => {
  test('traduit une limite en TicketCapacityError porteuse du ticket', async () => {
    const promesse = guardTicketCapacity(() => Promise.reject(categoriePleine()), { guildId: 'g', categoryId: 'c', ticketId: 't' });
    const err = await promesse.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketCapacityError);
    expect((err as TicketCapacityError).scope).toBe('CATEGORY_CHANNELS:c');
    expect((err as TicketCapacityError).ticketId).toBe('t');
    expect((err as TicketCapacityError).message.startsWith('❌')).toBe(true);
  });

  test('laisse passer les autres erreurs telles quelles', async () => {
    const origine = erreurDiscord(50013, 'Missing Permissions');
    const err = await guardTicketCapacity(() => Promise.reject(origine), { guildId: 'g', ticketId: null }).catch((e: unknown) => e);
    expect(err).toBe(origine);
  });

  test('rend le resultat quand la creation passe', async () => {
    expect(await guardTicketCapacity(() => Promise.resolve(42), { guildId: 'g', ticketId: null })).toBe(42);
  });
});
