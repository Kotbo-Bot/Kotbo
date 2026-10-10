<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardFetch } from '../lib/api';
  import Papicon from '../lib/components/Papicon.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { ALLOWED_FONTS, loadGoogleFont, themeStyleVars, type FormTheme } from '../lib/formTheme';
  import { m } from '../lib/i18n';
  import { isMobile } from '../lib/stores/media.svelte';

  // ── Props ──────────────────────────────────────────────────────────────────
  const { formId = null }: { formId?: string | null } = $props();

  // ── Types ──────────────────────────────────────────────────────────────────
  type FieldType =
    | 'short_text' | 'paragraph' | 'multiple_choice' | 'checkboxes'
    | 'dropdown' | 'linear_scale' | 'multiple_choice_grid' | 'checkbox_grid'
    | 'date' | 'time' | 'number' | 'email' | 'section_header';

  interface ConditionalLogic {
    fieldId: string;
    value: string;
    action: 'go_to_section';
    targetSectionIndex: number;
  }

  interface GridRow { id: string; label: string; }
  interface GridColumn { id: string; label: string; }

  interface FormField {
    id: string;
    type: FieldType;
    label: string;
    description?: string;
    required: boolean;
    placeholder?: string;
    options?: string[];
    rows?: GridRow[];
    columns?: GridColumn[];
    scaleMin?: number;
    scaleMax?: number;
    scaleMinLabel?: string;
    scaleMaxLabel?: string;
    validation?: { min?: number; max?: number; pattern?: string };
    logic?: ConditionalLogic[];
    sectionIndex: number;
  }

  interface Section {
    id: string;
    title: string;
    description?: string;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let formName = $state('Formulaire sans titre');
  let formDescription = $state('');
  let headerColor = $state('#6366f1');
  let sections = $state<Section[]>([{ id: 'section_0', title: m.fb_section_default_title({ number: 1 }), description: '' }]);
  let fields = $state<FormField[]>([]);
  let activeFieldId = $state<string | null>(null);
  let activeSection = $state(0);
  let showPreview = $state(false);
  let saving = $state(false);
  let loading = $state(true);
  let dragOverId = $state<string | null>(null);
  let dragSourceId = $state<string | null>(null);

  // Apparence (formulaires autonomes uniquement)
  let theme = $state<FormTheme>({});
  let customCss = $state('');
  let showAppearance = $state(false);
  let showMobileTools = $state(false);

  const PALETTE = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#0ea5e9','#1d4ed8','#374151'];

  const FIELD_TYPES = $derived<{ type: FieldType; label: string; icon: string }[]>([
    { type: 'short_text',           label: m.fb_field_short_text(),         icon: 'short_text' },
    { type: 'paragraph',            label: m.fb_field_paragraph(),          icon: 'notes' },
    { type: 'multiple_choice',      label: m.fb_field_multiple_choice(),        icon: 'radio_button_checked' },
    { type: 'checkboxes',           label: m.fb_field_checkboxes(),      icon: 'check_box' },
    { type: 'dropdown',             label: m.fb_field_dropdown(),    icon: 'arrow_drop_down_circle' },
    { type: 'linear_scale',         label: m.fb_field_linear_scale(),    icon: 'linear_scale' },
    { type: 'multiple_choice_grid', label: m.fb_field_multiple_choice_grid(),      icon: 'grid_on' },
    { type: 'checkbox_grid',        label: m.fb_field_checkbox_grid(),      icon: 'grid_view' },
    { type: 'date',                 label: m.fb_field_date(),                icon: 'calendar_today' },
    { type: 'time',                 label: m.fb_field_time(),               icon: 'schedule' },
    { type: 'number',               label: m.fb_field_number(),              icon: 'pin' },
    { type: 'email',                label: m.fb_field_email(),               icon: 'email' },
    { type: 'section_header',       label: m.fb_field_section_header(),    icon: 'title' },
  ]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const isCustomFormMode = $derived(window.location.pathname.startsWith('/forms'));
  const sectionFields = $derived((sIdx: number) => fields.filter(f => f.sectionIndex === sIdx));
  const publicUrl = $derived(
    formId && formId !== 'new' ? `${window.location.origin}/form/${formId}` : null,
  );

  // ── Load ───────────────────────────────────────────────────────────────────
  onMount(async () => {
    if (formId && formId !== 'new') {
      try {
        const endpoint = isCustomFormMode
          ? `/custom-forms/${formId}`
          : `/recruitment/forms/${formId}`;
        const res = await dashboardFetch(endpoint);
        if (res.ok) {
          const data = await res.json();
          const form = data.form;
          const structure = form.structure as any;
          formName = form.name;
          formDescription = form.description || '';
          headerColor = structure.headerColor || '#6366f1';
          sections = structure.sections || [{ id: 'section_0', title: 'Section 1', description: '' }];
          fields = structure.fields || [];
          theme = (form.theme as FormTheme) || {};
          customCss = form.customCss || '';
        }
      } catch { /* ignore */ }
    }
    loading = false;
  });

  // ── Auto-save (debounce 2s) ────────────────────────────────────────────────
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Access reactive state to subscribe
    void formName; void formDescription; void headerColor;
    void JSON.stringify(sections); void JSON.stringify(fields);
    void JSON.stringify(theme); void customCss;
    if (loading) return;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { void save(true); }, 2000);
  });

  // Charge la police du thème pour l'aperçu
  $effect(() => { if (theme.fontFamily) loadGoogleFont(theme.fontFamily); });

  // ── Actions ────────────────────────────────────────────────────────────────
  function uid() { return `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

  function addField(type: FieldType) {
    const defaults: Partial<FormField> = {};
    if (['multiple_choice','checkboxes','dropdown'].includes(type)) defaults.options = [m.fb_option_default({ number: 1 }), m.fb_option_default({ number: 2 })];
    if (type === 'linear_scale') { defaults.scaleMin = 1; defaults.scaleMax = 5; defaults.scaleMinLabel = ''; defaults.scaleMaxLabel = ''; }
    if (type === 'multiple_choice_grid' || type === 'checkbox_grid') {
      defaults.rows = [{ id: uid(), label: m.fb_row_default({ number: 1 }) }];
      defaults.columns = [{ id: uid(), label: m.fb_col_default({ number: 1 }) }, { id: uid(), label: m.fb_col_default({ number: 2 }) }];
    }
    const newField: FormField = {
      id: uid(), type, sectionIndex: activeSection,
      label: m.fb_question_default_title(), required: false, ...defaults,
    };
    fields = [...fields, newField];
    activeFieldId = newField.id;
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      showMobileTools = false;
    }
  }

  function duplicateField(field: FormField) {
    const copy: FormField = { ...field, id: uid(), label: field.label + m.fb_question_copy_suffix() };
    if (field.options) copy.options = [...field.options];
    const idx = fields.findIndex(f => f.id === field.id);
    fields = [...fields.slice(0, idx + 1), copy, ...fields.slice(idx + 1)];
    activeFieldId = copy.id;
  }

  function moveField(id: string, direction: -1 | 1) {
    const index = fields.findIndex((field) => field.id === id);
    if (index < 0) return;

    const sameSection = fields
      .map((field, fieldIndex) => ({ field, fieldIndex }))
      .filter(({ field }) => field.sectionIndex === fields[index].sectionIndex);
    const position = sameSection.findIndex(({ field }) => field.id === id);
    const target = sameSection[position + direction];
    if (!target) return;

    const next = [...fields];
    [next[index], next[target.fieldIndex]] = [next[target.fieldIndex], next[index]];
    fields = next;
  }

  function removeField(id: string) {
    fields = fields.filter(f => f.id !== id);
    if (activeFieldId === id) activeFieldId = null;
  }

  function addSection() {
    const idx = sections.length;
    sections = [...sections, { id: uid(), title: m.fb_section_default_title({ number: idx + 1 }), description: '' }];
  }

  function removeSection(idx: number) {
    if (sections.length === 1) return;
    sections = sections.filter((_, i) => i !== idx);
    // Re-index fields
    fields = fields
      .filter(f => f.sectionIndex !== idx)
      .map(f => ({ ...f, sectionIndex: f.sectionIndex > idx ? f.sectionIndex - 1 : f.sectionIndex }));
    if (activeSection >= sections.length) activeSection = sections.length - 1;
  }

  function updateField<K extends keyof FormField>(id: string, key: K, value: FormField[K]) {
    fields = fields.map(f => f.id === id ? { ...f, [key]: value } : f);
  }

  function addOption(fieldId: string) {
    const field = fields.find(f => f.id === fieldId);
    if (!field?.options) return;
    updateField(fieldId, 'options', [...field.options, m.fb_option_default({ number: field.options.length + 1 })]);
  }

  function removeOption(fieldId: string, optIdx: number) {
    const field = fields.find(f => f.id === fieldId);
    if (!field?.options) return;
    updateField(fieldId, 'options', field.options.filter((_, i) => i !== optIdx));
  }

  function updateOption(fieldId: string, optIdx: number, value: string) {
    const field = fields.find(f => f.id === fieldId);
    if (!field?.options) return;
    const opts = [...field.options];
    opts[optIdx] = value;
    updateField(fieldId, 'options', opts);
  }

  function addGridRow(fieldId: string) {
    const field = fields.find(f => f.id === fieldId);
    if (!field?.rows) return;
    updateField(fieldId, 'rows', [...field.rows, { id: uid(), label: m.fb_row_default({ number: field.rows.length + 1 }) }]);
  }

  function addGridColumn(fieldId: string) {
    const field = fields.find(f => f.id === fieldId);
    if (!field?.columns) return;
    updateField(fieldId, 'columns', [...field.columns, { id: uid(), label: m.fb_col_default({ number: field.columns.length + 1 }) }]);
  }

  function addLogicRule(fieldId: string) {
    const field = fields.find(f => f.id === fieldId);
    const existing = field?.logic || [];
    updateField(fieldId, 'logic', [...existing, {
      fieldId, value: '', action: 'go_to_section', targetSectionIndex: 0,
    }]);
  }

  // ── Drag-and-drop (native) ─────────────────────────────────────────────────
  function onDragStart(e: DragEvent, id: string) {
    dragSourceId = id;
    (e.dataTransfer as DataTransfer).effectAllowed = 'move';
  }

  function onDragOver(e: DragEvent, id: string) {
    e.preventDefault();
    dragOverId = id;
  }

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragSourceId || dragSourceId === targetId) { dragOverId = null; return; }
    const srcIdx = fields.findIndex(f => f.id === dragSourceId);
    const tgtIdx = fields.findIndex(f => f.id === targetId);
    const reordered = [...fields];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    fields = reordered;
    dragOverId = null;
    dragSourceId = null;
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function save(silent = false) {
    if (!authStore.selectedGuildId) return;
    saving = true;
    const structure = { title: formName, description: formDescription, headerColor, sections, fields };
    // Le thème n'existe que sur les formulaires autonomes (CustomForm)
    const appearance = isCustomFormMode
      ? { theme: Object.keys(theme).length ? theme : null, customCss: customCss.trim() || null }
      : {};
    try {
      if (formId && formId !== 'new') {
        // Update existing
        const endpoint = isCustomFormMode
          ? `/custom-forms/${formId}`
          : `/recruitment/forms/${formId}`;
        await dashboardFetch(endpoint, {
          method: 'PATCH',
          payload: { name: formName, description: formDescription, structure, ...appearance },
        });
        if (!silent) toast.success(m.fb_saved_toast());
      } else {
        // Create new → navigate to edit URL
        const endpoint = isCustomFormMode ? '/custom-forms' : '/recruitment/forms';
        const res = await dashboardFetch(endpoint, {
          method: 'POST',
          payload: { name: formName, description: formDescription, structure, template: 'custom', ...appearance },
        });
        if (res.ok) {
          const data = await res.json();
          const targetUrl = isCustomFormMode
            ? `/forms/builder/${data.form.id}`
            : `/recruitment-forms/builder/${data.form.id}`;
          router.goto(targetUrl);
          toast.success(m.fb_created_toast());
        }
      }
    } catch {
      if (!silent) toast.error('Erreur lors de la sauvegarde');
    } finally {
      saving = false;
    }
  }

  function copyPublicUrl() {
    if (publicUrl) {
      navigator.clipboard.writeText(publicUrl);
      toast.success(m.fb_url_copied_toast());
    }
  }
</script>

{#if loading}
  <div class="flex items-center justify-center min-h-screen bg-surface">
    <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
  </div>
{:else if showPreview}
  <!-- ── PREVIEW MODE ───────────────────────────────────────────────────────── -->
  <div class="min-h-screen bg-surface/50 pf-root"
    style="{themeStyleVars(theme, headerColor)};{theme.backgroundColor ? `background:${theme.backgroundColor};` : ''}{theme.fontFamily ? `font-family:var(--form-font);` : ''}{theme.textColor ? `color:${theme.textColor};` : ''}">
    {#if customCss.trim()}
      {@html `<style>${customCss.replace(/<\/style/gi, '')}</style>`}
    {/if}
    <div class="sticky top-0 z-10 bg-surface border-b border-outline-variant/20 px-6 py-3 flex items-center justify-between">
      <span class="font-semibold text-on-surface">{m.fb_preview_title()}</span>
      <button onclick={() => showPreview = false}
        class="px-4 py-2 rounded-xl bg-primary text-white text-sm font-bold flex items-center gap-2">
        <Papicon icon="edit" size={16} /> {m.fb_back_to_edit()}
      </button>
    </div>
    <div class="max-w-2xl mx-auto p-6 space-y-4 pt-8">
      <!-- Bannière / logo du thème -->
      {#if theme.bannerUrl}
        <div class="pf-banner rounded-xl overflow-hidden shadow-lg" style="border-radius:var(--form-radius,12px)">
          <img src={theme.bannerUrl} alt="Bannière" class="w-full h-40 object-cover" />
        </div>
      {/if}
      <!-- Header card -->
      <div class="pf-card rounded-lg overflow-hidden shadow-lg" style="border-radius:var(--form-radius,12px)">
        <div class="h-2" style="background:var(--form-color)"></div>
        <div class="border border-outline-variant/20 p-6 rounded-b-2xl"
          style="background:{theme.cardColor || 'var(--color-surface, #fff)'};{theme.glass ? 'backdrop-filter:blur(12px);background:color-mix(in srgb, ' + (theme.cardColor || '#151823') + ' 70%, transparent);' : ''}">
          {#if theme.logoUrl}
            <img src={theme.logoUrl} alt="Logo" class="w-14 h-14 rounded-2xl object-cover mb-3 shadow" />
          {/if}
          <h1 class="text-2xl font-semibold text-on-surface" style={theme.textColor ? `color:${theme.textColor}` : ''}>{formName}</h1>
          {#if formDescription}<p class="text-on-surface-variant/70 mt-2 text-sm">{formDescription}</p>{/if}
          {#if theme.welcomeText}<p class="mt-3 text-sm" style="color:var(--form-color)">{theme.welcomeText}</p>{/if}
        </div>
      </div>

      {#each sections as section, sIdx}
        {#if sIdx > 0}
          <div class="bg-surface border border-outline-variant/20 rounded-lg p-5 shadow">
            <div class="h-1 rounded-full mb-4" style="background:{headerColor}"></div>
            <h2 class="text-lg font-semibold text-on-surface">{section.title}</h2>
            {#if section.description}<p class="text-sm text-on-surface-variant/70 mt-1">{section.description}</p>{/if}
          </div>
        {/if}
        {#each sectionFields(sIdx) as field (field.id)}
          {#if field.type !== 'section_header'}
            <div class="bg-surface border border-outline-variant/20 rounded-lg p-5 shadow">
              <span class="block font-semibold text-on-surface mb-1">
                {field.label}{#if field.required}<span class="text-error ml-1">*</span>{/if}
              </span>
              {#if field.description}<p class="text-xs text-on-surface-variant/60 mb-3">{field.description}</p>{/if}

              {#if field.type === 'short_text' || field.type === 'email' || field.type === 'number'}
                <input type={field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text'}
                  placeholder={field.placeholder || ''}
                  class="w-full bg-surface-container rounded-xl px-4 py-2.5 text-sm border-b-2 border-primary/30 focus:border-primary outline-none transition-colors" />
              {:else if field.type === 'paragraph'}
                <textarea placeholder={field.placeholder || ''}
                  class="w-full bg-surface-container rounded-xl px-4 py-2.5 text-sm border-b-2 border-primary/30 focus:border-primary outline-none transition-colors resize-none h-24"></textarea>
              {:else if field.type === 'multiple_choice'}
                <div class="space-y-2">
                  {#each field.options || [] as opt}
                    <label class="flex items-center gap-3 cursor-pointer">
                      <input type="radio" name={field.id} class="accent-primary w-4 h-4" />
                      <span class="text-sm text-on-surface">{opt}</span>
                    </label>
                  {/each}
                </div>
              {:else if field.type === 'checkboxes'}
                <div class="space-y-2">
                  {#each field.options || [] as opt}
                    <label class="flex items-center gap-3 cursor-pointer">
                      <input type="checkbox" class="accent-primary w-4 h-4 rounded" />
                      <span class="text-sm text-on-surface">{opt}</span>
                    </label>
                  {/each}
                </div>
              {:else if field.type === 'dropdown'}
                <select class="w-full bg-surface-container rounded-xl px-4 py-2.5 text-sm outline-none border border-outline-variant/30">
                  <option value="">{m.fb_select_placeholder()}</option>
                  {#each field.options || [] as opt}
                    <option>{opt}</option>
                  {/each}
                </select>
              {:else if field.type === 'linear_scale'}
                <div class="flex items-center gap-4 mt-2">
                  {#if field.scaleMinLabel}<span class="text-xs text-on-surface-variant/60">{field.scaleMinLabel}</span>{/if}
                  <div class="flex gap-3 flex-1 justify-center">
                    {#each Array.from({ length: (field.scaleMax ?? 5) - (field.scaleMin ?? 1) + 1 }, (_, i) => (field.scaleMin ?? 1) + i) as n}
                      <label class="flex flex-col items-center gap-1 cursor-pointer">
                        <input type="radio" name={field.id} class="accent-primary" />
                        <span class="text-xs">{n}</span>
                      </label>
                    {/each}
                  </div>
                  {#if field.scaleMaxLabel}<span class="text-xs text-on-surface-variant/60">{field.scaleMaxLabel}</span>{/if}
                </div>
              {:else if field.type === 'date'}
                <input type="date" class="w-full bg-surface-container rounded-xl px-4 py-2.5 text-sm outline-none border border-outline-variant/30" />
              {:else if field.type === 'time'}
                <input type="time" class="w-full bg-surface-container rounded-xl px-4 py-2.5 text-sm outline-none border border-outline-variant/30" />
              {:else if field.type === 'multiple_choice_grid' || field.type === 'checkbox_grid'}
                <div class="overflow-x-auto mt-2">
                  <table class="w-full text-sm">
                    <thead>
                      <tr>
                        <th class="text-left py-1 pr-4 text-on-surface-variant/60"></th>
                        {#each field.columns || [] as col}
                          <th class="text-center py-1 px-2 text-xs font-semibold text-on-surface-variant/70">{col.label}</th>
                        {/each}
                      </tr>
                    </thead>
                    <tbody>
                      {#each field.rows || [] as row}
                        <tr class="border-t border-outline-variant/10">
                          <td class="py-2 pr-4 text-on-surface/80">{row.label}</td>
                          {#each field.columns || [] as _col}
                            <td class="py-2 px-2 text-center">
                              <input type={field.type === 'checkbox_grid' ? 'checkbox' : 'radio'} name={`${field.id}_${row.id}`} class="accent-primary" />
                            </td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {:else}
            <div class="bg-surface border-l-4 rounded-lg p-5 shadow" style="border-left-color:{headerColor}">
              <h3 class="font-semibold text-on-surface text-lg">{field.label}</h3>
              {#if field.description}<p class="text-sm text-on-surface-variant/70 mt-1">{field.description}</p>{/if}
            </div>
          {/if}
        {/each}
      {/each}

      <div class="flex justify-end pt-4">
        <button class="px-8 py-3 rounded-xl text-white font-semibold text-sm" style="background:{headerColor}">
          {m.fb_submit()}
        </button>
      </div>
    </div>
  </div>

{:else}
  <!-- ── EDITOR MODE ────────────────────────────────────────────────────────── -->
  <div class="flex flex-col min-h-screen bg-surface">

    <!-- Top bar -->
    <div class="form-builder-toolbar sticky top-0 z-10 bg-surface/95 border-b border-outline-variant/20 px-4 py-2 flex items-center gap-3">
      <button onclick={() => router.goto(isCustomFormMode ? '/forms' : '/recruitment-forms')}
        class="p-2 rounded-xl hover:bg-surface-container transition-colors"
        aria-label="Revenir à la liste des formulaires">
        <Papicon icon="arrow_back" size={20} />
      </button>
      <div class="form-builder-toolbar-title flex-1 min-w-0">
        <input bind:value={formName}
          class="w-full bg-transparent text-lg font-semibold text-on-surface outline-none focus:border-b-2 focus:border-primary"
          placeholder="Titre du formulaire" />
      </div>

      <div class="flex items-center gap-2 ml-auto shrink-0">
        <button
          type="button"
          onclick={() => showMobileTools = true}
          class="form-builder-tools-trigger hidden items-center gap-1.5 rounded-xl bg-surface-container px-3 py-1.5 text-xs font-bold"
          aria-expanded={showMobileTools}
          aria-controls="form-builder-tools"
        >
          <Papicon icon="tune" size={16} />
          <span>Outils</span>
        </button>
        {#if publicUrl}
          <button onclick={copyPublicUrl}
            class="px-3 py-1.5 rounded-xl bg-surface-container text-xs font-bold flex items-center gap-1.5 hover:bg-surface-container-high transition-colors"
            title={m.fb_public_link()}>
            <Papicon icon="link" size={14} />
            <span class="hidden sm:inline">{m.fb_public_link()}</span>
          </button>
        {/if}
        <button onclick={() => showPreview = true}
          class="px-3 py-1.5 rounded-xl bg-surface-container text-xs font-bold flex items-center gap-1.5 hover:bg-surface-container-high transition-colors">
          <Papicon icon="visibility" size={14} />
          <span class="hidden sm:inline">{m.fb_preview()}</span>
        </button>
        <button onclick={() => save(false)}
          class="px-4 py-1.5 rounded-xl bg-primary text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-primary/90 transition-colors disabled:opacity-60"
          disabled={saving}>
          {#if saving}
            <div class="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"></div>
          {:else}
            <Papicon icon="save" size={14} />
          {/if}
          <span class="hidden sm:inline">{saving ? m.fb_saving() : m.fb_save()}</span>
        </button>
      </div>
    </div>

    <div class="form-builder-workspace flex flex-1 overflow-hidden">

      {#if showMobileTools}
        <button
          type="button"
          class="form-builder-tools-backdrop"
          onclick={() => showMobileTools = false}
          aria-label="Fermer les outils"
        ></button>
      {/if}

      <!-- ── LEFT SIDEBAR: sections + question types ───────────────────────── -->
      <aside
        id="form-builder-tools"
        class:mobile-open={showMobileTools}
        class="form-builder-sidebar w-72 shrink-0 border-r border-outline-variant/20 flex flex-col bg-surface-container-low/40 overflow-y-auto"
      >
        <div class="form-builder-tools-mobile-header">
          <div>
            <p class="text-sm font-semibold text-on-surface">Outils du formulaire</p>
            <p class="text-xs text-on-surface-variant">Sections, champs et apparence</p>
          </div>
          <button type="button" onclick={() => showMobileTools = false} aria-label="Fermer les outils">
            <Papicon icon="x" size={18} />
          </button>
        </div>

        <!-- Header color picker -->
        <div class="p-4 border-b border-outline-variant/10">
          <p class="text-body-sm font-medium text-on-surface-variant/60 mb-2">{m.fb_header_color()}</p>
          <div class="flex flex-wrap gap-2">
            {#each PALETTE as color}
              <button onclick={() => headerColor = color}
                class="w-6 h-6 rounded-full transition-transform {headerColor === color ? 'ring-2 ring-offset-2 ring-offset-surface ring-primary scale-110' : ''}"
                style="background:{color}"
                aria-label="Color {color}"
              ></button>
            {/each}
          </div>
        </div>

        <!-- Apparence (formulaires autonomes uniquement) -->
        {#if isCustomFormMode}
          <div class="border-b border-outline-variant/10">
            <button onclick={() => showAppearance = !showAppearance}
              class="w-full p-4 flex items-center justify-between hover:bg-surface-container/50 transition-colors">
              <p class="text-body-sm font-medium text-on-surface-variant/60 flex items-center gap-2">
                <Papicon icon="palette" size={14} /> {m.fb_appearance()}
              </p>
              <Papicon icon={showAppearance ? 'expand_less' : 'expand_more'} size={16} />
            </button>
            {#if showAppearance}
              <div class="px-4 pb-4 space-y-3">
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_banner_url()}</p>
                  <input bind:value={theme.bannerUrl} placeholder="https://…/banniere.png"
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs outline-none border border-outline-variant/20 focus:border-primary" />
                </div>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_logo_url()}</p>
                  <input bind:value={theme.logoUrl} placeholder="https://…/logo.png"
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs outline-none border border-outline-variant/20 focus:border-primary" />
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_accent()}</p>
                    <input type="color" value={theme.accentColor || headerColor}
                      oninput={(e) => theme.accentColor = (e.currentTarget as HTMLInputElement).value}
                      class="w-full h-8 rounded-lg bg-surface-container border border-outline-variant/20 cursor-pointer" />
                  </div>
                  <div>
                    <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_background()}</p>
                    <input type="color" value={theme.backgroundColor || '#0b0d12'}
                      oninput={(e) => theme.backgroundColor = (e.currentTarget as HTMLInputElement).value}
                      class="w-full h-8 rounded-lg bg-surface-container border border-outline-variant/20 cursor-pointer" />
                  </div>
                  <div>
                    <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_cards()}</p>
                    <input type="color" value={theme.cardColor || '#151823'}
                      oninput={(e) => theme.cardColor = (e.currentTarget as HTMLInputElement).value}
                      class="w-full h-8 rounded-lg bg-surface-container border border-outline-variant/20 cursor-pointer" />
                  </div>
                  <div>
                    <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_text()}</p>
                    <input type="color" value={theme.textColor || '#e5e7eb'}
                      oninput={(e) => theme.textColor = (e.currentTarget as HTMLInputElement).value}
                      class="w-full h-8 rounded-lg bg-surface-container border border-outline-variant/20 cursor-pointer" />
                  </div>
                </div>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_font()}</p>
                  <select value={theme.fontFamily || ''}
                    onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; theme.fontFamily = v || undefined; if (v) loadGoogleFont(v); }}
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs outline-none border border-outline-variant/20">
                    <option value="">{m.fb_font_default()}</option>
                    {#each ALLOWED_FONTS as font}
                      <option value={font}>{font}</option>
                    {/each}
                  </select>
                </div>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">
                    {m.fb_border_radius({ px: theme.borderRadius ?? 12 })}
                  </p>
                  <input type="range" min="0" max="32" value={theme.borderRadius ?? 12}
                    oninput={(e) => theme.borderRadius = Number((e.currentTarget as HTMLInputElement).value)}
                    class="w-full accent-primary" />
                </div>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={theme.glass ?? false}
                    onchange={(e) => theme.glass = (e.currentTarget as HTMLInputElement).checked}
                    class="accent-primary w-4 h-4 rounded" />
                  <span class="text-xs text-on-surface/80">{m.fb_glassmorphism()}</span>
                </label>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_welcome_text()}</p>
                  <textarea bind:value={theme.welcomeText} rows="2" placeholder={m.fb_welcome_text_ph()}
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs outline-none border border-outline-variant/20 focus:border-primary resize-none"></textarea>
                </div>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_confirmation_text()}</p>
                  <textarea bind:value={theme.confirmationText} rows="2" placeholder={m.fb_confirmation_text_ph()}
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-xs outline-none border border-outline-variant/20 focus:border-primary resize-none"></textarea>
                </div>
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant/60 mb-1">{m.fb_custom_css()}</p>
                  <textarea bind:value={customCss} rows="6" spellcheck="false"
                    placeholder={'.pf-card { border: 1px solid gold; }'}
                    class="w-full bg-surface-container rounded-lg px-3 py-2 text-2xs font-mono outline-none border border-outline-variant/20 focus:border-primary resize-y"></textarea>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Sections -->
        <div class="p-4 border-b border-outline-variant/10">
          <div class="flex items-center justify-between mb-2">
            <p class="text-body-sm font-medium text-on-surface-variant/60">{m.fb_sections()}</p>
            <button onclick={addSection}
              class="p-1 rounded-lg hover:bg-surface-container transition-colors text-primary">
              <Papicon icon="add" size={16} />
            </button>
          </div>
          <div class="space-y-1">
            {#each sections as section, sIdx}
              <div class="flex items-center gap-2 group">
                <button onclick={() => activeSection = sIdx}
                  class="flex-1 text-left px-3 py-2 rounded-xl text-sm font-semibold transition-all {activeSection === sIdx ? 'bg-primary text-white' : 'hover:bg-surface-container text-on-surface/70'}">
                  {section.title || m.fb_section_default_title({ number: sIdx + 1 })}
                </button>
                {#if sections.length > 1}
                  <button onclick={() => removeSection(sIdx)}
                    class="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-error/20 text-error transition-all">
                    <Papicon icon="close" size={14} />
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        </div>

        <!-- Add question types -->
        <div class="p-4 flex-1">
          <p class="text-body-sm font-medium text-on-surface-variant/60 mb-3">{m.fb_add_question()}</p>
          <div class="grid grid-cols-1 gap-1">
            {#each FIELD_TYPES as ft}
              <button onclick={() => addField(ft.type)}
                class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface-container text-left transition-colors group">
                <Papicon icon={ft.icon} size={16} class="text-primary/70 group-hover:text-primary transition-colors" />
                <span class="text-xs font-semibold text-on-surface/70 group-hover:text-on-surface transition-colors">{ft.label}</span>
              </button>
            {/each}
          </div>
        </div>
      </aside>

      <!-- ── CENTER: canvas ────────────────────────────────────────────────── -->
      <main class="form-builder-canvas flex-1 overflow-y-auto bg-surface/50 p-6">
        <div class="max-w-2xl mx-auto space-y-3">

          <!-- Form header card -->
          <div class="rounded-lg overflow-hidden shadow-sm border border-outline-variant/20">
            <div class="h-2 transition-colors" style="background:{headerColor}"></div>
            <div class="bg-surface p-5">
              <input bind:value={formName}
                class="w-full bg-transparent text-xl font-semibold text-on-surface outline-none border-b-2 border-transparent focus:border-primary/50 pb-1 mb-2 transition-colors"
                placeholder={m.fb_form_title_ph()} />
              <input bind:value={formDescription}
                class="w-full bg-transparent text-sm text-on-surface-variant outline-none border-b border-transparent focus:border-primary/30 pb-1 transition-colors"
                placeholder={m.fb_form_desc_ph()} />
            </div>
          </div>

          <!-- Section header editor (active section > 0) -->
          {#if activeSection > 0}
            <div class="rounded-lg border-l-4 border-primary bg-surface p-5 shadow-sm border border-outline-variant/20">
              <input bind:value={sections[activeSection].title}
                class="w-full bg-transparent text-lg font-semibold text-on-surface outline-none border-b-2 border-transparent focus:border-primary/50 pb-1 mb-2 transition-colors"
                placeholder={m.fb_section_title_ph()} />
              <input bind:value={sections[activeSection].description}
                class="w-full bg-transparent text-sm text-on-surface-variant outline-none border-b border-transparent focus:border-primary/30 pb-1 transition-colors"
                placeholder={m.fb_section_desc_ph()} />
            </div>
          {/if}

          <!-- Fields -->
          {#each sectionFields(activeSection) as field (field.id)}
            {@const isActive = activeFieldId === field.id}
            <div
              role="button"
              tabindex="0"
              draggable={!$isMobile}
              ondragstart={(e) => onDragStart(e, field.id)}
              ondragover={(e) => onDragOver(e, field.id)}
              ondrop={(e) => onDrop(e, field.id)}
              ondragleave={() => dragOverId = null}
              onclick={() => activeFieldId = field.id}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') activeFieldId = field.id; }}
              class="rounded-lg bg-surface border-2 shadow-sm cursor-pointer transition-all outline-none focus:ring-2 focus:ring-primary/40
 {isActive ? 'border-primary shadow-primary/10' : 'border-outline-variant/20 hover:border-outline-variant/40'}
                {dragOverId === field.id ? 'scale-[1.01] border-primary/60' : ''}">

              <!-- Drag handle row -->
              <div class="flex items-center gap-2 px-4 pt-4 pb-2 border-b border-outline-variant/10">
                <Papicon icon="drag_indicator" size={18} class="text-on-surface-variant/30 cursor-grab" />
                <span class="text-2xs font-mono text-on-surface-variant/40 uppercase">
                  {FIELD_TYPES.find(t => t.type === field.type)?.label ?? field.type}
                </span>
                <div class="ml-auto flex gap-1">
                  <button onclick={(e) => { e.stopPropagation(); moveField(field.id, -1); }}
                    class="p-1.5 rounded-lg hover:bg-surface-container transition-colors" title="Déplacer vers le haut" aria-label="Déplacer vers le haut">
                    <Papicon icon="arrow-up" size={14} />
                  </button>
                  <button onclick={(e) => { e.stopPropagation(); moveField(field.id, 1); }}
                    class="p-1.5 rounded-lg hover:bg-surface-container transition-colors" title="Déplacer vers le bas" aria-label="Déplacer vers le bas">
                    <Papicon icon="arrow-down" size={14} />
                  </button>
                  <button onclick={(e) => { e.stopPropagation(); duplicateField(field); }}
                    class="p-1.5 rounded-lg hover:bg-surface-container transition-colors" title={m.fb_duplicate()} aria-label={m.fb_duplicate()}>
                    <Papicon icon="content_copy" size={14} />
                  </button>
                  <button onclick={(e) => { e.stopPropagation(); removeField(field.id); }}
                    class="p-1.5 rounded-lg hover:bg-error/10 text-error transition-colors" title={m.fb_delete()} aria-label={m.fb_delete()}>
                    <Papicon icon="delete" size={14} />
                  </button>
                </div>
              </div>

              <div class="p-4 space-y-3">
                {#if field.type === 'section_header'}
                  <input value={field.label} oninput={(e) => updateField(field.id, 'label', (e.target as HTMLInputElement).value)}
                    class="w-full text-lg font-semibold bg-transparent outline-none border-b-2 border-transparent focus:border-primary/50 pb-1"
                    placeholder={m.fb_field_section_header()} />
                  <input value={field.description || ''} oninput={(e) => updateField(field.id, 'description', (e.target as HTMLInputElement).value)}
                    class="w-full text-sm bg-transparent outline-none text-on-surface-variant border-b border-transparent focus:border-primary/30 pb-1"
                    placeholder={m.fb_form_desc_ph()} />
                {:else}
                  <!-- Label + required -->
                  <div class="flex items-start gap-3">
                    <input value={field.label} oninput={(e) => updateField(field.id, 'label', (e.target as HTMLInputElement).value)}
                      class="flex-1 text-base font-semibold bg-transparent outline-none border-b-2 border-transparent focus:border-primary/50 pb-1"
                      placeholder={m.fb_question_default_title()} />
                    <label class="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant/60 shrink-0 cursor-pointer mt-1">
                      <input type="checkbox" checked={field.required} onchange={(e) => updateField(field.id, 'required', (e.target as HTMLInputElement).checked)}
                        class="accent-primary" />
                      {m.fb_required()}
                    </label>
                  </div>

                  <!-- Preview of field type -->
                  {#if field.type === 'short_text' || field.type === 'email' || field.type === 'number'}
                    <input disabled placeholder={field.placeholder || m.fb_short_response_ph()}
                      class="w-full bg-surface-container/50 rounded-lg px-3 py-2 text-sm text-on-surface-variant/50 border-b border-outline-variant/30" />
                  {:else if field.type === 'paragraph'}
                    <div class="w-full bg-surface-container/50 rounded-lg px-3 py-2 text-sm text-on-surface-variant/40 border-b border-outline-variant/30 h-14">
                      {m.fb_long_response_ph()}
                    </div>
                  {:else if field.type === 'date'}
                    <input type="date" disabled class="bg-surface-container/50 rounded-lg px-3 py-2 text-sm text-on-surface-variant/50 border border-outline-variant/20" />
                  {:else if field.type === 'time'}
                    <input type="time" disabled class="bg-surface-container/50 rounded-lg px-3 py-2 text-sm text-on-surface-variant/50 border border-outline-variant/20" />
                  {:else if field.type === 'linear_scale'}
                    <div class="flex items-center gap-2 text-xs text-on-surface-variant/60">
                      <span>{field.scaleMin ?? 1}</span>
                      <div class="flex-1 h-1 bg-primary/20 rounded-full"></div>
                      <span>{field.scaleMax ?? 5}</span>
                    </div>
                  {:else if field.type === 'multiple_choice' || field.type === 'checkboxes' || field.type === 'dropdown'}
                    <div class="space-y-1.5">
                      {#each field.options || [] as opt, optIdx}
                        <div class="flex items-center gap-2">
                          {#if field.type === 'multiple_choice'}<div class="w-3.5 h-3.5 rounded-full border-2 border-primary/40 shrink-0"></div>
                          {:else if field.type === 'checkboxes'}<div class="w-3.5 h-3.5 rounded border-2 border-primary/40 shrink-0"></div>
                          {:else}<span class="text-xs text-on-surface-variant/40 w-4">{optIdx + 1}.</span>{/if}
                          <input value={opt} oninput={(e) => updateOption(field.id, optIdx, (e.target as HTMLInputElement).value)}
                            class="flex-1 bg-transparent border-b border-outline-variant/20 focus:border-primary/50 outline-none text-sm pb-0.5"
                            placeholder={m.fb_option_default({ number: optIdx + 1 })} />
                          <button onclick={() => removeOption(field.id, optIdx)}
                            class="p-0.5 rounded hover:bg-error/10 text-error transition-colors">
                            <Papicon icon="close" size={12} />
                          </button>
                        </div>
                      {/each}
                      <button onclick={() => addOption(field.id)}
                        class="text-xs text-primary/70 hover:text-primary font-semibold ml-5 transition-colors">
                        {m.fb_add_option()}
                      </button>
                    </div>
                  {:else if field.type === 'multiple_choice_grid' || field.type === 'checkbox_grid'}
                    <div class="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <p class="font-bold text-on-surface-variant/60 mb-1">Lignes</p>
                        {#each field.rows || [] as row}
                          <input value={row.label} oninput={(e) => { const rows = [...(field.rows||[])]; rows[rows.indexOf(row)].label = (e.target as HTMLInputElement).value; updateField(field.id,'rows',rows); }}
                            class="block w-full bg-transparent border-b border-outline-variant/20 focus:border-primary/50 outline-none py-0.5 mb-1" />
                        {/each}
                        <button onclick={() => addGridRow(field.id)} class="text-primary/70 hover:text-primary font-semibold">{m.fb_add_row()}</button>
                      </div>
                      <div>
                        <p class="font-bold text-on-surface-variant/60 mb-1">Colonnes</p>
                        {#each field.columns || [] as col}
                          <input value={col.label} oninput={(e) => { const cols = [...(field.columns||[])]; cols[cols.indexOf(col)].label = (e.target as HTMLInputElement).value; updateField(field.id,'columns',cols); }}
                            class="block w-full bg-transparent border-b border-outline-variant/20 focus:border-primary/50 outline-none py-0.5 mb-1" />
                        {/each}
                        <button onclick={() => addGridColumn(field.id)} class="text-primary/70 hover:text-primary font-semibold">{m.fb_add_col()}</button>
                      </div>
                    </div>
                  {/if}

                  <!-- Expanded options when active -->
                  {#if isActive}
                    <div class="border-t border-outline-variant/10 pt-3 mt-2 space-y-3">
                      <input value={field.description || ''} oninput={(e) => updateField(field.id, 'description', (e.target as HTMLInputElement).value)}
                        class="w-full text-xs bg-surface-container rounded-lg px-3 py-2 outline-none focus:ring-1 ring-primary/30"
                        placeholder={m.fb_help_desc_ph()} />
                      {#if field.type === 'short_text' || field.type === 'paragraph' || field.type === 'number' || field.type === 'email'}
                        <input value={field.placeholder || ''} oninput={(e) => updateField(field.id, 'placeholder', (e.target as HTMLInputElement).value)}
                          class="w-full text-xs bg-surface-container rounded-lg px-3 py-2 outline-none focus:ring-1 ring-primary/30"
                          placeholder={m.fb_placeholder_ph()} />
                      {/if}
                      {#if field.type === 'number'}
                        <div class="flex gap-2">
                          <input type="number" value={field.validation?.min ?? ''} oninput={(e) => updateField(field.id,'validation',{...field.validation,min:+(e.target as HTMLInputElement).value})}
                            class="w-1/2 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Min" />
                          <input type="number" value={field.validation?.max ?? ''} oninput={(e) => updateField(field.id,'validation',{...field.validation,max:+(e.target as HTMLInputElement).value})}
                            class="w-1/2 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Max" />
                        </div>
                      {/if}
                      {#if field.type === 'linear_scale'}
                        <div class="flex gap-2 flex-wrap">
                          <input type="number" min="0" max="10" value={field.scaleMin ?? 1} oninput={(e) => updateField(field.id,'scaleMin',+(e.target as HTMLInputElement).value)}
                            class="w-20 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Min" />
                          <input type="number" min="1" max="10" value={field.scaleMax ?? 5} oninput={(e) => updateField(field.id,'scaleMax',+(e.target as HTMLInputElement).value)}
                            class="w-20 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Max" />
                          <input value={field.scaleMinLabel || ''} oninput={(e) => updateField(field.id,'scaleMinLabel',(e.target as HTMLInputElement).value)}
                            class="flex-1 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Label min" />
                          <input value={field.scaleMaxLabel || ''} oninput={(e) => updateField(field.id,'scaleMaxLabel',(e.target as HTMLInputElement).value)}
                            class="flex-1 text-xs bg-surface-container rounded-lg px-3 py-2 outline-none" placeholder="Label max" />
                        </div>
                      {/if}

                      <!-- Conditional logic (multiple_choice, dropdown) -->
                      {#if (field.type === 'multiple_choice' || field.type === 'dropdown') && sections.length > 1}
                        <div class="border-t border-outline-variant/10 pt-3">
                          <div class="flex items-center justify-between mb-2">
                            <span class="text-xs font-bold text-on-surface-variant/60">{m.fb_conditional_logic()}</span>
                            <button onclick={() => addLogicRule(field.id)}
                              class="text-xs text-primary/70 hover:text-primary font-semibold transition-colors">{m.fb_add_rule()}</button>
                          </div>
                          {#each field.logic || [] as rule, rIdx}
                            <div class="flex items-center gap-2 text-xs mb-2 flex-wrap">
                              <span class="text-on-surface-variant/60">{m.fb_if_answer_is()}</span>
                              <select value={rule.value} onchange={(e) => { const logic=[...(field.logic||[])]; logic[rIdx]={...rule,value:(e.target as HTMLSelectElement).value}; updateField(field.id,'logic',logic); }}
                                class="bg-surface-container rounded-lg px-2 py-1 outline-none text-xs">
                                {#each field.options || [] as opt}
                                  <option value={opt}>{opt}</option>
                                {/each}
                              </select>
                              <span class="text-on-surface-variant/60">{m.fb_go_to_section()}</span>
                              <select value={rule.targetSectionIndex} onchange={(e) => { const logic=[...(field.logic||[])]; logic[rIdx]={...rule,targetSectionIndex:+(e.target as HTMLSelectElement).value}; updateField(field.id,'logic',logic); }}
                                class="bg-surface-container rounded-lg px-2 py-1 outline-none text-xs">
                                {#each sections as s, si}
                                  <option value={si}>{s.title || m.fb_section_default_title({ number: si + 1 })}</option>
                                {/each}
                              </select>
                              <button onclick={() => { const logic=[...(field.logic||[])]; logic.splice(rIdx,1); updateField(field.id,'logic',logic); }}
                                class="text-error hover:text-error transition-colors">
                                <Papicon icon="close" size={12} />
                              </button>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          {/each}

          {#if sectionFields(activeSection).length === 0}
            <div class="rounded-lg border-2 border-dashed border-outline-variant/20 p-12 text-center text-on-surface-variant/30">
              <Papicon icon="add_circle" size={48} class="mb-3" />
              <p class="text-sm">{m.fb_canvas_empty_hint()}</p>
            </div>
          {/if}
        </div>
      </main>
    </div>
  </div>
{/if}

<style>
  .form-builder-tools-mobile-header,
  .form-builder-tools-backdrop {
    display: none;
  }

  @media (max-width: 767px) {
    .form-builder-toolbar {
      top: calc(3.5rem + env(safe-area-inset-top));
      z-index: 30;
      min-height: 3.5rem;
      padding: 0.375rem 0.5rem;
    }

    .form-builder-toolbar-title {
      display: none;
    }

    .form-builder-tools-trigger {
      display: inline-flex;
      min-height: 2.75rem;
    }

    .form-builder-workspace {
      min-height: 0;
      overflow: visible;
    }

    .form-builder-canvas {
      width: 100%;
      padding: 0.75rem;
      overflow: visible;
    }

    .form-builder-sidebar {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 70;
      width: 100% !important;
      max-height: min(84dvh, 48rem);
      padding-bottom: env(safe-area-inset-bottom);
      border: 1px solid var(--outline-variant);
      border-bottom: 0;
      border-radius: 1.25rem 1.25rem 0 0;
      background: var(--surface-container-lowest);
      box-shadow: 0 -24px 70px rgba(0, 0, 0, 0.28);
      transform: translateY(105%);
      transition: transform 200ms ease;
    }

    .form-builder-sidebar.mobile-open {
      transform: translateY(0);
    }

    .form-builder-tools-mobile-header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      min-height: 4rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--outline-variant);
      background: var(--surface-container-lowest);
    }

    .form-builder-tools-mobile-header button {
      display: grid;
      min-width: 2.75rem;
      min-height: 2.75rem;
      place-items: center;
      border-radius: 0.75rem;
      background: var(--surface-container);
    }

    .form-builder-tools-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(3px);
    }

    .form-builder-sidebar :global(button) {
      min-height: 2.75rem;
    }

    .form-builder-canvas :global([draggable="true"]) {
      cursor: default;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .form-builder-sidebar {
      transition: none;
    }
  }
</style>
