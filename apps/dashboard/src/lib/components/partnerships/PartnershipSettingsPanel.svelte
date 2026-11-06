<script lang="ts">
  /**
   * Réglages du module Partenariats.
   *
   * Rangés dans l'ordre où on les rencontre : d'abord les salons et rôles sans
   * lesquels rien ne peut se poser, puis les candidatures, puis les
   * automatismes, puis ce qui sort du serveur (annuaire, réseau).
   *
   * Tous les automatismes sont éteints par défaut : ils touchent à des rôles,
   * à des salons et à des exemptions d'automod. Chaque bascule enregistre
   * immédiatement - un formulaire de trente champs avec un bouton final ne
   * pardonne pas une fermeture d'onglet.
   */
  import SectionCard from '../SectionCard.svelte';
  import FormSelect from '../FormSelect.svelte';
  import FormInput from '../FormInput.svelte';
  import Papicon from '../Papicon.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import { m } from '../../i18n';

  import type { DashboardChannel } from '@kotbo/contracts';
  // Le panneau n'affiche qu'un nom : la forme complete est celle que l'API
  // rend, et la redeclarer ici avait fini par diverger - `type` y etait
  // annonce en nombre alors que la reponse porte une chaine.
  type Channel = Pick<DashboardChannel, 'id' | 'name'>;
  type Role = { id: string; name: string };

  const {
    settings,
    channels = [],
    roles = [],
    tiers = [],
    onsave,
  }: {
    settings: Record<string, any> | null;
    channels?: Channel[];
    roles?: Role[];
    tiers?: { key: string; label: string; description: string }[];
    onsave: (patch: Record<string, unknown>) => void | Promise<void>;
  } = $props();

  function set(key: string, value: unknown) {
    void onsave({ [key]: value });
  }

  function toggle(key: string) {
    set(key, !settings?.[key]);
  }

  function number(key: string, event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) set(key, value);
  }

  /** Bascules regroupées, pour ne pas répéter trente fois le même balisage. */
  const automations = [
    { key: 'autoPublishAds', label: m.pset_auto_publish(), hint: m.pset_auto_publish_hint() },
    { key: 'reciprocityChecks', label: m.pset_reciprocity(), hint: m.pset_reciprocity_hint() },
    { key: 'autoApplyBenefits', label: m.pset_auto_benefits(), hint: m.pset_auto_benefits_hint() },
    { key: 'autoBreachOnFailure', label: m.pset_auto_breach(), hint: m.pset_auto_breach_hint() },
    { key: 'trackInvites', label: m.pset_track_invites(), hint: m.pset_track_invites_hint() },
    { key: 'trackReferredActivity', label: m.pset_track_activity(), hint: m.pset_track_activity_hint() },
  ];

  const notifications = [
    { key: 'notifyStaffChannel', label: m.pset_notify_staff() },
    { key: 'notifyDashboard', label: m.pset_notify_dashboard() },
    { key: 'notifyOwnerDm', label: m.pset_notify_owner_dm() },
  ];
</script>

<!-- Une bascule et son libelle : cliquer le texte bascule aussi. -->
{#snippet switchRow(key: string, label: string, hint = '', className = '')}
  <label class="flex {hint ? 'items-start' : 'items-center'} gap-3 cursor-pointer {className}">
    <ToggleSwitch size="sm" checked={!!settings?.[key]} onToggle={() => toggle(key)} ariaLabel={label} />
    <span>
      <span class="text-body-sm text-on-surface block">{label}</span>
      {#if hint}
        <span class="text-2xs text-on-surface-variant">{hint}</span>
      {/if}
    </span>
  </label>
{/snippet}

{#if !settings}
  <p class="text-xs text-on-surface-variant">{m.pset_unavailable()}</p>
{:else}
  <div class="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
    <!-- ── Activation ──────────────────────────────────────────────────── -->
    <SectionCard title={m.pset_module_title()} description={m.pset_module_desc()}>
      {@render switchRow('enabled', m.pset_enable(), m.pset_enable_hint())}

      <div class="mt-3">
        <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_default_tier()}</span>
        <FormSelect
          value={settings.defaultTier}
          className="w-full"
          onchange={(event) => set('defaultTier', (event.target as HTMLSelectElement).value)}
        >
          {#each tiers as tier (tier.key)}
            <option value={tier.key}>{tier.label}</option>
          {/each}
        </FormSelect>
      </div>

      {@render switchRow('requireDualApproval', m.pset_dual_approval(), m.pset_dual_approval_hint(), 'mt-3')}
    </SectionCard>

    <!-- ── Salons et rôles ─────────────────────────────────────────────── -->
    <SectionCard title={m.pset_channels_title()} description={m.pset_channels_desc()}>
      <div class="space-y-3">
        {#each [['staffChannelId', m.pset_staff_channel()], ['showcaseChannelId', m.pset_showcase_channel()], ['adsChannelId', m.pset_ads_channel()], ['digestChannelId', m.pset_digest_channel()]] as [key, label] (key)}
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{label}</span>
            <FormSelect
              value={settings[key] ?? ''}
              className="w-full"
              onchange={(event) => set(key, (event.target as HTMLSelectElement).value || null)}
            >
              <option value="">{m.common_none()}</option>
              {#each channels as channel (channel.id)}
                <option value={channel.id}>#{channel.name}</option>
              {/each}
            </FormSelect>
          </label>
        {/each}

        {#each [['partnerRoleId', m.pset_partner_role()], ['referredRoleId', m.pset_referred_role()]] as [key, label] (key)}
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{label}</span>
            <FormSelect
              value={settings[key] ?? ''}
              className="w-full"
              onchange={(event) => set(key, (event.target as HTMLSelectElement).value || null)}
            >
              <option value="">{m.common_none()}</option>
              {#each roles as role (role.id)}
                <option value={role.id}>{role.name}</option>
              {/each}
            </FormSelect>
          </label>
        {/each}
      </div>
    </SectionCard>

    <!-- ── Candidatures ────────────────────────────────────────────────── -->
    <SectionCard title={m.pset_applications_title()} description={m.pset_applications_desc()}>
      {@render switchRow('applicationsOpen', m.pset_applications_open(), m.pset_applications_open_hint())}

      <div class="grid grid-cols-2 gap-3 mt-3">
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_min_members()}</span>
          <FormInput type="number" value={settings.minMemberCount} onchange={(event) => number('minMemberCount', event)} />
        </label>
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_min_age()}</span>
          <FormInput type="number" value={settings.minServerAgeDays} onchange={(event) => number('minServerAgeDays', event)} />
        </label>
      </div>

      {@render switchRow('autoRejectBelowThreshold', m.pset_auto_reject(), m.pset_auto_reject_hint(), 'mt-3')}
    </SectionCard>

    <!-- ── Automatismes ────────────────────────────────────────────────── -->
    <SectionCard title={m.pset_automations_title()} description={m.pset_automations_desc()}>
      <div class="space-y-3">
        {#each automations as item (item.key)}
          {@render switchRow(item.key, item.label, item.hint)}
        {/each}

        <div class="grid grid-cols-2 gap-3 pt-2 border-t border-outline-variant/10">
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_reciprocity_interval()}</span>
            <FormInput type="number" value={settings.reciprocityIntervalHours} onchange={(event) => number('reciprocityIntervalHours', event)} />
          </label>
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_grace()}</span>
            <FormInput type="number" value={settings.reciprocityGraceCount} onchange={(event) => number('reciprocityGraceCount', event)} />
          </label>
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_renewal_notice()}</span>
            <FormInput type="number" value={settings.renewalNoticeDays} onchange={(event) => number('renewalNoticeDays', event)} />
          </label>
          <label class="block">
            <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_retention()}</span>
            <FormInput type="number" value={settings.retentionWindowDays} onchange={(event) => number('retentionWindowDays', event)} />
          </label>
        </div>
      </div>
    </SectionCard>

    <!-- ── Alertes ─────────────────────────────────────────────────────── -->
    <SectionCard title={m.pset_alerts_title()} description={m.pset_alerts_desc()}>
      <div class="space-y-3">
        {#each notifications as item (item.key)}
          {@render switchRow(item.key, item.label)}
        {/each}

        <label class="block pt-2 border-t border-outline-variant/10">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_digest()}</span>
          <FormSelect
            value={settings.digestFrequency}
            className="w-full"
            onchange={(event) => set('digestFrequency', (event.target as HTMLSelectElement).value)}
          >
            <option value="none">{m.common_none()}</option>
            <option value="weekly">{m.pset_weekly()}</option>
            <option value="monthly">{m.pset_monthly()}</option>
          </FormSelect>
        </label>
      </div>
    </SectionCard>

    <!-- ── Annuaire et réseau ──────────────────────────────────────────── -->
    <SectionCard title={m.pset_network_title()} description={m.pset_network_desc()}>
      <div class="space-y-3">
        {@render switchRow('directoryOptIn', m.pset_directory_opt_in(), m.pset_directory_opt_in_hint())}

        {@render switchRow('directoryAcceptProposals', m.pset_accept_proposals())}

        {@render switchRow('matchmakingEnabled', m.pset_matchmaking())}

        <div class="pt-2 border-t border-outline-variant/10 space-y-3">
          {@render switchRow('reputationShare', m.pset_reputation_share(), m.pset_reputation_share_hint())}

          {@render switchRow('reputationConsume', m.pset_reputation_consume(), m.pset_reputation_consume_hint())}
        </div>
      </div>
    </SectionCard>

    <!-- ── Finance ─────────────────────────────────────────────────────── -->
    <SectionCard title={m.pset_finance_title()} description={m.pset_finance_desc()}>
      {@render switchRow('financeEnabled', m.pset_finance_enable(), m.pset_finance_enable_hint())}

      <div class="grid grid-cols-2 gap-3 mt-3">
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_currency()}</span>
          <FormInput value={settings.currency} onchange={(event) => set('currency', (event.target as HTMLInputElement).value)} />
        </label>
        <label class="block">
          <span class="text-2xs font-bold text-on-surface-variant/80 ml-1 mb-1.5 block">{m.pset_payment_reminder()}</span>
          <FormInput type="number" value={settings.paymentReminderDays} onchange={(event) => number('paymentReminderDays', event)} />
        </label>
      </div>

      <p class="text-2xs text-on-surface-variant mt-3 flex items-start gap-1.5">
        <Papicon icon="info" size={12} class="mt-0.5 shrink-0" />
        <span>{m.pset_finance_note()}</span>
      </p>
    </SectionCard>
  </div>
{/if}
