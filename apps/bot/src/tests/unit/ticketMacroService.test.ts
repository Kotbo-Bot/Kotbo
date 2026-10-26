import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

// Le service importe le client Prisma ; ces tests n'en ont pas besoin.
const mockDb = {};
mock.module(path.resolve(__dirname, '../../utils/db.ts'), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(path.resolve(__dirname, '../../utils/db.js'), () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

import { parseMacroInput, withSignature } from '../../services/features/ticketMacroService.js';

describe('withSignature', () => {
  test('sans signature, le texte part seul', () => {
    expect(withSignature('Bonjour', null)).toEqual(['Bonjour']);
  });

  test('la signature est collée sous le texte', () => {
    expect(withSignature('Bonjour', '— Mito')).toEqual(['Bonjour\n\n— Mito']);
  });

  test('au-delà de 2000 caractères, la signature part dans un second message', () => {
    const long = 'a'.repeat(1995);
    expect(withSignature(long, '— Mito')).toEqual([long, '— Mito']);
  });
});

describe('parseMacroInput', () => {
  test('nom et contenu sont obligatoires', () => {
    expect(parseMacroInput({ content: 'Bonjour' })).toEqual({ error: 'Le nom de la macro est obligatoire.' });
    expect(parseMacroInput({ name: 'Accueil', content: '   ' })).toEqual({ error: 'Le contenu de la macro est obligatoire.' });
  });

  test('valeurs par défaut quand seuls nom et contenu sont fournis', () => {
    const parsed = parseMacroInput({ name: ' Accueil ', content: 'Bonjour {user}' });
    expect(parsed).toEqual({
      data: {
        name: 'Accueil',
        category: null,
        emoji: null,
        content: 'Bonjour {user}',
        enabled: true,
        position: 0,
        ticketTypeIds: [],
        allowedRoleIds: [],
        keywords: [],
        autoSendOnOpen: false,
        setTicketTypeId: null,
        addRoleId: null,
        removeRoleId: null,
        requestSatisfaction: false,
        closeTicket: false,
      },
    });
  });

  test('borne le contenu à la limite Discord et nettoie les listes', () => {
    const parsed = parseMacroInput({
      name: 'Longue',
      content: 'x'.repeat(2500),
      position: -3.7,
      keywords: ['  remboursement ', '', 42],
      ticketTypeIds: ['achat', '  ', null],
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.data.content).toHaveLength(2000);
    expect(parsed.data.position).toBe(0);
    expect(parsed.data.keywords).toEqual(['remboursement']);
    expect(parsed.data.ticketTypeIds).toEqual(['achat']);
  });

  test('une macro existante relue telle quelle reste valide (fusion de update_ticket_macro)', () => {
    const existing = {
      id: 'm1',
      guildId: 'g1',
      name: 'Clôture',
      category: null,
      emoji: null,
      content: 'Merci {user}',
      enabled: false,
      position: 4,
      ticketTypeIds: [],
      allowedRoleIds: [],
      keywords: [],
      autoSendOnOpen: false,
      setTicketTypeId: null,
      addRoleId: null,
      removeRoleId: null,
      requestSatisfaction: true,
      closeTicket: true,
      usageCount: 12,
      lastUsedAt: null,
    };
    const parsed = parseMacroInput({ ...existing, content: 'Merci {user}, à bientôt' });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.data.enabled).toBe(false);
    expect(parsed.data.position).toBe(4);
    expect(parsed.data.closeTicket).toBe(true);
    expect(parsed.data.content).toBe('Merci {user}, à bientôt');
    expect(parsed.data).not.toHaveProperty('usageCount');
  });
});
