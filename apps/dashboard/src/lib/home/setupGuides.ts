/**
 * Textes et reperes de guidage des etapes du parcours de configuration.
 *
 * L'API nomme chaque etape (« Salon de logs ») ; l'accueil a besoin d'une
 * consigne (« Choisis un salon de logs »), de la raison, et du champ a montrer
 * une fois sur la page. Une etape absente d'ici garde le libelle de l'API et
 * s'ouvre sans mise en evidence : ajouter une etape cote API ne casse rien.
 */
import { router } from 'tinro';
import type { HomeSetupGap } from '@kotbo/contracts';
import { m } from '../i18n';
import { guide } from '../stores/guide.svelte';

type SetupGuide = {
  /** Valeur `data-guide` du champ dans la page de l'etape. */
  target: string;
  title: () => string;
  why: () => string;
  guide: () => string;
};

const SETUP_GUIDES: Record<string, SetupGuide> = {
  logs: {
    target: 'logs-channel',
    title: m.home_step_logs_title,
    why: m.home_step_logs_why,
    guide: m.home_step_logs_guide,
  },
  'moderator-role': {
    target: 'sanctions-moderator-role',
    title: m.home_step_moderator_role_title,
    why: m.home_step_moderator_role_why,
    guide: m.home_step_moderator_role_guide,
  },
  regulation: {
    target: 'regulation-channel',
    title: m.home_step_regulation_title,
    why: m.home_step_regulation_why,
    guide: m.home_step_regulation_guide,
  },
  security: {
    target: 'security-presets',
    title: m.home_step_security_title,
    why: m.home_step_security_why,
    guide: m.home_step_security_guide,
  },
  'sanction-alerts': {
    target: 'sanctions-alert-channel',
    title: m.home_step_sanction_alerts_title,
    why: m.home_step_sanction_alerts_why,
    guide: m.home_step_sanction_alerts_guide,
  },
  tickets: {
    target: 'tickets-channels',
    title: m.home_step_tickets_title,
    why: m.home_step_tickets_why,
    guide: m.home_step_tickets_guide,
  },
  'ticket-quotas': {
    target: 'tickets-quotas',
    title: m.home_step_ticket_quotas_title,
    why: m.home_step_ticket_quotas_why,
    guide: m.home_step_ticket_quotas_guide,
  },
  welcome: {
    target: 'welcome-message',
    title: m.home_step_welcome_title,
    why: m.home_step_welcome_why,
    guide: m.home_step_welcome_guide,
  },
};

/** Etapes sans champ a montrer : seuls leur nom et leur raison sont traduits ici. */
const STEP_TEXTS: Record<string, { title: () => string; why: () => string }> = {
  installed: { title: m.setup_step_installed_title, why: m.setup_step_installed_why },
  timezone: { title: m.setup_step_timezone_title, why: m.setup_step_timezone_why },
};

export function setupStepTitle(gap: Pick<HomeSetupGap, 'key' | 'label'>): string {
  return (SETUP_GUIDES[gap.key] ?? STEP_TEXTS[gap.key])?.title() ?? gap.label;
}

export function setupStepWhy(gap: Pick<HomeSetupGap, 'key' | 'why'>): string | undefined {
  return (SETUP_GUIDES[gap.key] ?? STEP_TEXTS[gap.key])?.why() ?? gap.why;
}

/** Ouvre la page de l'etape et, quand on sait ou, montre le champ. */
export function startSetupGuide(gap: Pick<HomeSetupGap, 'key' | 'label' | 'href'>): void {
  const entry = SETUP_GUIDES[gap.key];
  if (!entry) {
    guide.stop();
    router.goto(gap.href);
    return;
  }
  guide.start({ target: entry.target, href: gap.href, title: entry.title(), body: entry.guide() });
}
