<!--
  Question posée avant la première mise en route du module : les messages
  analysés peuvent-ils servir à entraîner le modèle d'AegisAI (`save` de
  /analyze) ? Les deux réponses activent le module ; fermer la fenêtre
  n'active rien.
-->
<script lang="ts">
  import { Button } from '../ui';
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';

  let {
    open = $bindable(false),
    busy = false,
    onchoose,
  }: {
    open?: boolean;
    busy?: boolean;
    onchoose: (consent: boolean) => void;
  } = $props();
</script>

<Modal bind:open title={m.aegis_consent_title()} size="md" closeOnBackdropClick={!busy} closeOnEscape={!busy}>
  <div class="consent">
    <p>{m.aegis_consent_intro()}</p>
    <ul>
      <li>
        <Papicon icon="check-circle" size={16} class="text-success shrink-0 mt-0.5" />
        <span>{m.aegis_consent_yes_desc()}</span>
      </li>
      <li>
        <Papicon icon="lock" size={16} class="text-on-surface-variant shrink-0 mt-0.5" />
        <span>{m.aegis_consent_no_desc()}</span>
      </li>
    </ul>
    <p class="consent__note">{m.aegis_consent_note()}</p>
  </div>

  {#snippet footer()}
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" disabled={busy} onclick={() => onchoose(false)}>{m.aegis_consent_no()}</Button>
      <Button variant="primary" loading={busy} onclick={() => onchoose(true)}>{m.aegis_consent_yes()}</Button>
    </div>
  {/snippet}
</Modal>

<style>
  .consent {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 1.25rem;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--color-on-surface);
  }

  .consent p {
    margin: 0;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    gap: 0.5rem;
  }

  .consent__note {
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }
</style>
