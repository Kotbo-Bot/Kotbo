import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';

// Le panneau tire la base au chargement : on la neutralise, le compteur n'en a
// pas besoin et le test doit rester une vérification de forme, sans I/O.
const mockDb = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
for (const ext of ['ts', 'js']) {
  const target = path.resolve(import.meta.dir, `../../utils/db.${ext}`);
  mock.module(target, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb, upsertRetryingRace: (upsert: () => Promise<unknown>) => upsert() }));
}

const { countComponents, MAX_MESSAGE_COMPONENTS } = await import('../../services/features/rpgPanelService.js');

/** Reproduit la façon dont le panneau assemble un écran, sans toucher à la base. */
function screen(options: { texts?: number; separators?: number; sections?: number; rows?: number[] }): unknown {
  const container = new ContainerBuilder().setAccentColor(0x8b5cf6);

  for (let i = 0; i < (options.texts ?? 0); i++) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`texte ${i}`));
  }
  for (let i = 0; i < (options.separators ?? 0); i++) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  }
  for (let i = 0; i < (options.sections ?? 0); i++) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`objet ${i}`))
        .setButtonAccessory(
          new ButtonBuilder().setCustomId(`rpg:x:1:${i}`).setLabel('Voir').setStyle(ButtonStyle.Primary),
        ),
    );
  }
  for (const buttons of options.rows ?? []) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let i = 0; i < buttons; i++) {
      row.addComponents(new ButtonBuilder().setCustomId(`rpg:y:1:${i}`).setLabel(`b${i}`).setStyle(ButtonStyle.Secondary));
    }
    container.addActionRowComponents(row);
  }

  return container.toJSON();
}

describe('countComponents', () => {
  test('un conteneur vide compte pour lui-même', () => {
    expect(countComponents(screen({}))).toBe(1);
  });

  test('un bloc de texte et un séparateur comptent pour un chacun', () => {
    expect(countComponents(screen({ texts: 3, separators: 2 }))).toBe(1 + 3 + 2);
  });

  test('une section compte pour TROIS composants', () => {
    // C'est le piège qui a fait dépasser l'inventaire : elle-même, son texte, et son
    // accessoire. Cinq sections coûtent quinze composants, pas cinq.
    expect(countComponents(screen({ sections: 1 }))).toBe(1 + 3);
    expect(countComponents(screen({ sections: 5 }))).toBe(1 + 15);
  });

  test('une rangée compte pour elle-même plus ses boutons', () => {
    expect(countComponents(screen({ rows: [5] }))).toBe(1 + 1 + 5);
    expect(countComponents(screen({ rows: [3, 2] }))).toBe(1 + (1 + 3) + (1 + 2));
  });

  test('un sélecteur compte pour un, quel que soit son nombre d options', () => {
    const container = new ContainerBuilder();
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('rpg:z:1')
          .setPlaceholder('…')
          .addOptions(Array.from({ length: 25 }, (_, i) => ({ label: `o${i}`, value: `${i}` }))),
      ),
    );

    expect(countComponents(container.toJSON())).toBe(1 + 1 + 1);
  });

  test('plusieurs conteneurs s additionnent', () => {
    expect(countComponents([screen({ texts: 2 }), screen({ texts: 3 })])).toBe(3 + 4);
  });

  test('ignore ce qui n est pas un composant', () => {
    expect(countComponents(null)).toBe(0);
    expect(countComponents('texte')).toBe(0);
    expect(countComponents(42)).toBe(0);
  });
});

describe('budget des écrans du panneau', () => {
  // Les compositions réelles, telles que les assemblent les écrans du hub. Discord
  // rejette le message ENTIER au-delà du plafond, avec une erreur qui ne nomme pas
  // l'écran fautif : ce test est le seul endroit où le dépassement se voit.
  const screens: [string, Parameters<typeof screen>[0]][] = [
    ['inventaire', { texts: 3, separators: 2, sections: 6, rows: [1, 1, 4] }],
    ['bestiaire', { texts: 4, separators: 1, sections: 6, rows: [1, 4] }],
    ['boutique', { texts: 2, separators: 1, sections: 6, rows: [1, 3] }],
    ['personnage', { texts: 4, separators: 2, sections: 4, rows: [1, 2] }],
  ];

  for (const [name, composition] of screens) {
    test(`${name} tient dans le plafond`, () => {
      expect(countComponents(screen(composition))).toBeLessThanOrEqual(MAX_MESSAGE_COMPONENTS);
    });
  }

  test('la composition qui a cassé l inventaire dépasse bien', () => {
    // Cinq sections d'équipement plus six d'objets : 46 composants, refusés par Discord.
    expect(countComponents(screen({ texts: 3, separators: 2, sections: 11, rows: [1, 4] })))
      .toBeGreaterThan(MAX_MESSAGE_COMPONENTS);
  });
});
