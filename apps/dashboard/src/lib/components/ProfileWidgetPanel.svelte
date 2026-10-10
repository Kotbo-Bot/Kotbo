<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchWidgetData, activateWidget, deactivateWidget, refreshWidget, refreshAllWidgets, rotateWidgetToken, API_BASE_URL } from '../api';
  import { toast } from '../stores/toast.svelte';
  import Papicon from './Papicon.svelte';

  let loading = $state(true);
  let acting = $state(false);
  let copyingScript = $state(false);
  let copiedField: string | null = $state(null);
  let rotatingToken = $state(false);
  let showToken = $state(false);
  let data: any = $state(null);

  const isActive = $derived(data?.mySubscription?.enabled === true);
  const subscriptionCount = $derived(data?.subscriptions?.length ?? 0);
  const widgetToken = $derived(data?.mySubscription?.token ?? null);
  const apiOrigin = $derived(API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : ''));
  const widgetDataUrl = $derived(widgetToken ? `${apiOrigin}/api/public/widget-data?token=${widgetToken}` : '');

  async function copy(text: string, field: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedField = field;
      setTimeout(() => { if (copiedField === field) copiedField = null; }, 1500);
    } catch {
      toast.error('Impossible de copier');
    }
  }

  function syncServiceWorkerConfig() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !widgetToken) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: 'KOTBO_WIDGET_CONFIG', token: widgetToken, apiBase: apiOrigin }))
      .catch(() => {});
  }

  async function handleRotateToken() {
    rotatingToken = true;
    try {
      const result = await rotateWidgetToken();
      if (result?.token && data?.mySubscription) {
        data = { ...data, mySubscription: { ...data.mySubscription, token: result.token } };
        toast.success('Token régénéré. Pense à le mettre à jour dans Scriptable/KWGT.');
        syncServiceWorkerConfig();
      }
    } catch {
      toast.error('Erreur lors de la régénération du token');
    } finally {
      rotatingToken = false;
    }
  }

  async function load() {
    loading = true;
    try {
      data = await fetchWidgetData();
      syncServiceWorkerConfig();
    } catch {
      toast.error('Erreur lors du chargement');
    } finally {
      loading = false;
    }
  }

  async function handleActivate() {
    acting = true;
    try {
      const result = await activateWidget();
      if (result?.pushResult?.ok === false) {
        toast.warning(result.pushResult.error || 'Widget activé mais la synchronisation Discord a échoué.');
      } else {
        toast.success('Données synchronisées. Copie maintenant le script Vencord pour ajouter le widget à ton profil.');
      }
      await load();
    } catch {
      toast.error('Erreur lors de l\'activation');
    } finally {
      acting = false;
    }
  }

  async function handleCopyVencordScript() {
    copyingScript = true;
    try {
      const response = await fetch('/kotbo-widget-discord-v2.js', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      toast.success('Script copié. Colle-le dans la console DevTools de Discord/Vencord.');
    } catch {
      toast.error('Impossible de copier le script. Ouvre le fichier avec le lien puis copie son contenu.');
    } finally {
      copyingScript = false;
    }
  }

  async function handleDeactivate() {
    acting = true;
    try {
      await deactivateWidget();
      toast.success('Widget désactivé avec succès.');
      await load();
    } catch {
      toast.error('Erreur lors de la désactivation');
    } finally {
      acting = false;
    }
  }

  async function handleRefresh() {
    acting = true;
    try {
      const result = await refreshWidget();
      if (result?.pushResult?.ok) {
        toast.success('Widget rafraîchi !');
      }
    } catch {
      toast.error('Erreur lors du rafraîchissement');
    } finally {
      acting = false;
    }
  }

  async function handleRefreshAll() {
    acting = true;
    try {
      const result = await refreshAllWidgets();
      const failures = Array.isArray(result?.failures) ? result.failures : [];
      if (failures.length > 0) {
        toast.warning(`Widgets : ${result?.success ?? 0} OK, ${result?.failed ?? 0} échoués - ${failures.map((f: any) => `${f.userId}: ${f.error}`).join(' · ')}`);
      } else {
        toast.success(`Widgets rafraîchis : ${result?.success ?? 0} OK`);
      }
    } catch {
      toast.error('Erreur lors du rafraîchissement global');
    } finally {
      acting = false;
    }
  }

  onMount(load);
</script>

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">Chargement...</p>
  </div>
{:else}
  <!-- ======================== STATS ROW ======================== -->
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center {isActive ? 'bg-success/10 text-success' : 'bg-surface-container-high/30 text-on-surface-variant/50'}">
        <Papicon icon={isActive ? 'check-circle' : 'x-circle'} size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{isActive ? 'Actif' : 'Inactif'}</span>
        <span class="text-xs font-medium text-on-surface-variant/60 mt-0.5">Ton widget</span>
      </div>
    </div>
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-4 flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl flex items-center justify-center bg-primary/10 text-primary">
        <Papicon icon="users" size={20} />
      </div>
      <div class="flex flex-col">
        <span class="text-2xl font-bold">{subscriptionCount}</span>
        <span class="text-xs font-medium text-on-surface-variant/60 mt-0.5">Widgets actifs</span>
      </div>
    </div>
  </div>

  <!-- ======================== GRID ======================== -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

    <!-- Actions card -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="zap" size={18} />
        Actions
      </h3>
      <div class="flex flex-col gap-3">
        {#if isActive}
          <button
            class="px-4 py-2 bg-primary text-on-primary text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
            onclick={handleRefresh}
            disabled={acting}
          >
            <Papicon icon="refresh-cw" size={14} />
            Rafraîchir mon widget
          </button>
          <button
            class="px-5 py-2.5 bg-rose-500 text-white text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
            onclick={handleDeactivate}
            disabled={acting}
          >
            <Papicon icon="x" size={14} />
            Désactiver
          </button>
        {:else}
          <button
            class="px-5 py-2.5 bg-emerald-500 text-white text-body-sm font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2"
            onclick={handleActivate}
            disabled={acting}
          >
            <Papicon icon="check" size={14} />
            Activer le widget
          </button>
        {/if}

        <button
          class="px-5 py-2.5 bg-surface-container-high/40 text-on-surface-variant hover:bg-surface-container-high/60 text-body-sm font-medium rounded-xl transition-all flex items-center gap-2"
          onclick={handleRefreshAll}
          disabled={acting}
        >
          <Papicon icon="refresh-cw" size={14} />
          Rafraîchir tous les widgets
        </button>
      </div>
    </div>

    <!-- How it works card -->
    <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
      <h3 class="text-base font-semibold flex items-center gap-2.5">
        <Papicon icon="info" size={18} />
        Fonctionnement
      </h3>
      <div class="flex flex-col gap-4">
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">1</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">Connecte-toi au dashboard - l'autorisation widget est incluse automatiquement lors de la connexion Discord</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">2</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">Active le widget ici ou avec <code class="bg-surface-container-high/50 px-1.5 py-0.5 rounded text-xs">/widget activer</code> pour synchroniser tes statistiques.</span>
        </div>
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-7 h-7 bg-primary text-on-primary rounded-full flex items-center justify-center text-xs font-bold">3</span>
          <span class="text-sm text-on-surface-variant leading-relaxed">Copie le script ci-dessous, exécute-le une fois dans Discord/Vencord, puis recharge avec <kbd class="font-mono text-xs">Ctrl+R</kbd>.</span>
        </div>
      </div>
    </div>

    {#if isActive}
      <section class="lg:col-span-2 relative overflow-hidden rounded-xl border border-warning/20 bg-amber-400/[0.04] p-6">
        <div class="absolute -right-12 -top-16 h-44 w-44 rounded-full bg-warning/10 blur-3xl pointer-events-none"></div>
        <div class="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div class="space-y-3">
            <div class="flex items-center gap-2 text-warning">
              <Papicon icon="terminal" size={18} />
              <span class="text-xs font-semibold">Installation locale · Discord/Vencord</span>
            </div>
            <h3 class="text-base font-semibold text-on-surface">Ajouter Kotbo à ton Profile Board</h3>
            <p class="max-w-2xl text-sm leading-relaxed text-on-surface-variant">
              Discord refuse cette modification via OAuth. Le script utilise uniquement ta session locale Discord,
              conserve tes widgets actuels et n’extrait aucun token.
            </p>
            <ol class="grid gap-2 text-xs text-on-surface-variant sm:grid-cols-2 lg:grid-cols-4">
              <li><span class="mr-1.5 font-mono text-warning">01</span> Ouvre Discord/Vencord</li>
              <li><span class="mr-1.5 font-mono text-warning">02</span> DevTools avec Ctrl+Shift+I</li>
              <li><span class="mr-1.5 font-mono text-warning">03</span> Si demandé, tape « allow pasting »</li>
              <li><span class="mr-1.5 font-mono text-warning">04</span> Colle le script dans Console</li>
            </ol>
          </div>
          <div class="flex min-w-56 flex-col gap-2">
            <button
              class="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-400 px-5 py-3 text-body-sm font-medium text-black transition-transform hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60"
              onclick={handleCopyVencordScript}
              disabled={copyingScript}
            >
              <Papicon icon={copyingScript ? 'loader' : 'copy'} size={15} />
              {copyingScript ? 'Copie…' : 'Copier le script'}
            </button>
            <a
              href="/kotbo-widget-discord-v2.js"
              target="_blank"
              rel="noreferrer"
              class="text-center text-2xs text-on-surface-variant/70 underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
            >Voir le fichier avant de l’exécuter</a>
          </div>
        </div>
      </section>
    {/if}

    <!-- ==================== WIDGETS TÉLÉPHONE & PC ==================== -->
    {#if isActive}
      <section class="lg:col-span-2 rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-6 space-y-5">
        <div>
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="smartphone" size={18} />
            Widgets téléphone & PC
          </h3>
          <p class="mt-1 text-xs text-on-surface-variant/60">
            Installe Kotbo comme application (PWA) et affiche tes stats sur ton écran d'accueil ou de verrouillage.
          </p>
        </div>

        <!-- Token widget -->
        <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/20 p-4 space-y-2">
          <p class="text-xs font-semibold text-on-surface-variant/60">Token widget (lecture seule)</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 min-w-0 truncate rounded-lg border border-outline-variant/10 bg-surface-container-highest/40 px-3 py-2 font-mono text-xs text-on-surface">
              {showToken ? (widgetToken ?? '-') : '••••••••••••••••••••••••••••••••'}
            </code>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => showToken = !showToken}
            >
              {showToken ? 'Masquer' : 'Afficher'}
            </button>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors"
              onclick={() => widgetToken && copy(widgetToken, 'token')}
            >
              {copiedField === 'token' ? 'Copié' : 'Copier'}
            </button>
            <button
              class="shrink-0 rounded-lg border border-outline-variant/20 px-2.5 py-2 text-2xs text-on-surface-variant hover:text-on-surface transition-colors disabled:opacity-50"
              onclick={handleRotateToken}
              disabled={rotatingToken}
            >
              <Papicon icon="refresh-cw" size={14} />
            </button>
          </div>
          <p class="text-2xs text-on-surface-variant/50">
            Ce token permet uniquement de lire tes stats (niveau, messages, vocal, staff score). Régénère-le si tu penses qu'il a fuité.
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <!-- iOS / Scriptable -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="apple" size={16} />
              <span class="text-sm font-semibold">iOS · Scriptable</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>Installe l'app gratuite <strong>Scriptable</strong> (App Store)</li>
              <li>Colle-y le script Kotbo ci-dessous</li>
              <li>Ajoute un widget Scriptable à l'écran d'accueil</li>
              <li>En paramètre du widget : <code class="text-2xs">{widgetToken}|{apiOrigin}</code></li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/mobile-widgets/kotbo-widget.scriptable.js"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                Télécharger le script
              </a>
              <button
                class="text-2xs text-on-surface-variant/70 underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => widgetToken && copy(`${widgetToken}|${apiOrigin}`, 'ios-param')}
              >{copiedField === 'ios-param' ? 'Copié !' : 'Copier le paramètre'}</button>
            </div>
          </div>

          <!-- Android / KWGT -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="smartphone" size={16} />
              <span class="text-sm font-semibold">Android · KWGT</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>Installe <strong>KWGT Kustom Widget Maker</strong> (Play Store)</li>
              <li>Crée un widget texte par statistique</li>
              <li>Colle-y les formules du guide (déjà pré-remplies avec ton token)</li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/mobile-widgets/kwgt-guide.txt"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                Voir le guide
              </a>
              <button
                class="text-2xs text-on-surface-variant/70 underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => copy(widgetDataUrl, 'android-url')}
              >{copiedField === 'android-url' ? 'Copié !' : 'Copier l\'URL de données'}</button>
            </div>
          </div>

          <!-- Windows 11 / Edge -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="monitor" size={16} />
              <span class="text-sm font-semibold">Windows 11 · Edge</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>Ouvre ce dashboard dans <strong>Microsoft Edge</strong></li>
              <li>Menu ⋯ → Applications → « Installer ce site en tant qu'application »</li>
              <li>Clic droit sur l'icône Kotbo installée → « Ajouter au panneau Widgets »</li>
            </ol>
            <p class="text-2xs text-on-surface-variant/50">
              Le widget se synchronise automatiquement dès que tu ouvres l'app installée - aucune configuration de token nécessaire.
            </p>
          </div>

          <!-- Linux / Waybar & Conky -->
          <div class="rounded-lg border border-outline-variant/10 bg-surface-container-high/10 p-4 space-y-3">
            <div class="flex items-center gap-2 text-on-surface">
              <Papicon icon="terminal" size={16} />
              <span class="text-sm font-semibold">Linux · Waybar / Conky</span>
            </div>
            <ol class="space-y-1.5 text-xs text-on-surface-variant leading-relaxed list-decimal list-inside">
              <li>Copie le script (Waybar ou Conky) dans ton dossier de config</li>
              <li>Renseigne ton token, <code class="text-2xs">chmod +x</code> le script</li>
              <li>Ajoute le bloc de config fourni dans le guide</li>
            </ol>
            <div class="flex flex-col gap-1.5">
              <a
                href="/desktop-widgets/linux-widgets-guide.txt"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center justify-center gap-2 rounded-lg bg-surface-container-highest/50 px-3 py-2 text-xs font-semibold text-on-surface hover:bg-surface-container-highest/70 transition-colors"
              >
                <Papicon icon="download" size={13} />
                Voir le guide
              </a>
              <button
                class="text-2xs text-on-surface-variant/70 underline decoration-outline-variant underline-offset-4 hover:text-on-surface"
                onclick={() => copy(widgetDataUrl, 'linux-url')}
              >{copiedField === 'linux-url' ? 'Copié !' : 'Copier l\'URL de données'}</button>
            </div>
          </div>
        </div>
      </section>
    {/if}

    <!-- Active staff list card -->
    {#if data?.subscriptions?.length > 0}
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="users" size={18} />
          Staff avec widget actif
        </h3>
        <div class="flex flex-col divide-y divide-outline-variant/10">
          {#each data.subscriptions.filter((s: any) => s.enabled) as sub}
            <div class="flex items-center gap-4 py-3">
              <span class="flex-1 font-mono text-sm text-on-surface">{sub.userId}</span>
              <span class="text-xs text-on-surface-variant/60">{new Date(sub.createdAt).toLocaleDateString('fr-FR')}</span>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success border border-success/15">Actif</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

  </div>
{/if}

