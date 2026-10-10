<!--
  Profil de l'auteur du ticket, à droite de la conversation comme le panneau
  de profil de Discord : identité, rôles, ancienneté, puis ce qu'un membre du
  staff veut savoir avant de répondre (casier, tickets passés, points
  d'attention, note interne). La fiche complète et le dossier restent à un clic.
-->
<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { Button } from '../ui';
  import { memberAvatarSrc } from '../../discordMedia';
  import { m, dateLocale } from '../../i18n';
  import { fetchMemberCase, fetchMemberSummary, type MemberSummary } from '../../api';
  import type { MemberCaseResponse } from '@kotbo/contracts';

  const {
    userId,
    fallbackName = '',
    onopencase,
  }: {
    userId: string;
    fallbackName?: string;
    /** Ouvre le dossier détaillé (sanctions, notes, actions) dans la fenêtre de la page. */
    onopencase: (userId: string, name: string) => void;
  } = $props();

  let caseData = $state<MemberCaseResponse | null>(null);
  let summary = $state<MemberSummary | null>(null);
  let loading = $state(true);

  // Dernier membre demandé : un changement de ticket pendant le chargement ne
  // doit pas laisser s'afficher le profil du précédent.
  let requested = '';

  $effect(() => {
    const id = userId;
    requested = id;
    loading = true;
    caseData = null;
    summary = null;
    void Promise.all([
      fetchMemberCase(id).catch(() => null),
      fetchMemberSummary(id).catch(() => null),
    ]).then(([caseResult, summaryResult]) => {
      if (requested !== id) return;
      caseData = caseResult;
      summary = summaryResult?.summary ?? null;
      loading = false;
    });
  });

  const profile = $derived(caseData?.profile ?? null);
  const name = $derived(profile?.displayName || profile?.globalName || profile?.username || fallbackName || m.mb_member_fallback());
  const banner = $derived(
    profile?.bannerUrl
      ? `url("${profile.bannerUrl}") center / cover`
      : profile?.accentColor
        ? `#${profile.accentColor.toString(16).padStart(6, '0')}`
        : 'var(--primary)',
  );

  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  /** Casier : sanctions non archivées, comptées par type, plus les trois dernières. */
  const record = $derived.by(() => {
    const sanctions = (caseData?.sanctions ?? []).filter((sanction) => !sanction.archivedAt);
    const counts = { WARN: 0, TIMEOUT: 0, KICK: 0, BAN: 0 };
    for (const sanction of sanctions) {
      if (sanction.type === 'WARN') counts.WARN += 1;
      else if (sanction.type === 'TIMEOUT') counts.TIMEOUT += 1;
      else if (sanction.type === 'KICK') counts.KICK += 1;
      else counts.BAN += 1;
    }
    return { total: sanctions.length, counts, recent: sanctions.slice(0, 3), active: sanctions.filter((s) => s.status === 'ACTIVE' && s.type !== 'WARN').length };
  });

  const SANCTION_LABEL: Record<string, () => string> = {
    WARN: () => m.tmp_warn(),
    TIMEOUT: () => m.tmp_timeout(),
    KICK: () => m.tmp_kick(),
    TEMP_BAN: () => m.tmp_ban(),
    BAN: () => m.tmp_ban(),
    SOFTBAN: () => m.tmp_ban(),
  };

  const SIGNAL_CLASS = {
    danger: 'bg-error/10 text-error',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-surface-container text-on-surface-variant',
  } as const;
</script>

<div class="tmp">
  {#if loading && !caseData}
    <div class="p-4 space-y-3">
      <Skeleton height="h-20" />
      <Skeleton height="h-6" />
      <Skeleton height="h-24" />
      <Skeleton height="h-24" />
    </div>
  {:else}
    <div class="tmp__banner" style="background: {banner};"></div>
    <div class="tmp__head">
      <img class="tmp__avatar" src={memberAvatarSrc(profile?.avatarUrl, name, userId)} alt="" />
      <div class="flex flex-wrap gap-1 justify-end pt-2">
        {#if profile && !profile.isOnServer}<span class="tmp-chip bg-surface-container text-on-surface-variant">{m.mp_left()}</span>{/if}
        {#if profile?.staffGrade}<span class="tmp-chip bg-primary/10 text-primary">{profile.staffGrade}</span>{/if}
      </div>
    </div>

    <div class="tmp__body">
      <div>
        <p class="text-base font-bold text-on-surface leading-tight truncate">{name}</p>
        <p class="text-body-sm text-on-surface-variant truncate">@{profile?.username ?? userId}{#if profile?.pronouns} · {profile.pronouns}{/if}</p>
      </div>

      {#if summary && summary.signals.length > 0}
        <div class="flex flex-wrap gap-1">
          {#each summary.signals.slice(0, 4) as signal (signal.key + signal.label)}
            <span class="tmp-chip {SIGNAL_CLASS[signal.tone]}">{signal.label}</span>
          {/each}
        </div>
      {/if}

      <section class="tmp__section">
        <h4>{m.tmp_member_since()}</h4>
        <dl class="tmp__dates">
          <div><dt><Papicon icon="log-in" size={12} /> {m.mp_joined()}</dt><dd>{formatDate(profile?.guildJoinedAt)}</dd></div>
          <div><dt><Papicon icon="user" size={12} /> {m.mp_account_created()}</dt><dd>{formatDate(profile?.accountCreatedAt)}</dd></div>
        </dl>
      </section>

      {#if caseData && caseData.roles.length > 0}
        <section class="tmp__section">
          <h4>{m.mp_roles({ count: caseData.roles.length })}</h4>
          <div class="flex flex-wrap gap-1">
            {#each caseData.roles.slice(0, 12) as role (role.id)}
              <span class="tmp-role"><span class="w-2 h-2 rounded-full" style="background: {role.color && role.color !== '#000000' ? role.color : 'var(--outline-variant)'}"></span>{role.name}</span>
            {/each}
            {#if caseData.roles.length > 12}<span class="tmp-role">+{caseData.roles.length - 12}</span>{/if}
          </div>
        </section>
      {/if}

      <section class="tmp__section">
        <h4>{m.tmp_record()}</h4>
        {#if record.total === 0}
          <p class="text-body-sm text-on-surface-variant">{m.tmp_record_clean()}</p>
        {:else}
          <div class="tmp__counts">
            <div><strong>{record.counts.WARN}</strong><span>{m.tmp_warn()}</span></div>
            <div><strong>{record.counts.TIMEOUT}</strong><span>{m.tmp_timeout()}</span></div>
            <div><strong>{record.counts.KICK}</strong><span>{m.tmp_kick()}</span></div>
            <div><strong>{record.counts.BAN}</strong><span>{m.tmp_ban()}</span></div>
          </div>
          <ul class="space-y-1.5 mt-2">
            {#each record.recent as sanction (sanction.id)}
              <li class="text-2xs text-on-surface-variant">
                <span class="font-semibold text-on-surface">{SANCTION_LABEL[sanction.type]?.() ?? sanction.type}</span>
                · {formatDate(sanction.createdAt)}
                {#if sanction.reason}<span class="block truncate">{sanction.reason}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if summary}
        <section class="tmp__section">
          <h4>{m.mp_tickets()}</h4>
          <p class="text-body-sm text-on-surface">
            {m.tmp_tickets({ count: summary.support.tickets })}
            {#if summary.support.averageRating !== null}<span class="text-on-surface-variant"> · {m.mp_tickets_rating({ rating: summary.support.averageRating })}</span>{/if}
          </p>
        </section>
      {/if}

      {#if profile?.moderatorNote}
        <section class="tmp__section">
          <h4>{m.mp_note()}</h4>
          <p class="text-body-sm text-on-surface whitespace-pre-line line-clamp-4">{profile.moderatorNote}</p>
        </section>
      {/if}

      <div class="flex flex-col gap-1.5 pt-1">
        <Button size="sm" icon="folder" fullWidth onclick={() => onopencase(userId, name)}>{m.mp_open_case()}</Button>
        <Button size="sm" variant="ghost" icon="user" fullWidth href={`/members/${userId}`}>{m.mcm_open_profile()}</Button>
      </div>
    </div>
  {/if}
</div>

<style>
  .tmp {
    height: 100%;
    overflow-y: auto;
  }
  .tmp__banner {
    height: 4.5rem;
  }
  .tmp__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 0.9rem;
    margin-top: -2.25rem;
  }
  .tmp__avatar {
    width: 4.5rem;
    height: 4.5rem;
    border-radius: 999px;
    border: 5px solid var(--surface-container-low);
    background: var(--surface-container);
    object-fit: cover;
    flex-shrink: 0;
  }
  .tmp__body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem 0.9rem 1rem;
  }
  .tmp__section {
    padding: 0.7rem 0.8rem;
    border-radius: 0.6rem;
    background: var(--surface-container-lowest);
  }
  .tmp__section h4 {
    margin-bottom: 0.4rem;
    font-size: 0.6875rem;
    font-weight: 700;
    color: var(--on-surface-variant);
  }
  .tmp__dates {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.75rem;
  }
  .tmp__dates div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .tmp__dates dt {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--on-surface-variant);
  }
  .tmp__dates dd {
    color: var(--on-surface);
  }
  .tmp__counts {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
    text-align: center;
  }
  .tmp__counts strong {
    display: block;
    font-size: 1rem;
    color: var(--on-surface);
    font-variant-numeric: tabular-nums;
  }
  .tmp__counts span {
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
  }
  .tmp-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 500;
  }
  .tmp-role {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.35rem;
    background: var(--surface-container);
    font-size: 0.6875rem;
    color: var(--on-surface);
  }
</style>
