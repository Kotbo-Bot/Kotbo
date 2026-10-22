<script lang="ts">
  /**
   * Verification d'identite (OAuth du multi-comptes), partagee entre
   * Securite > Multi-comptes et la page Reglement. Charge et enregistre seule
   * sa config : les deux pages voient les memes reglages.
   */
  import { onMount } from 'svelte';
  import { m } from '../../i18n';
  import { channelDisplayName } from '../../channelUtils';
  import { authStore } from '../../stores/auth.svelte';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { fetchVerificationConfig, updateVerificationConfig, updateModuleStatus } from '../../api';
  import Papicon from '../Papicon.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import SearchableSelect from '../SearchableSelect.svelte';

  let {
    /** false : masque les reglages de warns, sans rapport avec l'entree des membres. */
    showWarnSettings = true,
    /** Etat enregistre (et non celui de l'interrupteur en cours d'edition). */
    enabled = $bindable(false),
  }: { showWarnSettings?: boolean; enabled?: boolean } = $props();

  let verifConfig = $state<{
    verificationEnabled: boolean;
    verificationMode: string;
    verificationAction: string;
    verificationChannelId: string | null;
    verificationFallbackChannelId: string | null;
    verificationRoleId: string | null;
    verificationLogChannelId: string | null;
    verificationEmbedTitle: string;
    verificationEmbedDesc: string;
    verificationEmbedColor: string;
    verificationOnJoin: boolean;
    verificationSaveIp: boolean;
    verificationSaveDevice: boolean;
    verificationLevelCommand: string;
    verificationLevelJoin: string;
    verificationWarnThreshold: number | null;
    warnWeightingEnabled: boolean;
    warnDecayDays: number | null;
    countArchivedInWarnScore: boolean;
    warnAutoArchiveDays: number | null;
    wordStatsEnabled: boolean;
    banHygieneEnabled: boolean;
    verificationWarnAutoMode: string;
    verificationWarnReason: string;
  } | null>(null);
  let deployingEmbed = $state(false);
  let saving = $state(false);
  let verifModuleEnabled = $state(false);

  async function loadVerifConfig() {
    // Un refus ne doit pas laisser l'onglet vide : la verification est un module
    // a part, eteint par defaut, et sa route se ferme avec lui. Sans valeurs par
    // defaut, il n'y avait plus d'interrupteur pour l'allumer.
    let data: any = null;
    try {
      data = await fetchVerificationConfig();
      verifModuleEnabled = !!data;
    } catch {
      verifModuleEnabled = false;
    }
    verifConfig = {
      verificationEnabled: data?.verificationEnabled ?? false,
      verificationMode: data?.verificationMode ?? 'EMBED',
      verificationAction: data?.verificationAction ?? 'NOTIFY_STAFF',
      verificationChannelId: data?.verificationChannelId ?? null,
      verificationFallbackChannelId: data?.verificationFallbackChannelId ?? null,
      verificationRoleId: data?.verificationRoleId ?? null,
      verificationLogChannelId: data?.verificationLogChannelId ?? null,
      verificationEmbedTitle: data?.verificationEmbedTitle ?? m.da_default_embed_title(),
      verificationEmbedDesc: data?.verificationEmbedDesc ?? '',
      verificationEmbedColor: data?.verificationEmbedColor ?? '#5865F2',
      verificationOnJoin: data?.verificationOnJoin ?? true,
      verificationSaveIp: data?.verificationSaveIp ?? true,
      verificationSaveDevice: data?.verificationSaveDevice ?? true,
      verificationLevelCommand: data?.verificationLevelCommand ?? 'HIGH',
      verificationLevelJoin: data?.verificationLevelJoin ?? 'HIGH',
      verificationWarnThreshold: data?.verificationWarnThreshold ?? null,
      warnWeightingEnabled: data?.warnWeightingEnabled ?? false,
      warnDecayDays: data?.warnDecayDays ?? null,
      countArchivedInWarnScore: data?.countArchivedInWarnScore ?? false,
      warnAutoArchiveDays: data?.warnAutoArchiveDays ?? null,
      wordStatsEnabled: data?.wordStatsEnabled ?? false,
      banHygieneEnabled: data?.banHygieneEnabled ?? true,
      verificationWarnAutoMode: data?.verificationWarnAutoMode ?? 'FULL_AUTO',
      verificationWarnReason: data?.verificationWarnReason ?? m.da_default_warn_reason(),
    };
    enabled = verifConfig.verificationEnabled;
  }

  async function saveVerifConfig() {
    if (!verifConfig || saving) return;
    saving = true;
    try {
      // L'interrupteur pilote le module « Verification de securite » : sa route
      // de configuration se ferme quand il est eteint, donc on l'allume avant
      // d'ecrire et on l'eteint apres.
      const enabling = verifConfig.verificationEnabled && !verifModuleEnabled;
      const disabling = !verifConfig.verificationEnabled && verifModuleEnabled;

      if (enabling) {
        const toggled = await updateModuleStatus('security_verification', 'active');
        if (!toggled) throw new Error(m.da_error_api());
        verifModuleEnabled = true;
      }

      if (verifModuleEnabled) {
        const ok = await updateVerificationConfig(verifConfig);
        if (!ok) throw new Error(m.da_error_api());
      }

      if (disabling) {
        const toggled = await updateModuleStatus('security_verification', 'inactive');
        if (!toggled) throw new Error(m.da_error_api());
        verifModuleEnabled = false;
      }
      enabled = verifConfig.verificationEnabled;
      toast.success(m.da_verif_updated());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.da_error_api());
    } finally {
      saving = false;
    }
  }

  async function deployVerifEmbed() {
    if (!verifConfig?.verificationChannelId || !authStore.selectedGuildId) return;
    deployingEmbed = true;
    try {
      const res = await fetch(`${(import.meta.env.VITE_API_URL ?? '').trim().replace(/\/$/, '')}/api/verify/${authStore.selectedGuildId}/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authStore.token}` },
        body: JSON.stringify({ channelId: verifConfig.verificationChannelId }),
      });
      const data = await res.json();
      if (res.ok) toast.success(m.da_embed_sent());
      else toast.error(data.error || m.da_embed_send_error());
    } catch { toast.error(m.da_embed_deploy_error()); }
    finally { deployingEmbed = false; }
  }

  onMount(loadVerifConfig);
</script>

{#if verifConfig}
  <div class="space-y-6">
    <!-- Enable toggle -->
    <div class="flex items-center justify-between gap-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container-low/30">
      <div class="flex items-center gap-3">
        <div class="h-9 w-9 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0">
          <Papicon icon="ShieldCheck" size={18} />
        </div>
        <div>
          <p class="font-bold text-on-surface text-sm">{m.da_verification()}</p>
          <p class="text-xs text-on-surface-variant">{m.da_oauth_verify()}</p>
        </div>
      </div>
      <ToggleSwitch
        checked={verifConfig.verificationEnabled}
        onToggle={(v) => { verifConfig!.verificationEnabled = v; }}
        activeClass="bg-indigo-500"
      />
    </div>

    {#if verifConfig.verificationEnabled}
      <!-- Mode & Action -->
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_send_mode()}</span>
          <select bind:value={verifConfig.verificationMode} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
            <option value="DM">{m.da_mode_dm()}</option>
            <option value="EMBED">{m.da_embed_button()}</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_action_if_dc()}</span>
          <select bind:value={verifConfig.verificationAction} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
            <option value="NOTIFY_STAFF">{m.da_notify_staff()}</option>
            <option value="AUTO_LINK">{m.da_auto_link()}</option>
          </select>
        </label>
      </div>

      <!-- Niveaux de vérification -->
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_level_command()}</span>
          <select bind:value={verifConfig.verificationLevelCommand} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
            <option value="LOW">{m.da_level_low()}</option>
            <option value="MEDIUM">{m.da_level_medium()}</option>
            <option value="HIGH">{m.da_level_high()}</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_level_join()}</span>
          <select bind:value={verifConfig.verificationLevelJoin} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm">
            <option value="LOW">{m.da_level_low()}</option>
            <option value="MEDIUM">{m.da_level_medium()}</option>
            <option value="HIGH">{m.da_level_high()}</option>
          </select>
        </label>
      </div>


      <!-- Channels & Roles -->
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_verify_channel()}</span>
          <SearchableSelect bind:value={verifConfig.verificationChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_no_channel()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_verified_role()}</span>
          <SearchableSelect bind:value={verifConfig.verificationRoleId} options={dashboardStore.state.discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.da_no_role()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_log_channel()}</span>
          <SearchableSelect bind:value={verifConfig.verificationLogChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_default()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
        </label>
        <label class="space-y-1.5 sm:col-span-2 lg:col-span-3">
          <span class="text-xs font-semibold text-on-surface-variant/40">{m.da_fallback_channel()}</span>
          <SearchableSelect bind:value={verifConfig.verificationFallbackChannelId} options={dashboardStore.state.discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.da_default_verify_channel()} className="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
          <span class="block text-2xs text-on-surface-variant">{m.da_fallback_channel_desc()}</span>
        </label>
      </div>

      <!-- Embed customization -->
      <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_embed_title()}</span>
          <input type="text" bind:value={verifConfig.verificationEmbedTitle} maxlength="256" class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" />
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-medium text-on-surface-variant/40">{m.da_color()}</span>
          <div class="flex items-center gap-2">
            <input type="color" bind:value={verifConfig.verificationEmbedColor} class="h-9.5 w-9.5 rounded-lg border border-outline-variant/10 bg-transparent cursor-pointer shrink-0" />
            <input type="text" bind:value={verifConfig.verificationEmbedColor} maxlength="7" class="flex-1 rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm font-mono" />
          </div>
        </label>
      </div>

      <label class="space-y-1.5">
        <span class="text-xs font-medium text-on-surface-variant/40">{m.da_description()}</span>
        <textarea bind:value={verifConfig.verificationEmbedDesc} rows="3" maxlength="2048" class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm resize-y"></textarea>
      </label>

      <!-- Auto on join -->
      <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
        <div>
          <p class="font-bold text-on-surface text-sm">{m.da_verify_on_join()}</p>
          <p class="text-xs text-on-surface-variant">{m.da_verify_on_join_desc()}</p>
        </div>
        <ToggleSwitch
          checked={verifConfig.verificationOnJoin}
          onToggle={(v) => { verifConfig!.verificationOnJoin = v; }}
          activeClass="bg-indigo-500"
        />
      </div>

      <!-- Save IP -->
      <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
        <div>
          <p class="font-bold text-on-surface text-sm">{m.da_save_ip()}</p>
          <p class="text-xs text-on-surface-variant">{m.da_save_ip_desc()}</p>
        </div>
        <ToggleSwitch
          checked={verifConfig.verificationSaveIp}
          onToggle={(v) => { verifConfig!.verificationSaveIp = v; }}
          activeClass="bg-indigo-500"
        />
      </div>

      <!-- Save Device Info -->
      <div class="flex items-center justify-between gap-4 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/30">
        <div>
          <p class="font-bold text-on-surface text-sm">{m.da_save_device_full()}</p>
          <p class="text-xs text-on-surface-variant">{m.da_save_device_desc()}</p>
        </div>
        <ToggleSwitch
          checked={verifConfig.verificationSaveDevice}
          onToggle={(v) => { verifConfig!.verificationSaveDevice = v; }}
          activeClass="bg-indigo-500"
        />
      </div>

      {#if showWarnSettings}
      <!-- Warn Threshold Auto-Verification -->
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-4 space-y-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="h-7 w-7 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400 shrink-0">
              <Papicon icon="AlertTriangle" size={15} />
            </div>
            <div>
              <p class="font-bold text-on-surface text-sm">{m.da_verify_on_warns()}</p>
              <p class="text-xs text-on-surface-variant">{m.da_verify_on_warns_desc()}</p>
            </div>
          </div>

          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_threshold()}</span>
              <div class="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="99"
                  placeholder={m.da_disabled_zero()}
                  value={verifConfig.verificationWarnThreshold ?? ''}
                  oninput={(e) => {
                    const v = parseInt((e.target as HTMLInputElement).value);
                    verifConfig!.verificationWarnThreshold = isNaN(v) || v <= 0 ? null : v;
                  }}
                  class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                />
                {#if !verifConfig.verificationWarnThreshold}
                  <span class="text-xs text-on-surface-variant/40 whitespace-nowrap">{m.da_disabled()}</span>
                {/if}
              </div>
              <p class="text-2xs text-on-surface-variant/40">{m.da_empty_to_disable()}</p>
            </label>

            <label class="space-y-1.5">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_trigger_mode()}</span>
              <select bind:value={verifConfig.verificationWarnAutoMode} class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm" disabled={!verifConfig.verificationWarnThreshold}>
                <option value="FULL_AUTO">{m.da_mode_full_auto_opt()}</option>
                <option value="NOTIFY_STAFF">{m.da_mode_notify_opt()}</option>
              </select>
            </label>
          </div>

          {#if verifConfig.verificationWarnThreshold}
            <label class="space-y-1.5 block">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_reason_label()}</span>
              <input
                type="text"
                maxlength="512"
                bind:value={verifConfig.verificationWarnReason}
                class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
              />
            </label>

            <div class="flex items-start gap-2 p-3 rounded-lg bg-orange-500/5 border border-orange-500/15 text-xs text-orange-300">
              <Papicon icon="Info" size={13} class_="shrink-0 mt-0.5" />
              <span>
                {#if verifConfig.verificationWarnAutoMode === 'FULL_AUTO'}
                  {m.da_in_mode()} <strong>{m.da_full_auto()}</strong>{m.da_full_auto_desc_1()} <strong>{verifConfig.verificationWarnThreshold > 1 ? m.da_warn_other({ n: verifConfig.verificationWarnThreshold }) : m.da_warn_one({ n: verifConfig.verificationWarnThreshold })}</strong>.
                {:else}
                  {m.da_in_mode()} <strong>{m.da_notify_staff_mode()}</strong>{m.da_full_auto_desc_2()}
                {/if}
              </span>
            </div>
          {/if}

          <!-- Archivage des warns : expiration automatique + poids au score -->
          <div class="pt-4 mt-2 border-t border-outline-variant/10 space-y-4">
            <label class="space-y-1.5 block">
              <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_auto_archive()}</span>
              <input
                type="number"
                min="0"
                max="3650"
                placeholder={m.da_never_zero()}
                value={verifConfig.warnAutoArchiveDays ?? ''}
                oninput={(e) => {
                  const v = parseInt((e.target as HTMLInputElement).value);
                  verifConfig!.warnAutoArchiveDays = isNaN(v) || v <= 0 ? null : v;
                }}
                class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
              />
              <p class="text-2xs text-on-surface-variant/40">{m.da_warn_auto_archive_hint()}</p>
            </label>

            <label class="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={verifConfig.countArchivedInWarnScore} class="mt-0.5 accent-indigo-500" />
              <span>
                <span class="text-sm font-medium text-on-surface block">{m.da_count_archived()}</span>
                <span class="text-2xs text-on-surface-variant block mt-0.5">{m.da_count_archived_desc()}</span>
              </span>
            </label>
          </div>

          <!-- Warns pondérés -->
          <div class="pt-4 mt-2 border-t border-outline-variant/10 space-y-4">
            <label class="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={verifConfig.warnWeightingEnabled} class="mt-0.5 accent-indigo-500" />
              <span>
                <span class="text-sm font-medium text-on-surface block">{m.da_weighted_warns()}</span>
                <span class="text-2xs text-on-surface-variant block mt-0.5">
                  {m.da_weighted_warns_desc_1()} <code class="text-indigo-400">/sanction warn</code>. {m.da_weighted_warns_desc_2()}
                  <strong>{m.da_weighted_warns_score()}</strong> {m.da_weighted_warns_desc_3()}
                </span>
              </span>
            </label>

            {#if verifConfig.warnWeightingEnabled}
              <label class="space-y-1.5 block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.da_warn_decay()}</span>
                <input
                  type="number"
                  min="0"
                  max="3650"
                  placeholder={m.da_never_zero()}
                  value={verifConfig.warnDecayDays ?? ''}
                  oninput={(e) => {
                    const v = parseInt((e.target as HTMLInputElement).value);
                    verifConfig!.warnDecayDays = isNaN(v) || v <= 0 ? null : v;
                  }}
                  class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-3 py-2.5 text-sm"
                />
                <p class="text-2xs text-on-surface-variant/40">
                  {m.da_warn_decay_hint()}
                </p>
              </label>

              <div class="flex items-start gap-2 p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/15 text-xs text-indigo-300">
                <Papicon icon="Info" size={13} class_="shrink-0 mt-0.5" />
                <span>
                  {m.da_threshold_hint()} <strong>{verifConfig.verificationWarnThreshold ?? '-'}</strong>,
                  {verifConfig.verificationWarnThreshold ? m.da_threshold_needed({ light: verifConfig.verificationWarnThreshold, severe: Math.ceil(verifConfig.verificationWarnThreshold / 3) }) : m.da_threshold_configure()}{verifConfig.warnDecayDays ? m.da_threshold_decay({ days: verifConfig.warnDecayDays }) : ''}.
                  {m.da_existing_warns_hint()}
                </span>
              </div>
            {/if}
          </div>

          <!-- Statistiques de mots -->
          <div class="pt-4 mt-2 border-t border-outline-variant/10">
            <label class="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={verifConfig.wordStatsEnabled} class="mt-0.5 accent-indigo-500" />
              <span>
                <span class="text-sm font-medium text-on-surface block">{m.da_word_stats()}</span>
                <span class="text-2xs text-on-surface-variant block mt-0.5">
                  {m.da_word_stats_desc_1()} <strong>{m.da_word_stats_tab()}</strong> {m.da_word_stats_of_stats()}
                  {m.da_word_stats_privacy()}
                </span>
              </span>
            </label>
          </div>

          <!-- Hygiène des bans -->
          <div class="pt-4 mt-2 border-t border-outline-variant/10">
            <label class="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" bind:checked={verifConfig.banHygieneEnabled} class="mt-0.5 accent-indigo-500" />
              <span>
                <span class="text-sm font-medium text-on-surface block">{m.da_ban_hygiene()}</span>
                <span class="text-2xs text-on-surface-variant block mt-0.5">
                  {m.da_ban_hygiene_desc_1()}
                  <strong>{m.da_ban_hygiene_deleted()}</strong>{m.da_ban_hygiene_desc_2()}
                </span>
              </span>
            </label>
          </div>
        </div>
    {/if}
    {/if}

    <!-- La sauvegarde reste hors du bloc : cachee avec les champs, elle
         empechait d'enregistrer l'extinction de la verification. -->
    <div class="flex flex-wrap gap-2">
      <button onclick={saveVerifConfig} disabled={saving}
        class="px-5 py-2.5 bg-indigo-600 text-white rounded-lg text-body-sm font-medium hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center gap-1.5">
        <Papicon icon="Save" size={13} /> {m.da_save()}
      </button>
      {#if verifConfig.verificationEnabled && verifConfig.verificationMode === 'EMBED' && verifConfig.verificationChannelId}
        <button onclick={deployVerifEmbed} disabled={deployingEmbed}
          class="px-5 py-2.5 border border-indigo-500/20 text-indigo-400 rounded-lg text-body-sm font-medium hover:bg-indigo-500 hover:text-white transition-all disabled:opacity-50 flex items-center gap-1.5">
          {#if deployingEmbed}
            <div class="h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent"></div>
            {m.da_sending()}
          {:else}
            <Papicon icon="Send" size={13} /> {m.da_deploy_embed()}
          {/if}
        </button>
      {/if}
    </div>
  </div>
{:else}
  <div class="flex flex-col items-center py-20 gap-3">
    <div class="h-8 w-8 animate-spin rounded-full border-3 border-primary border-t-transparent"></div>
    <p class="text-xs text-on-surface-variant">{m.da_loading()}</p>
  </div>
{/if}

