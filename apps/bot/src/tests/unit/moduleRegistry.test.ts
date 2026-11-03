/**
 * Le registre des modules est consomme par cinq couches (page, ecriture en
 * base, garde d execution, routes API, navigation). Une incoherence dedans ne
 * se voit nulle part a la compilation : elle se traduit par un module qui ne
 * s eteint pas, ou par une route ouverte alors qu elle devrait etre fermee.
 */
import { describe, expect, test } from 'bun:test';
import {
  MODULE_CATEGORIES,
  MODULE_REGISTRY,
  canonicalModuleKey,
  defaultModuleStates,
  getModuleDefinition,
  getModuleDependents,
  getModuleForApiSegment,
  getModuleForCustomId,
  getModuleForPath,
  getModuleRequirements,
  isCoreModule,
  isModulePaused,
  withoutPausedModulePermissions,
} from '@kotbo/contracts';

describe('registre des modules', () => {
  test('les cles sont uniques', () => {
    const keys = MODULE_REGISTRY.map((mod) => mod.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('aucun alias ne recouvre une cle canonique d un autre module', () => {
    const keys = new Set(MODULE_REGISTRY.map((mod) => mod.key));
    for (const mod of MODULE_REGISTRY) {
      for (const alias of mod.aliases ?? []) {
        expect(keys.has(alias)).toBeFalse();
        expect(canonicalModuleKey(alias)).toBe(mod.key);
      }
    }
  });

  test('chaque dependance declaree existe', () => {
    for (const mod of MODULE_REGISTRY) {
      for (const requirement of mod.requires ?? []) {
        expect(getModuleDefinition(requirement)).toBeDefined();
      }
    }
  });

  test('aucun cycle de dependances', () => {
    for (const mod of MODULE_REGISTRY) {
      expect(getModuleRequirements(mod.key)).not.toContain(mod.key);
    }
  });

  test('un segment d API n appartient qu a un seul module', () => {
    const seen = new Map<string, string>();
    for (const mod of MODULE_REGISTRY) {
      for (const segment of mod.apiSegments ?? []) {
        expect(seen.get(segment) ?? mod.key).toBe(mod.key);
        seen.set(segment, mod.key);
      }
    }
  });

  test('la colonne qui fait foi en lecture est aussi ecrite', () => {
    // Un `legacyField` absent de `guildFields` se lit sans jamais etre mis a
    // jour : le module repartirait sur son etat d avant a chaque bascule.
    for (const mod of MODULE_REGISTRY.filter((entry) => entry.legacyField)) {
      expect(mod.guildFields ?? []).toContain(mod.legacyField as string);
    }
  });

  test('les categories declarees existent toutes dans MODULE_CATEGORIES', () => {
    const known = new Set(MODULE_CATEGORIES.map((category) => category.key));
    for (const mod of MODULE_REGISTRY) {
      expect(known.has(mod.category)).toBeTrue();
    }
  });

  test('un module du coeur ne depend de rien de desactivable', () => {
    for (const mod of MODULE_REGISTRY.filter((entry) => entry.core)) {
      for (const requirement of getModuleRequirements(mod.key)) {
        expect(isCoreModule(requirement)).toBeTrue();
      }
    }
  });

  test('les modules du coeur sont actifs par defaut', () => {
    const states = defaultModuleStates();
    for (const mod of MODULE_REGISTRY.filter((entry) => entry.core)) {
      expect(states[mod.key]).toBeTrue();
    }
  });
});

describe('modules en pause', () => {
  test('le daily algo et les partenariats sont en pause', () => {
    expect(isModulePaused('daily_algo')).toBeTrue();
    expect(isModulePaused('partnerships')).toBeTrue();
  });

  test('la pause se lit aussi par une cle historique', () => {
    expect(isModulePaused('dailyalgo')).toBeTrue();
  });

  test('un module ordinaire ou inconnu n est pas en pause', () => {
    expect(isModulePaused('tickets')).toBeFalse();
    expect(isModulePaused('module-inexistant')).toBeFalse();
    expect(isModulePaused(undefined)).toBeFalse();
  });

  test('un module du coeur ne peut pas etre mis en pause', () => {
    for (const mod of MODULE_REGISTRY.filter((entry) => entry.core)) {
      expect(isModulePaused(mod.key)).toBeFalse();
    }
  });

  test('les permissions d un module en pause ne sont plus accordees', () => {
    expect(
      withoutPausedModulePermissions(['daily_algo:create_exercise', 'recruitment:forms', 'dailyalgo:read_exercise']),
    ).toEqual(['recruitment:forms']);
  });

  test('une permission sans module connu est conservee', () => {
    expect(withoutPausedModulePermissions(['custom', 'recruitment:manage'])).toEqual(['custom', 'recruitment:manage']);
  });

  test('un module en pause est eteint par defaut', () => {
    const states = defaultModuleStates();
    for (const mod of MODULE_REGISTRY.filter((entry) => entry.paused)) {
      expect(states[mod.key]).toBeFalse();
    }
  });
});

describe('resolution du module proprietaire', () => {
  test('les alias historiques mènent a la cle canonique', () => {
    expect(canonicalModuleKey('dailyalgo')).toBe('daily_algo');
    expect(canonicalModuleKey('traduction')).toBe('translation');
  });

  test('une cle inconnue est renvoyee telle quelle', () => {
    expect(canonicalModuleKey('module-inexistant')).toBe('module-inexistant');
    expect(getModuleDefinition('module-inexistant')).toBeUndefined();
  });

  test('un segment d API remonte a son module', () => {
    expect(getModuleForApiSegment('tickets')).toBe('tickets');
    expect(getModuleForApiSegment('daily-algo-runs')).toBe('daily_algo');
    expect(getModuleForApiSegment('segment-inconnu')).toBeUndefined();
    expect(getModuleForApiSegment(undefined)).toBeUndefined();
  });

  test('le prefixe le plus long l emporte sur un customId', () => {
    // `modal:ticket:` et `ticket:` appartiennent au meme module ici, mais la
    // regle doit tenir : c est elle qui empeche un prefixe court d un autre
    // module de capturer les interactions d un prefixe plus specifique.
    expect(getModuleForCustomId('modal:ticket:open:123')).toBe('tickets');
    expect(getModuleForCustomId('ticket:claim:abc')).toBe('tickets');
    expect(getModuleForCustomId('rpg_drop_claim:1')).toBe('economy');
    expect(getModuleForCustomId('inconnu:42')).toBeUndefined();
  });

  test('les boutons et modals du daily algo remontent a leur module', () => {
    // Sans ces prefixes, les boutons des anciens defis restaient cliquables
    // une fois le module eteint : la garde ne savait pas a qui ils etaient.
    for (const customId of [
      'daily-algo-submit:run1',
      'daily-algo-why:run1',
      'daily-algo-solution:run1',
      'daily-algo-feedback:sub1',
      'modal:daily-algo-feedback:sub1',
      'modal:daily-algo-rate:sub1',
    ]) {
      expect(getModuleForCustomId(customId)).toBe('daily_algo');
    }
  });

  test('une route du dashboard remonte a son module, sous-routes comprises', () => {
    expect(getModuleForPath('/tickets')).toBe('tickets');
    expect(getModuleForPath('/security/sanctions/42')).toBe('sanctions');
    expect(getModuleForPath('/route-inconnue')).toBeUndefined();
    // La racine appartient a « Vue d ensemble » mais ne doit rien capturer :
    // sinon tout chemin du dashboard serait rattache a ce module.
    expect(getModuleForPath('/economy')).toBe('economy');
  });
});

describe('graphe de dependances', () => {
  test('les dependants sont transitifs', () => {
    // Saisons et Clans exigent Leveling ; Marche exige Economie.
    expect(getModuleDependents('leveling')).toContain('seasons');
    expect(getModuleDependents('leveling')).toContain('clans');
    expect(getModuleDependents('economy')).toContain('marketplace');
  });

  test('les prerequis sont transitifs', () => {
    expect(getModuleRequirements('marketplace')).toContain('economy');
    expect(getModuleRequirements('seasons')).toContain('leveling');
  });

  test('un module sans lien n a ni prerequis ni dependant', () => {
    expect(getModuleRequirements('regulation')).toEqual([]);
    expect(getModuleDependents('regulation')).toEqual([]);
  });
});
