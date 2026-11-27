<script lang="ts">
  import { router } from 'tinro';
  import Papicon from './Papicon.svelte';
  import { buildCrumbs } from '../breadcrumbs';
  import { m } from '../i18n';
  import { guardedLinkClick } from '../navigationGuard';

  const crumbs = $derived(buildCrumbs($router.path));
  const parent = $derived(crumbs.length > 2 ? crumbs[crumbs.length - 2] : null);
</script>

{#if parent}
  {@const parentHref = parent.href}
  <nav class="breadcrumbs mb-4 select-none" aria-label={m.a11y_breadcrumbs()}>
    <a
      href={parentHref}
      onclick={(e) => guardedLinkClick(e, parentHref)}
      class="inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded-md text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
    >
      <Papicon icon="chevron-left" size={14} />
      {m.nav_back_to({ page: parent.name })}
    </a>
  </nav>
{/if}
