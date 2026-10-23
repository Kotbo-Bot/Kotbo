<!--
  Langue du bot et fuseau horaire du serveur.

  Les deux reglages vivaient en widgets de l'accueil, et le fuseau n'etait
  modifiable nulle part ailleurs une fois la prise en main finie : qui avait
  retire le widget ne pouvait plus le changer. Ce bloc les rend a la page des
  reglages du serveur ; l'accueil le reutilise pour qui garde les widgets.

  `only` restreint le bloc a un seul des deux reglages (un widget = un
  reglage), `stacked` passe le controle sous le libelle pour les colonnes
  etroites.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { authStore } from '../stores/auth.svelte';
  import { navigationStore } from '../stores/navigation.svelte';
  import { timezoneStore } from '../stores/timezone.svelte';
  import { toast } from '../stores/toast.svelte';
  import {
    fetchGuildLanguage,
    updateGuildLanguage,
    fetchGuildTimezone,
    updateGuildTimezone,
    type GuildLanguageState,
    type GuildTimezoneState,
  } from '../api';
  import { m, dateLocale } from '../i18n';
  import SettingsGroup from './management/SettingsGroup.svelte';
  import SettingsRow from './management/SettingsRow.svelte';
  import { Button } from './ui';

  const {
    only = 'both',
    stacked = false,
    /** Sans titre ni description : le widget de l'accueil porte deja le sien. */
    bare = false,
  }: { only?: 'both' | 'language' | 'timezone'; stacked?: boolean; bare?: boolean } = $props();

  const showLanguage = $derived(only !== 'timezone');
  const showTimezone = $derived(only !== 'language');
  const uid = $props.id();

  let language = $state<GuildLanguageState | null>(null);
  let timezone = $state<GuildTimezoneState | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let savingLanguage = $state(false);
  let savingTimezone = $state(false);
  let loadedGuildId: string | null = null;

  // L'apercu de l'heure n'affiche que les minutes : un reveil toutes les
  // trente secondes suffit a ne jamais montrer une heure en retard.
  let now = $state(Date.now());
  const clock = setInterval(() => (now = Date.now()), 30_000);
  onDestroy(() => clearInterval(clock));

  async function load(force = false) {
    const guildId = authStore.selectedGuildId;
    if (!guildId || loading || (!force && loadedGuildId === guildId)) return;
    loading = true;
    failed = false;
    try {
      const [lang, zone] = await Promise.all([
        showLanguage ? fetchGuildLanguage() : Promise.resolve(null),
        showTimezone ? fetchGuildTimezone() : Promise.resolve(null),
      ]);
      if (authStore.selectedGuildId !== guildId) return;
      language = lang;
      timezone = zone;
      failed = (showLanguage && !lang) || (showTimezone && !zone);
      loadedGuildId = guildId;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (navigationStore.isAdmin && authStore.selectedGuildId) void load();
  });

  const languageLabel = (code: 'fr' | 'en') =>
    code === 'fr' ? m.home_botlanguage_fr() : m.home_botlanguage_en();

  /** « auto » ou le code de la langue choisie a la main. */
  const languageChoice = $derived(language ? (language.mode === 'auto' ? 'auto' : language.locale) : 'auto');

  const languageDescription = $derived.by(() => {
    if (!language) return '';
    if (language.mode === 'manual') return m.server_locale_language_manual_desc();
    return language.detected
      ? m.server_locale_language_auto_desc({ lang: languageLabel(language.detected) })
      : m.server_locale_language_auto_none_desc();
  });

  async function changeLanguage(value: string) {
    if (savingLanguage || !language || value === languageChoice) return;
    savingLanguage = true;
    try {
      const state = await updateGuildLanguage(value === 'auto' ? { mode: 'auto' } : { language: value as 'fr' | 'en' });
      if (!state) return;
      language = state;
      // Changer de langue republie les panneaux deja poses (reglement,
      // tickets, roles-reaction) : le taire laisserait croire qu'ils sont
      // restes dans l'ancienne langue, ou qu'ils ont tous suivi alors que non.
      const failedCount = state.rerender?.failed ?? 0;
      const updatedCount = state.rerender?.updated ?? 0;
      if (failedCount > 0) {
        toast.error(failedCount === 1 ? m.server_locale_panels_failed_one() : m.server_locale_panels_failed({ n: failedCount }));
      } else if (updatedCount > 0) {
        toast.success(updatedCount === 1 ? m.server_locale_panels_updated_one() : m.server_locale_panels_updated({ n: updatedCount }));
      } else {
        toast.success(m.server_locale_language_saved());
      }
    } catch {
      // dashboardRequest a deja notifie l'echec.
    } finally {
      savingLanguage = false;
    }
  }

  async function changeTimezone(value: string) {
    if (savingTimezone || !timezone || value === timezone.timezone) return;
    savingTimezone = true;
    try {
      const state = await updateGuildTimezone(value);
      if (state) {
        timezone = state;
        // Le store partage sert aux formulaires de date ailleurs : sans cette
        // synchro, Reunions et Planning saisiraient dans l'ancien fuseau
        // jusqu'au prochain rechargement.
        timezoneStore.apply(state.timezone);
      }
    } catch {
      // dashboardRequest a deja notifie l'echec.
    } finally {
      savingTimezone = false;
    }
  }

  const timePreview = $derived.by(() => {
    if (!timezone) return '';
    try {
      return new Intl.DateTimeFormat(dateLocale(), { timeZone: timezone.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(now));
    } catch {
      return '';
    }
  });
</script>

{#snippet rows()}
  {#if loading && !language && !timezone}
    <div class="p-4 space-y-3" aria-busy="true">
      {#if showLanguage}<div class="h-9 rounded-lg bg-surface-container-high animate-pulse"></div>{/if}
      {#if showTimezone}<div class="h-9 rounded-lg bg-surface-container-high animate-pulse"></div>{/if}
    </div>
  {:else if failed && !language && !timezone}
    <div class="p-4 flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-on-surface-variant">{m.server_locale_error()}</p>
      <Button size="sm" variant="ghost" icon="refresh-cw" onclick={() => load(true)}>{m.common_retry()}</Button>
    </div>
  {:else}
    {#if showLanguage && language}
      <SettingsRow label={m.home_botlanguage()} description={languageDescription} labelFor="{uid}-language" {stacked}>
        <select
          id="{uid}-language"
          class="input {stacked ? '' : 'md:w-64!'}"
          value={languageChoice}
          disabled={savingLanguage}
          onchange={(e) => changeLanguage(e.currentTarget.value)}
        >
          <option value="auto">
            {language.detected
              ? m.server_locale_option_auto({ lang: languageLabel(language.detected) })
              : m.server_locale_option_auto_plain()}
          </option>
          {#each language.available as code (code)}
            <option value={code}>{languageLabel(code)}</option>
          {/each}
        </select>
      </SettingsRow>
    {/if}
    {#if showTimezone && timezone}
      <SettingsRow
        label={m.home_timezone()}
        description={timePreview ? m.server_locale_timezone_desc({ time: timePreview }) : m.home_timezone_hint()}
        labelFor="{uid}-timezone"
        {stacked}
      >
        <select
          id="{uid}-timezone"
          class="input {stacked ? '' : 'md:w-64!'}"
          value={timezone.timezone}
          disabled={savingTimezone}
          onchange={(e) => changeTimezone(e.currentTarget.value)}
        >
          {#each timezone.available as zone (zone)}
            <option value={zone}>{zone.replace(/_/g, ' ')}</option>
          {/each}
        </select>
      </SettingsRow>
    {/if}
  {/if}
{/snippet}

{#if navigationStore.isAdmin}
  {#if bare}
    <div class="-mx-4 divide-y divide-outline-variant/40">
      {@render rows()}
    </div>
  {:else}
    <SettingsGroup title={m.server_locale_title()} description={m.server_locale_desc()}>
      <div class="rounded-xl border border-outline-variant/40 divide-y divide-outline-variant/40 bg-surface-container-high/10">
        {@render rows()}
      </div>
    </SettingsGroup>
  {/if}
{/if}
