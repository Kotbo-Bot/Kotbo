import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fous du volet vocal de ChannelsManagement.svelte, lus dans la source
 * (la page est un composant : le dépôt n'a pas de harnais de rendu, comme pour
 * `channelsManagementGuard.test.ts`). Chaque test correspond à un point de
 * l'audit du dashboard ; la logique pure, elle, est testée dans
 * `tempVoiceUi.test.ts`.
 */
const read = (...parts: string[]) => readFileSync(join(import.meta.dir, '..', ...parts), 'utf-8');
const page = read('pages', 'ChannelsManagement.svelte');
const COUPE = page.lastIndexOf('</script>');
const script = page.slice(0, COUPE);
const balisage = page.slice(COUPE);
const dict = (lang: 'fr' | 'en') => JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'messages', `${lang}.json`), 'utf-8')) as Record<string, string>;

describe('enregistrement', () => {
  test('2 — le retour « enregistré » est vidé dès que la page redevient modifiée', () => {
    expect(script).toMatch(/\$effect\(\(\) => \{\s*if \(isDirty\) untrack\(\(\) => saveAction\.clearFeedback\(\)\);\s*\}\);/);
  });

  test('5 — une erreur d\'enregistrement part aussi en toast, une seule fois', () => {
    expect(script).toContain('if (!success && saveAction.state.error) toast.error(saveAction.state.error);');
    // L'ancienne validation du rôle cible faisait elle-même un toast PUIS lançait : deux messages.
    expect(script).not.toContain('toast.error(m.cm_role_target_required())');
    expect(script).toContain('throw new Error(m.cm_role_target_required())');
  });

  test('6 — les notices du serveur s\'affichent en toast d\'information', () => {
    expect(script).toMatch(/Array\.isArray\(res\.notices\)[\s\S]{0,120}toast\.info\(/);
  });

  test('12 — ce que le serveur a normalisé est réappliqué (politique, modérateurs, demandes d\'accès)', () => {
    for (const key of ['tempVoiceDefaults', 'tempVoiceModPermissions', 'tempVoiceAccessRequest']) {
      expect(script).toMatch(new RegExp(`if \\(res\\.resolved\\.${key}\\) \\{\\s*config\\.${key} =`));
    }
    // Avant la photographie de ce qui est « enregistré », sinon la page resterait « modifiée ».
    expect(script.indexOf('res.resolved.tempVoiceDefaults')).toBeLessThan(script.indexOf('savedConfig = JSON.parse(JSON.stringify(config));\n      success = true'));
  });

  test('12 — le sous-onglet vocal est lu et écrit dans ?sub=', () => {
    expect(script).toContain('tempVoiceSubFromSearch(window.location.search)');
    expect(script).toContain('withTempVoiceSub(window.location.search, tvSub)');
    expect(script).toContain('window.history.replaceState');
  });

  test('3 — silence après un refus : min 1 dans le champ et bornes à l\'envoi', () => {
    expect(balisage).toMatch(/id="ar-cooldown-input"\s+type="number"\s+min="1"\s+max="1440"/);
    expect(script).toContain('denyCooldownMinutes: clampInt(config.tempVoiceAccessRequest.denyCooldownMinutes, 1, 1440, 10)');
  });
});

describe('générateurs', () => {
  test('1 — les sélecteurs de salon n\'offrent pas les salons déjà pris', () => {
    expect(script).toContain('takenGeneratorChannelIds(null, config.tempVoiceGenerators)');
    expect(script).toContain('takenGeneratorChannelIds(config.tempVoiceChannelId, config.tempVoiceGenerators, index)');
    expect(balisage).toContain('options={mainGeneratorChannelOptions}');
    expect(balisage).toContain('options={generatorChannelOptions(index)}');
  });

  test('7 — la carte d\'un générateur n\'est plus coincée en 4 colonnes dans une colonne étroite', () => {
    expect(balisage).not.toContain('md:grid-cols-4');
    // Le conteneur de la liste n'est plus plafonné à max-w-xl (seuls les champs du principal le sont).
    const debut = balisage.indexOf('<!-- DYNAMIC VOCAL CREATORS TAB -->');
    const bloc = balisage.slice(debut, balisage.indexOf('{:else if activeTab === \'access-requests\'}'));
    expect(bloc).toMatch(/<section class="[^"]*">\s*<div class="space-y-4">/);
  });
});

describe('salons actifs (carte mobile)', () => {
  const debutMobile = balisage.indexOf('<!-- Mobile Cards -->');
  const carte = balisage.slice(debutMobile, balisage.indexOf('cm_close_channel_full', debutMobile));

  test('8 — le renommage a son bouton « Annuler » et son libellé traduit', () => {
    expect(carte).toContain('editingChannel = null');
    expect(carte).toContain('{m.common_cancel()}');
    expect(carte).toContain('{m.cm_validate()}');
    expect(carte).not.toMatch(/>\s*OK\s*</);
  });

  test('8 — le pluriel passe par des clés dédiées, jamais « 1 connectés »', () => {
    expect(carte).toContain('connectedLabel(chan.membersCount)');
    expect(carte).not.toContain('cm_members_connected_suffix');
    for (const lang of ['fr', 'en'] as const) {
      expect(dict(lang).cm_members_connected_one).toContain('{count}');
      expect(dict(lang).cm_members_connected_other).toContain('{count}');
    }
    expect(dict('fr').cm_members_connected_one).not.toMatch(/s$/);
  });
});

describe('interrupteurs', () => {
  test('10 / 11 — « Créer son salon » et « Demandes d\'accès » : ToggleSwitch nommé, qui ne s\'écrase pas', () => {
    expect(balisage).toMatch(/<ToggleSwitch\s+checked=\{config\.tempVoiceEnabled\}[\s\S]{0,160}ariaLabel=\{m\.cm_temp_voice_title\(\)\}/);
    expect(balisage).toMatch(/<ToggleSwitch\s+checked=\{config\.tempVoiceAccessRequest\.enabled\}[\s\S]{0,160}ariaLabel=\{m\.cm_ar_title\(\)\}/);
    // Plus de case à cocher déguisée sans nom accessible pour ces deux réglages.
    expect(balisage).not.toMatch(/<input\s+type="checkbox"\s+bind:checked=\{config\.(tempVoiceEnabled|tempVoiceAccessRequest\.enabled)\}/);
    // Le conteneur et l'interrupteur (shrink-0 dans ToggleSwitch) gardent leur largeur à 390 px.
    expect(read('lib', 'components', 'ToggleSwitch.svelte')).toContain('shrink-0');
    expect(balisage).toMatch(/<div class="flex items-center gap-2 shrink-0">\s*<ToggleSwitch\s+checked=\{config\.tempVoiceEnabled\}/);
  });
});

describe('4 — « Places par défaut »', () => {
  test('le champ est resynchronisé après correction et à la sortie du champ', () => {
    const editor = read('lib', 'components', 'TempVoicePolicyEditor.svelte');
    expect(editor).toContain('userLimitDisplayFix(input.value)');
    expect(editor).toContain('onblur={resyncUserLimit}');
  });
});

describe('A — mention du propriétaire', () => {
  test('défaut, type d\'API, cartes-radio avec aide par option, textes fr/en', () => {
    expect(script).toContain('ownerMentionPlacement: TEMP_VOICE_OWNER_MENTION_DEFAULT');
    expect(read('lib', 'api', 'moderation.ts')).toContain("ownerMentionPlacement: 'panel' | 'message' | 'none'");
    expect(balisage).toContain('bind:group={config.tempVoiceModPermissions.ownerMentionPlacement}');
    for (const key of ['panel', 'message', 'none']) {
      expect(script).toContain(`key: '${key}', label: () => m.cm_tv_owner_mention_${key}(), hint: () => m.cm_tv_owner_mention_${key}_hint()`);
      for (const lang of ['fr', 'en'] as const) {
        expect(dict(lang)[`cm_tv_owner_mention_${key}`]).toBeTruthy();
        expect(dict(lang)[`cm_tv_owner_mention_${key}_hint`]).toBeTruthy();
      }
    }
  });
});

describe('D — mode démonstration', () => {
  test('« demo_mode » est traduit en anglais', () => {
    expect(dict('en').demo_mode).toBe('Demo mode');
    expect(dict('fr').demo_mode).toBe('Mode Démonstration');
  });
});
