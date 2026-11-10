import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { argsFromQuery, isReadTool, statutOutil } from '../../api/mcp/restApi.js';
import { err, toolError } from '../../api/mcp/toolkit.js';

describe('API REST : lecture des paramètres', () => {
  const schema = z.object({
    member: z.string(),
    limit: z.number().int().optional(),
    active: z.boolean().optional(),
  });

  test('un ID Discord reste une chaîne, les nombres et booléens sont convertis', () => {
    const parsed = argsFromQuery(schema, new URLSearchParams('member=123456789012345678&limit=10&active=true'));
    expect(parsed.success && parsed.data).toEqual({ member: '123456789012345678', limit: 10, active: true });
  });

  test('un nom numérique reste une chaîne', () => {
    const parsed = argsFromQuery(schema, new URLSearchParams('member=2024'));
    expect(parsed.success && parsed.data).toEqual({ member: '2024' });
  });

  test('tableau : valeur seule, valeurs répétées ou JSON', () => {
    const avecListe = z.object({ staff_ids: z.array(z.string()).optional() });
    const lire = (q: string) => {
      const parsed = argsFromQuery(avecListe, new URLSearchParams(q));
      return parsed.success && parsed.data.staff_ids;
    };
    expect(lire('staff_ids=123456789012345678')).toEqual(['123456789012345678']);
    expect(lire('staff_ids=1&staff_ids=2')).toEqual(['1', '2']);
    expect(lire('staff_ids=["1","2"]')).toEqual(['1', '2']);
  });

  test('paramètre inconnu ou requis manquant : refusé', () => {
    expect(argsFromQuery(schema, new URLSearchParams('member=a&evil=1')).success).toBe(false);
    expect(argsFromQuery(schema, new URLSearchParams('limit=3')).success).toBe(false);
  });

  test('seuls les outils de lecture sont exposés', () => {
    expect(isReadTool('get_member_level')).toBe(true);
    expect(isReadTool('list_channels')).toBe(true);
    expect(isReadTool('delete_channel')).toBe(false);
    expect(isReadTool('apply_sanction')).toBe(false);
  });
});

describe('API REST : statut HTTP', () => {
  test('succès, erreur métier, droit manquant, panne interne', () => {
    expect(statutOutil({})).toBe(200);
    expect(statutOutil(err('Membre introuvable.'))).toBe(400);
    expect(statutOutil(err('Permission requise.', { 'mcp/www_authenticate': ['Bearer'] }))).toBe(403);
    // Un `Error` nu porte un message écrit pour l'utilisateur (utils/publicError.ts) : refus métier, 400.
    expect(statutOutil(toolError(new Error('Salon introuvable.')))).toBe(400);
    // Plantage du code : message masqué, panne.
    expect(statutOutil(toolError(new TypeError("Cannot read properties of undefined (reading 'id')")))).toBe(500);
    expect(statutOutil(toolError(Object.assign(new Error('refusé'), { code: 'ECONNREFUSED' })))).toBe(500);
  });
});

describe('API REST : les outils exposés restent en lecture', () => {
  // Lu sur la source : `isReadTool` ne regarde que le nom, rien n'empêcherait
  // un `get_…` qui écrit d'être servi par une API annoncée en lecture seule.
  test('aucun outil get_/list_/search_/read_ n’écrit', () => {
    const dossier = path.resolve(import.meta.dir, '../../api/mcp/tools');
    const outil = /registerTool\(\s*['"]([a-z_0-9]+)['"]/g;
    const ecriture = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|send|edit)\(|\baudit\(/;
    const fautifs: string[] = [];
    for (const fichier of readdirSync(dossier).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(dossier, fichier), 'utf8');
      const trouves = [...source.matchAll(outil)];
      trouves.forEach((m, i) => {
        const corps = source.slice(m.index, trouves[i + 1]?.index ?? source.length);
        if (isReadTool(m[1]) && ecriture.test(corps)) fautifs.push(m[1]);
      });
    }
    expect(fautifs).toEqual([]);
  });
});
