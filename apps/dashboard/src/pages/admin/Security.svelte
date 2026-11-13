<script lang="ts">
  import { m } from '../../lib/i18n';
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchGlobalAdmins, addGlobalAdmin, removeGlobalAdmin, fetchGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist } from '../../lib/api';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import { Button, Callout } from '../../lib/components/ui';

  import { errorMessage } from '@kotbo/shared';
  interface GlobalAdmin {
    userId: string;
    username: string;
    avatarUrl: string | null;
    addedBy: string;
    createdAt: string;
  }

  interface BlacklistEntry {
    userId: string;
    username: string;
    avatarUrl: string | null;
    reason: string | null;
    addedBy: string;
    createdAt: string;
  }

  // `DISCORD_` fait partie de `envPrefix` dans vite.config : la variable est
  // donc exposee au client. Un prefixe absent de cette liste - `PUBLIC_` par
  // exemple - donnerait `undefined` sans que rien ne le signale.
  const OWNER_ID = import.meta.env.DISCORD_CLIENT_OWNER_ID;

  let globalAdmins = $state<GlobalAdmin[]>([]);
  let globalBlacklist = $state<BlacklistEntry[]>([]);
  let newAdminId = $state('');
  let newBlacklistId = $state('');
  let newBlacklistReason = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [adminsData, blacklistData] = await Promise.all([
        fetchGlobalAdmins(),
        fetchGlobalBlacklist()
      ]);
      globalAdmins = adminsData?.admins ?? [];
      globalBlacklist = blacklistData?.blacklist ?? [];
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  });

  async function handleAddAdmin(e: Event) {
    e.preventDefault();
    if (!newAdminId.trim()) return;
    try {
      await addGlobalAdmin(newAdminId.trim());
      newAdminId = '';
      const data = await fetchGlobalAdmins();
      globalAdmins = data?.admins ?? [];
      toast.success(m.asec_admin_added());
    } catch (err) { toast.error(errorMessage(err)); }
  }

  async function handleRemoveAdmin(userId: string, username: string) {
    if (!(await confirmDialog.danger(`Retirer l'accès global à ${username} ?`, '', 'Retirer'))) return;
    try {
      await removeGlobalAdmin(userId);
      globalAdmins = globalAdmins.filter(a => a.userId !== userId);
      toast.success(m.asec_access_revoked({ name: username }));
    } catch (err) { toast.error(errorMessage(err)); }
  }

  async function handleAddBlacklist(e: Event) {
    e.preventDefault();
    if (!newBlacklistId.trim()) return;
    try {
      await addGlobalBlacklist(newBlacklistId.trim(), newBlacklistReason.trim());
      newBlacklistId = '';
      newBlacklistReason = '';
      const data = await fetchGlobalBlacklist();
      globalBlacklist = data?.blacklist ?? [];
      toast.success(m.asec_blacklist_added());
    } catch (err) { toast.error(errorMessage(err)); }
  }

  async function handleRemoveBlacklist(userId: string) {
    if (!(await confirmDialog.ask({ title: 'Retirer de la liste noire globale ?', confirmLabel: 'Retirer', variant: 'warning' }))) return;
    try {
      await removeGlobalBlacklist(userId);
      globalBlacklist = globalBlacklist.filter(b => b.userId !== userId);
      toast.success(m.asec_blacklist_removed());
    } catch (err) { toast.error(errorMessage(err)); }
  }
</script>

{#snippet avatar(username: string, avatarUrl: string | null)}
  {#if avatarUrl}
    <img src={avatarUrl} alt="" class="w-9 h-9 rounded-full shrink-0" loading="lazy" />
  {:else}
    <div class="w-9 h-9 rounded-full bg-on-surface/8 flex items-center justify-center shrink-0 text-on-surface-variant font-semibold text-sm">
      {username.charAt(0).toUpperCase()}
    </div>
  {/if}
{/snippet}

<AdminShell title="Sécurité" description="Qui a la main sur toute l’instance, et qui en est exclu partout.">
  {#if error}
    <Callout variant="danger" title="Erreur de chargement">{error}</Callout>
  {/if}

  <!-- Deux listes courtes : côte à côte plutôt que derrière des onglets. -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
    <AdminCard
      title="Administrateurs globaux"
      description="Accès complet à cette console et au dashboard de tous les serveurs."
      icon="ShieldCheck"
      tone="success"
      padded={false}
    >
      {#snippet actions()}
        <AdminBadge label={String(globalAdmins.length)} tone="success" />
      {/snippet}

      <form onsubmit={handleAddAdmin} class="flex gap-2 p-4 border-b border-outline-variant/20">
        <input
          type="text"
          inputmode="numeric"
          bind:value={newAdminId}
          aria-label="ID Discord de l’administrateur"
          placeholder="ID Discord (ex: 457275321171968000)"
          class="input font-mono"
          required
        />
        <Button type="submit" variant="primary" icon="Plus">Ajouter</Button>
      </form>

      {#if loading}
        <div class="p-4 space-y-2">
          {#each Array(2) as _, index (index)}
            <div class="h-12 rounded-xl bg-on-surface/6 animate-pulse"></div>
          {/each}
        </div>
      {:else if globalAdmins.length === 0}
        <p class="px-5 py-6 text-body-sm text-on-surface-variant text-center">Aucun administrateur global.</p>
      {:else}
        <ul class="divide-y divide-outline-variant/20">
          {#each globalAdmins as admin (admin.userId)}
            <li class="flex items-center gap-3 px-4 py-3">
              {@render avatar(admin.username, admin.avatarUrl)}
              <div class="min-w-0 flex-1">
                <p class="text-body-sm font-semibold text-on-surface truncate">{admin.username}</p>
                <p class="text-2xs text-on-surface-variant font-mono">{admin.userId}</p>
              </div>
              {#if admin.userId === OWNER_ID}
                <AdminBadge label="Créateur" tone="success" />
              {:else}
                <Button
                  size="sm"
                  variant="danger"
                  icon="Trash"
                  title="Révoquer l'accès"
                  aria-label="Révoquer l'accès de {admin.username}"
                  onclick={() => handleRemoveAdmin(admin.userId, admin.username)}
                />
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>

    <AdminCard
      title="Liste noire globale"
      description="Ces comptes ne peuvent plus utiliser Kotbo, sur aucun serveur."
      icon="UserX"
      tone="danger"
      padded={false}
    >
      {#snippet actions()}
        <AdminBadge label={String(globalBlacklist.length)} tone={globalBlacklist.length > 0 ? 'danger' : 'neutral'} />
      {/snippet}

      <form onsubmit={handleAddBlacklist} class="grid gap-2 p-4 border-b border-outline-variant/20 sm:grid-cols-[1fr_1fr_auto]">
        <input
          type="text"
          inputmode="numeric"
          bind:value={newBlacklistId}
          aria-label="ID Discord à bloquer"
          placeholder="ID Discord à bloquer"
          class="input font-mono"
          required
        />
        <input type="text" bind:value={newBlacklistReason} aria-label="Raison" placeholder="Raison (optionnel)" class="input" />
        <Button type="submit" variant="danger" icon="Ban">Bannir</Button>
      </form>

      {#if loading}
        <div class="p-4 space-y-2">
          {#each Array(2) as _, index (index)}
            <div class="h-12 rounded-xl bg-on-surface/6 animate-pulse"></div>
          {/each}
        </div>
      {:else if globalBlacklist.length === 0}
        <p class="px-5 py-6 text-body-sm text-on-surface-variant text-center">Personne dans la liste noire.</p>
      {:else}
        <ul class="divide-y divide-outline-variant/20">
          {#each globalBlacklist as user (user.userId)}
            <li class="flex items-center gap-3 px-4 py-3">
              {@render avatar(user.username, user.avatarUrl)}
              <div class="min-w-0 flex-1">
                <p class="text-body-sm font-semibold text-on-surface truncate">{user.username}</p>
                <p class="text-2xs text-on-surface-variant font-mono">{user.userId}</p>
                {#if user.reason}
                  <p class="text-xs text-on-surface-variant mt-0.5">{user.reason}</p>
                {/if}
              </div>
              <Button size="sm" icon="Unlock" onclick={() => handleRemoveBlacklist(user.userId)}>Retirer</Button>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>
  </div>
</AdminShell>
