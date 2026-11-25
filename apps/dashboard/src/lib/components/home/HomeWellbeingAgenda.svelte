<!--
  « Mes échéances » de la cellule bien-être, en tête de l'accueil : suivis et
  tâches des 7 prochains jours de la personne connectée. Aucun titre ni
  contenu de dossier : seulement la date et un lien qui ouvre le dossier sur
  la page Bien-être (avec ses propres contrôles d'accès). Rien ne s'affiche
  hors de la cellule, ni sans échéance.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { dashboardFetch } from '../../api';
  import { canViewFeature } from '../../permissions.svelte';
  import { dateLocale, m } from '../../i18n';
  import Papicon from '../Papicon.svelte';

  type AgendaItem = { caseId: string; kind: 'review' | 'task'; dueAt: string; overdue: boolean };

  let items = $state<AgendaItem[]>([]);

  onMount(async () => {
    if (!canViewFeature('wellbeing')) return;
    const res = await dashboardFetch('/wellbeing/agenda').catch(() => null);
    if (res?.ok) items = (await res.json()).items ?? [];
  });

  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
</script>

{#if items.length > 0}
  <section class="section-card p-5 space-y-3" aria-labelledby="home-wellbeing-agenda">
    <h2 id="home-wellbeing-agenda" class="text-base font-semibold flex items-center gap-2">
      <Papicon icon="shield" size={16} /> {m.wb_agenda_title({ count: items.length })}
    </h2>
    <ul class="space-y-1.5">
      {#each items as item, index (`${item.caseId}-${item.kind}-${index}`)}
        <li>
          <button
            type="button"
            onclick={() => router.goto(`/wellbeing?case=${encodeURIComponent(item.caseId)}`)}
            class="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-left bg-surface-container-high/20 hover:bg-surface-container-high/40 transition-colors"
          >
            <span class="flex items-center gap-2 text-on-surface">
              <Papicon icon={item.kind === 'task' ? 'CheckSquare' : 'Clock'} size={14} />
              {item.kind === 'task' ? m.wb_agenda_task() : m.wb_agenda_review()}
            </span>
            <span class="text-xs {item.overdue ? 'text-on-error-container font-semibold' : 'text-on-surface-variant'}">
              {item.overdue ? m.wb_agenda_overdue({ date: formatDay(item.dueAt) }) : formatDay(item.dueAt)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
    <p class="text-2xs text-on-surface-variant">{m.wb_agenda_privacy()}</p>
  </section>
{/if}
