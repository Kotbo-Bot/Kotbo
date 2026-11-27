<script lang="ts">
  import { m } from '../../../i18n';
  /**
   * Le niveau de moderation, montre plutot que decrit.
   *
   * Les trois reglages sont les memes qu'avant. Ce qui change, c'est qu'on les
   * voit a l'oeuvre : la colonne de droite fait passer les memes messages dans
   * un faux salon, et c'est le niveau retenu qui decide de leur sort. Changer
   * de carte rejoue la scene, et l'ecart entre « Souple » et « Strict » se
   * constate au lieu de se croire.
   *
   * Deux ecritures, deux modules : les filtres de message et les seuils
   * anti-raid vivent dans deux configurations distinctes, et un prereglage
   * deplace les deux.
   */
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { MODERATION_LEVELS, celebrateStep, type ModerationLevel } from '../../../onboarding';
  import ChoiceCard from '../ChoiceCard.svelte';
  import ModerationSim from '../ModerationSim.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';
  import { saveInBackground } from '../../../onboarding/backgroundSave';
  import { saveModeration } from '../../../onboarding/quickSetup';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const level = $derived<ModerationLevel>(wizard.moderation ?? 'standard');

  function apply() {
    const chosenLevel = level;
    void saveInBackground('moderation', () => saveModeration(chosenLevel), m.onb_moderation_save_failed());
    celebrateStep();
    wizard.next();
  }
</script>

<WizardShell
  title={m.obx_md_title()}
  lead={m.obx_md_lead()}
  {onEditTracks}
>
  <div class="space-y-3">
    {#each MODERATION_LEVELS as entry (entry.key)}
      <ChoiceCard
        label={entry.label}
        pitch={entry.pitch}
        detail={entry.detail}
        icon={entry.icon}
        selected={level === entry.key}
        badge={entry.key === 'standard' ? m.obx_recommended() : undefined}
        onclick={() => { wizard.answer({ moderation: entry.key }) }}
      />
    {/each}
  </div>

  {#snippet preview()}
    <ModerationSim {level} />
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy}
      class="btn btn-primary"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Appliquer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
