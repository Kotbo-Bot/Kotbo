<script lang="ts">
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { loadGoogleFont, themeBaseCss, themeStyleVars, type FormTheme } from '../lib/formTheme';
  import PrivacyNotice from '../lib/components/PrivacyNotice.svelte';
  import Papicon from '../lib/components/Papicon.svelte';

  const { formId }: { formId: string } = $props();

  // ── Types ──────────────────────────────────────────────────────────────────
  type FieldType = 'short_text'|'paragraph'|'multiple_choice'|'checkboxes'|'dropdown'
    |'linear_scale'|'multiple_choice_grid'|'checkbox_grid'|'date'|'time'|'number'|'email'|'section_header';

  interface FormField {
    id: string; type: FieldType; label: string; description?: string;
    required: boolean; placeholder?: string; options?: string[];
    rows?: {id:string;label:string}[]; columns?: {id:string;label:string}[];
    scaleMin?: number; scaleMax?: number; scaleMinLabel?: string; scaleMaxLabel?: string;
    validation?: {min?:number;max?:number;pattern?:string};
    logic?: {value:string;action:'go_to_section';targetSectionIndex:number}[];
    sectionIndex: number;
  }
  interface Section { id:string; title:string; description?:string; }
  interface FormData { id:string; name:string; description?:string; guildId:string; requiresDiscordAuth?: boolean;
    formType?: 'recruitment' | 'custom';
    structure:{title:string;description?:string;headerColor?:string;sections?:Section[];fields:FormField[]};
    theme?: FormTheme | null;
    customCss?: string | null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let form = $state<FormData|null>(null);
  let loading = $state(true);
  let notFound = $state(false);
  let submitted = $state(false);
  let submitting = $state(false);
  let submitError = $state('');
  let isCustomForm = $state(false);

  // Current section index
  let currentSection = $state(0);

  // User answers: fieldId → value
  type AnswerValue = string | string[] | Record<string, string | string[]>;
  let answers = $state<Record<string, AnswerValue>>({});

  // Validation errors: fieldId → message
  let errors = $state<Record<string, string>>({});

  // ── Derived ────────────────────────────────────────────────────────────────
  const sections = $derived(form?.structure.sections || [{ id:'s0', title:'', description:'' }]);
  const theme = $derived(form?.theme || null);
  // CSS injecté : base générée depuis le thème + CSS custom (déjà sanitizé serveur,
  // on retire </style par défense en profondeur)
  const injectedCss = $derived(
    [themeBaseCss(theme), (form?.customCss || '').replace(/<\/style/gi, '')].filter(Boolean).join('\n')
  );
  const rootStyle = $derived([
    themeStyleVars(theme, form?.structure.headerColor || '#6366f1'),
    theme?.backgroundColor ? `background:${theme.backgroundColor}` : '',
    theme?.fontFamily ? `font-family:var(--form-font)` : '',
  ].filter(Boolean).join(';'));
  const allFields = $derived(form?.structure.fields || []);
  const currentFields = $derived(allFields.filter(f => f.sectionIndex === currentSection && f.type !== 'section_header'));
  const totalSections = $derived(sections.length);
  const progress = $derived(Math.round(((currentSection + 1) / totalSections) * 100));
  const authRequired = $derived(form?.requiresDiscordAuth ?? false);

  // ── Load form ──────────────────────────────────────────────────────────────
  onMount(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/forms/${formId}`);
      if (!res.ok) { notFound = true; return; }
      form = await res.json() as FormData;
      isCustomForm = form.formType === 'custom';
    } catch {
      notFound = true;
    } finally {
      loading = false;
    }
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  function validateSection(): boolean {
    const newErrors: Record<string,string> = {};
    for (const field of currentFields) {
      const val = answers[field.id];
      if (field.required) {
        if (!val || (Array.isArray(val) && val.length === 0) || val === '') {
          newErrors[field.id] = 'Ce champ est obligatoire';
          continue;
        }
      }
      if (field.type === 'email' && val && typeof val === 'string') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
          newErrors[field.id] = 'Adresse email invalide';
        }
      }
      if (field.type === 'number' && val !== undefined && val !== '') {
        const n = Number(val);
        if (field.validation?.min !== undefined && n < field.validation.min)
          newErrors[field.id] = `Minimum: ${field.validation.min}`;
        if (field.validation?.max !== undefined && n > field.validation.max)
          newErrors[field.id] = `Maximum: ${field.validation.max}`;
      }
    }
    errors = newErrors;
    return Object.keys(newErrors).length === 0;
  }

  // ── Conditional logic: find next section ───────────────────────────────────
  function resolveNextSection(): number {
    // Check all multiple_choice/dropdown fields in current section for logic rules
    for (const field of allFields.filter(f => f.sectionIndex === currentSection)) {
      if (!field.logic?.length) continue;
      const answer = answers[field.id];
      if (typeof answer !== 'string') continue;
      const rule = field.logic.find(r => r.value === answer);
      if (rule) return rule.targetSectionIndex;
    }
    return currentSection + 1;
  }

  function nextSection() {
    if (authRequired && !authStore.isAuthenticated) { submitError = 'Vous devez vous connecter avec Discord avant de continuer.'; return; }
    if (!validateSection()) return;
    const next = resolveNextSection();
    if (next < totalSections) {
      currentSection = next;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      void submit();
    }
  }

  function prevSection() {
    if (currentSection > 0) {
      currentSection--;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function submit() {
    if (authRequired && !authStore.isAuthenticated) { submitError = 'Vous devez vous connecter avec Discord avant de soumettre ce formulaire.'; return; }
    if (!validateSection()) return;
    submitting = true;
    submitError = '';
    try {
      // Extract well-known fields for top-level metadata
      const discordId = (answers['discord_id'] as string) || undefined;
      const email = (answers['email'] as string) || undefined;
      const username = (answers['discord_username'] as string) || undefined;

      const endpoint = isCustomForm
        ? `${API_BASE_URL}/api/public/custom-forms/${formId}/submit`
        : `${API_BASE_URL}/api/public/forms/${formId}/submit`;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authStore.token) headers.Authorization = `Bearer ${authStore.token}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: answers, discordId, email, username }),
      });
      if (!res.ok) {
        const err = await res.json();
        submitError = err.error || 'Erreur lors de la soumission';
        return;
      }
      submitted = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      submitError = 'Impossible de contacter le serveur. Vérifiez votre connexion.';
    } finally {
      submitting = false;
    }
  }

  // ── Input helpers ──────────────────────────────────────────────────────────
  function setAnswer(id: string, value: string) { answers = { ...answers, [id]: value }; }

  function toggleCheckbox(id: string, option: string) {
    const current = (answers[id] as string[]) || [];
    const updated = current.includes(option)
      ? current.filter(v => v !== option)
      : [...current, option];
    answers = { ...answers, [id]: updated };
  }

  function setGridAnswer(id: string, rowId: string, colId: string, multi: boolean) {
    const current = (answers[id] as Record<string,string|string[]>) || {};
    if (multi) {
      const existing = (current[rowId] as string[]) || [];
      current[rowId] = existing.includes(colId) ? existing.filter(c => c !== colId) : [...existing, colId];
    } else {
      current[rowId] = colId;
    }
    answers = { ...answers, [id]: { ...current } };
  }

  function loginWithDiscord() {
    window.location.href = `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }

  $effect(() => { if (theme?.fontFamily) loadGoogleFont(theme.fontFamily); });

  $effect(() => {
    if (authStore.user && form?.structure?.fields) {
      if (authStore.user.id) {
        const idField = form.structure.fields.find(f => f.id === 'discord_id' || f.label.toLowerCase().includes('discord id'));
        if (idField && !answers[idField.id]) {
          answers[idField.id] = authStore.user.id;
        }
      }
      if (authStore.user.username) {
        const userField = form.structure.fields.find(f => f.id === 'discord_username' || f.label.toLowerCase().includes('pseudo discord') || f.label.toLowerCase().includes('discord username') || f.label.toLowerCase().includes('nom discord'));
        if (userField && !answers[userField.id]) {
          answers[userField.id] = authStore.user.username;
        }
      }
    }
  });
</script>

<svelte:head>
  <title>{form?.name ?? 'Formulaire'} | Kotbo</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="pf-root min-h-screen bg-gradient-to-br from-surface to-surface-container-low/50 py-8 px-4" style={rootStyle}>

  {#if injectedCss}
    {@html `<style>${injectedCss}</style>`}
  {/if}

  {#if loading}
    <div class="flex items-center justify-center min-h-[60vh]">
      <div class="text-center">
        <div class="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin mx-auto mb-4"></div>
        <p class="text-on-surface-variant/60">Chargement du formulaire…</p>
      </div>
    </div>

  {:else if notFound}
    <div class="max-w-lg mx-auto text-center py-24">
      <div class="flex justify-center mb-6 text-on-surface-variant/40"><Papicon icon="search" size={56} /></div>
      <h1 class="text-2xl font-semibold text-on-surface mb-3">Formulaire introuvable</h1>
      <p class="text-on-surface-variant/60 text-sm">Ce formulaire n'existe pas ou n'est plus actif.</p>
    </div>

  {:else if submitted}
    <!-- ── Success ── -->
    <div class="max-w-lg mx-auto">
      <div class="pf-card rounded-xl overflow-hidden shadow-sm border border-outline-variant/20">
        <div class="h-3" style="background:var(--form-color)"></div>
        <div class="bg-surface p-10 text-center">
          <div class="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg"
            style="background:color-mix(in srgb, var(--form-color) 15%, transparent)">
            <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                style="stroke:var(--form-color)" />
            </svg>
          </div>
          <h1 class="text-2xl font-semibold text-on-surface mb-3">Réponse envoyée !</h1>
          <p class="text-on-surface-variant/70 text-sm leading-relaxed">
            {theme?.confirmationText || 'Votre réponse a bien été reçue. Vous serez contacté prochainement par notre équipe.'}
          </p>
          <div class="mt-8 text-xs text-on-surface-variant/40">
            Propulsé par <span class="font-bold" style="color:var(--form-color)">Kotbo</span>
          </div>
        </div>
      </div>
    </div>

  {:else if form}
    <div class="max-w-2xl mx-auto space-y-4">

      <!-- Progress bar (multi-section) -->
      {#if totalSections > 1}
        <div class="flex items-center gap-3 px-1">
          <div class="flex-1 h-1.5 bg-surface-container rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" style="width:{progress}%;background:var(--form-color)"></div>
          </div>
          <span class="text-xs font-semibold text-on-surface-variant/60 shrink-0">
            {currentSection + 1} / {totalSections}
          </span>
        </div>
      {/if}

      <!-- Bannière du thème -->
      {#if theme?.bannerUrl}
        <div class="pf-banner rounded-xl overflow-hidden shadow-lg border border-outline-variant/20">
          <img src={theme.bannerUrl} alt="" class="w-full max-h-52 object-cover" />
        </div>
      {/if}

      <!-- Header card -->
      <div class="pf-card rounded-xl overflow-hidden shadow-lg border border-outline-variant/20">
        <div class="h-3" style="background:var(--form-color)"></div>
        <div class="bg-surface p-6">
          {#if theme?.logoUrl}
            <img src={theme.logoUrl} alt="" class="pf-logo w-14 h-14 rounded-2xl object-cover mb-3 shadow-md" />
          {/if}
          <h1 class="text-2xl font-semibold text-on-surface">{form.name}</h1>
          {#if form.description}
            <p class="text-on-surface-variant/70 mt-2 text-sm leading-relaxed">{form.description}</p>
          {/if}
          {#if theme?.welcomeText}
            <p class="mt-3 text-sm leading-relaxed" style="color:var(--form-color)">{theme.welcomeText}</p>
          {/if}
          {#if currentSection > 0}
            <div class="mt-4 pt-4 border-t border-outline-variant/10">
              <h2 class="text-lg font-bold text-on-surface">{sections[currentSection]?.title}</h2>
              {#if sections[currentSection]?.description}
                <p class="text-sm text-on-surface-variant/60 mt-1">{sections[currentSection].description}</p>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <!-- Discord association section -->
      {#if !authStore.isAuthenticated}
        <div class="rounded-xl border p-5 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-sm animate-in fade-in duration-300
 {authRequired ? 'border-warning/30 bg-warning/5' : 'border-blue-500/20 bg-blue-500/5'}">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0
 {authRequired ? 'bg-warning/10 text-warning' : 'bg-blue-500/10 text-blue-500'}">
              <svg class="w-5 h-5 fill-current" viewBox="0 0 127.14 96.36">
                <path d="M107.7,8.07A105.15,105.15,0,0,0,77.26,0a77.19,77.19,0,0,0-3.3,6.83A96.67,96.67,0,0,0,53.22,6.83,77.19,77.19,0,0,0,49.88,0,105.15,105.15,0,0,0,19.44,8.07C3.66,31.58-1.86,54.65,1,77.53A105.73,105.73,0,0,0,32,96.36a77.7,77.7,0,0,0,6.63-10.85,68.43,68.43,0,0,1-10.5-5c.9-.65,1.76-1.34,2.58-2a75.58,75.58,0,0,0,72.9,0c.82.71,1.68,1.4,2.58,2a68.69,68.69,0,0,1-10.5,5,77.7,77.7,0,0,0,6.63,10.85,105.73,105.73,0,0,0,31-18.83C129.87,49.86,124.15,26.91,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53S36.18,40.36,42.45,40.36,53.83,46,53.83,53,48.72,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.24,60,73.24,53S78.41,40.36,84.69,40.36,96.07,46,96.07,53,91,65.69,84.69,65.69Z"/>
              </svg>
            </div>
            <div>
              <h4 class="font-semibold text-on-surface text-sm">
                {authRequired ? 'Connexion Discord obligatoire' : 'Connexion Discord recommandée'}
              </h4>
              <p class="text-xs text-on-surface-variant/70 mt-0.5">
                {authRequired
                  ? 'Ce formulaire nécessite de se connecter avec Discord avant de pouvoir être rempli.'
                  : 'Associez votre compte Discord pour préremplir votre ID et votre pseudo automatiquement.'}
              </p>
            </div>
          </div>
          <button
            onclick={loginWithDiscord}
            class="px-4 py-2 text-white rounded-lg text-body-sm font-medium transition-all shadow-md shrink-0 flex items-center gap-2
 {authRequired ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}"
          >
            Se connecter
          </button>
        </div>
      {:else}
        <div class="rounded-xl border border-success/20 bg-success/5 p-5 flex items-center justify-between gap-4 shadow-sm animate-in fade-in duration-300">
          <div class="flex items-center gap-3">
            {#if authStore.user?.avatar}
              <img 
                src="https://cdn.discordapp.com/avatars/{authStore.user.id}/{authStore.user.avatar}.png" 
                alt="Avatar" 
                class="w-10 h-10 rounded-full shrink-0 border border-success/30" 
              />
            {:else}
              <div class="w-10 h-10 rounded-full bg-success/10 text-success flex items-center justify-center shrink-0 border border-success/30 font-semibold text-sm">
                {authStore.user?.username?.charAt(0).toUpperCase()}
              </div>
            {/if}
            <div>
              <h4 class="font-semibold text-on-surface text-sm">Connecté avec Discord</h4>
              <p class="text-xs text-on-surface-variant/70 mt-0.5">En tant que <span class="font-bold text-success">{authStore.user?.username}</span> (ID: {authStore.user?.id})</p>
            </div>
          </div>
          <button
            onclick={() => authStore.logout()}
            class="px-3 py-1.5 border border-outline-variant/35 text-on-surface-variant hover:bg-surface-hover hover:text-on-surface rounded-lg text-xs font-semibold transition-all shrink-0"
          >
            Déconnexion
          </button>
        </div>
      {/if}

      <!-- Fields (masqués tant que la connexion Discord obligatoire n'est pas faite) -->
      {#if !authRequired || authStore.isAuthenticated}
      {#each currentFields as field (field.id)}
        {@const error = errors[field.id]}
        <div class="pf-card pf-field rounded-lg bg-surface border border-outline-variant/20 p-5 shadow-sm
 {error ? 'ring-2 ring-error/40' : ''}">

          <label for={field.id} class="block font-semibold text-on-surface mb-1 text-[15px]">
            {field.label}
            {#if field.required}<span class="text-error ml-1">*</span>{/if}
          </label>
          {#if field.description}
            <p class="text-xs text-on-surface-variant/60 mb-3 leading-relaxed">{field.description}</p>
          {/if}

          {#if field.type === 'short_text'}
            <input id={field.id} type="text" value={(answers[field.id] as string) || ''}
              oninput={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
              placeholder={field.placeholder || ''}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors" />

          {:else if field.type === 'email'}
            <input id={field.id} type="email" value={(answers[field.id] as string) || ''}
              oninput={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
              placeholder={field.placeholder || 'exemple@email.com'}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors" />

          {:else if field.type === 'number'}
            <input id={field.id} type="number" value={(answers[field.id] as string) || ''}
              min={field.validation?.min} max={field.validation?.max}
              oninput={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
              placeholder={field.placeholder || ''}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors" />

          {:else if field.type === 'paragraph'}
            <textarea id={field.id} value={(answers[field.id] as string) || ''}
              oninput={(e) => setAnswer(field.id, (e.target as HTMLTextAreaElement).value)}
              placeholder={field.placeholder || ''}
              rows={4}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors resize-y"></textarea>

          {:else if field.type === 'multiple_choice'}
            <div class="space-y-2">
              {#each field.options || [] as opt}
                <label class="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-surface-container/50 transition-colors group">
                  <div class="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all
 {answers[field.id] === opt ? 'border-primary' : 'border-outline-variant/50 group-hover:border-primary/50'}"
                    style={answers[field.id] === opt ? `border-color:var(--form-color)` : ''}>
                    {#if answers[field.id] === opt}
                      <div class="w-2.5 h-2.5 rounded-full" style="background:var(--form-color)"></div>
                    {/if}
                  </div>
                  <input type="radio" name={field.id} value={opt} class="sr-only"
                    onchange={() => setAnswer(field.id, opt)} />
                  <span class="text-sm text-on-surface">{opt}</span>
                </label>
              {/each}
            </div>

          {:else if field.type === 'checkboxes'}
            <div class="space-y-2">
              {#each field.options || [] as opt}
                {@const checked = ((answers[field.id] as string[]) || []).includes(opt)}
                <label class="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-surface-container/50 transition-colors group">
                  <div class="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all
 {checked ? 'border-primary' : 'border-outline-variant/50 group-hover:border-primary/50'}"
                    style={checked ? `border-color:var(--form-color);background:var(--form-color)` : ''}>
                    {#if checked}
                      <svg class="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round"/>
                      </svg>
                    {/if}
                  </div>
                  <input type="checkbox" class="sr-only" checked={checked}
                    onchange={() => toggleCheckbox(field.id, opt)} />
                  <span class="text-sm text-on-surface">{opt}</span>
                </label>
              {/each}
            </div>

          {:else if field.type === 'dropdown'}
            <select id={field.id} value={(answers[field.id] as string) || ''}
              onchange={(e) => setAnswer(field.id, (e.target as HTMLSelectElement).value)}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/30 focus:border-primary transition-colors appearance-none cursor-pointer">
              <option value="" disabled>Sélectionner une option…</option>
              {#each field.options || [] as opt}
                <option value={opt}>{opt}</option>
              {/each}
            </select>

          {:else if field.type === 'linear_scale'}
            {@const min = field.scaleMin ?? 1}
            {@const max = field.scaleMax ?? 5}
            {@const scale = Array.from({length: max - min + 1}, (_, i) => min + i)}
            <div class="mt-2">
              <div class="flex items-center gap-2">
                {#if field.scaleMinLabel}
                  <span class="text-xs text-on-surface-variant/60 shrink-0">{field.scaleMinLabel}</span>
                {/if}
                <div class="flex gap-1 flex-1 justify-center flex-wrap">
                  {#each scale as n}
                    {@const selected = answers[field.id] === String(n)}
                    <label class="flex flex-col items-center gap-1 cursor-pointer">
                      <div class="w-9 h-9 rounded-full border-2 flex items-center justify-center text-sm font-bold transition-all
 {selected ? 'text-white scale-110' : 'border-outline-variant/40 hover:border-primary/50 text-on-surface-variant/70'}"
                        style={selected ? `background:var(--form-color);border-color:var(--form-color)` : ''}>
                        {n}
                      </div>
                      <input type="radio" name={field.id} value={String(n)} class="sr-only"
                        onchange={() => setAnswer(field.id, String(n))} />
                    </label>
                  {/each}
                </div>
                {#if field.scaleMaxLabel}
                  <span class="text-xs text-on-surface-variant/60 shrink-0">{field.scaleMaxLabel}</span>
                {/if}
              </div>
            </div>

          {:else if field.type === 'date'}
            <input id={field.id} type="date" value={(answers[field.id] as string) || ''}
              onchange={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/30 focus:border-primary transition-colors" />

          {:else if field.type === 'time'}
            <input id={field.id} type="time" value={(answers[field.id] as string) || ''}
              onchange={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
              class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/30 focus:border-primary transition-colors" />

          {:else if field.type === 'multiple_choice_grid' || field.type === 'checkbox_grid'}
            {@const isMulti = field.type === 'checkbox_grid'}
            <div class="overflow-x-auto -mx-1">
              <table class="w-full text-sm min-w-max">
                <thead>
                  <tr>
                    <th class="text-left py-2 pr-4 text-xs text-on-surface-variant/50 font-semibold"></th>
                    {#each field.columns || [] as col}
                      <th class="text-center py-2 px-3 text-xs text-on-surface-variant/60 font-semibold">{col.label}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each field.rows || [] as row}
                    <tr class="border-t border-outline-variant/10 hover:bg-surface-container/30 transition-colors">
                      <td class="py-3 pr-4 text-on-surface/80 text-sm">{row.label}</td>
                      {#each field.columns || [] as col}
                        {@const gridAns = (answers[field.id] as Record<string,string|string[]>) || {}}
                        {@const selected = isMulti
                          ? ((gridAns[row.id] as string[]) || []).includes(col.id)
                          : gridAns[row.id] === col.id}
                        <td class="py-3 px-3 text-center">
                          <button onclick={() => setGridAnswer(field.id, row.id, col.id, isMulti)}
                            class="w-5 h-5 mx-auto flex items-center justify-center transition-all
 {isMulti ? 'rounded' : 'rounded-full'} border-2
                              {selected ? 'border-primary scale-110' : 'border-outline-variant/40 hover:border-primary/50'}"
                            style={selected ? `border-color:var(--form-color);background:var(--form-color)` : ''}>
                            {#if selected && !isMulti}
                              <div class="w-2 h-2 rounded-full bg-white"></div>
                            {:else if selected}
                              <svg class="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                                <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round"/>
                              </svg>
                            {/if}
                          </button>
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          {#if error}
            <p class="pf-error mt-2 text-xs text-error flex items-center gap-1">
              <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 7a1 1 0 110-2 1 1 0 010 2z"/>
              </svg>
              {error}
            </p>
          {/if}
        </div>
      {/each}
      {/if}

      <!-- Submit error -->
      {#if submitError}
        <div class="rounded-lg bg-error/10 border border-error/20 px-5 py-4 text-sm text-error font-medium">
          {submitError}
        </div>
      {/if}

      <!-- Navigation buttons -->
      {#if !authRequired || authStore.isAuthenticated}
      {#if currentSection === totalSections - 1}
        <PrivacyNotice compact text="Les réponses sont transmises aux responsables du serveur pour traiter ce formulaire. Ne saisissez pas de donnée sensible non demandée. " />
      {/if}
      <div class="flex items-center gap-3 pb-8">
        {#if currentSection > 0}
          <button onclick={prevSection}
            class="px-6 py-3 rounded-xl bg-surface-container font-bold text-sm hover:bg-surface-container-high transition-colors">
            <span class="inline-flex items-center gap-2">
              <Papicon icon="arrow-left" size={14} />
              Précédent
            </span>
          </button>
        {/if}
        <div class="flex-1"></div>
        <button onclick={nextSection} disabled={submitting}
          class="pf-submit px-8 py-3 rounded-xl text-white font-semibold text-sm shadow-lg transition-all active:scale-[0.98] disabled:opacity-60 disabled:scale-100"
          style="background:var(--form-color)">
          {#if submitting}
            <span class="flex items-center gap-2">
              <div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div>
              Envoi…
            </span>
          {:else if currentSection < totalSections - 1}
            Suivant →
          {:else}
            Envoyer ✓
          {/if}
        </button>
      </div>
      {/if}

      <!-- Footer -->
      <div class="text-center pb-4 text-xs text-on-surface-variant/30">
        Propulsé par <span class="font-bold" style="color:var(--form-color)">Kotbo</span>
      </div>
    </div>
  {/if}
</div>
