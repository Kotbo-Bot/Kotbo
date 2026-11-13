import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou des pages traduites : un texte francais ecrit en dur reste en
 * francais pour un utilisateur en anglais. Une fois une page passee a
 * `m.<cle>()`, elle entre dans la liste ci-dessous et n'en sort plus.
 *
 * Le reperage tient aux lettres accentuees : il manque « Campagnes », mais
 * aucune phrase francaise un peu longue n'y echappe, et il ne confond jamais
 * une valeur de code avec un texte affiche.
 */
const SRC = join(import.meta.dir, '..');

/**
 * Restent volontairement hors de la liste, parce que leur francais part dans
 * Discord et suit la langue du bot, pas celle du dashboard : les modeles de
 * workflow, les echelles de roles et les preselections de l'onboarding
 * (lib/onboarding/ladders.ts, presets.ts, modulePresets.ts), et les ecrans qui
 * en montrent le contenu brut (accueil, reglement, economie, quetes, drops).
 */
const TRANSLATED = [
  'lib/api/client.ts',
  'lib/api/content.ts',
  'lib/api/guild.ts',
  'lib/api/modules.ts',
  'lib/api/tournaments.ts',
  'lib/asyncAction.svelte.ts',
  'lib/components/AmountRangeSlider.svelte',
  'lib/components/analytics/AnalyticsFilterBar.svelte',
  'lib/components/CommandPalette.svelte',
  'lib/components/DemoBanner.svelte',
  'lib/components/DiscordMemberLookup.svelte',
  'lib/components/DropClaimRulesPanel.svelte',
  'lib/components/DurationPresets.svelte',
  'lib/components/EmptyState.svelte',
  'lib/components/FormColorPicker.svelte',
  'lib/components/MainLayout.svelte',
  'lib/components/Modal.svelte',
  'lib/components/ModuleDisabledNotice.svelte',
  'lib/components/ModulePage.svelte',
  'lib/components/Navbar.svelte',
  'lib/components/onboarding/BuildSequence.svelte',
  'lib/components/onboarding/ChannelPicker.svelte',
  'lib/components/onboarding/RecoveredContent.svelte',
  'lib/components/onboarding/steps/CheckoutStep.svelte',
  'lib/components/onboarding/steps/KindStep.svelte',
  'lib/components/onboarding/steps/LevelsStep.svelte',
  'lib/components/onboarding/steps/LogsStep.svelte',
  'lib/components/onboarding/steps/MappingStep.svelte',
  'lib/components/onboarding/steps/McpStep.svelte',
  'lib/components/onboarding/steps/MigrationBotsStep.svelte',
  'lib/components/onboarding/steps/ModerationStep.svelte',
  'lib/components/onboarding/steps/RecapStep.svelte',
  'lib/components/onboarding/steps/StaffStep.svelte',
  'lib/components/onboarding/steps/StructureStep.svelte',
  'lib/components/onboarding/steps/ThemeStep.svelte',
  'lib/components/onboarding/steps/TicketsStep.svelte',
  'lib/components/onboarding/steps/WelcomeStep.svelte',
  'lib/components/onboarding/WizardShell.svelte',
  'lib/components/partnerships/PartnershipPanel.svelte',
  'lib/components/partnerships/PartnershipSettingsPanel.svelte',
  'lib/components/partnerships/PartnershipSetupBanner.svelte',
  'lib/components/ProfileWidgetPanel.svelte',
  'lib/components/RolePermissionSettings.svelte',
  'lib/components/security/CaptchaFields.svelte',
  'lib/components/security/SecurityPage.svelte',
  'lib/components/security/ShieldCard.svelte',
  'lib/components/security/VisionPanel.svelte',
  'lib/components/ServerTemplatePanel.svelte',
  'lib/components/Sidebar.svelte',
  'lib/components/tickets/TicketTranscripts.svelte',
  'lib/components/workflows/WorkflowMessageModal.svelte',
  'lib/components/workflows/WorkflowNodeCard.svelte',
  'lib/onboarding/mapping.ts',
  'lib/onboarding/steps.ts',
  'lib/sanctions/importParser.ts',
  'lib/stores/dashboard.svelte.ts',
  'lib/stores/notifications.svelte.ts',
  'lib/stores/staff.svelte.ts',
  'lib/stores/theme.svelte.ts',
  'lib/workflowPreview.ts',
  'pages/Activation.svelte',
  'pages/Analytics.svelte',
  'pages/AutoMod.svelte',
  'pages/Campaigns.svelte',
  'pages/ChannelsManagement.svelte',
  'pages/CustomBot.svelte',
  'pages/CustomFormResponses.svelte',
  'pages/CustomForms.svelte',
  'pages/Economy.svelte',
  'pages/Evaluations.svelte',
  'pages/FormBuilder.svelte',
  'pages/LevelingPublic.svelte',
  'pages/Migration.svelte',
  'pages/NicknameModeration.svelte',
  'pages/NotificationsSettings.svelte',
  'pages/Onboarding.svelte',
  'pages/PartnerPortal.svelte',
  'pages/PartnershipDirectory.svelte',
  'pages/Partnerships.svelte',
  'pages/Profile.svelte',
  'pages/PublicAppeal.svelte',
  'pages/PublicForm.svelte',
  'pages/PublicProfile.svelte',
  'pages/Reputation.svelte',
  'pages/SanctionEvidenceFile.svelte',
  'pages/Schedules.svelte',
  'pages/security/Aegis.svelte',
  'pages/security/AntiRaid.svelte',
  'pages/SecurityAudit.svelte',
  'pages/security/QuickSetup.svelte',
  'pages/ServerFileFilters.svelte',
  'pages/Servers.svelte',
  'pages/Tickets.svelte',
  'pages/Verify.svelte',
];

/**
 * Francais legitime dans un fichier traduit : le nom d'une langue dans cette
 * langue, et un nom de role Discord compare tel quel.
 */
const ALLOWED = new Set(['Français', 'Gérant']);

const ACCENT = /[éèêëàâçùûüôîïœÉÈÊÀÂÇÔÎ]/;

function withoutComments(code: string): string {
  return code
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1')
    // Un journal de console s'adresse au developpeur, pas a l'utilisateur.
    .replace(/\bconsole\.(?:log|info|warn|error|debug)\([^\n]*/g, '');
}

export function hardcodedFrench(code: string): string[] {
  const clean = withoutComments(code);
  const found: string[] = [];
  for (const [, single, double, template] of clean.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const text = single ?? double ?? template ?? '';
    if (ACCENT.test(text) && !ALLOWED.has(text)) found.push(text);
  }
  // Le code du <script> a deja ete lu par ses chaines : seul le balisage reste.
  const markup = clean.replace(/<script[\s\S]*?<\/script>/g, '');
  for (const [, text] of markup.matchAll(/>([^<>{}]+)</g)) {
    if (ACCENT.test(text) && !ALLOWED.has(text.trim())) found.push(text.trim());
  }
  return found;
}

describe('garde-fou des textes francais ecrits en dur', () => {
  test('le reperage trouve attributs, textes et chaines, et ignore les commentaires', () => {
    const sample = [
      '<script>',
      "  // Commentaire accentué ignoré",
      "  const a = 'Paramètres enregistrés.';",
      "  console.error('Échec du chargement :', err);",
      '  const b = m.ok();',
      '</script>',
      '<!-- bloc décrit ici -->',
      '<FormInput placeholder="Sélectionner" label={m.label()} />',
      '<p>Désactive tout</p>',
      '<p>{m.desc()}</p>',
      "<option>Français</option>",
    ].join('\n');
    expect(hardcodedFrench(sample)).toEqual(['Paramètres enregistrés.', 'Sélectionner', 'Désactive tout']);
  });

  for (const file of TRANSLATED) {
    test(`${file} n'affiche aucun texte francais ecrit en dur`, () => {
      expect(hardcodedFrench(readFileSync(join(SRC, file), 'utf-8'))).toEqual([]);
    });
  }
});
