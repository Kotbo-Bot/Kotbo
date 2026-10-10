<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchEvidenceFileSignedUrl } from '../lib/api';

  const { fileId } = $props<{ fileId: string }>();

  let signedUrl = $state('');
  let error = $state('');
  let loading = $state(true);
  let mimeType = $state('');
  let fileName = $state('');

  onMount(async () => {
    try {
      const url = await fetchEvidenceFileSignedUrl(fileId);
      if (url) {
        signedUrl = url;
        // Effectue un fetch GET léger pour lire uniquement les en-têtes de réponse (MIME et nom de fichier)
        const res = await fetch(url);
        if (res.ok) {
          mimeType = res.headers.get('content-type') || '';
          const disposition = res.headers.get('content-disposition') || '';
          const match = disposition.match(/filename="([^"]+)"/);
          fileName = match ? match[1] : 'Fichier de preuve';
        } else {
          error = 'Impossible de lire les détails du fichier.';
        }
      } else {
        error = 'Impossible de charger le fichier de preuve ou lien expiré.';
      }
    } catch (err) {
      console.error(err);
      error = 'Erreur lors de la récupération du fichier de preuve.';
    } finally {
      loading = false;
    }
  });

  const isImage = $derived(mimeType.startsWith('image/'));
  const isVideo = $derived(mimeType.startsWith('video/'));
  const isPdf = $derived(mimeType === 'application/pdf');
</script>

<div class="fixed inset-0 w-full h-full bg-[#1e1f22] overflow-hidden flex flex-col font-sans text-white">
  <!-- Header -->
  <header class="flex items-center justify-between px-6 py-4 bg-[#2b2d31] border-b border-[#1f2023]/60 shadow-md">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="min-w-0">
        <h1 class="text-sm font-semibold truncate max-w-md" title={fileName}>{fileName || 'Chargement…'}</h1>
        <p class="text-xs text-white/40 truncate">{mimeType || 'Détection du format…'}</p>
      </div>
    </div>

    {#if signedUrl}
      <a
        href={signedUrl}
        download={fileName}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-2 bg-primary hover:bg-primary/95 text-on-primary px-4 py-2 rounded-lg text-body-sm font-medium transition-all duration-200 hover:-translate-y-[1px] active:translate-y-0 active:scale-[0.98] shadow-sm"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Télécharger
      </a>
    {/if}
  </header>

  <!-- Content / Preview Area -->
  <main class="flex-1 flex items-center justify-center p-6 bg-[#1a1b1e] overflow-auto">
    {#if loading}
      <div class="flex flex-col items-center gap-3">
        <div class="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
        <p class="text-xs text-white/50 font-medium">Chargement de la preuve…</p>
      </div>
    {:else if error}
      <div class="max-w-md w-full bg-[#2b2d31] border border-rose-500/10 rounded-2xl p-8 text-center shadow-2xl animate-in fade-in zoom-in-95 duration-300">
        <div class="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-5 border border-rose-500/20">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <h2 class="text-base font-bold text-white mb-2">Impossible d'afficher la preuve</h2>
        <p class="text-xs text-white/60 leading-relaxed mb-6">{error}</p>
        <button
          onclick={() => window.close()}
          class="bg-white/10 hover:bg-white/15 text-white border border-white/10 px-5 py-2.5 rounded-lg text-xs font-semibold tracking-wide transition-all active:scale-[0.98]"
        >
          Fermer l'onglet
        </button>
      </div>
    {:else if signedUrl}
      <div class="max-w-5xl w-full h-full flex items-center justify-center p-2 animate-in fade-in duration-300">
        {#if isImage}
          <img
            src={signedUrl}
            alt={fileName}
            class="max-w-full max-h-[80vh] object-contain rounded-xl border border-white/5 shadow-2xl"
          />
        {:else if isVideo}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            src={signedUrl}
            controls
            autoplay
            class="max-w-full max-h-[80vh] rounded-xl border border-white/5 shadow-2xl focus:outline-none"
          ></video>
        {:else if isPdf}
          <iframe
            src={signedUrl}
            title={fileName}
            class="w-full h-[80vh] border-none rounded-xl shadow-2xl bg-white"
          ></iframe>
        {:else}
          <!-- Fallback file representation -->
          <div class="max-w-sm w-full bg-[#2b2d31] border border-white/5 rounded-2xl p-8 text-center shadow-2xl">
            <div class="w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mx-auto mb-5 border border-primary/20">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </div>
            <h2 class="text-base font-bold text-white mb-2">{fileName}</h2>
            <p class="text-xs text-white/50 mb-6">Ce type de fichier ne peut pas être prévisualisé directement dans le navigateur.</p>
            <a
              href={signedUrl}
              download={fileName}
              class="inline-flex items-center gap-2 bg-primary hover:bg-primary/95 text-on-primary px-6 py-3 rounded-lg text-body-sm font-medium transition-all duration-200 active:scale-[0.98] shadow-sm"
            >
              Télécharger le fichier
            </a>
          </div>
        {/if}
      </div>
    {/if}
  </main>
</div>
