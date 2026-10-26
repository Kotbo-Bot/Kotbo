<!--
  Panneaux de discussion, sous les fils automatiques de l'onglet Auto-Thread.

  Un panneau est un message du bot avec des boutons ; chaque bouton ouvre,
  après un formulaire, un fil public, un fil privé ou un post de forum dont
  le membre devient propriétaire. Le brouillon est validé avec les mêmes
  règles que le bot (@kotbo/shared), et l'aperçu du nom du fil utilise la
  même fonction que lui.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    THREAD_PANEL_ARCHIVE_MINUTES,
    THREAD_PANEL_LIMITS,
    THREAD_PANEL_PLACEHOLDERS,
    THREAD_PANEL_SLOWMODE_SECONDS,
    THREAD_PANEL_STARTER_PLACEHOLDERS,
    buildThreadPanelName,
    defaultThreadPanel,
    defaultThreadPanelButton,
    maxThreadPanelFields,
    normalizeThreadPanel,
    type ThreadPanelButton,
    type ThreadPanelButtonStyle,
    type ThreadPanelData,
    type ThreadPanelTarget,
  } from '@kotbo/shared';
  import { Button, Callout, EmptyState, Field, ToggleSwitch } from '../ui';
  import SearchableSelect from '../SearchableSelect.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import {
    deleteThreadPanel,
    fetchThreadPanels,
    publishThreadPanel,
    saveThreadPanel,
    type ThreadPanelForum,
    type ThreadPanelRow,
  } from '../../api';
  import { toast } from '../../stores/toast.svelte';
  import { confirmDialog } from '../../stores/confirmDialog.svelte';
  import { m, getLocale } from '../../i18n';

  const {
    channels,
    roles,
  }: {
    /** Salons textuels et d'annonces proposés, nom déjà mis en forme. */
    channels: Array<{ id: string; name: string }>;
    roles: Array<{ id: string; name: string }>;
  } = $props();

  type Draft = ThreadPanelData & { id: string | null; channelId: string };

  let panels = $state<ThreadPanelRow[]>([]);
  let forums = $state<ThreadPanelForum[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let draft = $state<Draft | null>(null);
  let baseline = $state('');
  let buttonIndex = $state(0);

  const locale = getLocale() === 'fr' ? 'fr' : 'en';

  // ── Libellés ────────────────────────────────────────────────────────────
  const TARGETS: Array<{ value: ThreadPanelTarget; label: () => string; hint: () => string }> = [
    { value: 'public', label: () => m.tp_target_public(), hint: () => m.tp_target_public_hint() },
    { value: 'private', label: () => m.tp_target_private(), hint: () => m.tp_target_private_hint() },
    { value: 'forum', label: () => m.tp_target_forum(), hint: () => m.tp_target_forum_hint() },
  ];

  const STYLES: Array<{ value: ThreadPanelButtonStyle; label: () => string }> = [
    { value: 'primary', label: () => m.tp_style_primary() },
    { value: 'secondary', label: () => m.tp_style_secondary() },
    { value: 'success', label: () => m.tp_style_success() },
    { value: 'danger', label: () => m.tp_style_danger() },
  ];

  const ARCHIVE_LABEL: Record<number, () => string> = {
    60: () => m.at_archive_1h(),
    1440: () => m.at_archive_24h(),
    4320: () => m.at_archive_3d(),
    10080: () => m.at_archive_1w(),
  };

  const ERRORS: Record<string, () => string> = {
    name_required: () => m.tp_err_name_required(),
    title_required: () => m.tp_err_title_required(),
    buttons_required: () => m.tp_err_buttons_required(),
    buttons_too_many: () => m.tp_err_buttons_too_many({ max: THREAD_PANEL_LIMITS.buttonsPerPanel }),
    button_label_required: () => m.tp_err_button_label_required(),
    fields_too_many: () => m.tp_err_fields_too_many(),
    field_label_required: () => m.tp_err_field_label_required(),
    forum_channel_required: () => m.tp_err_forum_channel_required(),
    image_url_invalid: () => m.tp_err_image_url_invalid(),
  };

  function slowmodeLabel(seconds: number): string {
    if (!seconds) return m.tp_slowmode_off();
    if (seconds >= 3600) return m.tp_hours({ count: seconds / 3600 });
    if (seconds >= 60) return m.tp_minutes({ count: seconds / 60 });
    return m.at_seconds({ count: seconds });
  }

  function channelName(id: string | null): string {
    if (!id) return '';
    return channels.find((c) => c.id === id)?.name ?? forums.find((f) => f.id === id)?.name ?? `#${id}`;
  }

  // ── Brouillon ───────────────────────────────────────────────────────────
  function toDraft(row: ThreadPanelRow): Draft {
    const normalized = normalizeThreadPanel(row);
    const data = normalized.ok ? normalized.value : { ...defaultThreadPanel(), name: row.name };
    return { ...data, id: row.id, channelId: row.channelId };
  }

  const snapshot = (d: Draft | null) => (d ? JSON.stringify(d) : '');
  const dirty = $derived(!!draft && snapshot(draft) !== baseline);
  const savedRow = $derived(draft?.id ? panels.find((p) => p.id === draft!.id) ?? null : null);
  const button = $derived(draft?.buttons[buttonIndex] ?? null);

  function open(d: Draft | null, saved: boolean) {
    draft = d;
    baseline = saved ? snapshot(d) : '';
    buttonIndex = 0;
  }

  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    return confirmDialog.ask({
      title: m.at_discard_title(),
      description: m.at_discard_desc(),
      confirmLabel: m.at_discard_confirm(),
      variant: 'danger',
    });
  }

  async function load(selectId: string | null = null) {
    const res = await fetchThreadPanels();
    panels = res?.panels ?? [];
    forums = res?.forums ?? [];
    const target = panels.find((p) => p.id === selectId) ?? panels[0] ?? null;
    open(target ? toDraft(target) : null, true);
  }

  onMount(async () => {
    try {
      await load();
    } finally {
      loading = false;
    }
  });

  async function selectPanel(id: string) {
    if (id === draft?.id || !(await confirmDiscard())) return;
    const row = panels.find((p) => p.id === id);
    if (row) open(toDraft(row), true);
  }

  async function addPanel() {
    if (!(await confirmDiscard())) return;
    const base = defaultThreadPanel();
    open({
      ...base,
      name: m.tp_default_name(),
      title: m.tp_default_title(),
      description: m.tp_default_description(),
      buttons: [{ ...base.buttons[0], label: m.tp_default_button(), titleLabel: m.tp_default_title_label() }],
      id: null,
      channelId: draft?.channelId ?? '',
    }, false);
  }

  function addButton() {
    if (!draft || draft.buttons.length >= THREAD_PANEL_LIMITS.buttonsPerPanel) return;
    draft.buttons.push({ ...defaultThreadPanelButton(), label: m.tp_default_button(), titleLabel: m.tp_default_title_label() });
    buttonIndex = draft.buttons.length - 1;
  }

  function moveButton(delta: number) {
    if (!draft) return;
    const target = buttonIndex + delta;
    if (target < 0 || target >= draft.buttons.length) return;
    const list = [...draft.buttons];
    [list[buttonIndex], list[target]] = [list[target], list[buttonIndex]];
    draft.buttons = list;
    buttonIndex = target;
  }

  function removeButton() {
    if (!draft || draft.buttons.length <= 1) return;
    draft.buttons.splice(buttonIndex, 1);
    buttonIndex = Math.max(0, buttonIndex - 1);
  }

  function setTarget(value: ThreadPanelTarget) {
    if (!button) return;
    const wasForum = button.target === 'forum';
    button.target = value;
    // Un salon textuel ne peut pas accueillir un post de forum, et inversement.
    if (wasForum !== (value === 'forum')) button.targetChannelId = null;
  }

  function addField() {
    if (!button || button.fields.length >= maxFields) return;
    button.fields.push({ id: Math.random().toString(36).slice(2, 10), label: '', placeholder: '', style: 'paragraph', required: false, maxLength: 1000 });
  }

  function moveField(index: number, delta: number) {
    if (!button) return;
    const target = index + delta;
    if (target < 0 || target >= button.fields.length) return;
    const list = [...button.fields];
    [list[index], list[target]] = [list[target], list[index]];
    button.fields = list;
  }

  // ── Dérivés d'affichage ─────────────────────────────────────────────────
  const maxFields = $derived(button ? maxThreadPanelFields(button) : 4);
  const forum = $derived(button?.targetChannelId ? forums.find((f) => f.id === button!.targetChannelId) ?? null : null);
  const forumOptions = $derived(forums.map((f) => ({ id: f.id, name: `💬 ${f.name}` })));
  const tagOptions = $derived((forum?.tags ?? []).map((tag) => ({ id: tag.id, name: tag.emoji ? `${tag.emoji} ${tag.name}` : tag.name })));

  const namePreview = $derived(button
    ? buildThreadPanelName(button, {
      title: m.tp_preview_title(),
      displayName: m.tp_preview_user(),
      username: 'membre',
      count: (savedRow?.stats.total ?? 0) + 1,
      date: new Date(),
    }, locale)
    : '');

  const validation = $derived(draft ? normalizeThreadPanel(draft) : null);
  const validationError = $derived(validation && 'error' in validation ? (ERRORS[validation.error]?.() ?? validation.error) : '');

  const panelOptions = $derived([
    ...panels.map((row) => ({ id: row.id, name: `${channelName(row.channelId)} · ${row.name} · ${row.enabled ? m.at_state_on() : m.at_state_off()}` })),
    ...(draft && !draft.id ? [{ id: '__new__', name: m.tp_new_panel() }] : []),
  ]);

  const publishBlocked = $derived(!draft?.id ? m.tp_publish_save_first() : dirty ? m.tp_publish_unsaved() : '');

  // ── Actions ─────────────────────────────────────────────────────────────
  async function save() {
    if (!draft) return;
    if (!draft.channelId) return void toast.error(m.tp_err_channel_required());
    if (validationError) return void toast.error(validationError);
    busy = true;
    try {
      const { id, ...payload } = $state.snapshot(draft);
      const res = await saveThreadPanel(id, payload);
      if (!res?.ok || !res.panel) throw new Error(res?.error || m.at_save_failed());
      const keep = buttonIndex;
      await load(res.panel.id);
      buttonIndex = Math.min(keep, (draft?.buttons.length ?? 1) - 1);
      if (res.publishError) toast.error(res.publishError);
      else toast.success(res.panel.messageId ? m.tp_saved_published() : m.at_saved());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_save_failed());
    } finally {
      busy = false;
    }
  }

  function revert() {
    if (draft?.id && baseline) {
      draft = JSON.parse(baseline);
      buttonIndex = 0;
      return;
    }
    open(panels[0] ? toDraft(panels[0]) : null, true);
  }

  async function publish() {
    if (!draft?.id) return;
    busy = true;
    try {
      const res = await publishThreadPanel(draft.id);
      if (!res?.ok) throw new Error(res?.error || m.tp_publish_failed());
      await load(draft.id);
      toast.success(m.tp_published({ channel: channelName(draft?.channelId ?? null) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.tp_publish_failed());
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!draft) return;
    if (!draft.id) return revert();
    if (!(await confirmDialog.ask({
      title: m.tp_delete_title(),
      description: m.tp_delete_desc({ name: draft.name }),
      confirmLabel: m.common_delete(),
      variant: 'danger',
    }))) return;
    busy = true;
    try {
      const res = await deleteThreadPanel(draft.id);
      if (!res?.ok) throw new Error(res?.error || m.at_delete_failed());
      await load();
      toast.success(m.tp_deleted());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.at_delete_failed());
    } finally {
      busy = false;
    }
  }
</script>

<section class="tp-panel">
  <header class="tp-panel__head">
    <div>
      <h3 class="text-base font-semibold text-on-surface">{m.tp_title()}</h3>
      <p class="text-body-sm text-on-surface-variant mt-0.5">{m.tp_desc()}</p>
    </div>
    <Button icon="plus" onclick={addPanel} disabled={busy}>{m.tp_add_panel()}</Button>
  </header>

  {#if loading}
    <div class="flex justify-center py-12" aria-busy="true">
      <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
    </div>
  {:else if !draft}
    <EmptyState icon="chat" title={m.tp_empty_title()} description={m.tp_empty_desc()}>
      {#snippet action()}
        <Button variant="primary" icon="plus" onclick={addPanel}>{m.tp_add_first_panel()}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <Field label={m.tp_select_label()}>
      {#snippet children(id)}
        <select
          {id}
          class="input"
          value={draft?.id ?? '__new__'}
          onchange={(e) => {
            const value = (e.currentTarget as HTMLSelectElement).value;
            if (value !== '__new__') void selectPanel(value);
            (e.currentTarget as HTMLSelectElement).value = draft?.id ?? '__new__';
          }}
        >
          {#each panelOptions as option (option.id)}
            <option value={option.id}>{option.name}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <div class="tp-panel__title">
      <div class="min-w-0">
        <h4 class="text-xl font-semibold text-on-surface truncate">{draft.name || m.tp_new_panel()}</h4>
        <p class="text-body-sm text-on-surface-variant">
          {#if savedRow?.messageId}
            {m.tp_status_published({ channel: channelName(savedRow.channelId) })}
          {:else}
            {m.tp_status_unpublished()}
          {/if}
          {#if savedRow}
            · {m.tp_stats({ open: savedRow.stats.open, total: savedRow.stats.total })}
          {/if}
        </p>
      </div>
      <label class="inline-flex items-center gap-2 text-sm text-on-surface-variant">
        <ToggleSwitch checked={draft.enabled} onToggle={(v) => draft && (draft.enabled = v)} ariaLabel={m.at_enabled()} />
        {draft.enabled ? m.at_state_on() : m.at_state_off()}
      </label>
    </div>

    <div class="tp-panel__body">
      <div class="tp-panel__main">
        <!-- 1. Le message -->
        <section class="tp-step">
          <h5 class="tp-step__title"><span class="tp-step__num">1</span>{m.tp_step_message()}</h5>
          <p class="tp-step__desc">{m.tp_step_message_desc()}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <Field label={m.tp_channel_label()}>
              {#snippet children(id)}
                <SearchableSelect {id} options={channels} bind:value={draft!.channelId} placeholder={m.cm_select_channel_placeholder()} clearable={false} />
              {/snippet}
            </Field>
            <Field label={m.tp_name_label()} hint={m.tp_name_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class="input" maxlength={THREAD_PANEL_LIMITS.name} bind:value={draft!.name} />
              {/snippet}
            </Field>
            <Field label={m.tp_embed_title_label()} class="sm:col-span-2">
              {#snippet children(id)}
                <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.title} bind:value={draft!.title} />
              {/snippet}
            </Field>
            <Field label={m.tp_embed_description_label()} class="sm:col-span-2">
              {#snippet children(id)}
                <textarea {id} class="input" rows="3" maxlength={THREAD_PANEL_LIMITS.description} bind:value={draft!.description}></textarea>
              {/snippet}
            </Field>
            <Field label={m.tp_color_label()}>
              {#snippet children(id)}
                <input {id} type="color" class="tp-color" bind:value={draft!.color} />
              {/snippet}
            </Field>
            <Field label={m.tp_image_label()} hint={m.tp_image_hint()}>
              {#snippet children(id, describedBy)}
                <input
                  {id}
                  aria-describedby={describedBy}
                  class="input"
                  type="url"
                  placeholder="https://…"
                  value={draft!.imageUrl ?? ''}
                  oninput={(e) => draft && (draft.imageUrl = (e.currentTarget as HTMLInputElement).value.trim() || null)}
                />
              {/snippet}
            </Field>
          </div>
        </section>

        <!-- 2. Les boutons -->
        <section class="tp-step">
          <h5 class="tp-step__title"><span class="tp-step__num">2</span>{m.tp_step_buttons()}</h5>
          <p class="tp-step__desc">{m.tp_step_buttons_desc()}</p>

          <div class="tp-buttons" role="tablist" aria-label={m.tp_step_buttons()}>
            {#each draft.buttons as item, index (item.id)}
              <button
                type="button"
                role="tab"
                aria-selected={index === buttonIndex}
                class="tp-chip"
                class:tp-chip--active={index === buttonIndex}
                onclick={() => (buttonIndex = index)}
              >
                {item.emoji ? `${item.emoji} ` : ''}{item.label || m.tp_unnamed_button()}
              </button>
            {/each}
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              onclick={addButton}
              disabled={draft.buttons.length >= THREAD_PANEL_LIMITS.buttonsPerPanel}
              disabledReason={m.tp_err_buttons_too_many({ max: THREAD_PANEL_LIMITS.buttonsPerPanel })}
            >{m.tp_add_button()}</Button>
          </div>

          {#if button}
            <div class="tp-card">
              <div class="grid gap-4 sm:grid-cols-3">
                <Field label={m.tp_button_label()}>
                  {#snippet children(id)}
                    <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.buttonLabel} bind:value={button!.label} />
                  {/snippet}
                </Field>
                <Field label={m.tp_button_emoji()} hint={m.tp_button_emoji_hint()}>
                  {#snippet children(id, describedBy)}
                    <input
                      {id}
                      aria-describedby={describedBy}
                      class="input"
                      maxlength={THREAD_PANEL_LIMITS.emoji}
                      value={button!.emoji ?? ''}
                      oninput={(e) => button && (button.emoji = (e.currentTarget as HTMLInputElement).value.trim() || null)}
                    />
                  {/snippet}
                </Field>
                <Field label={m.tp_button_style()}>
                  {#snippet children(id)}
                    <select {id} class="input" bind:value={button!.style}>
                      {#each STYLES as option (option.value)}
                        <option value={option.value}>{option.label()}</option>
                      {/each}
                    </select>
                  {/snippet}
                </Field>
              </div>

              <fieldset class="tp-choices">
                <legend class="tp-legend">{m.tp_target_legend()}</legend>
                {#each TARGETS as option (option.value)}
                  <label class="tp-choice">
                    <input type="radio" name="tp-target-{button.id}" checked={button.target === option.value} onchange={() => setTarget(option.value)} />
                    <span>
                      <strong>{option.label()}</strong>
                      <small>{option.hint()}</small>
                    </span>
                  </label>
                {/each}
              </fieldset>

              {#if button.target === 'forum'}
                <Field label={m.tp_forum_label()}>
                  {#snippet children(id)}
                    <SearchableSelect {id} options={forumOptions} bind:value={button!.targetChannelId} placeholder={m.tp_forum_placeholder()} clearable={false} />
                  {/snippet}
                </Field>
              {:else}
                <Field label={m.tp_target_channel_label()} hint={m.tp_target_channel_hint()}>
                  {#snippet children(id)}
                    <SearchableSelect {id} options={channels} bind:value={button!.targetChannelId} placeholder={m.tp_target_channel_placeholder()} />
                  {/snippet}
                </Field>
              {/if}

              <!-- Formulaire -->
              <h6 class="tp-sub">{m.tp_form_title()}</h6>
              <div class="grid gap-4 sm:grid-cols-2">
                <Field label={m.tp_title_label_label()}>
                  {#snippet children(id)}
                    <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.fieldLabel} bind:value={button!.titleLabel} />
                  {/snippet}
                </Field>
                <Field label={m.tp_title_placeholder_label()}>
                  {#snippet children(id)}
                    <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.fieldPlaceholder} bind:value={button!.titlePlaceholder} />
                  {/snippet}
                </Field>
              </div>
              {#each button.fields as field, index (field.id)}
                <div class="tp-field">
                  <div class="grid gap-3 sm:grid-cols-2">
                    <Field label={m.tp_field_label({ n: index + 1 })}>
                      {#snippet children(id)}
                        <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.fieldLabel} bind:value={field.label} />
                      {/snippet}
                    </Field>
                    <Field label={m.tp_field_placeholder()}>
                      {#snippet children(id)}
                        <input {id} class="input" maxlength={THREAD_PANEL_LIMITS.fieldPlaceholder} bind:value={field.placeholder} />
                      {/snippet}
                    </Field>
                    <Field label={m.tp_field_style()}>
                      {#snippet children(id)}
                        <select {id} class="input" bind:value={field.style}>
                          <option value="short">{m.tp_field_short()}</option>
                          <option value="paragraph">{m.tp_field_paragraph()}</option>
                        </select>
                      {/snippet}
                    </Field>
                    <Field label={m.tp_field_max_length()}>
                      {#snippet children(id)}
                        <input {id} class="input" type="number" min="1" max={THREAD_PANEL_LIMITS.fieldMaxLength} bind:value={field.maxLength} />
                      {/snippet}
                    </Field>
                  </div>
                  <div class="tp-field__foot">
                    <label class="inline-flex items-center gap-2 text-sm text-on-surface-variant">
                      <ToggleSwitch size="sm" checked={field.required} onToggle={(v) => (field.required = v)} ariaLabel={m.tp_field_required()} />
                      {m.tp_field_required()}
                    </label>
                    <div class="flex gap-1">
                      <Button size="sm" variant="ghost" icon="arrow-up" onclick={() => moveField(index, -1)} disabled={index === 0} disabledReason={m.tp_already_first()} aria-label={m.tp_move_up()} />
                      <Button size="sm" variant="ghost" icon="arrow-down" onclick={() => moveField(index, 1)} disabled={index === button!.fields.length - 1} disabledReason={m.tp_already_last()} aria-label={m.tp_move_down()} />
                      <Button size="sm" variant="ghost" icon="trash" onclick={() => button!.fields.splice(index, 1)} aria-label={m.tp_field_remove()} />
                    </div>
                  </div>
                </div>
              {/each}
              <div>
                <Button
                  size="sm"
                  icon="plus"
                  onclick={addField}
                  disabled={button.fields.length >= maxFields}
                  disabledReason={m.tp_err_fields_too_many()}
                >{m.tp_add_field({ left: maxFields - button.fields.length })}</Button>
              </div>

              <!-- Le fil créé -->
              <h6 class="tp-sub">{m.tp_thread_title()}</h6>
              <div class="grid gap-4 sm:grid-cols-2">
                <Field label={m.tp_name_template_label()} hint={m.tp_placeholders({ list: THREAD_PANEL_PLACEHOLDERS.join(' ') })}>
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} class="input" maxlength={THREAD_PANEL_LIMITS.nameTemplate} bind:value={button!.nameTemplate} />
                  {/snippet}
                </Field>
                <div class="tp-preview" aria-live="polite">
                  <span class="text-body-sm text-on-surface-variant">{m.tp_name_preview()}</span>
                  <strong class="truncate">🧵 {namePreview}</strong>
                </div>
                <Field label={m.tp_starter_label()} hint={m.tp_placeholders({ list: THREAD_PANEL_STARTER_PLACEHOLDERS.join(' ') })} class="sm:col-span-2">
                  {#snippet children(id, describedBy)}
                    <textarea {id} aria-describedby={describedBy} class="input" rows="3" maxlength={THREAD_PANEL_LIMITS.starterMessage} placeholder={m.tp_starter_placeholder()} bind:value={button!.starterMessage}></textarea>
                  {/snippet}
                </Field>
                <Field label={m.tp_archive_label()}>
                  {#snippet children(id)}
                    <select {id} class="input" bind:value={button!.archiveMinutes}>
                      {#each THREAD_PANEL_ARCHIVE_MINUTES as minutes (minutes)}
                        <option value={minutes}>{ARCHIVE_LABEL[minutes]()}</option>
                      {/each}
                    </select>
                  {/snippet}
                </Field>
                <Field label={m.tp_slowmode_label()}>
                  {#snippet children(id)}
                    <select {id} class="input" bind:value={button!.slowmodeSeconds}>
                      {#each THREAD_PANEL_SLOWMODE_SECONDS as seconds (seconds)}
                        <option value={seconds}>{slowmodeLabel(seconds)}</option>
                      {/each}
                    </select>
                  {/snippet}
                </Field>
                <Field label={m.tp_mention_roles_label()} hint={m.tp_mention_roles_hint()} class="sm:col-span-2">
                  {#snippet children(id)}
                    <MultiSelect {id} bind:values={button!.mentionRoleIds} options={roles} placeholder={m.tp_roles_placeholder()} />
                  {/snippet}
                </Field>
              </div>

              <!-- Règles -->
              <h6 class="tp-sub">{m.tp_rules_title()}</h6>
              <div class="grid gap-4 sm:grid-cols-3">
                <Field label={m.tp_max_open_label()} hint={m.tp_zero_unlimited()}>
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} class="input" type="number" min="0" max={THREAD_PANEL_LIMITS.maxOpenPerMember} bind:value={button!.maxOpenPerMember} />
                  {/snippet}
                </Field>
                <Field label={m.tp_cooldown_label()} hint={m.tp_zero_none()}>
                  {#snippet children(id, describedBy)}
                    <input
                      {id}
                      aria-describedby={describedBy}
                      class="input"
                      type="number"
                      min="0"
                      max={THREAD_PANEL_LIMITS.cooldownMaxSeconds / 60}
                      value={Math.round(button!.cooldownSeconds / 60)}
                      oninput={(e) => button && (button.cooldownSeconds = Math.max(0, Math.round(Number((e.currentTarget as HTMLInputElement).value) || 0)) * 60)}
                    />
                  {/snippet}
                </Field>
                <Field label={m.tp_claim_label()} hint={m.tp_claim_hint()}>
                  {#snippet children(id, describedBy)}
                    <input {id} aria-describedby={describedBy} class="input" type="number" min="0" max={THREAD_PANEL_LIMITS.claimMaxDays} bind:value={button!.claimAfterDays} />
                  {/snippet}
                </Field>
                <Field label={m.tp_allowed_roles_label()} hint={m.tp_allowed_roles_hint()} class="sm:col-span-3">
                  {#snippet children(id)}
                    <MultiSelect {id} bind:values={button!.allowedRoleIds} options={roles} placeholder={m.tp_roles_placeholder()} />
                  {/snippet}
                </Field>
              </div>

              {#if button.target === 'private'}
                <label class="tp-toggle-row">
                  <ToggleSwitch checked={button.joinRequests} onToggle={(v) => button && (button.joinRequests = v)} ariaLabel={m.tp_join_requests_label()} />
                  <span>
                    <strong>{m.tp_join_requests_label()}</strong>
                    <small>{m.tp_join_requests_hint()}</small>
                  </span>
                </label>
              {/if}

              {#if button.target === 'forum'}
                <h6 class="tp-sub">{m.tp_forum_tags_title()}</h6>
                {#if !forum}
                  <Callout variant="info">{m.tp_forum_pick_first()}</Callout>
                {:else if tagOptions.length === 0}
                  <Callout variant="info">{m.tp_forum_no_tags()}</Callout>
                {:else}
                  <div class="grid gap-4 sm:grid-cols-2">
                    <Field label={m.tp_forced_tags_label()} hint={m.tp_forced_tags_hint()}>
                      {#snippet children(id)}
                        <MultiSelect {id} bind:values={button!.forumTagIds} options={tagOptions} placeholder={m.tp_tags_placeholder()} />
                      {/snippet}
                    </Field>
                    <Field label={m.tp_choice_tags_label()} hint={m.tp_choice_tags_hint()}>
                      {#snippet children(id)}
                        <MultiSelect {id} bind:values={button!.forumChoiceTagIds} options={tagOptions} placeholder={m.tp_tags_placeholder()} />
                      {/snippet}
                    </Field>
                    <Field label={m.tp_resolved_tag_label()} hint={m.tp_resolved_tag_hint()}>
                      {#snippet children(id)}
                        <SearchableSelect {id} options={tagOptions} bind:value={button!.resolvedTagId} placeholder={m.tp_resolved_tag_none()} />
                      {/snippet}
                    </Field>
                  </div>
                {/if}
              {/if}

              <div class="tp-card__foot">
                <div class="flex gap-1">
                  <Button size="sm" variant="ghost" icon="arrow-left" onclick={() => moveButton(-1)} disabled={buttonIndex === 0} disabledReason={m.tp_already_first()}>{m.tp_move_left()}</Button>
                  <Button size="sm" variant="ghost" icon="arrow-right" onclick={() => moveButton(1)} disabled={buttonIndex === draft.buttons.length - 1} disabledReason={m.tp_already_last()}>{m.tp_move_right()}</Button>
                </div>
                <Button size="sm" variant="danger" icon="trash" onclick={removeButton} disabled={draft.buttons.length <= 1} disabledReason={m.tp_err_buttons_required()}>{m.tp_remove_button()}</Button>
              </div>
            </div>
          {/if}
        </section>

        <!-- 3. Journal -->
        <section class="tp-step">
          <h5 class="tp-step__title"><span class="tp-step__num">3</span>{m.tp_step_logs()}</h5>
          <p class="tp-step__desc">{m.tp_step_logs_desc()}</p>
          <Field label={m.tp_log_channel_label()}>
            {#snippet children(id)}
              <SearchableSelect {id} options={channels} bind:value={draft!.logChannelId} placeholder={m.tp_log_channel_none()} />
            {/snippet}
          </Field>
        </section>

        {#if validationError}
          <Callout variant="warning">{validationError}</Callout>
        {/if}

        <div class="tp-actions">
          <Button variant="primary" icon="check" onclick={save} loading={busy} disabled={!dirty && !!draft.id} disabledReason={m.tp_nothing_to_save()}>{m.common_save()}</Button>
          <Button icon="send" onclick={publish} disabled={busy || !!publishBlocked} disabledReason={publishBlocked}>
            {savedRow?.messageId ? m.tp_republish() : m.tp_publish()}
          </Button>
          {#if dirty}
            <Button variant="ghost" onclick={revert}>{m.common_cancel()}</Button>
          {/if}
          <Button variant="danger" icon="trash" onclick={remove} disabled={busy}>{m.common_delete()}</Button>
        </div>
      </div>

      <!-- Aperçu façon Discord -->
      <aside class="tp-discord" aria-label={m.tp_preview_label()}>
        <span class="text-body-sm text-on-surface-variant">{m.tp_preview_label()}</span>
        <div class="tp-embed" style:border-left-color={draft.color}>
          <strong class="tp-embed__title">{draft.title}</strong>
          {#if draft.description}<p class="tp-embed__desc">{draft.description}</p>{/if}
          {#if draft.imageUrl}<img class="tp-embed__image" src={draft.imageUrl} alt="" />{/if}
        </div>
        <div class="tp-embed__buttons">
          {#each draft.buttons as item (item.id)}
            <span class="tp-dbutton tp-dbutton--{item.style}">{item.emoji ? `${item.emoji} ` : ''}{item.label}</span>
          {/each}
        </div>
      </aside>
    </div>
  {/if}
</section>

<style>
  .tp-panel {
    display: grid;
    gap: 1.25rem;
  }

  .tp-panel__head,
  .tp-panel__title,
  .tp-card__foot,
  .tp-field__foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .tp-panel__head {
    align-items: flex-start;
  }

  .tp-panel__body {
    display: grid;
    gap: 1.5rem;
    align-items: start;
  }

  @media (min-width: 1100px) {
    .tp-panel__body {
      grid-template-columns: minmax(0, 1fr) 300px;
    }

    .tp-discord {
      position: sticky;
      top: 1rem;
    }
  }

  .tp-panel__main {
    min-width: 0;
    display: grid;
    gap: 1rem;
  }

  .tp-step {
    padding-bottom: 0.25rem;
  }

  .tp-step + .tp-step {
    border-top: 1px solid var(--color-outline-variant);
    padding-top: 1.25rem;
  }

  .tp-step__title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .tp-step__num {
    display: inline-grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 999px;
    background: var(--color-primary);
    color: var(--color-on-primary, #fff);
    font-size: 0.8125rem;
  }

  .tp-step__desc {
    margin: 0.375rem 0 0.875rem;
    font-size: 0.875rem;
    color: var(--color-on-surface-variant);
  }

  .tp-sub {
    margin-top: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }

  .tp-buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.875rem;
  }

  .tp-chip {
    padding: 0.375rem 0.875rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 999px;
    background: var(--color-surface-container-low);
    color: var(--color-on-surface);
    font-size: 0.875rem;
  }

  .tp-chip--active {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  }

  .tp-card {
    display: grid;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
  }

  .tp-legend {
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-on-surface);
  }

  .tp-choices {
    display: grid;
    gap: 0.625rem;
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }

  @media (min-width: 640px) {
    .tp-choices {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .tp-legend {
      grid-column: 1 / -1;
    }
  }

  .tp-choice,
  .tp-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    cursor: pointer;
  }

  .tp-choice:has(input:checked) {
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  }

  .tp-choice input {
    margin-top: 0.2rem;
    accent-color: var(--color-primary);
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .tp-choice strong,
  .tp-toggle-row strong {
    display: block;
    font-size: 0.875rem;
    color: var(--color-on-surface);
  }

  .tp-choice small,
  .tp-toggle-row small {
    display: block;
    margin-top: 0.125rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }

  .tp-field {
    display: grid;
    gap: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
  }

  .tp-preview {
    display: grid;
    align-content: center;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    background: var(--color-surface-container-low);
    color: var(--color-on-surface);
  }

  .tp-color {
    width: 3rem;
    height: 2.5rem;
    padding: 0;
    border: 1px solid var(--color-outline-variant);
    border-radius: 0.5rem;
    background: none;
    cursor: pointer;
  }

  .tp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .tp-discord {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }

  .tp-embed {
    display: grid;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    border-left: 4px solid;
    border-radius: 0.375rem;
    background: var(--color-surface-container);
  }

  .tp-embed__title {
    color: var(--color-on-surface);
    font-size: 0.9375rem;
  }

  .tp-embed__desc {
    white-space: pre-line;
    overflow-wrap: anywhere;
    color: var(--color-on-surface-variant);
    font-size: 0.875rem;
  }

  .tp-embed__image {
    max-width: 100%;
    border-radius: 0.375rem;
  }

  .tp-embed__buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .tp-dbutton {
    padding: 0.375rem 0.875rem;
    border-radius: 0.25rem;
    color: #fff;
    font-size: 0.875rem;
    font-weight: 500;
  }

  /* Couleurs des boutons Discord : ce sont les leurs, pas des jetons du dashboard. */
  .tp-dbutton--primary { background: #5865f2; }
  .tp-dbutton--secondary { background: #4e5058; }
  .tp-dbutton--success { background: #248046; }
  .tp-dbutton--danger { background: #da373c; }
</style>
