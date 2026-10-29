<script lang="ts">
  /**
   * Shield : niveau d'alerte du serveur, de 5 (tout va bien) à 1 (catastrophe).
   *
   * Agit immédiatement, sans passer par l'enregistrement de la page : en
   * pleine alerte, on ne veut pas d'une étape de plus. `onSynced` reporte dans
   * la page les champs que le serveur a modifiés (captcha, verrous…).
   */
  import { authStore } from '../../stores/auth.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { setShieldLevel, publishShieldPanel, createShieldStatusChannel } from '../../api';
  import SectionCard from '../SectionCard.svelte';
  import Button from '../ui/Button.svelte';
  import Callout from '../ui/Callout.svelte';

  let {
    config,
    channels = [],
    onSynced,
  }: {
    config: Record<string, any>;
    channels?: { id: string; name: string }[];
    onSynced: (fresh: Record<string, any>) => void;
  } = $props();

  const LEVELS = [
    { level: 5, emoji: '🔵', name: 'Tout va bien', summary: 'Vérification Discord moyenne.', tone: 'border-primary/40 bg-primary/5' },
    { level: 4, emoji: '🟢', name: 'Vigilance', summary: 'Captcha activé, sinon vérification élevée.', tone: 'border-success/40 bg-success/5' },
    { level: 3, emoji: '🟡', name: 'Alerte', summary: 'Vérification maximale, captcha pour tous, MP fermés.', tone: 'border-warning/40 bg-warning/5' },
    { level: 2, emoji: '🔴', name: 'Critique', summary: 'Captcha gelé. Sans captcha : mode raid.', tone: 'border-error/40 bg-error/5' },
    { level: 1, emoji: '⚪', name: 'Catastrophe', summary: 'Serveur verrouillé : @everyone ne peut plus écrire.', tone: 'border-outline bg-surface-container-high' },
  ];

  let busy = $state(false);
  let warnings = $state<string[]>([]);
  let panelChannel = $state('');

  const current = $derived(Number(config.shieldLevel ?? 5));
  const hasCaptcha = $derived(Boolean(config.captchaChannelId && config.captchaUnverifiedRoleId));

  async function apply(level: number) {
    if (busy || level === current) return;
    if (level <= 2) {
      const ok = await confirmDialog.ask({
        title: `Passer en Shield ${level} ?`,
        description: level === 1
          ? 'Le serveur sera verrouillé : @everyone ne pourra plus écrire, réagir ni parler. Tout est rétabli en redescendant.'
          : hasCaptcha
            ? 'Les arrivants seront retenus sans captcha jusqu\'à la fin de l\'alerte.'
            : 'Sans captcha configuré, le mode raid sera activé.',
        confirmLabel: `Shield ${level}`,
        variant: 'danger',
      });
      if (!ok) return;
    }
    busy = true;
    try {
      const res = await setShieldLevel(level, authStore.selectedGuildId);
      if (res) {
        warnings = res.warnings;
        onSynced(res.config);
        toast.success(`Shield ${level} appliqué${res.warnings.length ? ' en partie' : ''}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Changement impossible');
    } finally {
      busy = false;
    }
  }

  async function publish(create: boolean) {
    if (busy) return;
    busy = true;
    try {
      const res = await publishShieldPanel(create ? { create: true } : { channelId: panelChannel }, authStore.selectedGuildId);
      if (res) {
        onSynced(res.config);
        toast.success(create ? 'Salon #shield créé et panneau publié : ouvre-le aux rôles de l\'équipe' : 'Panneau publié');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publication impossible');
    } finally {
      busy = false;
    }
  }

  async function createStatus() {
    if (busy) return;
    busy = true;
    try {
      const res = await createShieldStatusChannel(authStore.selectedGuildId);
      if (res) {
        onSynced(res.config);
        toast.success('Salon de statut créé');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Création impossible');
    } finally {
      busy = false;
    }
  }
</script>

<SectionCard
  title="Shield"
  description="Le niveau d'alerte du serveur. Chaque niveau durcit le serveur tout seul ; revenir à 5 annule ce que Shield avait activé, sans toucher à ce que l'équipe avait mis en place. Le niveau ne change jamais seul."
  icon="Siren"
>
  <div class="space-y-4">
    <div class="grid sm:grid-cols-5 gap-2">
      {#each LEVELS as item (item.level)}
        <button
          type="button"
          class="rounded-xl border px-3 py-3 text-left transition-colors disabled:cursor-default {item.level === current ? item.tone : 'border-outline-variant/30 hover:border-outline-variant'}"
          disabled={busy || item.level === current}
          aria-pressed={item.level === current}
          onclick={() => apply(item.level)}
        >
          <p class="text-body-sm font-semibold text-on-surface">{item.emoji} Shield {item.level}</p>
          <p class="text-xs font-medium text-on-surface">{item.name}</p>
          <p class="text-xs text-on-surface-variant mt-1 leading-relaxed">{item.summary}</p>
        </button>
      {/each}
    </div>

    {#if warnings.length > 0}
      <Callout variant="warning" title="Appliqué en partie">
        <ul class="list-disc pl-4 space-y-0.5">
          {#each warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Callout>
    {/if}
    {#if !hasCaptcha}
      <Callout variant="info">Sans captcha configuré (salon et rôle), Shield renforce la vérification Discord et, aux niveaux 2 et 1, active le mode raid.</Callout>
    {/if}

    <div class="grid sm:grid-cols-2 gap-3">
      <div class="rounded-xl border border-outline-variant/30 p-3 space-y-2">
        <p class="text-body-sm font-medium text-on-surface">Panneau de l'équipe</p>
        <p class="text-xs text-on-surface-variant">
          {config.shieldPanelChannelId ? `Publié dans #${channels.find((c) => c.id === config.shieldPanelChannelId)?.name ?? config.shieldPanelChannelId}.` : 'Cinq boutons pour changer de niveau depuis Discord. Toute personne qui voit le salon peut s\'en servir.'}
        </p>
        <div class="flex flex-wrap gap-2">
          <select
            bind:value={panelChannel}
            class="flex-1 min-w-0 rounded-lg bg-surface-container border border-outline-variant/40 px-3 py-1.5 text-body-sm text-on-surface"
          >
            <option value="">Choisir un salon réservé à l'équipe</option>
            {#each channels as channel (channel.id)}<option value={channel.id}>#{channel.name}</option>{/each}
          </select>
          <Button size="sm" variant="secondary" disabled={busy || !panelChannel} onclick={() => publish(false)}>Publier</Button>
          <Button size="sm" variant="ghost" icon="Plus" disabled={busy} onclick={() => publish(true)}>Créer #shield</Button>
        </div>
      </div>
      <div class="rounded-xl border border-outline-variant/30 p-3 space-y-2">
        <p class="text-body-sm font-medium text-on-surface">Salon vocal de statut</p>
        <p class="text-xs text-on-surface-variant">
          Son nom affiche le niveau (« 🔵 Shield 5 »). Personne ne peut s'y connecter. Discord limite les renommages à deux toutes les dix minutes : le panneau reste la référence.
        </p>
        <Button size="sm" variant="secondary" icon="Volume2" disabled={busy || Boolean(config.shieldStatusChannelId)} onclick={createStatus}>
          {config.shieldStatusChannelId ? 'Salon de statut actif' : 'Créer le salon de statut'}
        </Button>
      </div>
    </div>
  </div>
</SectionCard>
