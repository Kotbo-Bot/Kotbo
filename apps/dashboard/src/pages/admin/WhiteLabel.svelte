<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchWhiteLabelInstances,
    createWhiteLabelInstance,
    updateWhiteLabelInstance,
    deleteWhiteLabelInstance,
    bindGuildToInstance,
    unbindGuildFromInstance,
    fetchWhiteLabelInstance,
    fetchAdminGuilds,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import type { AdminTableColumn } from '../../lib/components/admin/types';
  import { Button, Field, Modal, ToggleSwitch } from '../../lib/components/ui';

  import { errorMessage } from '@kotbo/shared';
  interface WLInstance {
    id: string;
    slug: string;
    name: string;
    enabled: boolean;
    discordClientId: string;
    dashboardUrl: string | null;
    apiPort: number | null;
    brandName: string | null;
    brandColor: string;
    brandLogoUrl: string | null;
    brandFaviconUrl: string | null;
    brandFooterText: string | null;
    ownerId: string;
    maxGuilds: number;
    guildCount: number;
    createdAt: string;
  }

  let instances = $state<WLInstance[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let creating = $state(false);
  let detailInstance = $state<any>(null);
  let detailOpen = $state(false);
  let allGuilds = $state<{ id: string; name: string }[]>([]);

  // Form state
  let form = $state({
    slug: '',
    name: '',
    discordToken: '',
    discordClientId: '',
    discordClientSecret: '',
    discordRedirectUri: '',
    dashboardUrl: '',
    apiPort: '',
    brandName: '',
    brandColor: '#5865F2',
    brandLogoUrl: '',
    brandFaviconUrl: '',
    brandFooterText: '',
    ownerId: '',
    maxGuilds: '1',
  });

  function resetForm() {
    form = {
      slug: '', name: '', discordToken: '', discordClientId: '',
      discordClientSecret: '', discordRedirectUri: '', dashboardUrl: '',
      apiPort: '', brandName: '', brandColor: '#5865F2', brandLogoUrl: '',
      brandFaviconUrl: '', brandFooterText: '', ownerId: '', maxGuilds: '1',
    };
  }

  const formComplete = $derived(
    Boolean(form.slug && form.name && form.discordToken && form.discordClientId && form.discordClientSecret && form.ownerId),
  );

  async function loadInstances() {
    try {
      const data = await fetchWhiteLabelInstances();
      instances = data.instances;
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  onMount(async () => {
    await loadInstances();
    loading = false;
  });

  async function handleCreate() {
    creating = true;
    try {
      const payload: Record<string, any> = { ...form };
      if (!payload.apiPort) delete payload.apiPort;
      if (!payload.discordRedirectUri) delete payload.discordRedirectUri;
      await createWhiteLabelInstance(payload);
      toast.success(m.awl_instance_created({ name: form.name }));
      showCreateModal = false;
      resetForm();
      await loadInstances();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      creating = false;
    }
  }

  async function handleToggle(inst: WLInstance) {
    try {
      await updateWhiteLabelInstance(inst.id, { enabled: !inst.enabled });
      toast.success(inst.enabled ? m.awl_instance_disabled({ name: inst.name }) : m.awl_instance_enabled({ name: inst.name }));
      await loadInstances();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDelete(inst: WLInstance) {
    if (!(await confirmDialog.danger(`Supprimer l'instance « ${inst.name} » ?`, `(${inst.slug}) Cette action est irréversible.`))) return;
    try {
      await deleteWhiteLabelInstance(inst.id);
      toast.success(m.awl_instance_deleted());
      if (detailInstance?.id === inst.id) detailOpen = false;
      await loadInstances();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function openDetail(inst: { id: string }) {
    try {
      const data = await fetchWhiteLabelInstance(inst.id);
      detailInstance = data.instance;
      detailOpen = true;
      allGuilds = (await fetchAdminGuilds()).guilds ?? [];
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleBindGuild(guildId: string) {
    if (!detailInstance) return;
    try {
      await bindGuildToInstance(detailInstance.id, guildId);
      toast.success(m.awl_guild_attached());
      await openDetail(detailInstance);
      await loadInstances();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleUnbindGuild(guildId: string) {
    if (!detailInstance) return;
    try {
      await unbindGuildFromInstance(detailInstance.id, guildId);
      toast.success(m.awl_guild_detached());
      await openDetail(detailInstance);
      await loadInstances();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const boundGuilds = $derived<{ id: string }[]>(detailInstance?.guilds ?? []);
  const bindableGuilds = $derived(allGuilds.filter((guild) => !boundGuilds.some((bound) => bound.id === guild.id)));
  const guildName = (id: string) => allGuilds.find((guild) => guild.id === id)?.name ?? '';

  const columns: AdminTableColumn[] = [
    { key: 'name', label: 'Instance' },
    { key: 'guilds', label: 'Serveurs', align: 'right', width: 'w-28' },
    { key: 'url', label: 'Dashboard', hideBelow: 'md' },
    { key: 'enabled', label: 'Active', align: 'center', width: 'w-24' },
    { key: 'actions', label: '', align: 'right', width: 'w-28' },
  ];
</script>

<AdminShell title="Marque blanche" description="Instances du bot déployées sous une autre marque, et serveurs qui leur sont rattachés.">
  {#snippet actions()}
    <Button variant="primary" icon="Plus" onclick={() => { resetForm(); showCreateModal = true; }}>Nouvelle instance</Button>
  {/snippet}

  <AdminTable
    {columns}
    rows={instances}
    {loading}
    skeletonRows={3}
    emptyIcon="Layers"
    emptyTitle="Aucune instance en marque blanche"
    emptyHint="Crée une instance pour déployer le bot sous une autre marque."
  >
    {#snippet row(item, _index)}
      {@const inst = item as WLInstance}
      <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors">
        <td class="px-4 py-3">
          <button type="button" onclick={() => openDetail(inst)} class="flex items-center gap-3 min-w-0 text-left group">
            <!-- La couleur vient de la marque du client, pas du thème. -->
            <span
              class="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center overflow-hidden"
              style="background-color: {inst.brandColor}20; color: {inst.brandColor}"
            >
              {#if inst.brandLogoUrl}
                <img src={inst.brandLogoUrl} alt="" class="w-6 h-6 rounded" loading="lazy" />
              {:else}
                <Papicon icon="Bot" size={16} />
              {/if}
            </span>
            <span class="min-w-0">
              <span class="block text-body-sm font-semibold text-on-surface truncate group-hover:text-primary transition-colors">{inst.name}</span>
              <span class="block text-2xs text-on-surface-variant font-mono truncate">{inst.slug}</span>
            </span>
          </button>
        </td>
        <td class="px-4 py-3 text-right text-body-sm font-semibold text-on-surface tabular-nums">{inst.guildCount}/{inst.maxGuilds}</td>
        <td class="px-4 py-3 hidden md:table-cell">
          <p class="text-xs text-on-surface-variant truncate max-w-64">{inst.dashboardUrl ?? 'Par défaut'}</p>
          {#if inst.apiPort}<p class="text-2xs text-on-surface-variant font-mono">Port {inst.apiPort}</p>{/if}
        </td>
        <td class="px-4 py-3">
          <div class="flex justify-center">
            <ToggleSwitch size="sm" checked={inst.enabled} ariaLabel="Activer {inst.name}" onToggle={() => handleToggle(inst)} />
          </div>
        </td>
        <td class="px-4 py-3">
          <div class="flex items-center justify-end gap-1">
            <Button size="sm" icon="Settings" title="Détails et serveurs" aria-label="Détails de {inst.name}" onclick={() => openDetail(inst)} />
            <Button size="sm" variant="danger" icon="Trash" title="Supprimer" aria-label="Supprimer {inst.name}" onclick={() => handleDelete(inst)} />
          </div>
        </td>
      </tr>
    {/snippet}
  </AdminTable>
</AdminShell>

<AdminDrawer bind:open={detailOpen} title={detailInstance?.name ?? ''} subtitle={detailInstance?.slug ?? ''}>
  {#if detailInstance}
    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {#each [
        { label: 'Client ID', value: detailInstance.discordClientId, mono: true },
        { label: 'Jeton du bot', value: detailInstance.discordToken, mono: true },
        { label: 'URL du dashboard', value: detailInstance.dashboardUrl || 'Par défaut', mono: false },
        { label: 'Propriétaire', value: detailInstance.ownerId, mono: true },
      ] as entry (entry.label)}
        <div class="min-w-0">
          <dt class="text-xs font-semibold text-on-surface-variant">{entry.label}</dt>
          <dd class="text-body-sm text-on-surface break-all mt-0.5 {entry.mono ? 'font-mono' : ''}">{entry.value}</dd>
        </div>
      {/each}
    </dl>

    <div class="mt-6 pt-5 border-t border-outline-variant/20 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-on-surface">Serveurs rattachés</h3>
        <AdminBadge label="{boundGuilds.length}/{detailInstance.maxGuilds}" tone={boundGuilds.length >= detailInstance.maxGuilds ? 'warning' : 'neutral'} />
      </div>

      {#if boundGuilds.length === 0}
        <p class="text-body-sm text-on-surface-variant">Aucun serveur rattaché pour l’instant.</p>
      {:else}
        <ul class="divide-y divide-outline-variant/20 rounded-xl border border-outline-variant/25">
          {#each boundGuilds as guild (guild.id)}
            <li class="flex items-center justify-between gap-3 px-3 py-2">
              <div class="min-w-0">
                {#if guildName(guild.id)}<p class="text-body-sm font-semibold text-on-surface truncate">{guildName(guild.id)}</p>{/if}
                <p class="text-2xs font-mono text-on-surface-variant">{guild.id}</p>
              </div>
              <Button size="sm" variant="danger" onclick={() => handleUnbindGuild(guild.id)}>Détacher</Button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if boundGuilds.length < detailInstance.maxGuilds}
        <Field label="Rattacher un serveur">
          {#snippet children(id)}
            <select
              {id}
              class="input"
              onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v) void handleBindGuild(v); }}
            >
              <option value="">Choisis un serveur…</option>
              {#each bindableGuilds as guild (guild.id)}
                <option value={guild.id}>{guild.name} ({guild.id})</option>
              {/each}
            </select>
          {/snippet}
        </Field>
      {:else}
        <p class="text-xs text-on-surface-variant">Plafond atteint : détache un serveur pour en rattacher un autre.</p>
      {/if}
    </div>
  {/if}
</AdminDrawer>

<Modal bind:open={showCreateModal} title="Nouvelle instance en marque blanche" size="md">
  <form id="wl-create" class="space-y-5" onsubmit={(e) => { e.preventDefault(); if (formComplete) void handleCreate(); }}>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Slug" required>
        {#snippet children(id)}<input {id} bind:value={form.slug} placeholder="ma-commu" class="input font-mono" />{/snippet}
      </Field>
      <Field label="Nom" required>
        {#snippet children(id)}<input {id} bind:value={form.name} placeholder="Ma Communauté" class="input" />{/snippet}
      </Field>
    </div>

    <fieldset class="space-y-3">
      <legend class="text-xs font-semibold text-on-surface-variant mb-2">Application Discord</legend>
      <Field label="Jeton du bot" required>
        {#snippet children(id)}<input {id} bind:value={form.discordToken} type="password" autocomplete="off" class="input font-mono" />{/snippet}
      </Field>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Client ID" required>
          {#snippet children(id)}<input {id} bind:value={form.discordClientId} placeholder="123456…" inputmode="numeric" class="input font-mono" />{/snippet}
        </Field>
        <Field label="Client Secret" required>
          {#snippet children(id)}<input {id} bind:value={form.discordClientSecret} type="password" autocomplete="off" class="input font-mono" />{/snippet}
        </Field>
      </div>
      <Field label="Redirect URI (optionnel)">
        {#snippet children(id)}
          <input {id} bind:value={form.discordRedirectUri} placeholder="https://api.commu.fr/api/auth/discord/callback" class="input" />
        {/snippet}
      </Field>
    </fieldset>

    <fieldset class="space-y-3">
      <legend class="text-xs font-semibold text-on-surface-variant mb-2">Dashboard</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="URL du dashboard">
          {#snippet children(id)}<input {id} bind:value={form.dashboardUrl} placeholder="https://panel.commu.fr" class="input" />{/snippet}
        </Field>
        <Field label="Port de l’API">
          {#snippet children(id)}<input {id} bind:value={form.apiPort} type="number" placeholder="8788" class="input" />{/snippet}
        </Field>
      </div>
    </fieldset>

    <fieldset class="space-y-3">
      <legend class="text-xs font-semibold text-on-surface-variant mb-2">Marque</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Nom de marque">
          {#snippet children(id)}<input {id} bind:value={form.brandName} placeholder="Mon Bot" class="input" />{/snippet}
        </Field>
        <Field label="Couleur principale">
          {#snippet children(id)}
            <div class="flex items-center gap-2">
              <input {id} bind:value={form.brandColor} type="color" class="w-9 h-9 shrink-0 rounded-lg cursor-pointer border-0 bg-transparent" />
              <input bind:value={form.brandColor} placeholder="#5865F2" class="input font-mono" aria-label="Couleur principale (hex)" />
            </div>
          {/snippet}
        </Field>
      </div>
      <Field label="URL du logo">
        {#snippet children(id)}<input {id} bind:value={form.brandLogoUrl} placeholder="https://…" class="input" />{/snippet}
      </Field>
      <Field label="Texte de pied de page">
        {#snippet children(id)}<input {id} bind:value={form.brandFooterText} placeholder="Powered by…" class="input" />{/snippet}
      </Field>
    </fieldset>

    <fieldset class="space-y-3">
      <legend class="text-xs font-semibold text-on-surface-variant mb-2">Propriétaire</legend>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="ID Discord du propriétaire" required>
          {#snippet children(id)}<input {id} bind:value={form.ownerId} placeholder="123456789…" inputmode="numeric" class="input font-mono" />{/snippet}
        </Field>
        <Field label="Serveurs maximum">
          {#snippet children(id)}<input {id} bind:value={form.maxGuilds} type="number" min="1" class="input" />{/snippet}
        </Field>
      </div>
    </fieldset>
  </form>

  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (showCreateModal = false)}>Annuler</Button>
      <Button
        type="submit"
        form="wl-create"
        variant="primary"
        loading={creating}
        disabled={!formComplete}
        disabledReason={m.common_reason_fill_field()}
      >
        Créer l’instance
      </Button>
    </div>
  {/snippet}
</Modal>
