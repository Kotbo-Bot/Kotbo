<script lang="ts">
  import {
    DROP_CLAIM_DAILY_LIMIT_RANGE,
    DROP_CLAIM_MIN_MEMBER_DAYS_RANGE,
    dropClaimRoleMissing,
    hasDropClaimRules,
    normalizeDropClaimRules,
    type DropClaimRules,
  } from '@kotbo/shared';
  import Papicon from './Papicon.svelte';
  import SearchableSelect from './SearchableSelect.svelte';
  import { m } from '../i18n';

  let {
    rules = $bindable(),
    roles,
    disabled = false,
  }: {
    rules: DropClaimRules;
    roles: Array<{ id: string; name: string }>;
    disabled?: boolean;
  } = $props();

  // Un champ vidé ou « Aucun » choisi laisse `null` ou `''` : relu comme l'API
  // le lira, la règle est éteinte et ne s'affiche pas comme active.
  const active = $derived(hasDropClaimRules(normalizeDropClaimRules(rules)));

  // Rôle requis supprimé sur Discord : le clic l'ignore, la page le dit. Rôles pas
  // encore chargés : rien n'est signalé sur une liste vide.
  const roleMissing = $derived(
    dropClaimRoleMissing(normalizeDropClaimRules(rules), roles.length > 0 ? roles.map((role) => role.id) : null),
  );

  // Règle éteinte (0) affichée en champ vide : le texte gris dit « Aucune … »,
  // comme l'option « Aucun » du rôle. Un champ vidé rééteint la règle.
  const off = (value: number) => value || null;

  // Replié par défaut : sans règle, tout le monde ramasse et il n'y a rien à
  // régler. Le badge de l'en-tête signale les règles actives sans l'ouvrir.
  let expanded = $state(false);

  const inputClass = 'w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-bold disabled:opacity-50';
</script>

<div class="border border-outline-variant/15 rounded-xl">
  <button
    type="button"
    onclick={() => expanded = !expanded}
    aria-expanded={expanded}
    aria-controls="drop-claim-rules"
    class="w-full flex items-start justify-between gap-4 p-4 text-left cursor-pointer"
  >
    <div>
      <h4 class="text-sm font-semibold flex items-center gap-2">
        <Papicon icon="ShieldCheck" size={15} /> {m.drop_claim_rules_title()}
        {#if active}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">{m.drop_claim_rules_active()}</span>
        {/if}
        {#if roleMissing}
          <span class="text-2xs font-semibold px-2 py-0.5 rounded-full bg-warning/10 text-warning">{m.drop_claim_required_role_missing_badge()}</span>
        {/if}
      </h4>
      <p class="text-xs text-on-surface-variant mt-0.5">{m.drop_claim_rules_desc()}</p>
    </div>
    <Papicon icon={expanded ? 'ChevronUp' : 'ChevronDown'} size={16} />
  </button>

  {#if expanded}
    <div id="drop-claim-rules" class="grid grid-cols-1 md:grid-cols-3 gap-4 px-4 pb-4">
      <div class="space-y-1.5">
        <label for="drop-claim-daily-limit" class="text-xs font-semibold text-on-surface-variant ml-1">{m.drop_claim_daily_limit_label()}</label>
        <input
          id="drop-claim-daily-limit"
          type="number"
          min="0"
          max={DROP_CLAIM_DAILY_LIMIT_RANGE.max}
          placeholder={m.drop_claim_daily_limit_off()}
          bind:value={() => off(rules.dailyLimit), (value) => rules.dailyLimit = value ?? 0}
          class={inputClass}
          {disabled}
        />
        <p class="text-2xs text-on-surface-variant mt-1">{m.drop_claim_daily_limit_desc()}</p>
      </div>

      <div class="space-y-1.5">
        <label for="drop-claim-min-days" class="text-xs font-semibold text-on-surface-variant ml-1">{m.drop_claim_min_days_label()}</label>
        <input
          id="drop-claim-min-days"
          type="number"
          min="0"
          max={DROP_CLAIM_MIN_MEMBER_DAYS_RANGE.max}
          placeholder={m.drop_claim_min_days_off()}
          bind:value={() => off(rules.minMemberDays), (value) => rules.minMemberDays = value ?? 0}
          class={inputClass}
          {disabled}
        />
        <p class="text-2xs text-on-surface-variant mt-1">{m.drop_claim_min_days_desc()}</p>
      </div>

      <div class="space-y-1.5">
        <label for="drop-claim-required-role" class="text-xs font-semibold text-on-surface-variant ml-1">{m.drop_claim_required_role_label()}</label>
        <SearchableSelect
          id="drop-claim-required-role"
          bind:value={rules.requiredRoleId}
          options={[{ id: '', name: m.drop_option_none() }, ...roles.map((role) => ({ id: role.id, name: `@${role.name}` }))]}
          placeholder={m.drop_select_role_placeholder()}
          {disabled}
        />
        <p class="text-2xs text-on-surface-variant mt-1">{m.drop_claim_required_role_desc()}</p>
        {#if roleMissing}
          <p class="text-2xs text-warning mt-1">{m.drop_claim_required_role_missing()}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
