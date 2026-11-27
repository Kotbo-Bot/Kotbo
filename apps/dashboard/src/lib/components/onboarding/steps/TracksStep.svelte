<script lang="ts">
  /**
   * Le premier ecran : Kotbo est arrive, et il n'y a qu'une decision a prendre.
   *
   * Trois ecrans precedaient la premiere action utile (bienvenue, neuf ou
   * existant, langue). Leurs reponses sont presque toujours celles que Kotbo
   * devine : elles tiennent ici, pre-remplies. Reste le choix : l'installation
   * express (structure, moderation equilibree, accueil) ou la selection des
   * sujets, repliee par defaut.
   *
   * La langue s'enregistre avant de continuer, parce que la maquette nomme ses
   * salons dans la langue du serveur.
   *
   * Sur un serveur deja en place, l'ecran se joue en deux temps : le serveur
   * (`kind`), puis la reprise, puis le choix (`tracks`). Elle est imposee avant
   * le menu des modules : proposer de tout monter sans avoir regarde ce qui
   * existe serait la meilleure facon de le doubler.
   */
  import { m } from '../../../i18n';
  import { onMount } from 'svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { authStore } from '../../../stores/auth.svelte';
  import { botLocale } from '../../../stores/botLocale.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import {
    TRACKS,
    TRACK_GROUPS,
    COMMON_TIMEZONES,
    defaultTracks,
    estimatedMinutes,
    stepsOfTrack,
    celebrateStep,
    type ServerKind,
    type TrackKey,
  } from '../../../onboarding';
  import {
    ADMIN_INVITE_PERMISSIONS,
    buildBotInviteUrl,
    fetchDiscordClientId,
    fetchGuildLanguage,
    fetchGuildTimezone,
    updateGuildLanguage,
    updateGuildTimezone,
  } from '../../../api';
  import { errorMessage } from '@kotbo/shared';
  import { Button, Callout, ListGroup, ListRow, Segmented } from '../../ui';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import ToggleCard from '../ToggleCard.svelte';
  import WizardShell from '../WizardShell.svelte';

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );
  const template = $derived(onboardingData.template);
  const isAdministrator = $derived(template?.isAdministrator ?? true);

  const suggested = $derived<ServerKind>(
    template?.maturity.maturity === 'established' ? 'existing' : 'new'
  );
  const kind = $derived<ServerKind>(wizard.kind ?? suggested);

  // Tant que rien n'a ete valide, ce sont les suggestions tirees de l'etat du
  // serveur : un serveur habite n'a pas les memes cases cochees qu'un serveur
  // cree ce matin.
  let picked = $state<TrackKey[] | null>(null);
  const selection = $derived(picked ?? wizard.tracks);

  function toggle(key: TrackKey) {
    const current = selection;
    picked = current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key];
  }

  const minutes = $derived(estimatedMinutes(selection));
  const screens = $derived(
    selection.reduce((total, key) => total + screensOf(key), 0)
  );

  function screensOf(key: TrackKey): number {
    return stepsOfTrack(key, kind, { structured: wizard.structured }).length;
  }

  /** La grille reste repliee tant qu'on n'a pas demande a choisir. */
  let choosing = $state(wizard.isDone('tracks') && !wizard.express);

  let language = $state<'fr' | 'en'>('fr');
  let timezone = $state('Europe/Paris');
  /** Ce qui etait en vigueur : rien n'est reecrit si rien ne bouge. */
  let saved = { language: null as 'fr' | 'en' | null, timezone: null as string | null };
  let clientId = $state('');
  let refreshingPerms = $state(false);

  onMount(async () => {
    const [lang, zone, id] = await Promise.all([
      fetchGuildLanguage().catch(() => null),
      fetchGuildTimezone().catch(() => null),
      fetchDiscordClientId().catch(() => ''),
    ]);
    if (lang?.locale) { language = lang.locale; saved.language = lang.locale; }
    if (zone?.timezone) { timezone = zone.timezone; saved.timezone = zone.timezone; }
    clientId = id;
  });

  const onServer = $derived(wizard.step === 'kind');
  /** Un serveur neuf repond aux deux questions sur le meme ecran. */
  const showServer = $derived(onServer || kind === 'new');

  function chooseKind(next: ServerKind) {
    wizard.answer({ kind: next });
    // Lancee des le clic : l'attente tombe pendant qu'on lit.
    if (next === 'existing') void onboardingData.loadMigration();
    wizard.goto(next === 'existing' ? 'kind' : 'tracks');
  }

  /** La maquette est nommee dans la langue du serveur : elle s'ecrit avant la suite. */
  async function saveServer() {
    if (saved.language !== null && language !== saved.language) {
      await updateGuildLanguage({ language }, undefined, { silent: true });
      saved.language = language;
      botLocale.set(language);
      await onboardingData.refreshTemplate();
    }
    if (saved.timezone !== null && timezone !== saved.timezone) {
      await updateGuildTimezone(timezone, undefined, { silent: true });
      saved.timezone = timezone;
    }
  }

  async function continueToTakeover() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await saveServer();
      wizard.answer({ kind: 'existing' });
      celebrateStep();
      wizard.complete('kind');
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_identity_save_failed());
    } finally {
      onboardingData.busy = false;
    }
  }

  async function refreshPermissions() {
    refreshingPerms = true;
    try {
      await onboardingData.loadCore();
      toast.success(m.obx_wc_perms_refreshed());
    } catch {
      toast.error(m.obx_wc_perms_refresh_failed());
    } finally {
      refreshingPerms = false;
    }
  }

  async function start(express: boolean) {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      wizard.answer({ kind });
      await saveServer();
      if (express) wizard.setTracks(['structure', 'moderation', 'greeting'], { express: true });
      else wizard.setTracks([...selection]);
      celebrateStep();
      wizard.complete('tracks');
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_identity_save_failed());
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell>
  <div class="flex flex-col items-center text-center">
    <KotboMark size={60} halo />
    <h1 class="mt-5 text-2xl sm:text-[28px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
      {m.obx_wc_title({ server: selectedGuild?.name ?? m.obx_rc_your_server() })}
    </h1>
    <p class="mt-2 max-w-lg text-[15px] text-on-surface-variant leading-relaxed">{m.onb_start_lead()}</p>
  </div>

  {#if !isAdministrator}
    <div class="mt-6">
      <Callout variant="warning" title={m.obx_wc_restricted_title()}>
        {m.obx_wc_restricted_desc()}
        {#snippet actions()}
          {#if clientId}
            <Button
              variant="primary"
              size="sm"
              iconRight="ExternalLink"
              href={buildBotInviteUrl(clientId, ADMIN_INVITE_PERMISSIONS, selectedGuild?.id)}
              target="_blank"
            >
              {m.obx_wc_grant_admin()}
            </Button>
          {/if}
          <Button variant="secondary" size="sm" icon="refresh-cw" loading={refreshingPerms} onclick={refreshPermissions}>
            {m.obx_wc_check_status()}
          </Button>
        {/snippet}
      </Callout>
    </div>
  {/if}

  {#if showServer}
  <div class="mt-7">
    <ListGroup title={m.onb_start_server()}>
      <ListRow
        stacked
        icon="search"
        label={m.obx_kd_title()}
        description={kind === 'existing' ? m.obx_kd_existing_pitch() : m.obx_kd_new_pitch()}
      >
        <Segmented
          stretch
          label={m.obx_kd_title()}
          options={[
            { value: 'new', label: m.obx_kd_new() },
            { value: 'existing', label: m.obx_kd_existing() },
          ]}
          value={kind}
          onchange={chooseKind}
        />
      </ListRow>
      <ListRow icon="globe" label={m.onb_start_language()}>
        <Segmented
          label={m.onb_start_language()}
          options={[{ value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }]}
          value={language}
          onchange={(next) => (language = next)}
        />
      </ListRow>
      <ListRow stacked icon="clock" label={m.us_timezone()}>
        <select aria-label={m.us_timezone()} bind:value={timezone} class="input w-full text-sm">
          {#each COMMON_TIMEZONES as zone (zone.value)}
            <option value={zone.value}>{zone.label}</option>
          {/each}
          {#if !COMMON_TIMEZONES.some((zone) => zone.value === timezone)}
            <option value={timezone}>{timezone}</option>
          {/if}
        </select>
      </ListRow>
    </ListGroup>
  </div>
  {/if}

  {#if onServer}
    <p class="mt-4 text-center text-sm text-on-surface-variant">{m.onb_start_takeover_hint()}</p>
  {:else if !choosing}
    <div class="mt-6">
      <ListGroup title={m.onb_start_express_title()} footer={m.onb_start_express_footer()}>
        {#each TRACKS.filter((track) => ['structure', 'moderation', 'greeting'].includes(track.key)) as track (track.key)}
          <ListRow icon={track.icon} label={track.label()} description={track.outcome()} />
        {/each}
      </ListGroup>
    </div>
  {:else}
  <h2 class="mt-8 mb-4 text-lg font-semibold text-on-surface font-headline">{m.onb_tracks_title()}</h2>
  <div class="space-y-8">
    {#each TRACK_GROUPS as group (group.key)}
      {@const tracks = TRACKS.filter((track) => track.group === group.key)}
      <section>
        <div class="mb-3 flex items-baseline gap-2.5">
          <h2 class="text-body-sm font-semibold text-on-surface">{group.label()}</h2>
          <p class="text-xs text-on-surface-variant/45 truncate">{group.hint()}</p>
        </div>

        <div class="grid gap-2.5 sm:grid-cols-2">
          {#each tracks as track (track.key)}
            {@const count = screensOf(track.key)}
            <ToggleCard
              label={track.label()}
              pitch={track.pitch()}
              detail={track.outcome()}
              icon={track.icon}
              meta={m.onb_tracks_screens({ count })}
              selected={selection.includes(track.key)}
              onclick={() => toggle(track.key)}
            />
          {/each}
        </div>
      </section>
    {/each}

    <p class="text-xs text-on-surface-variant leading-relaxed">
      {m.onb_tracks_group_hint()}
    </p>
  </div>

  {/if}

  {#snippet footer()}
    {#if onServer}
      <button type="button" onclick={continueToTakeover} disabled={onboardingData.busy} class="btn btn-primary">
        {onboardingData.busy ? m.obx_creating() : m.obx_continue()}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else if !choosing}
      <button type="button" onclick={() => (choosing = true)} class="btn btn-ghost">
        {m.onb_start_choose()}
      </button>
      <button type="button" onclick={() => start(true)} disabled={onboardingData.busy} class="btn btn-primary">
        {onboardingData.busy ? m.obx_creating() : m.onb_start_express_cta()}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={() => (picked = defaultTracks(kind))}
        class="btn btn-ghost btn-sm !hidden sm:!inline-flex"
      >
        {m.onb_tracks_essentials()}
      </button>
      <div class="hidden sm:flex flex-col items-end leading-tight mr-1">
        <span class="text-xs font-semibold tabular-nums text-on-surface">{m.onb_tracks_estimate({ minutes })}</span>
        <span class="text-2xs text-on-surface-variant tabular-nums">
          {m.onb_tracks_count({ count: selection.length, total: TRACKS.length })}
          {#if screens > 0}· {m.onb_tracks_screens({ count: screens })}{/if}
        </span>
      </div>
      <button type="button" onclick={() => start(false)} disabled={onboardingData.busy} class="btn btn-primary">
        {onboardingData.busy ? m.obx_creating() : m.obx_continue()}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
