/**
 * Catalogue « + Ajouter » : sections prêtes à poser, façon constructeur de
 * site. Chacune a une vignette schématique (colonnes et ce qu'elles
 * contiennent) et fabrique une section au format du site, textes d'exemple
 * compris. Les blocs de modules gardent leur configuration par défaut.
 */
import type { JSONContent } from '@tiptap/core';
import { SITE_SECTION_DEFAULTS, normalizeModuleConfig, type SiteModuleKey, type SiteSectionAttrs } from '@kotbo/shared';
import { m } from '../../../i18n';

export type PresetCategory = 'hero' | 'content' | 'community' | 'action' | 'social' | 'blank';

/** Ce qu'une vignette dessine dans chaque colonne. */
export type ThumbPart = 'title' | 'text' | 'button' | 'media' | 'cards' | 'list';

export interface SectionPreset {
  id: string;
  category: PresetCategory;
  label: () => string;
  thumb: { background: SiteSectionAttrs['background']; columns: ThumbPart[][]; weights?: number[]; centered?: boolean };
  /** Le bloc de module dont dépend la section : grisée si le module est fermé. */
  module?: SiteModuleKey;
  build: (ctx: { siteName: string }) => JSONContent;
}

const text = (value: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
const centered = (value: string): JSONContent => ({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: value }] });
const heading = (level: number, value: string, align?: 'center'): JSONContent => ({
  type: 'heading',
  attrs: { level, ...(align ? { textAlign: align } : {}) },
  content: [{ type: 'text', text: value }],
});
const mod = (key: SiteModuleKey, config: Record<string, unknown> = {}): JSONContent => ({ type: 'module', attrs: { module: key, config: normalizeModuleConfig(key, config) } });
const button = (label: string, href: string, variant = 'primary', align = 'left'): JSONContent => ({ type: 'button', attrs: { label, href, variant, align } });

function section(attrs: Partial<SiteSectionAttrs>, columns: JSONContent[][]): JSONContent {
  return {
    type: 'section',
    attrs: { ...SITE_SECTION_DEFAULTS, ...attrs },
    content: columns.map((content) => ({ type: 'column', content: content.length > 0 ? content : [{ type: 'paragraph' }] })),
  };
}

export const SECTION_PRESETS: SectionPreset[] = [
  {
    id: 'hero-center',
    category: 'hero',
    label: () => m.ste_pre_hero_center(),
    thumb: { background: 'gradient', columns: [['title', 'text', 'button']], centered: true },
    module: 'join',
    build: ({ siteName }) =>
      section({ background: 'gradient', bgGradient: 'night', padding: 'large', width: 'full', height: 'tall', align: 'center', animation: 'fade' }, [
        [heading(1, m.ste_pre_hero_title({ name: siteName }), 'center'), centered(m.ste_pre_hero_text()), mod('join')],
      ]),
  },
  {
    id: 'hero-split',
    category: 'hero',
    label: () => m.ste_pre_hero_split(),
    thumb: { background: 'dark', columns: [['title', 'text', 'button'], ['cards']] },
    module: 'pulse',
    build: ({ siteName }) =>
      section({ background: 'dark', padding: 'large', width: 'full', layout: '1-1', align: 'center', animation: 'slide-up' }, [
        [heading(1, m.ste_pre_hero_title({ name: siteName })), text(m.ste_pre_hero_text()), mod('join')],
        [mod('pulse')],
      ]),
  },
  {
    id: 'hero-image',
    category: 'hero',
    label: () => m.ste_pre_hero_image(),
    thumb: { background: 'image', columns: [['title', 'text', 'button']] },
    build: ({ siteName }) =>
      section({ background: 'gradient', bgGradient: 'aurora', padding: 'large', width: 'full', height: 'screen', align: 'center', animation: 'zoom' }, [
        [heading(1, m.ste_pre_hero_title({ name: siteName })), text(m.ste_pre_hero_text()), button(m.ste_pre_discover(), '#decouvrir')],
      ]),
  },
  {
    id: 'features-3',
    category: 'content',
    label: () => m.ste_pre_features(),
    thumb: { background: 'none', columns: [['title', 'text'], ['title', 'text'], ['title', 'text']] },
    build: () =>
      section({ layout: '1-1-1', anchor: 'decouvrir', animation: 'slide-up' }, [
        [heading(3, m.ste_pre_feature_1()), text(m.ste_pre_feature_text())],
        [heading(3, m.ste_pre_feature_2()), text(m.ste_pre_feature_text())],
        [heading(3, m.ste_pre_feature_3()), text(m.ste_pre_feature_text())],
      ]),
  },
  {
    id: 'text-media',
    category: 'content',
    label: () => m.ste_pre_text_media(),
    thumb: { background: 'none', columns: [['title', 'text', 'button'], ['media']] },
    build: () =>
      section({ layout: '1-1', align: 'center' }, [
        [heading(2, m.ste_pre_about_title()), text(m.ste_pre_about_text()), button(m.ste_pre_read_rules(), '/~/wiki', 'secondary')],
        [mod('keyStats')],
      ]),
  },
  {
    id: 'title',
    category: 'content',
    label: () => m.ste_pre_title(),
    thumb: { background: 'none', columns: [['title', 'text']], centered: true },
    build: () => section({ padding: 'small' }, [[heading(2, m.ste_pre_title_text(), 'center'), centered(m.ste_pre_title_sub())]]),
  },
  {
    id: 'faq',
    category: 'content',
    label: () => m.ste_pre_faq(),
    thumb: { background: 'none', columns: [['title', 'text'], ['list']], weights: [1, 2] },
    build: () =>
      section({ layout: '1-2' }, [
        [heading(2, m.ste_pre_faq_title()), text(m.ste_pre_faq_text())],
        [
          {
            type: 'faq',
            content: [1, 2, 3].map(() => ({ type: 'faqItem', attrs: { question: m.ste_pre_faq_question() }, content: [text(m.ste_pre_faq_answer())] })),
          },
        ],
      ]),
  },
  {
    id: 'stats',
    category: 'community',
    label: () => m.ste_pre_stats(),
    thumb: { background: 'surface', columns: [['cards']] },
    module: 'keyStats',
    build: () => section({ background: 'surface', width: 'full' }, [[heading(2, m.ste_pre_stats_title(), 'center'), mod('keyStats')]]),
  },
  {
    id: 'team',
    category: 'community',
    label: () => m.ste_pre_team(),
    thumb: { background: 'none', columns: [['title', 'cards']] },
    module: 'staff',
    build: () => section({ anchor: 'equipe' }, [[heading(2, m.ste_pre_team_title()), mod('staff')]]),
  },
  {
    id: 'live',
    category: 'community',
    label: () => m.ste_pre_live(),
    thumb: { background: 'none', columns: [['title', 'cards'], ['title', 'list']] },
    module: 'members',
    build: () =>
      section({ layout: '1-1' }, [
        [heading(2, m.ste_pre_live_members()), mod('members')],
        [heading(2, m.ste_pre_live_voice()), mod('voice')],
      ]),
  },
  {
    id: 'events',
    category: 'community',
    label: () => m.ste_pre_events(),
    thumb: { background: 'none', columns: [['title', 'list'], ['title', 'cards']], weights: [2, 1] },
    module: 'events',
    build: () =>
      section({ layout: '2-1' }, [
        [heading(2, m.ste_pre_events_title()), mod('events')],
        [heading(3, m.ste_pre_giveaways_title()), mod('giveaways')],
      ]),
  },
  {
    id: 'news',
    category: 'community',
    label: () => m.ste_pre_news(),
    thumb: { background: 'none', columns: [['title', 'cards']] },
    module: 'blogList',
    build: () => section({}, [[heading(2, m.ste_pre_news_title()), mod('blogList')]]),
  },
  {
    id: 'cta',
    category: 'action',
    label: () => m.ste_pre_cta(),
    thumb: { background: 'accent', columns: [['title', 'text', 'button']], centered: true },
    module: 'join',
    build: () =>
      section({ background: 'accent', width: 'full', align: 'center', animation: 'fade', anchor: 'rejoindre' }, [
        [heading(2, m.ste_pre_cta_title(), 'center'), centered(m.ste_pre_cta_text()), mod('join')],
      ]),
  },
  {
    id: 'recruit',
    category: 'action',
    label: () => m.ste_pre_recruit(),
    thumb: { background: 'dark', columns: [['title', 'text'], ['list']] },
    module: 'recruitment',
    build: () =>
      section({ background: 'dark', layout: '1-1' }, [
        [heading(2, m.ste_pre_recruit_title()), text(m.ste_pre_recruit_text())],
        [mod('recruitment')],
      ]),
  },
  {
    id: 'support',
    category: 'action',
    label: () => m.ste_pre_support(),
    thumb: { background: 'surface', columns: [['title', 'text'], ['list']] },
    module: 'ticket',
    build: () =>
      section({ background: 'surface', layout: '1-1' }, [
        [heading(2, m.ste_pre_support_title()), text(m.ste_pre_support_text())],
        [mod('ticket')],
      ]),
  },
  {
    id: 'testimonials',
    category: 'social',
    label: () => m.ste_pre_testimonials(),
    thumb: { background: 'none', columns: [['cards'], ['cards'], ['cards']] },
    build: () =>
      section({}, [
        [
          heading(2, m.ste_pre_testimonials_title(), 'center'),
          {
            type: 'testimonials',
            attrs: { columns: 3 },
            content: [1, 2, 3].map(() => ({ type: 'testimonial', attrs: { name: m.ste_pre_testimonial_name(), role: '', avatar: '' }, content: [text(m.ste_pre_testimonial_text())] })),
          },
        ],
      ]),
  },
  {
    id: 'rules',
    category: 'social',
    label: () => m.ste_pre_rules(),
    thumb: { background: 'none', columns: [['title', 'list']] },
    module: 'rules',
    build: () => section({ anchor: 'reglement' }, [[heading(2, m.ste_pre_rules_title()), mod('rules')]]),
  },
  ...(['1', '1-1', '1-1-1', '2-1'] as const).map(
    (layout): SectionPreset => ({
      id: `blank-${layout}`,
      category: 'blank',
      label: () => m.ste_pre_blank({ count: layout.split('-').length }),
      thumb: { background: 'none', columns: layout.split('-').map(() => []), weights: layout.split('-').map(Number) },
      build: () => section({ layout }, layout.split('-').map(() => [])),
    }),
  ),
];

export const PRESET_CATEGORIES: Array<[PresetCategory, () => string]> = [
  ['hero', () => m.ste_pre_cat_hero()],
  ['content', () => m.ste_pre_cat_content()],
  ['community', () => m.ste_pre_cat_community()],
  ['action', () => m.ste_pre_cat_action()],
  ['social', () => m.ste_pre_cat_social()],
  ['blank', () => m.ste_pre_cat_blank()],
];
