<script lang="ts">
  /**
   * Reglages appliques aux salons qu'un generateur de vocaux temporaires cree.
   *
   * Ces valeurs etaient codees en dur dans le bot : le proprietaire recevait
   * toujours les trois memes pouvoirs, aucun role n'entrait d'office, et le
   * chat ecrit du salon n'etait reglable nulle part. Le meme editeur sert au
   * generateur principal et a chacun des generateurs additionnels : un seul
   * endroit a lire pour savoir ce qu'un salon recevra.
   */
  import SearchableSelect from './SearchableSelect.svelte';
  import Papicon from './Papicon.svelte';
  import { m } from '../i18n';
  import type { TempVoicePolicy, TempVoiceOwnerPower, TempVoiceTextChatMode } from '../api/moderation';

  let {
    policy = $bindable(),
    availableRoles = [],
    idPrefix = 'temp-voice-policy',
  }: {
    policy: TempVoicePolicy;
    availableRoles: Array<{ id: string; name: string }>;
    idPrefix?: string;
  } = $props();

  /** Le bot applique la meme borne : au-dela, Discord refuse la valeur. */
  const MAX_USER_LIMIT = 99;
  const MAX_AUTO_ALLOW_ROLES = 10;

  const OWNER_POWERS: Array<{ key: TempVoiceOwnerPower; label: () => string; hint: () => string }> = [
    { key: 'mute', label: () => m.cm_tv_power_mute(), hint: () => m.cm_tv_power_mute_hint() },
    { key: 'deafen', label: () => m.cm_tv_power_deafen(), hint: () => m.cm_tv_power_deafen_hint() },
    { key: 'move', label: () => m.cm_tv_power_move(), hint: () => m.cm_tv_power_move_hint() },
    { key: 'manageChannel', label: () => m.cm_tv_power_manage_channel(), hint: () => m.cm_tv_power_manage_channel_hint() },
    { key: 'manageMessages', label: () => m.cm_tv_power_manage_messages(), hint: () => m.cm_tv_power_manage_messages_hint() },
  ];

  const TEXT_CHAT_MODES: Array<{ key: TempVoiceTextChatMode; label: () => string; hint: () => string }> = [
    { key: 'inherit', label: () => m.cm_tv_chat_inherit(), hint: () => m.cm_tv_chat_inherit_hint() },
    { key: 'open', label: () => m.cm_tv_chat_open(), hint: () => m.cm_tv_chat_open_hint() },
    { key: 'locked', label: () => m.cm_tv_chat_locked(), hint: () => m.cm_tv_chat_locked_hint() },
  ];

  /** Choix de role restants : un role deja autorise n'a pas a etre reproposé. */
  const selectableRoles = $derived(
    availableRoles.filter((role) => !policy.autoAllowRoleIds.includes(role.id)),
  );

  const roleName = (roleId: string) => availableRoles.find((role) => role.id === roleId)?.name ?? roleId;

  let roleToAdd = $state('');

  function addRole(roleId: string | null) {
    if (!roleId) return;
    if (policy.autoAllowRoleIds.includes(roleId)) return;
    if (policy.autoAllowRoleIds.length >= MAX_AUTO_ALLOW_ROLES) return;
    policy.autoAllowRoleIds = [...policy.autoAllowRoleIds, roleId];
    // Le champ se vide : sans cela, le role choisi reste affiche alors qu'il
    // figure deja dans la liste juste en dessous.
    roleToAdd = '';
  }

  function removeRole(roleId: string) {
    policy.autoAllowRoleIds = policy.autoAllowRoleIds.filter((id) => id !== roleId);
  }

  function togglePower(power: TempVoiceOwnerPower) {
    policy.ownerPowers = policy.ownerPowers.includes(power)
      ? policy.ownerPowers.filter((entry) => entry !== power)
      : [...policy.ownerPowers, power];
  }

  function onUserLimitInput(event: Event) {
    const raw = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10);
    policy.userLimit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_USER_LIMIT) : 0;
  }
</script>

<div class="space-y-5 pt-5 border-t border-outline-variant/10">
  <div>
    <h5 class="text-xs font-semibold flex items-center gap-2 text-primary uppercase tracking-wider">
      <Papicon icon="shield" size={14} />
      {m.cm_tv_policy_title()}
    </h5>
    <p class="text-[11px] text-on-surface-variant/60 mt-1">{m.cm_tv_policy_desc()}</p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
    <!-- Places par défaut -->
    <div class="space-y-1.5">
      <label for="{idPrefix}-user-limit" class="text-xs font-bold text-on-surface/80 block">
        {m.cm_tv_user_limit_label()}
      </label>
      <input
        id="{idPrefix}-user-limit"
        type="number"
        min="0"
        max={MAX_USER_LIMIT}
        value={policy.userLimit}
        oninput={onUserLimitInput}
        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 transition-all"
      />
      <p class="text-[10px] text-on-surface-variant/40">{m.cm_tv_user_limit_hint()}</p>
    </div>

    <!-- Créer verrouillé -->
    <div class="space-y-1.5">
      <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_lock_label()}</span>
      <label
        for="{idPrefix}-lock-on-create"
        class="flex items-start gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg px-4 py-2.5 cursor-pointer hover:border-primary/30 transition-all"
      >
        <input
          id="{idPrefix}-lock-on-create"
          type="checkbox"
          bind:checked={policy.lockOnCreate}
          class="mt-0.5 accent-primary w-4 h-4 shrink-0"
        />
        <span class="text-[11px] text-on-surface-variant/70 leading-relaxed">{m.cm_tv_lock_hint()}</span>
      </label>
    </div>
  </div>

  <!-- Chat écrit du salon -->
  <div class="space-y-2">
    <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_chat_label()}</span>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {#each TEXT_CHAT_MODES as mode (mode.key)}
        <label
          for="{idPrefix}-chat-{mode.key}"
          class="flex flex-col gap-1 border rounded-lg px-4 py-3 cursor-pointer transition-all {policy.textChat === mode.key
            ? 'bg-primary/10 border-primary/40'
            : 'bg-surface-container-high/20 border-outline-variant/10 hover:border-primary/20'}"
        >
          <span class="flex items-center gap-2 text-xs font-bold text-on-surface">
            <input
              id="{idPrefix}-chat-{mode.key}"
              type="radio"
              value={mode.key}
              bind:group={policy.textChat}
              class="accent-primary w-3.5 h-3.5"
            />
            {mode.label()}
          </span>
          <span class="text-[10px] text-on-surface-variant/60 leading-relaxed">{mode.hint()}</span>
        </label>
      {/each}
    </div>
  </div>

  <!-- Rôles autorisés d'office -->
  <div class="space-y-2">
    <label for="{idPrefix}-auto-allow" class="text-xs font-bold text-on-surface/80 block">
      {m.cm_tv_auto_allow_label()}
    </label>
    <p class="text-[10px] text-on-surface-variant/40">{m.cm_tv_auto_allow_hint()}</p>

    {#if policy.autoAllowRoleIds.length > 0}
      <div class="flex flex-wrap gap-2">
        {#each policy.autoAllowRoleIds as roleId (roleId)}
          <span class="inline-flex items-center gap-1.5 bg-primary/10 border border-primary/20 text-primary text-[11px] font-semibold rounded-full pl-3 pr-1.5 py-1">
            @{roleName(roleId)}
            <button
              type="button"
              onclick={() => removeRole(roleId)}
              class="hover:bg-primary/20 rounded-full p-0.5 transition-all"
              aria-label={m.cm_tv_auto_allow_remove({ role: roleName(roleId) })}
            >
              <Papicon icon="x" size={12} />
            </button>
          </span>
        {/each}
      </div>
    {/if}

    {#if policy.autoAllowRoleIds.length >= MAX_AUTO_ALLOW_ROLES}
      <p class="text-[10px] text-on-surface-variant/60">{m.cm_tv_auto_allow_full({ max: MAX_AUTO_ALLOW_ROLES })}</p>
    {:else}
      <SearchableSelect
        id="{idPrefix}-auto-allow"
        options={selectableRoles.map((role) => ({ id: role.id, name: `@${role.name}` }))}
        bind:value={roleToAdd}
        placeholder={m.cm_tv_auto_allow_placeholder()}
        on:change={(event) => addRole((event.detail?.id as string | undefined) ?? roleToAdd)}
      />
    {/if}
  </div>

  <!-- Pouvoirs du propriétaire -->
  <div class="space-y-2">
    <span class="text-xs font-bold text-on-surface/80 block">{m.cm_tv_owner_powers_label()}</span>
    <p class="text-[10px] text-on-surface-variant/40">{m.cm_tv_owner_powers_hint()}</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {#each OWNER_POWERS as power (power.key)}
        <label
          for="{idPrefix}-power-{power.key}"
          class="flex items-start gap-3 bg-surface-container-high/20 border border-outline-variant/10 rounded-lg px-4 py-2.5 cursor-pointer hover:border-primary/30 transition-all"
        >
          <input
            id="{idPrefix}-power-{power.key}"
            type="checkbox"
            checked={policy.ownerPowers.includes(power.key)}
            onchange={() => togglePower(power.key)}
            class="mt-0.5 accent-primary w-4 h-4 shrink-0"
          />
          <span class="flex flex-col gap-0.5">
            <span class="text-xs font-bold text-on-surface">{power.label()}</span>
            <span class="text-[10px] text-on-surface-variant/60 leading-relaxed">{power.hint()}</span>
          </span>
        </label>
      {/each}
    </div>
  </div>
</div>
