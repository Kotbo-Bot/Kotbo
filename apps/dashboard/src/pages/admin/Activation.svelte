<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchActivationCodes, createActivationCode, deleteActivationCode } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import { Button, Callout, Field, FilterPills } from '../../lib/components/ui';

  import { errorMessage } from '@kotbo/shared';
  interface ActivationCode {
    id: string;
    code: string;
    isActive: boolean;
    usedByGuildId: string | null;
    guildName: string | null;
    accessType: 'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION';
    durationMinutes: number | null;
    label: string | null;
    guildActivated: boolean | null;
    accessExpiresAt: string | null;
    accessExpiredAt: string | null;
  }

  let activationCodes = $state<ActivationCode[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Formulaire de génération : accès permanent ou période limitée. La durée est
  // saisie dans l'unité qui arrange, puis convertie en minutes, l'unité que
  // l'API et la base manipulent.
  const UNITS = { minute: 1, hour: 60, day: 1440 } as const;
  type Unit = keyof typeof UNITS;

  let grantType = $state<'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION'>('PERMANENT');
  let grantAmount = $state(15);
  let grantUnit = $state<Unit>('day');
  let grantLabel = $state('');
  let generating = $state(false);

  const MS_PER_MINUTE = 60_000;

  const grantMinutes = $derived(Math.round(grantAmount * UNITS[grantUnit]));

  /** Raccourcis proposés selon l'unité choisie. */
  const presets = $derived(
    grantUnit === 'minute' ? [15, 30, 60] : grantUnit === 'hour' ? [1, 6, 24] : [7, 15, 30],
  );

  function minutesLeft(expiresAt: string): number {
    return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / MS_PER_MINUTE));
  }

  /** Même rendu que le bot côté Discord : « 15 jours », « 2 heures », « 30 minutes ». */
  function formatDuration(minutes: number): string {
    const plural = (v: number, word: string) => `${v} ${word}${v > 1 ? 's' : ''}`;
    if (minutes < 60) return plural(Math.max(1, minutes), 'minute');
    if (minutes < 1440) {
      const h = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? plural(h, 'heure') : `${plural(h, 'heure')} ${plural(rest, 'minute')}`;
    }
    const d = Math.floor(minutes / 1440);
    const restH = Math.floor((minutes % 1440) / 60);
    return restH === 0 ? plural(d, 'jour') : `${plural(d, 'jour')} ${plural(restH, 'heure')}`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Libellé court du type d'accès porté par un code. */
  function accessLabel(item: ActivationCode): string {
    const duration = item.durationMinutes ? formatDuration(item.durationMinutes) : '';
    if (item.accessType === 'TRIAL') return `Essai ${duration}`;
    if (item.accessType === 'SUBSCRIPTION') return `Abonnement ${duration}`;
    return 'Permanent';
  }

  async function loadActivationCodes() {
    activationCodes = await fetchActivationCodes();
  }

  onMount(async () => {
    try {
      await loadActivationCodes();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  });

  async function handleGenerateCode() {
    if (grantType !== 'PERMANENT' && (!Number.isInteger(grantMinutes) || grantMinutes < 1)) {
      toast.error(m.aact_duration_invalid());
      return;
    }

    generating = true;
    try {
      const newCode = await createActivationCode({
        accessType: grantType,
        durationMinutes: grantType === 'PERMANENT' ? null : grantMinutes,
        label: grantLabel.trim() || null,
      });
      toast.success(
        grantType === 'PERMANENT'
          ? m.aact_code_generated({ code: newCode.code })
          : m.aact_code_generated_duration({ duration: formatDuration(grantMinutes), code: newCode.code }),
      );
      grantLabel = '';
      await loadActivationCodes();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      generating = false;
    }
  }

  async function handleDeleteCode(codeId: string, code: string, usedBy: string | null) {
    const confirmed = usedBy
      ? await confirmDialog.danger(
          `Supprimer le code utilisé par « ${usedBy} » ?`,
          'Ce serveur sera immédiatement désactivé.',
        )
      : await confirmDialog.danger(`Supprimer le code d'activation ${code} ?`);
    if (!confirmed) return;
    try {
      await deleteActivationCode(codeId);
      toast.success(m.aact_code_deleted());
      await loadActivationCodes();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  // ── Liste : recherche et filtre d'état ────────────────────────────────────
  let search = $state('');
  let statusFilter = $state('ALL');

  function codeStatus(item: ActivationCode): 'FREE' | 'USED' | 'OFF' {
    if (item.usedByGuildId) return item.guildActivated === false || item.accessExpiredAt ? 'OFF' : 'USED';
    return item.isActive ? 'FREE' : 'OFF';
  }

  const counts = $derived({
    FREE: activationCodes.filter((c) => codeStatus(c) === 'FREE').length,
    USED: activationCodes.filter((c) => codeStatus(c) === 'USED').length,
    OFF: activationCodes.filter((c) => codeStatus(c) === 'OFF').length,
  });

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return activationCodes.filter((item) => {
      if (statusFilter !== 'ALL' && codeStatus(item) !== statusFilter) return false;
      if (!needle) return true;
      return [item.code, item.label, item.guildName, item.usedByGuildId].some((v) => v?.toLowerCase().includes(needle));
    });
  });

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(m.pf_copied());
    } catch {
      // Presse-papiers refusé (contexte non sécurisé) : le code reste sélectionnable à la main.
    }
  }

  const columns: AdminTableColumn[] = [
    { key: 'code', label: 'Code' },
    { key: 'access', label: 'Accès' },
    { key: 'guild', label: 'Serveur' },
    { key: 'actions', label: '', align: 'right', width: 'w-20' },
  ];
</script>

<AdminShell title="Codes d’activation" description="Génération et suivi des codes donnant accès aux fonctions complètes.">
  {#if error}
    <Callout variant="danger" title="Erreur de chargement">{error}</Callout>
  {/if}

  <AdminCard title="Générer un code" icon="Key" tone="primary">
    <div class="flex flex-wrap items-end gap-4">
      <div class="space-y-1.5">
        <span class="field-label">Type d'accès</span>
        <FilterPills
          label="Type d'accès"
          options={[
            { value: 'PERMANENT', label: 'Permanent' },
            { value: 'TRIAL', label: 'Essai' },
            { value: 'SUBSCRIPTION', label: 'Abonnement' },
          ]}
          value={grantType}
          onchange={(value) => (grantType = value as typeof grantType)}
        />
      </div>

      {#if grantType !== 'PERMANENT'}
        <Field label="Durée">
          {#snippet children(id)}
            <div class="flex items-center gap-2">
              <input {id} type="number" min="1" bind:value={grantAmount} class="input w-20" />
              <select aria-label="Unité de durée" bind:value={grantUnit} class="input w-28">
                <option value="minute">minutes</option>
                <option value="hour">heures</option>
                <option value="day">jours</option>
              </select>
              {#each presets as preset (preset)}
                <Button size="sm" variant={grantAmount === preset ? 'primary' : 'secondary'} onclick={() => (grantAmount = preset)}>
                  {preset}
                </Button>
              {/each}
            </div>
          {/snippet}
        </Field>
      {/if}

      <Field label="Note interne (optionnel)" class="flex-1 min-w-[220px]">
        {#snippet children(id)}
          <input {id} type="text" placeholder="Nom du client, contexte…" bind:value={grantLabel} class="input" />
        {/snippet}
      </Field>

      <Button variant="primary" icon="Unlock" loading={generating} onclick={handleGenerateCode}>Générer un code</Button>
    </div>

    <!-- Une seule ligne d'aide, qui décrit ce que le code choisi va réellement faire. -->
    <p class="text-xs text-on-surface-variant leading-relaxed border-t border-outline-variant/20 pt-4 mt-4">
      {#if grantType === 'PERMANENT'}
        Accès sans expiration. Un code ne vaut que pour un seul serveur à la fois.
      {:else}
        Accès de {formatDuration(grantMinutes)}. Le serveur reçoit un embed à l'activation, un rappel à
        mi-parcours puis à J-3 et J-1 quand la période est assez longue, et se désactive automatiquement à
        l'échéance. Un code ne vaut que pour un seul serveur à la fois.
      {/if}
    </p>
  </AdminCard>

  <AdminToolbar
    bind:search
    bind:activeFilter={statusFilter}
    placeholder="Rechercher un code, une note ou un serveur…"
    filters={[
      { value: 'ALL', label: 'Tous', count: activationCodes.length },
      { value: 'FREE', label: 'Disponibles', count: counts.FREE },
      { value: 'USED', label: 'Utilisés', count: counts.USED },
      { value: 'OFF', label: 'Coupés ou expirés', count: counts.OFF },
    ]}
    resultCount={filtered.length}
    resultLabel="code"
  />

  <AdminTable
    {columns}
    rows={filtered}
    {loading}
    emptyIcon="Key"
    emptyTitle={activationCodes.length === 0 ? 'Aucun code pour le moment' : 'Aucun code ne correspond'}
    emptyHint={activationCodes.length === 0 ? 'Génères-en un ci-dessus pour activer un serveur.' : 'Élargis la recherche ou change de filtre.'}
  >
    {#snippet row(entry, _index)}
      {@const item = entry as ActivationCode}
      <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors">
        <td class="px-4 py-3">
          <button
            type="button"
            onclick={() => copyCode(item.code)}
            title="Copier le code"
            class="inline-flex items-center gap-2 font-mono text-body-sm font-semibold text-on-surface bg-on-surface/6 hover:bg-on-surface/10 px-2.5 py-1 rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          >
            {item.code}
            <Papicon icon="Copy" size={12} class="text-on-surface-variant" />
          </button>
          {#if item.label}
            <p class="text-2xs text-on-surface-variant mt-1">{item.label}</p>
          {/if}
        </td>
        <td class="px-4 py-3">
          <AdminBadge
            label={accessLabel(item)}
            tone={item.accessType === 'PERMANENT' ? 'neutral' : 'primary'}
            icon={item.accessType === 'PERMANENT' ? '' : 'Clock'}
          />
          {#if item.accessExpiredAt}
            <p class="text-2xs text-error mt-1">Expiré le {formatDate(item.accessExpiredAt)}</p>
          {:else if item.accessExpiresAt}
            <p class="text-2xs text-on-surface-variant mt-1">
              {formatDuration(minutesLeft(item.accessExpiresAt))} restantes · {formatDate(item.accessExpiresAt)}
            </p>
          {/if}
        </td>
        <!-- Le serveur porte à lui seul le statut du code : un code rattaché à
             un serveur est utilisé, un code libre est disponible. -->
        <td class="px-4 py-3">
          {#if item.usedByGuildId}
            <div class="flex items-center gap-2">
              <p class="text-body-sm font-semibold text-on-surface">{item.guildName || 'Serveur inconnu'}</p>
              {#if item.guildActivated === false}
                <!-- Un essai révoqué à la main garde son code sans poser d'échéance :
                     sans ce marqueur, la colonne Accès afficherait un décompte pour
                     un serveur déjà coupé. -->
                <AdminBadge size="sm" label="Coupé" tone="danger" />
              {/if}
            </div>
            <p class="text-2xs text-on-surface-variant font-mono mt-0.5">{item.usedByGuildId}</p>
          {:else if item.isActive}
            <AdminBadge label="Disponible" tone="success" dot />
          {:else}
            <AdminBadge label="Désactivé" tone="neutral" dot />
          {/if}
        </td>
        <td class="px-4 py-3 text-right">
          <Button
            size="sm"
            variant="danger"
            icon="Trash"
            aria-label={item.usedByGuildId ? 'Révoquer et désactiver le serveur' : 'Supprimer ce code'}
            title={item.usedByGuildId ? 'Révoquer et désactiver le serveur' : 'Supprimer ce code'}
            onclick={() => handleDeleteCode(item.id, item.code, item.guildName)}
          />
        </td>
      </tr>
    {/snippet}
  </AdminTable>
</AdminShell>
