<script lang="ts">
  import type { Snippet } from 'svelte';
  import { DetailSheet as KotboDetailSheet, type TabItem } from '@kotbo/ui';

  const {
    open,
    onClose,
    icon,
    title,
    subtitle = '',
    bannerUrl = null,
    leading,
    badges,
    titleMeta,
    actions,
    tabs = [],
    active = '',
    activeTab,
    onchange = () => {},
    onTabChange,
    tabsLabel = '',
    children,
  }: {
    open: boolean;
    onClose: () => void;
    icon?: string;
    title: string;
    subtitle?: string | Snippet;
    bannerUrl?: string | null;
    leading?: Snippet;
    badges?: Snippet;
    titleMeta?: Snippet;
    actions?: Snippet;
    tabs?: TabItem[];
    active?: string;
    activeTab?: string;
    onchange?: (id: string) => void;
    onTabChange?: (id: string) => void;
    tabsLabel?: string;
    children: Snippet;
  } = $props();
</script>

<KotboDetailSheet
  {open}
  {onClose}
  {icon}
  {title}
  {subtitle}
  {bannerUrl}
  {leading}
  {badges}
  {titleMeta}
  {actions}
  {tabs}
  {active}
  {activeTab}
  {onchange}
  {onTabChange}
  {tabsLabel}
  {children}
/>
