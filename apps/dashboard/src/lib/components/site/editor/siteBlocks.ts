/**
 * Ce que l'éditeur sait insérer : blocs de texte et blocs de modules, avec
 * leurs libellés, icônes et le résumé affiché dans la carte d'un bloc.
 */
import type { Editor, Range } from '@tiptap/core';
import { SITE_MODULES, normalizeModuleConfig, type SiteIconName, type SiteKeyStatItem, type SiteKeyStatMetric, type SiteModuleKey } from '@kotbo/shared';
import { m } from '../../../i18n';
import type { SiteCatalog } from '../../../api/site';
import type { SlashItem } from './slashMenu';

export const MODULE_ICONS: Record<SiteModuleKey, SiteIconName> = {
  staff: 'users',
  rules: 'scroll',
  news: 'newspaper',
  partners: 'handshake',
  serverStats: 'chart',
  keyStats: 'activity',
  appeal: 'gavel',
  recruitment: 'user-plus',
  form: 'clipboard',
  ticket: 'ticket',
  suggestions: 'lightbulb',
  leaderboard: 'trophy',
  clans: 'shield',
  giveaways: 'gift',
  events: 'calendar',
  seasons: 'calendar-range',
  marketplace: 'cart',
  starboard: 'star',
  vote: 'vote',
  voteLeaderboard: 'trophy',
  profile: 'user',
  memberSettings: 'bell',
  memberRewards: 'coins',
  memberInventory: 'package',
  memberPurchases: 'bag',
  shop: 'cart',
  changelog: 'history',
  wikiIndex: 'book',
  blogList: 'pen',
  search: 'search',
  members: 'users-round',
  join: 'login',
  voice: 'volume',
  channelFeed: 'message',
};

export function moduleLabel(key: SiteModuleKey): string {
  const labels: Record<SiteModuleKey, () => string> = {
    staff: () => m.ste_block_staff(),
    rules: () => m.ste_block_rules(),
    news: () => m.ste_block_news(),
    partners: () => m.ste_block_partners(),
    serverStats: () => m.ste_block_serverStats(),
    keyStats: () => m.ste_block_keyStats(),
    appeal: () => m.ste_block_appeal(),
    recruitment: () => m.ste_block_recruitment(),
    form: () => m.ste_block_form(),
    ticket: () => m.ste_block_ticket(),
    suggestions: () => m.ste_block_suggestions(),
    leaderboard: () => m.ste_block_leaderboard(),
    clans: () => m.ste_block_clans(),
    giveaways: () => m.ste_block_giveaways(),
    events: () => m.ste_block_events(),
    seasons: () => m.ste_block_seasons(),
    marketplace: () => m.ste_block_marketplace(),
    starboard: () => m.ste_block_starboard(),
    vote: () => m.ste_block_vote(),
    voteLeaderboard: () => m.ste_block_voteLeaderboard(),
    profile: () => m.ste_block_profile(),
    memberSettings: () => m.ste_block_memberSettings(),
    memberRewards: () => m.ste_block_memberRewards(),
    memberInventory: () => m.ste_block_memberInventory(),
    memberPurchases: () => m.ste_block_memberPurchases(),
    shop: () => m.ste_block_shop(),
    changelog: () => m.ste_block_changelog(),
    wikiIndex: () => m.ste_block_wikiIndex(),
    blogList: () => m.ste_block_blogList(),
    search: () => m.ste_block_search(),
    members: () => m.ste_block_members(),
    join: () => m.ste_block_join(),
    voice: () => m.ste_block_voice(),
    channelFeed: () => m.ste_block_channelFeed(),
  };
  return labels[key]();
}

export function moduleDescription(key: SiteModuleKey): string {
  const descriptions: Record<SiteModuleKey, () => string> = {
    staff: () => m.ste_block_staff_desc(),
    rules: () => m.ste_block_rules_desc(),
    news: () => m.ste_block_news_desc(),
    partners: () => m.ste_block_partners_desc(),
    serverStats: () => m.ste_block_serverStats_desc(),
    keyStats: () => m.ste_block_keyStats_desc(),
    appeal: () => m.ste_block_appeal_desc(),
    recruitment: () => m.ste_block_recruitment_desc(),
    form: () => m.ste_block_form_desc(),
    ticket: () => m.ste_block_ticket_desc(),
    suggestions: () => m.ste_block_suggestions_desc(),
    leaderboard: () => m.ste_block_leaderboard_desc(),
    clans: () => m.ste_block_clans_desc(),
    giveaways: () => m.ste_block_giveaways_desc(),
    events: () => m.ste_block_events_desc(),
    seasons: () => m.ste_block_seasons_desc(),
    marketplace: () => m.ste_block_marketplace_desc(),
    starboard: () => m.ste_block_starboard_desc(),
    vote: () => m.ste_block_vote_desc(),
    voteLeaderboard: () => m.ste_block_voteLeaderboard_desc(),
    profile: () => m.ste_block_profile_desc(),
    memberSettings: () => m.ste_block_memberSettings_desc(),
    memberRewards: () => m.ste_block_memberRewards_desc(),
    memberInventory: () => m.ste_block_memberInventory_desc(),
    memberPurchases: () => m.ste_block_memberPurchases_desc(),
    shop: () => m.ste_block_shop_desc(),
    changelog: () => m.ste_block_changelog_desc(),
    wikiIndex: () => m.ste_block_wikiIndex_desc(),
    blogList: () => m.ste_block_blogList_desc(),
    search: () => m.ste_block_search_desc(),
    members: () => m.ste_block_members_desc(),
    join: () => m.ste_block_join_desc(),
    voice: () => m.ste_block_voice_desc(),
    channelFeed: () => m.ste_block_channelFeed_desc(),
  };
  return descriptions[key]();
}

const CATEGORY_LABELS: Record<string, () => string> = {
  vitrine: () => m.ste_cat_vitrine(),
  demarches: () => m.ste_cat_demarches(),
  engagement: () => m.ste_cat_engagement(),
  membre: () => m.ste_cat_membre(),
  contenus: () => m.ste_cat_contenus(),
  discord: () => m.ste_cat_discord(),
};

/** Résumé d'une configuration, affiché dans la carte du bloc. */
export function moduleSummary(key: SiteModuleKey, raw: Record<string, unknown>, catalog: SiteCatalog | null): string {
  const config = normalizeModuleConfig(key, raw);
  switch (key) {
    case 'leaderboard':
      return m.ste_sum_leaderboard({ variant: leaderboardVariantLabel(String(config.variant)), limit: Number(config.limit) });
    case 'clans':
      return m.ste_sum_clans({ variant: config.variant === 'rpg' ? m.ste_variant_clans_rpg() : m.ste_variant_clans_leveling(), limit: Number(config.limit) });
    case 'news':
    case 'events':
    case 'marketplace':
    case 'voteLeaderboard':
    case 'changelog':
    case 'starboard':
    case 'blogList':
    case 'seasons':
      return m.ste_sum_limit({ limit: Number(config.limit) });
    case 'giveaways':
      return m.ste_sum_giveaways({ limit: Number(config.limit) });
    case 'form': {
      const form = catalog?.forms.find((f) => f.id === config.formId);
      return form ? form.name : m.ste_sum_form_missing();
    }
    case 'recruitment': {
      const ids = (config.formIds as string[]) ?? [];
      return ids.length === 0 ? m.ste_sum_recruitment_all() : m.ste_sum_recruitment_some({ count: ids.length });
    }
    case 'staff': {
      const ids = (config.hierarchyIds as string[]) ?? [];
      const layout = config.layout === 'org' ? m.ste_layout_org() : m.ste_layout_grid();
      return ids.length === 0 ? m.ste_sum_staff_all({ layout }) : m.ste_sum_staff_some({ layout, count: ids.length });
    }
    case 'partners':
      return m.ste_sum_partners({ count: ((config.items as unknown[]) ?? []).length });
    case 'channelFeed': {
      const channel = catalog?.channels.find((c) => c.id === config.channelId);
      return channel ? `#${channel.name}` : m.ste_sum_channel_missing();
    }
    case 'suggestions':
      return m.ste_sum_limit({ limit: Number(config.limit) });
    case 'keyStats': {
      const items = (config.items as SiteKeyStatItem[]) ?? [];
      return items.map((item) => item.label || keyStatLabel(item.metric)).join(' · ') || moduleDescription(key);
    }
    default:
      return moduleDescription(key);
  }
}

/** Nom d'un chiffre du bloc « Chiffres clés ». */
export function keyStatLabel(metric: SiteKeyStatMetric): string {
  const labels: Record<SiteKeyStatMetric, () => string> = {
    members: () => m.ste_metric_members(),
    online: () => m.ste_metric_online(),
    boosts: () => m.ste_metric_boosts(),
    channels: () => m.ste_metric_channels(),
    messages30d: () => m.ste_metric_messages30d(),
    voiceHours30d: () => m.ste_metric_voice_hours30d(),
    joined30d: () => m.ste_metric_joined30d(),
    wikiPages: () => m.ste_metric_wiki_pages(),
    blogArticles: () => m.ste_metric_blog_articles(),
    custom: () => m.ste_metric_custom(),
  };
  return labels[metric]();
}

export function leaderboardVariantLabel(variant: string): string {
  switch (variant) {
    case 'prestige':
      return m.ste_variant_prestige();
    case 'reputation':
      return m.ste_variant_reputation();
    case 'season':
      return m.ste_variant_season();
    case 'economy':
      return m.ste_variant_economy();
    default:
      return m.ste_variant_xp();
  }
}

function setBlock(type: string, attrs?: Record<string, unknown>) {
  return (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range).setNode(type, attrs).run();
}

function insert(content: Record<string, unknown> | Record<string, unknown>[]) {
  return (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range).insertContent(content).run();
}

const emptyParagraph = { type: 'paragraph' };
const cell = (span = 1) => ({ type: 'gridCell', attrs: { span, rowSpan: 1, surface: true }, content: [emptyParagraph] });
const heading = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const testimonial = () => ({ type: 'testimonial', attrs: { name: '', role: '', avatar: '' }, content: [emptyParagraph] });

export interface SlashContext {
  catalog: SiteCatalog | null;
  /** Ouvre le sélecteur d'image (téléversement ou bibliothèque). */
  pickImage: (insertAt: (src: string) => void) => void;
  /** Demande l'adresse d'une vidéo, puis l'insère. */
  pickVideo: (insert: (attrs: { provider: string; videoId: string; caption: string }) => void) => void;
  /** Ouvre la configuration d'un nœud fraîchement inséré. */
  configureAt: (type: string, pos: number, attrs: Record<string, unknown>) => void;
}

/** Tous les éléments du menu « / ». */
export function buildSlashItems(context: SlashContext): SlashItem[] {
  const text = m.ste_group_text();
  const layout = m.ste_group_layout();
  const media = m.ste_group_media();
  const sections = m.ste_group_sections();
  const items: SlashItem[] = [
    { id: 'p', group: text, label: m.ste_item_paragraph(), description: m.ste_item_paragraph_desc(), icon: 'pilcrow', keywords: 'texte text', run: setBlock('paragraph') },
    { id: 'h1', group: text, label: m.ste_item_h1(), description: m.ste_item_heading_desc(), icon: 'h1', keywords: 'titre heading', run: setBlock('heading', { level: 1 }) },
    { id: 'h2', group: text, label: m.ste_item_h2(), description: m.ste_item_heading_desc(), icon: 'h2', keywords: 'titre heading', run: setBlock('heading', { level: 2 }) },
    { id: 'h3', group: text, label: m.ste_item_h3(), description: m.ste_item_heading_desc(), icon: 'h3', keywords: 'titre heading', run: setBlock('heading', { level: 3 }) },
    { id: 'ul', group: text, label: m.ste_item_bullets(), description: m.ste_item_bullets_desc(), icon: 'list', keywords: 'liste list', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { id: 'ol', group: text, label: m.ste_item_numbers(), description: m.ste_item_numbers_desc(), icon: 'list-ordered', keywords: 'liste list', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { id: 'todo', group: text, label: m.ste_item_tasks(), description: m.ste_item_tasks_desc(), icon: 'list-checks', keywords: 'tâches tasks checklist', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { id: 'quote', group: text, label: m.ste_item_quote(), description: m.ste_item_quote_desc(), icon: 'quote', keywords: 'citation quote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { id: 'code', group: text, label: m.ste_item_code(), description: m.ste_item_code_desc(), icon: 'code', keywords: 'code', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { id: 'callout', group: layout, label: m.ste_item_callout(), description: m.ste_item_callout_desc(), icon: 'info', keywords: 'encadré note info alerte', run: insert({ type: 'callout', attrs: { variant: 'info', icon: '' }, content: [emptyParagraph] }) },
    { id: 'grid2', group: layout, label: m.ste_item_grid({ count: 2 }), description: m.ste_item_grid_desc(), icon: 'columns2', keywords: 'bento grille colonnes', run: insert({ type: 'grid', attrs: { columns: 2 }, content: [cell(), cell()] }) },
    { id: 'grid3', group: layout, label: m.ste_item_grid({ count: 3 }), description: m.ste_item_grid_desc(), icon: 'columns3', keywords: 'bento grille colonnes', run: insert({ type: 'grid', attrs: { columns: 3 }, content: [cell(), cell(), cell()] }) },
    { id: 'bento', group: layout, label: m.ste_item_bento(), description: m.ste_item_bento_desc(), icon: 'grid', keywords: 'bento grille', run: insert({ type: 'grid', attrs: { columns: 3 }, content: [cell(2), cell(1), cell(1), cell(2)] }) },
    { id: 'hr', group: layout, label: m.ste_item_divider(), description: m.ste_item_divider_desc(), icon: 'minus', keywords: 'séparateur divider', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { id: 'table', group: layout, label: m.ste_item_table(), description: m.ste_item_table_desc(), icon: 'table', keywords: 'tableau table', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'faq', group: layout, label: m.ste_item_faq(), description: m.ste_item_faq_desc(), icon: 'help', keywords: 'faq questions', run: insert({ type: 'faq', content: [{ type: 'faqItem', attrs: { question: '' }, content: [emptyParagraph] }] }) },
    {
      id: 'button',
      group: layout,
      label: m.ste_item_button(),
      description: m.ste_item_button_desc(),
      icon: 'pointer',
      keywords: 'bouton lien cta',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).insertContent({ type: 'button', attrs: { label: m.ste_button_default(), href: '/~/', variant: 'primary', align: 'left' } }).run();
        const pos = e.state.selection.from - 1;
        context.configureAt('button', Math.max(0, pos), { label: m.ste_button_default(), href: '/~/', variant: 'primary', align: 'left' });
      },
    },
    {
      id: 'banner',
      group: sections,
      label: m.ste_item_banner(),
      description: m.ste_item_banner_desc(),
      icon: 'flame',
      keywords: 'bannière banner hero appel cta section',
      run: insert({
        type: 'banner',
        attrs: { image: '', tone: 'accent', align: 'center', tall: false },
        content: [heading(2, m.ste_banner_title()), { type: 'paragraph', content: [{ type: 'text', text: m.ste_banner_text() }] }, { type: 'button', attrs: { label: m.ste_button_default(), href: '/~/', variant: 'primary', align: 'center' } }],
      }),
    },
    {
      id: 'testimonials',
      group: sections,
      label: m.ste_item_testimonials(),
      description: m.ste_item_testimonials_desc(),
      icon: 'message-circle',
      keywords: 'témoignages avis testimonials reviews section',
      run: insert({ type: 'testimonials', attrs: { columns: 3 }, content: [testimonial(), testimonial(), testimonial()] }),
    },
    {
      id: 'gallery',
      group: sections,
      label: m.ste_item_gallery(),
      description: m.ste_item_gallery_desc(),
      icon: 'layers',
      keywords: 'galerie images photos carrousel gallery section',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).insertContent({ type: 'gallery', attrs: { images: [], layout: 'grid', columns: 3 } }).run();
        const pos = e.state.selection.from - 1;
        context.configureAt('gallery', Math.max(0, pos), { images: [], layout: 'grid', columns: 3 });
      },
    },
    { id: 'toc', group: layout, label: m.ste_item_toc(), description: m.ste_item_toc_desc(), icon: 'toc', keywords: 'sommaire toc', run: insert({ type: 'toc', attrs: { maxLevel: 3 } }) },
    {
      id: 'image',
      group: media,
      label: m.ste_item_image(),
      description: m.ste_item_image_desc(),
      icon: 'image',
      keywords: 'image photo',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        context.pickImage((src) => e.chain().focus().insertContent({ type: 'image', attrs: { src, alt: '', caption: '', width: 'wide' } }).run());
      },
    },
    {
      id: 'video',
      group: media,
      label: m.ste_item_video(),
      description: m.ste_item_video_desc(),
      icon: 'play',
      keywords: 'vidéo bande-annonce trailer youtube twitch vimeo',
      run: (e, r) => {
        e.chain().focus().deleteRange(r).run();
        context.pickVideo((attrs) => e.chain().focus().insertContent({ type: 'video', attrs }).run());
      },
    },
  ];

  const available = new Map((context.catalog?.blocks ?? []).map((b) => [b.key, b.available]));
  for (const key of Object.keys(SITE_MODULES) as SiteModuleKey[]) {
    const spec = SITE_MODULES[key];
    items.push({
      id: `module:${key}`,
      group: CATEGORY_LABELS[spec.category]?.() ?? spec.category,
      label: moduleLabel(key),
      description: available.get(key) === false ? m.ste_block_unavailable() : moduleDescription(key),
      icon: MODULE_ICONS[key],
      keywords: `${key} module`,
      run: (e, r) => {
        const config = normalizeModuleConfig(key, spec.defaults);
        e.chain().focus().deleteRange(r).insertContent({ type: 'module', attrs: { module: key, config } }).run();
        // Les blocs qui n'ont pas de sens sans réglage s'ouvrent tout de suite.
        if (['form', 'channelFeed', 'partners', 'keyStats'].includes(key)) {
          const pos = e.state.selection.from - 1;
          context.configureAt('module', Math.max(0, pos), { module: key, config });
        }
      },
    });
  }
  return items;
}
