<script lang="ts">
  /**
   * Fiche serveur de la console admin, partie Membres : rétention par cohorte,
   * profil des membres, plus actifs et staff, membres à risque, sources
   * d'arrivée et membres communs avec les autres serveurs Kotbo (nommément,
   * réservé à l'équipe Kotbo).
   */
  import { errorMessage } from '@kotbo/shared';
  import { fetchGuildMembersSheet, fetchSharedMembers, type GuildMembersSheet } from '../../api/adminInsights';
  import AdminCard from './AdminCard.svelte';
  import AdminBadge from './AdminBadge.svelte';
  import AdminBarList from './AdminBarList.svelte';
  import { formatNumber, formatVoice } from './format';
  import { Button, Callout } from '../ui';

  const { guildId, days }: { guildId: string; days: number } = $props();

  let data = $state<GuildMembersSheet | null>(null);
  let error = $state<string | null>(null);
  let shared = $state<{ guildId: string; name: string; members: { userId: string; name: string; username: string | null; avatarUrl: string | null }[] } | null>(null);
  let sharedLoading = $state<string | null>(null);

  $effect(() => {
    const id = guildId;
    const d = days;
    data = null;
    shared = null;
    fetchGuildMembersSheet(id, d)
      .then((res) => { if (id === guildId) { data = res; error = null; } })
      .catch((err) => { error = errorMessage(err); });
  });

  async function showShared(otherId: string, name: string) {
    sharedLoading = otherId;
    try {
      const res = await fetchSharedMembers(guildId, otherId);
      shared = { guildId: otherId, name, members: res.members };
    } catch (err) {
      error = errorMessage(err);
    } finally {
      sharedLoading = null;
    }
  }

  const AGE_LABEL: Record<string, string> = {
    under1d: 'Moins d’un jour', under7d: 'Moins d’une semaine', under30d: 'Moins d’un mois', under365d: 'Moins d’un an', over365d: 'Plus d’un an',
  };
  const SOURCE_LABEL: Record<string, string> = { invite: 'Invitations', vanity: 'Lien personnalisé', label: 'Liens nommés', unknown: 'Inconnue' };

  /** Fond de cellule de rétention : plus c'est vert, mieux le serveur garde ses arrivants. */
  function cell(value: number | null): string {
    if (value === null) return 'text-on-surface-variant';
    if (value >= 70) return 'bg-success/15 text-on-success-container';
    if (value >= 40) return 'bg-warning/15 text-on-warning-container';
    return 'bg-error/15 text-on-error-container';
  }
  const fmtPct = (v: number | null) => (v === null ? '–' : `${v.toLocaleString('fr-FR')} %`);
  const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
</script>

{#if error}
  <Callout variant="danger">{error}</Callout>
{/if}

{#if !data}
  {#if !error}<div class="h-72 admin-surface animate-pulse"></div>{/if}
{:else}
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
    <AdminCard title="Rétention par mois d’arrivée" description="Part des arrivants encore là après 1, 7 et 30 jours" class="lg:col-span-2">
      {#if data.cohorts.length === 0}
        <p class="text-sm text-on-surface-variant">Aucune arrivée connue sur six mois.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <caption class="sr-only">Rétention par mois d’arrivée</caption>
            <thead>
              <tr class="text-left text-xs text-on-surface-variant">
                <th scope="col" class="py-2 pr-3 font-medium">Mois</th>
                <th scope="col" class="py-2 px-3 font-medium text-right">Arrivées</th>
                <th scope="col" class="py-2 px-3 font-medium text-right">1 jour</th>
                <th scope="col" class="py-2 px-3 font-medium text-right">7 jours</th>
                <th scope="col" class="py-2 px-3 font-medium text-right">30 jours</th>
                <th scope="col" class="py-2 pl-3 font-medium text-right">Encore là</th>
              </tr>
            </thead>
            <tbody>
              {#each data.cohorts as c (c.month)}
                <tr class="border-t border-outline-variant">
                  <th scope="row" class="py-2 pr-3 text-left font-normal text-on-surface capitalize">{monthLabel(c.month)}</th>
                  <td class="py-2 px-3 text-right tabular-nums">{formatNumber(c.joined)}</td>
                  {#each [c.d1, c.d7, c.d30, c.stillHere] as v, i (i)}
                    <td class="py-1.5 px-1 text-right"><span class="inline-block min-w-16 rounded-lg px-2 py-1 tabular-nums {cell(v)}">{fmtPct(v)}</span></td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </AdminCard>

    <AdminCard title="Profil des membres" description="{formatNumber(data.profile.humans)} humains · {formatNumber(data.profile.bots)} bots">
      <p class="text-xs font-medium text-on-surface-variant mb-2">Âge des comptes</p>
      <AdminBarList items={data.profile.accountAge.buckets.map((b) => ({ key: b.key, label: AGE_LABEL[b.key] ?? b.key, value: b.count }))} />
      {#if data.profile.locales.length}
        <p class="text-xs font-medium text-on-surface-variant mt-5 mb-2">Langues</p>
        <AdminBarList items={data.profile.locales.map((l) => ({ key: l.locale, label: l.locale, value: l.count }))} />
      {/if}
    </AdminCard>

    <AdminCard title="Rôles les plus portés">
      <AdminBarList items={data.profile.roles.map((r) => ({ key: r.roleId, label: r.name, value: r.count }))} emptyLabel="Aucun rôle connu" />
      <p class="text-xs font-medium text-on-surface-variant mt-5 mb-2">Tags d’autres serveurs portés ici</p>
      <AdminBarList
        items={data.profile.tags.map((t) => ({ key: t.guildId, label: t.name ?? t.guildId, sublabel: t.tag ?? undefined, value: t.count, image: t.iconUrl, href: `/admin/servers/${t.guildId}` }))}
        emptyLabel="Aucun membre n’affiche un autre tag"
      />
    </AdminCard>

    <AdminCard title="Membres les plus actifs" description="Messages sur {days} jours">
      <AdminBarList
        items={data.topMembers.map((p) => ({ key: p.userId, label: p.name, sublabel: `${formatVoice(p.voiceMinutes)} en vocal${p.staff ? ' · staff' : ''}`, value: p.messages, image: p.avatarUrl }))}
        emptyLabel="Pas d’activité sur la période"
      />
    </AdminCard>

    <AdminCard title="Staff déclaré et staff réel" description="Sanctions posées sur 90 jours">
      <div class="flex flex-wrap gap-2 mb-4">
        <AdminBadge label="{data.staff.declared} déclarés" tone="neutral" />
        <AdminBadge label="{data.staff.acting} ont sanctionné" tone="primary" />
        {#if data.staff.idleDeclared > 0}<AdminBadge label="{data.staff.idleDeclared} déclarés sans sanction" tone="warning" />{/if}
      </div>
      <AdminBarList
        items={data.staff.moderators.map((p) => ({ key: p.userId, label: p.name, sublabel: p.declared ? 'déclaré au staff' : 'hors staff déclaré', value: p.sanctions, image: p.avatarUrl }))}
        emptyLabel="Aucune sanction manuelle sur 90 jours"
      />
    </AdminCard>

    <AdminCard title="Membres à risque" description="Les plus sanctionnés (90 j) et les plus toxiques ({days} j)">
      <AdminBarList
        items={data.atRisk.sanctions.map((p) => ({ key: p.userId, label: p.name, sublabel: 'sanctions', value: p.count, image: p.avatarUrl }))}
        emptyLabel="Aucune sanction"
      />
      {#if data.atRisk.toxic.length}
        <p class="text-xs font-medium text-on-surface-variant mt-5 mb-2">Messages toxiques (AegisAI)</p>
        <AdminBarList items={data.atRisk.toxic.map((p) => ({ key: p.userId, label: p.name, sublabel: `sur ${formatNumber(p.analyzed)} analysés`, value: p.toxic, image: p.avatarUrl }))} />
      {/if}
    </AdminCard>

    <AdminCard title="Sources d’arrivée" description={data.sources ? `${formatNumber(data.sources.tracked)} arrivées suivies sur ${days} jours` : ''}>
      {#if !data.sources || data.sources.tracked === 0}
        <p class="text-sm text-on-surface-variant">Aucune arrivée suivie sur la période.</p>
      {:else}
        <AdminBarList items={data.sources.kinds.filter((k) => k.joined > 0).map((k) => ({ key: k.kind, label: SOURCE_LABEL[k.kind] ?? k.kind, sublabel: `rétention ${fmtPct(k.retention)}`, value: k.joined }))} />
        {#if data.sources.links.length}
          <p class="text-xs font-medium text-on-surface-variant mt-5 mb-2">Liens</p>
          <AdminBarList items={data.sources.links.map((l) => ({ key: l.code, label: l.label ?? l.code, sublabel: `rétention ${fmtPct(l.retention)}${l.isVanity ? ' · lien perso' : ''}`, value: l.joined }))} limit={8} />
        {/if}
      {/if}
      {#if data.newcomers?.left24h.count}
        <p class="text-xs text-on-surface-variant mt-4">{formatNumber(data.newcomers.left24h.count)} arrivants partis en moins de 24 h ({fmtPct(data.newcomers.left24h.rate)}).</p>
      {/if}
    </AdminCard>

    <AdminCard title="Membres en commun" description="Autres serveurs Kotbo qui partagent le plus de membres" class="lg:col-span-2">
      {#if data.overlap.length === 0}
        <p class="text-sm text-on-surface-variant">Aucun membre en commun avec un autre serveur Kotbo.</p>
      {:else}
        <ul class="divide-y divide-outline-variant">
          {#each data.overlap as o (o.guildId)}
            <li class="flex flex-wrap items-center gap-3 py-2.5">
              {#if o.iconUrl}<img src={o.iconUrl} alt="" class="w-8 h-8 rounded-xl" />{:else}<span class="w-8 h-8 rounded-xl bg-surface-container"></span>{/if}
              <a href="/admin/servers/{o.guildId}" class="min-w-0 flex-1 text-sm font-medium text-on-surface hover:text-primary truncate">{o.name ?? o.guildId}</a>
              <span class="text-sm tabular-nums text-on-surface">{formatNumber(o.shared)}</span>
              <Button size="sm" variant="ghost" icon="Users" disabled={sharedLoading === o.guildId} onclick={() => showShared(o.guildId, o.name ?? o.guildId)}>Voir qui</Button>
            </li>
          {/each}
        </ul>
        {#if shared}
          <div class="mt-4 rounded-2xl border border-outline-variant p-4">
            <p class="text-sm font-medium text-on-surface mb-3">Membres aussi sur {shared.name} ({formatNumber(shared.members.length)}{shared.members.length >= 200 ? ' premiers' : ''})</p>
            <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-80 overflow-y-auto">
              {#each shared.members as p (p.userId)}
                <li class="flex items-center gap-2 min-w-0">
                  {#if p.avatarUrl}<img src={p.avatarUrl} alt="" class="w-6 h-6 rounded-full" loading="lazy" />{/if}
                  <span class="text-xs text-on-surface truncate">{p.name}</span>
                  {#if p.username}<span class="text-2xs text-on-surface-variant truncate">@{p.username}</span>{/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </AdminCard>
  </div>
{/if}
