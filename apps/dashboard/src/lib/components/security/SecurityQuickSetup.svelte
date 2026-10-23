<script lang="ts">
  /**
   * Section « Configuration rapide » du hub Securite.
   *
   * Les niveaux de protection reglent d'un coup les filtres AutoMod et les
   * seuils anti-raid. Ils vivaient dans Securite > Filtres, ou ils etaient a la
   * fois difficiles a trouver et trompeurs : la page ne montre que les filtres,
   * alors qu'un niveau deplace aussi le bouclier de siege. Le hub est le seul
   * endroit d'ou les deux relevent.
   *
   * Le composant charge et enregistre lui-meme les deux modeles : le hub n'a
   * aucune raison de porter cet etat, et AutoMod n'a plus a garder une copie de
   * l'anti-raid dont il ne se sert pas.
   */
  import { router } from 'tinro';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import Skeleton from '../Skeleton.svelte';
  import AutomodPresetPicker from '../AutomodPresetPicker.svelte';
  import {
    findAutomodPreset,
    type AutomodPreset,
    type AutomodFilterValues,
    type AutomodRaidValues,
  } from '@kotbo/shared';
  import {
    fetchAutoModConfig,
    updateAutoModConfig,
    fetchRaidProtection,
    updateRaidProtection,
  } from '../../api';

  const actionState = createAsyncActionState();
  let loading = $state(true);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.automod?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  // Les deux modeles sont charges tels quels et renvoyes entiers : un niveau ne
  // touche qu'a une poignee de champs, tout le reste doit repartir intact. D'ou
  // l'intersection avec `Record<string, unknown>`, qui porte ce reste sans
  // obliger a redeclarer ici deux modeles entiers.
  type Filters = Partial<AutomodFilterValues> & Record<string, unknown>;
  type Raid = Partial<AutomodRaidValues> & Record<string, unknown>;

  let filters = $state<Filters | null>(null);
  let savedFilters = $state<Filters | null>(null);
  let raid = $state<Raid | null>(null);
  let savedRaid = $state<Raid | null>(null);

  const ready = $derived(!!filters && !!raid);

  const selectedPreset = $derived(filters && raid ? findAutomodPreset(filters, raid) : null);
  const activePreset = $derived(
    savedFilters && savedRaid ? findAutomodPreset(savedFilters, savedRaid) : null,
  );

  const dirty = $derived(
    JSON.stringify(filters) !== JSON.stringify(savedFilters)
      || JSON.stringify(raid) !== JSON.stringify(savedRaid)
  );

  // Un niveau choisi n'est applique qu'a l'enregistrement : sans cette barre,
  // quitter la page perdait le choix en silence. L'identifiant est stable, le
  // libelle est traduit : confondre les deux ferait deriver la propriete de la
  // barre au changement de langue.
  const OWNER = 'security-quick-setup';

  $effect(() => {
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: OWNER,
          label: m.sec_quick_setup_title(),
          onSave: () => save(),
          onReset: () => {
            filters = savedFilters ? JSON.parse(JSON.stringify(savedFilters)) : null;
            raid = savedRaid ? JSON.parse(JSON.stringify(savedRaid)) : null;
          },
        });
      });
    } else {
      untrack(() => {
        unsavedChanges.release(OWNER);
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release(OWNER);
  });

  onMount(async () => {
    try {
      // Les droits viennent du store, que ModulePage ne rafraichit qu'au bascul
      // d'un module, jamais au montage : sans cet appel, la section peut
      // s'afficher en lecture seule alors que l'admin peut tout regler.
      const [, automodRes, raidRes] = await Promise.all([
        dashboardStore.refresh(),
        fetchAutoModConfig(),
        fetchRaidProtection(),
      ]);
      if (automodRes) {
        const charge = automodRes.config ?? {};
        filters = charge;
        savedFilters = JSON.parse(JSON.stringify(charge));
      }
      // Le repli sur un objet vide couvre l'ecart de deploiement : le bot cree
      // desormais la config manquante a la lecture, mais le dashboard part
      // separement et peut tourner un moment devant un bot plus ancien, qui
      // renvoie encore `config: null` sur un serveur fraichement rejoint.
      // Exiger une config y faisait echouer la section.
      if (raidRes) {
        const charge = raidRes.config ?? {};
        raid = charge;
        savedRaid = JSON.parse(JSON.stringify(charge));
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  function selectPreset(preset: AutomodPreset) {
    if (!canManageSettings || !filters || !raid) return;
    Object.assign(filters, preset.filters);
    Object.assign(raid, preset.raid);
  }

  async function save(): Promise<boolean> {
    if (!canManageSettings || !filters || !raid) return false;
    let success = false;
    await actionState.run(async () => {
      if (JSON.stringify(filters) !== JSON.stringify(savedFilters)) {
        const res = await updateAutoModConfig(filters);
        if (!res?.config) throw new Error(m.am_err_save_automod());
        filters = res.config;
        savedFilters = JSON.parse(JSON.stringify(res.config));
      }
      if (JSON.stringify(raid) !== JSON.stringify(savedRaid)) {
        const res = await updateRaidProtection(raid);
        if (!res?.config) throw new Error(m.am_err_save_raid());
        raid = res.config;
        savedRaid = JSON.parse(JSON.stringify(res.config));
      }
      success = true;
      return true;
    }, { successMessage: m.am_toast_saved() });
    return success;
  }

  // La carte « Personnalise » n'applique rien : elle renvoie la ou les reglages
  // se font filtre par filtre.
  function openDetail() {
    router.goto('/security/filters');
  }
</script>

<section class="flex flex-col gap-4" data-guide="security-presets">
  <div class="flex items-baseline justify-between gap-4">
    <h2 class="font-headline text-base font-semibold tracking-tight text-on-surface">
      {m.sec_quick_setup_title()}
    </h2>
  </div>

  {#if loading}
    <Skeleton height="320px" radius="1rem" />
  {:else if ready}
    <AutomodPresetPicker
      selectedId={selectedPreset?.id ?? null}
      activeId={activePreset?.id ?? null}
      customFilters={selectedPreset ? savedFilters! : filters!}
      customRaid={selectedPreset ? savedRaid! : raid!}
      disabled={!canManageSettings}
      {dirty}
      saving={actionState.state.loading}
      onselect={selectPreset}
      onsave={save}
      ondetail={openDetail}
    />
  {:else}
    <p class="text-sm text-on-surface-variant">{m.sec_quick_setup_unavailable()}</p>
  {/if}
</section>
