<!--
  Essai d'une phrase : la note d'AegisAI, située sur l'échelle des seuils en
  cours d'édition (pas ceux enregistrés), pour régler la sensibilité sur des
  exemples concrets. Rien n'est enregistré ni partagé pour l'entraînement.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Button, Callout, Field } from '../ui';
  import { m, getLocale } from '../../i18n';
  import { testAegisText, type AegisTestResult } from '../../api';
  import { DEMO_MODE } from '../../demo/mode';
  import { aegisSamples, type AegisSample } from '../../demo/aegisSamples';
  import AegisScale from './AegisScale.svelte';
  import { EMOTION_COLORS, emotionLabel, points, zoneOf, ZONE_TONE } from './aegisFormat';

  const { review, auto, disabled = false }: { review: number; auto: number; disabled?: boolean } = $props();

  let text = $state('');
  let busy = $state(false);
  let result = $state<AegisTestResult | null>(null);
  let error = $state('');

  // Démo : pas d'IA derrière, seules les phrases d'exemple ont une note. Un clic
  // sur un exemple, ou n'importe quelle touche dans le champ, tape la phrase
  // lettre par lettre à la place du visiteur, puis lance l'essai.
  const samples = $derived(DEMO_MODE ? aegisSamples(getLocale()) : []);
  let nextSample = 0;
  let typing: ReturnType<typeof setInterval> | null = null;

  function stopTyping() {
    if (typing) clearInterval(typing);
    typing = null;
  }

  function typeSample(sample: AegisSample) {
    stopTyping();
    result = null;
    text = '';
    let index = 0;
    typing = setInterval(() => {
      index += 1;
      text = sample.text.slice(0, index);
      if (index >= sample.text.length) {
        stopTyping();
        void run();
      }
    }, 28);
  }

  function onDemoKey(event: KeyboardEvent) {
    if (event.key === 'Tab' || event.key === 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (typing || !samples.length) return;
    typeSample(samples[nextSample % samples.length]);
    nextSample += 1;
  }

  onDestroy(stopTyping);

  const zone = $derived(result ? zoneOf(points(result.toxicity), review, auto) : null);
  const verdict = $derived(
    zone === 'auto' ? m.aegis_test_result_auto() : zone === 'review' ? m.aegis_test_result_review() : m.aegis_test_result_none(),
  );

  async function run(event?: SubmitEvent) {
    event?.preventDefault();
    if (!text.trim() || busy) return;
    busy = true;
    error = '';
    try {
      result = await testAegisText(text);
    } catch (err) {
      result = null;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="tester" onsubmit={run}>
  <Field label={m.aegis_test_title()} hint={m.aegis_test_desc()}>
    {#snippet children(id, describedBy)}
      <div class="tester__row">
        <input
          {id}
          aria-describedby={describedBy}
          class="input flex-1"
          type="text"
          maxlength="2000"
          placeholder={m.aegis_test_placeholder()}
          bind:value={text}
          {disabled}
          readonly={DEMO_MODE}
          onkeydown={DEMO_MODE ? onDemoKey : undefined}
        />
        <Button type="submit" variant="secondary" icon="sparkles" loading={busy} disabled={disabled || !text.trim()}>{m.aegis_test_button()}</Button>
      </div>
    {/snippet}
  </Field>

  {#if samples.length}
    <div class="tester__samples">
      {#each samples as sample (sample.text)}
        <Button type="button" variant="ghost" size="sm" onclick={() => typeSample(sample)} disabled={disabled}>{sample.label}</Button>
      {/each}
    </div>
  {/if}

  {#if error}
    <Callout variant="danger">{error}</Callout>
  {:else if result}
    <div class="tester__result" aria-live="polite">
      <AegisScale {review} {auto} marker={points(result.toxicity)} />
      <div class="tester__facts">
        <p class="tester__verdict {zone ? ZONE_TONE[zone] : ''}">{verdict}</p>
        {#if result.saved}<p class="tester__shared">{m.aegis_test_shared()}</p>{/if}
        <dl>
          <div>
            <dt>{m.aegis_test_toxicity()}</dt>
            <dd class="tabular-nums">{points(result.toxicity)} / 100</dd>
          </div>
          <div>
            <dt>{m.aegis_test_emotion()}</dt>
            <dd>
              <span class="emotion-dot" style="background: {EMOTION_COLORS[result.emotion.label]};" aria-hidden="true"></span>
              {emotionLabel(result.emotion.label)} <span class="text-on-surface-variant tabular-nums">· {points(result.emotion.score)} %</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  {/if}
</form>

<style>
  .tester {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tester__row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .tester__samples {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .tester__row input {
    min-width: 12rem;
  }

  .tester__result {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
  }

  .tester__facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1.5rem;
  }

  .tester__verdict {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .tester__shared {
    margin: 0;
    width: 100%;
    order: 3;
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  dl {
    display: flex;
    gap: 1.5rem;
    margin: 0;
  }

  dt {
    font-size: 0.75rem;
    color: var(--color-on-surface-variant);
  }

  dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .emotion-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
  }
</style>
