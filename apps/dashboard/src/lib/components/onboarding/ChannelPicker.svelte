<script lang="ts">
  import { m } from '../../i18n';
  /**
   * « Choisissez un salon » - et, quand il n'y en a pas, « je le crée ».
   *
   * Trois écrans du parcours demandent de désigner un salon : la journalisation,
   * les alertes du staff, les drops. Sur un serveur neuf où la structure n'a pas
   * été posée, la liste déroulante est vide ou ne contient rien qui convienne, et
   * le parcours se terminait alors par un réglage non renseigné - celui-là même
   * dont on venait d'expliquer qu'il servirait le jour d'un incident.
   *
   * Le bouton pose le salon au bon endroit, avec les bonnes permissions, et le
   * sélectionne. Il n'apparaît pas quand un salon manifestement approprié existe
   * déjà : proposer d'en créer un second serait proposer un doublon.
   *
   * Il reste visible, plus discret, quand un salon a été suggéré sans certitude :
   * la reconnaissance par le nom se trompe, et il faut pouvoir passer outre.
   */
  import { toast } from '../../stores/toast.svelte';
  import { onboardingData } from '../../stores/onboardingData.svelte';
  import { createOnboardingChannel, type OnboardingChannelPurpose } from '../../api';
  import Papicon from '../Papicon.svelte';

  import { errorMessage } from '@kotbo/shared';
  const {
    id,
    label,
    hint,
    purpose,
    value,
    /** Proposé quand aucun salon n'est retenu : « Aucun salon », le plus souvent. */
    noneLabel,
    /** Ce que le bouton propose de créer, à la première personne du serveur. */
    createLabel,
    /** Vrai quand le salon retenu vient d'une reconnaissance par le nom, donc faillible. */
    suggested = false,
    onpick,
  }: {
    id: string;
    label: string;
    hint?: string;
    purpose: OnboardingChannelPurpose;
    value: string;
    noneLabel?: string;
    createLabel: string;
    suggested?: boolean;
    onpick: (channelId: string | null) => void;
  } = $props();

  const channels = $derived(onboardingData.channels);

  let creating = $state(false);

  async function create() {
    if (creating || onboardingData.busy) return;
    creating = true;
    try {
      const channel = await createOnboardingChannel(purpose);
      // La liste vient d'une lecture du serveur : sans la relire, le salon créé
      // n'existerait pas dans le menu et le choix ne s'afficherait pas.
      await onboardingData.loadGuild(true);
      onpick(channel.id);
      toast.success(
        channel.created
          ? m.onb_channel_created({ name: channel.name })
          : m.onb_channel_reused({ name: channel.name }),
      );
    } catch (err) {
      toast.error(errorMessage(err) || m.onb_channel_create_failed());
    } finally {
      creating = false;
    }
  }
</script>

<div>
  <label for={id} class="block text-body-sm font-semibold text-on-surface mb-1.5">{label}</label>

  <select
    {id}
    {value}
    onchange={(event) => onpick(event.currentTarget.value || null)}
    class="input"
  >
    {#if noneLabel}
      <option value="">{noneLabel}</option>
    {/if}
    {#each channels as channel (channel.id)}
      <option value={channel.id}>#{channel.name}</option>
    {/each}
  </select>

  {#if hint}
    <p class="mt-1.5 text-xs text-on-surface-variant leading-relaxed">{hint}</p>
  {/if}

  {#if !value}
    <!-- Rien de retenu : c'est le cas où le parcours se terminerait sur un
         réglage vide. Le bouton est mis en avant. -->
    <button
      type="button"
      onclick={create}
      disabled={creating || onboardingData.busy}
      class="btn btn-tonal btn-sm mt-2.5"
    >
      <Papicon icon={creating ? 'loader' : 'plus'} size={14} class={creating ? 'animate-spin' : ''} />
      {creating ? m.obx_creating() : createLabel}
    </button>
  {:else if suggested}
    <!-- Un salon a été deviné d'après son nom. La reconnaissance se trompe :
         proposer quand même, mais sans insister. -->
    <button
      type="button"
      onclick={create}
      disabled={creating || onboardingData.busy}
      class="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-variant
             hover:text-primary transition-colors disabled:opacity-50"
    >
      <Papicon icon={creating ? 'loader' : 'plus'} size={12} class={creating ? 'animate-spin' : ''} />
      {creating ? m.obx_creating() : createLabel}
    </button>
  {/if}
</div>
