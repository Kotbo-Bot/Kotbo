<script lang="ts">
  import { explainDisabled } from '../../../actions/explainDisabled';
  import { m } from '../../../i18n';
  /**
   * Le premier message qu'un arrivant lit.
   *
   * Trois tons prets a poser : on part d'une phrase, on ne redige pas. Et
   * l'apercu montre le resultat, pas le gabarit - personne ne juge une phrase a
   * travers ses accolades et ses asterisques, et « est-ce que ca sonne bien ? »
   * redevient une question a laquelle on peut repondre.
   */
  import { authStore } from '../../../stores/auth.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { bot } from '../../../stores/botLocale.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { celebrateStep } from '../../../onboarding';
  import { fetchWelcomeConfig, updateWelcomeConfig } from '../../../api';
  import DiscordPreview from '../DiscordPreview.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  import { errorMessage } from '@kotbo/shared';
  const { onEditTracks }: { onEditTracks: () => void } = $props();

  /** Variables Discord laissees telles quelles dans le texte. */
  const VARS = { user: '{user}', server: '{server}' };

  const TONES = [
    { key: 'warm', label: m.obx_gr_warm(), icon: 'heart', get text() { return m.bot_greet_warm(VARS, bot()); } },
    { key: 'plain', label: m.obx_gr_plain(), icon: 'align-left', get text() { return m.bot_greet_plain(VARS, bot()); } },
    { key: 'playful', label: m.obx_gr_playful(), icon: 'star', get text() { return m.bot_greet_playful(VARS, bot()); } },
  ];

  let message = $state('');
  let loaded = $state(false);

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  /** Le gabarit, avec ses variables remplacees : c'est ce que l'arrivant lira. */
  const rendered = $derived(
    message
      .replaceAll('{user}', `@${authStore.user?.username ?? m.obx_gr_newcomer()}`)
      .replaceAll('{server}', selectedGuild?.name ?? m.obx_rc_your_server())
  );

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void (async () => {
      try {
        const config = await fetchWelcomeConfig();
        message = config?.welcomeMessage
          || m.bot_greet_default_server(VARS, bot());
      } catch {
        message = m.bot_greet_default(VARS, bot());
      }
    })();
  });

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await updateWelcomeConfig(
        { welcomeEnabled: true, welcomeMessage: message },
        undefined,
        { silent: true },
      );
      celebrateStep();
      wizard.complete('greeting');
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_greeting_save_failed());
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.obx_gr_title()}
  lead={m.obx_gr_lead()}
  {onEditTracks}
>
  <div class="flex flex-wrap gap-2 mb-4">
    {#each TONES as tone (tone.key)}
      <button
        type="button"
        onclick={() => { message = tone.text; celebrateStep(); }}
        class="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container-low/40 px-3 py-1.5 text-xs font-medium text-on-surface-variant/80
               hover:border-primary/45 hover:text-on-surface transition-colors"
      >
        <Papicon icon={tone.icon} size={13} />
        {tone.label}
      </button>
    {/each}
  </div>

  <label for="welcome-message" class="block text-body-sm font-semibold text-on-surface mb-2">
    {m.obx_gr_label()}
  </label>
  <textarea
    id="welcome-message"
    bind:value={message}
    rows="5"
    class="w-full rounded-xl border border-field-border bg-surface-container-low/40 px-4 py-3 text-sm text-on-surface
           placeholder-on-surface-variant/40 focus:outline-none focus:border-primary/50 resize-none"
    placeholder={m.bot_greet_placeholder(VARS, bot())}
  ></textarea>

  <p class="mt-2 text-xs text-on-surface-variant/55 leading-relaxed">
    <code class="px-1 py-0.5 rounded bg-surface-container text-on-surface-variant">{'{user}'}</code>
    {m.obx_gr_user_hint()}
    <code class="px-1 py-0.5 rounded bg-surface-container text-on-surface-variant">{'{server}'}</code>
    {m.obx_gr_server_hint()}
  </p>

  {#snippet preview()}
    <DiscordPreview channel="bienvenue" content={rendered} />
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy}
      use:explainDisabled={(!message.trim()) ? m.common_reason_fill_field() : ''}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? m.obx_saving() : m.common_save()}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
