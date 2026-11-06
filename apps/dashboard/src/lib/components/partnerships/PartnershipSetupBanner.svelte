<script lang="ts">
  /**
   * Bandeau de mise en service.
   *
   * Un module a moitie regle ne previent personne quand un partenariat derape :
   * les alertes partent vers un salon qui n'existe pas, les avantages ne
   * trouvent aucun role a poser. Plutot que de laisser le decouvrir a l'usage,
   * le bandeau dit ce qui manque, pourquoi cela compte, et propose de tout
   * poser d'un geste.
   *
   * Il disparait des que le necessaire est en place : un bandeau permanent
   * finit par ne plus etre lu.
   */
  import ActionButton from '../ActionButton.svelte';
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';

  type Readiness = {
    ready: boolean;
    enabled: boolean;
    missing: { key: string; label: string; why: string; optional: boolean }[];
    missingPermissions: string[];
  };

  const {
    readiness,
    running = false,
    onsetup,
  }: {
    readiness: Readiness | null;
    running?: boolean;
    onsetup: () => void | Promise<void>;
  } = $props();

  const blocking = $derived((readiness?.missing ?? []).filter((item) => !item.optional));
  const optional = $derived((readiness?.missing ?? []).filter((item) => item.optional));
  const blocked = $derived((readiness?.missingPermissions ?? []).length > 0);
</script>

{#if readiness && !readiness.ready}
  <div
    class="rounded-2xl border px-5 py-4 mb-4 {blocking.length > 0 || !readiness.enabled
      ? 'border-primary/30 bg-primary/5'
      : 'border-outline-variant/20 bg-surface-container'}"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="sparkles" size={15} />
          {#if !readiness.enabled}
            Mettre les partenariats en service
          {:else if blocking.length > 0}
            Il manque l'essentiel pour que le module serve
          {:else}
            Deux ou trois choses rendraient le module plus utile
          {/if}
        </p>

        <p class="text-xs text-on-surface-variant mt-1 max-w-2xl">
          {#if !readiness.enabled}
            Kotbo cree les salons et le role necessaires, puis allume le module. Ce qui existe deja est repris
            tel quel, rien n'est remplace.
          {:else}
            Les automatismes ne sont pas touchés : ils restent éteints tant que tu ne les actives pas.
          {/if}
        </p>
      </div>

      {#if !blocked}
        <ActionButton
          variant="primary"
          size="sm"
          icon="sparkles"
          label={running ? m.psb_running() : readiness.enabled ? m.psb_complete() : m.psb_enable()}
          onclick={onsetup}
        />
      {/if}
    </div>

    {#if blocked}
      <!-- Les permissions sont la seule chose que le module ne peut pas
           resoudre lui-meme : on dit laquelle manque, precisement. -->
      <div class="mt-3 rounded-lg bg-error/10 px-3 py-2">
        <p class="text-xs text-error flex items-start gap-1.5">
          <Papicon icon="alert-triangle" size={13} class="mt-0.5 shrink-0" />
          <span>
            Kotbo n'a pas les permissions necessaires : {readiness.missingPermissions.join(', ')}. Accordez-les au
            role du bot, puis revenez ici.
          </span>
        </p>
      </div>
    {:else if readiness.missing.length > 0}
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {#each [...blocking, ...optional] as item (item.key)}
          <div class="rounded-lg bg-surface-container-low/60 px-3 py-2">
            <p class="text-xs text-on-surface flex items-center gap-1.5">
              <Papicon
                icon={item.optional ? 'circle' : 'alert-triangle'}
                size={12}
                class={item.optional ? 'text-on-surface-variant' : 'text-warning'}
              />
              {item.label}
              {#if item.optional}<span class="text-2xs text-on-surface-variant">{m.ppan_optional()}</span>{/if}
            </p>
            <p class="text-2xs text-on-surface-variant mt-0.5">{item.why}</p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
