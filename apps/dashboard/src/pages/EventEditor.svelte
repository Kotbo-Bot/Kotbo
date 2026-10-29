<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { Button, Callout, Field, FilterPills, SectionCard, SettingsRow, ToggleSwitch } from '../lib/components/ui';
  import { eventTypeMeta, hasRegistrations } from '../lib/components/events/eventTypes';
  import { DEFAULT_TOURNAMENT_SETTINGS, type TournamentFormat } from '../lib/api/tournaments';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardFetch } from '../lib/api';
  import { m } from '../lib/i18n';

  const { eventId } = $props<{ eventId: string }>();

  let event = $state<any>(null);
  let isSaving = $state(false);
  let isPublishing = $state(false);
  let customForms = $state<{ id: string; name: string }[]>([]);

  const textChannels = $derived((dashboardStore.state.discordChannels || []).filter((c: any) => c.type === 'text' || c.type === 'announcement'));
  const meta = $derived(event ? eventTypeMeta(event.type) : null);
  const registrationType = $derived(event ? hasRegistrations(event.type) : false);
  const isTournament = $derived(event?.type === 'TOURNAMENT');
  const tournament = $derived(event?.config?.tournament);
  const BEST_OF = [1, 3, 5, 7];

  onMount(async () => {
    await Promise.all([loadEvent(), dashboardStore.refresh()]);
  });

  async function loadEvent() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}`, { guildId });
      const data = await res.json();
      const loaded = data.event;
      if (!loaded) return;
      const config = loaded.config && typeof loaded.config === 'object' ? loaded.config : {};
      loaded.config = { createDiscordEvent: true, sendEmbed: true, location: 'Discord', endTime: '', ...config };
      if (loaded.type === 'TOURNAMENT') loaded.config.tournament = { ...DEFAULT_TOURNAMENT_SETTINGS, ...(config.tournament ?? {}) };
      event = loaded;
      if (hasRegistrations(loaded.type)) await loadCustomForms();
    } catch {
      toast.error(m.eve_load_error());
    }
  }

  async function loadCustomForms() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/custom-forms`, { guildId });
      const data = await res.json();
      customForms = data.forms || [];
    } catch {
      customForms = [];
    }
  }

  async function save(silent = false) {
    isSaving = true;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}`, {
        guildId,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (!res.ok) throw new Error();
      if (!silent) toast.success(m.eve_saved_toast());
      return true;
    } catch {
      toast.error(m.eve_save_error_toast());
      return false;
    } finally {
      isSaving = false;
    }
  }

  async function publish() {
    if (!(await save(true))) return;
    isPublishing = true;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}/publish`, { guildId, method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error);
      }
      toast.success(m.eve_published_toast());
      router.goto(registrationType ? `/events/control/${eventId}` : '/events');
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : m.eve_publish_error());
    } finally {
      isPublishing = false;
    }
  }

  // ── Quiz ──────────────────────────────────────────────────────────────
  function addQuestion() {
    event.questions = [...(event.questions ?? []), { text: m.eve_new_question_default(), options: ['Option 1', 'Option 2'], correctOptionIndex: 0, imageUrl: '' }];
  }
  const removeQuestion = (index: number) => (event.questions = event.questions.filter((_: unknown, i: number) => i !== index));
  const addOption = (q: number) => (event.questions[q].options = [...event.questions[q].options, `Option ${event.questions[q].options.length + 1}`]);
  function removeOption(q: number, o: number) {
    const question = event.questions[q];
    question.options = question.options.filter((_: unknown, i: number) => i !== o);
    if (question.correctOptionIndex >= question.options.length) question.correctOptionIndex = 0;
  }

  // ── CTF ───────────────────────────────────────────────────────────────
  function addCtfChallenge() {
    event.ctfChallenges = [...(event.ctfChallenges ?? []), { title: m.eve_new_challenge_default(), description: '', flag: 'FLAG{...}', points: 100, xpReward: 0, roleIdReward: '', imageUrl: '' }];
  }
  const removeCtfChallenge = (index: number) => (event.ctfChallenges = event.ctfChallenges.filter((_: unknown, i: number) => i !== index));

  // ── Import CSV des questions ─────────────────────────────────────────
  let csvInput = $state<HTMLInputElement>();
  function handleCsvImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (readerEvent) => {
      const text = readerEvent.target?.result as string;
      const lines = (text || '').split(/\r?\n/).filter((line) => line.trim() !== '');
      if (lines.length < 2) return;
      const header = lines[0];
      const sep = header.includes('\t') ? '\t' : header.includes(';') ? ';' : ',';
      const columns = header.split(sep).map((c) => c.trim().toLowerCase());
      const questionCol = columns.findIndex((c) => c.includes('question'));
      const responseCol = columns.findIndex((c) => c.includes('réponse') || c.includes('reponse'));
      const optionCols = columns.map((name, index) => ({ name, index })).filter((c) => c.name.startsWith('option'));
      if (questionCol === -1 || responseCol === -1 || optionCols.length === 0) {
        toast.error(m.eve_csv_format_error());
        return;
      }
      const imported = lines.slice(1).map((line) => {
        const cells = line.split(sep).map((c) => c.trim());
        const options = optionCols.map((oc) => cells[oc.index]).filter((v) => v !== undefined && v !== '');
        // Bonne réponse en lettre (A, B…) ou en numéro (1, 2…).
        const raw = (cells[responseCol] || '').toUpperCase();
        const index = /^[A-Z]$/.test(raw) ? raw.charCodeAt(0) - 65 : parseInt(raw) - 1;
        return {
          text: cells[questionCol] || m.eve_new_question_default(),
          imageUrl: '',
          options: options.length ? options : ['Option 1', 'Option 2'],
          correctOptionIndex: Number.isNaN(index) ? 0 : Math.max(0, Math.min(index, options.length - 1)),
        };
      });
      event.questions = [...(event.questions ?? []), ...imported];
      input.value = '';
    };
    reader.readAsText(file);
  }

  const formatOptions = $derived<{ value: TournamentFormat; label: string }[]>([
    { value: 'SINGLE', label: m.tn_format_single() },
    { value: 'DOUBLE', label: m.tn_format_double() },
    { value: 'GROUPS', label: m.tn_format_groups() },
  ]);
  const formatHint = $derived(
    tournament?.format === 'DOUBLE' ? m.tn_format_double_desc() : tournament?.format === 'GROUPS' ? m.tn_format_groups_desc() : m.tn_format_single_desc(),
  );
</script>

<ModulePage
  title={event ? event.title : m.eve_custom_editor_title()}
  description={meta ? m.eve_editor_desc({ type: meta.label() }) : ''}
  icon={meta?.icon ?? 'Edit3'}
  featureKey="events"
>
  {#snippet actions()}
    <div class="flex flex-wrap gap-2">
      <Button variant="ghost" icon="ArrowLeft" href="/events">{m.eve_btn_back()}</Button>
      <Button variant="secondary" loading={isSaving} onclick={() => save()} disabled={!event}>{m.eve_btn_save()}</Button>
      <Button variant="primary" icon="Send" loading={isPublishing} onclick={publish} disabled={!event}>
        {event && event.status !== 'DRAFT' ? m.eve_btn_republish() : m.eve_btn_publish_discord()}
      </Button>
    </div>
  {/snippet}

  {#if !event}
    <div class="space-y-4">
      {#each [0, 1] as i (i)}<div class="h-48 animate-pulse rounded-xl bg-surface-container-low"></div>{/each}
    </div>
  {:else}
    <div class="space-y-6 pb-20">
      <SectionCard title={m.eve_section_info()} icon="FileText">
        <div class="space-y-4">
          <Field label={m.eve_field_title()} required>
            {#snippet children(id, describedBy)}
              <input {id} aria-describedby={describedBy} class="input" maxlength="100" bind:value={event.title} />
            {/snippet}
          </Field>
          <Field label={m.eve_field_description()} hint={m.eve_description_hint()}>
            {#snippet children(id, describedBy)}
              <textarea {id} aria-describedby={describedBy} class="input min-h-28" rows="4" placeholder={m.eve_desc_placeholder()} bind:value={event.description}></textarea>
            {/snippet}
          </Field>
        </div>
      </SectionCard>

      {#if isTournament}
        <SectionCard title={m.tn_settings_title()} description={m.tn_settings_desc()} icon="Trophy" flush>
          {#if event.status === 'ONGOING'}
            <div class="p-4 pb-0"><Callout variant="warning">{m.tn_settings_live_warning()}</Callout></div>
          {/if}
          <div class="divide-y divide-outline-variant">
            <SettingsRow label={m.tn_field_format()} description={formatHint} stacked>
              <FilterPills label={m.tn_field_format()} options={formatOptions} value={tournament.format} onchange={(v) => (tournament.format = v)} />
            </SettingsRow>
            <SettingsRow label={m.tn_field_best_of()} description={m.tn_field_best_of_desc()} labelFor="tn-bo">
              <select id="tn-bo" class="input w-32" bind:value={tournament.bestOf}>
                {#each BEST_OF as bo (bo)}<option value={bo}>BO{bo}</option>{/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.tn_field_final_best_of()} description={m.tn_field_final_best_of_desc()} labelFor="tn-final-bo">
              <select id="tn-final-bo" class="input w-40" bind:value={tournament.finalBestOf}>
                <option value={null}>{m.tn_same_best_of()}</option>
                {#each BEST_OF as bo (bo)}<option value={bo}>BO{bo}</option>{/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.tn_field_set_detail()} description={m.tn_field_set_detail_desc()}>
              <ToggleSwitch checked={tournament.setDetail} onToggle={(v: boolean) => (tournament.setDetail = v)} />
            </SettingsRow>
            {#if tournament.format !== 'DOUBLE'}
              <SettingsRow label={m.tn_field_third_place()} description={m.tn_field_third_place_desc()}>
                <ToggleSwitch checked={tournament.thirdPlace} onToggle={(v: boolean) => (tournament.thirdPlace = v)} />
              </SettingsRow>
            {/if}
            {#if tournament.format === 'GROUPS'}
              <SettingsRow label={m.tn_field_group_count()} description={m.tn_field_group_count_desc()} labelFor="tn-groups">
                <input id="tn-groups" class="input w-24" type="number" min="1" max="16" bind:value={tournament.groupCount} />
              </SettingsRow>
              <SettingsRow label={m.tn_field_qualifiers()} description={m.tn_field_qualifiers_desc()} labelFor="tn-qualifiers">
                <input id="tn-qualifiers" class="input w-24" type="number" min="0" max="8" bind:value={tournament.groupQualifiers} />
              </SettingsRow>
            {/if}
            <SettingsRow label={m.tn_field_team_size()} description={m.tn_field_team_size_desc()} labelFor="tn-team">
              <input id="tn-team" class="input w-24" type="number" min="1" max="10" bind:value={tournament.teamSize} />
            </SettingsRow>
            <SettingsRow label={m.tn_field_max_entries()} description={m.tn_field_max_entries_desc()} labelFor="tn-max">
              <input id="tn-max" class="input w-24" type="number" min="0" max="256" bind:value={tournament.maxEntries} />
            </SettingsRow>
          </div>
        </SectionCard>
      {/if}

      {#if registrationType}
        <SectionCard title={m.eve_section_announcement()} description={m.eve_section_announcement_desc()} icon="Megaphone" flush>
          <div class="divide-y divide-outline-variant">
            <SettingsRow label={m.eve_field_announcement_channel()} description={m.eve_announcement_channel_desc()} labelFor="ev-channel">
              <select id="ev-channel" class="input w-full sm:w-72" bind:value={event.announcementChannelId}>
                <option value={null}>{m.eve_channel_none()}</option>
                {#each textChannels as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.eve_field_linked_form()} description={isTournament && tournament.teamSize > 1 ? m.tn_form_team_hint() : m.eve_linked_form_desc()} labelFor="ev-form">
              <select id="ev-form" class="input w-full sm:w-72" bind:value={event.formId}>
                <option value={null}>{m.eve_form_none()}</option>
                {#each customForms as form (form.id)}<option value={form.id}>{form.name}</option>{/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.eve_field_start_date()} labelFor="ev-start">
              <input
                id="ev-start"
                class="input w-full sm:w-72"
                type="datetime-local"
                bind:value={event.triggerValue}
                onchange={() => (event.triggerType = event.triggerValue ? 'SCHEDULED' : null)}
              />
            </SettingsRow>
            <SettingsRow label={m.eve_field_end_date()} labelFor="ev-end">
              <input id="ev-end" class="input w-full sm:w-72" type="datetime-local" bind:value={event.config.endTime} />
            </SettingsRow>
            <SettingsRow label={m.eve_field_location()} labelFor="ev-location">
              <input id="ev-location" class="input w-full sm:w-72" placeholder={m.eve_location_ph()} bind:value={event.config.location} />
            </SettingsRow>
            <SettingsRow label={m.eve_create_discord_event()} description={m.eve_create_discord_event_desc()}>
              <ToggleSwitch checked={event.config.createDiscordEvent} onToggle={(v: boolean) => (event.config.createDiscordEvent = v)} />
            </SettingsRow>
            <SettingsRow label={m.eve_send_announcement_embed()} description={m.eve_send_announcement_embed_desc()}>
              <ToggleSwitch checked={event.config.sendEmbed} onToggle={(v: boolean) => (event.config.sendEmbed = v)} />
            </SettingsRow>
          </div>
        </SectionCard>
      {:else}
        <SectionCard title={m.eve_section_launch()} description={m.eve_section_launch_desc()} icon="Play" flush>
          <div class="divide-y divide-outline-variant">
            <SettingsRow label={m.eve_field_game_channel()} description={m.eve_game_channel_desc()} labelFor="ev-game-channel">
              <select id="ev-game-channel" class="input w-full sm:w-72" bind:value={event.channelId}>
                <option value={null}>{m.eve_channel_pick()}</option>
                {#each textChannels as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
              </select>
            </SettingsRow>
            <SettingsRow label={m.eve_field_trigger_type()} labelFor="ev-trigger">
              <select id="ev-trigger" class="input w-full sm:w-72" bind:value={event.triggerType}>
                <option value={null}>{m.eve_trigger_manual()}</option>
                <option value="MEMBER_COUNT">{m.eve_trigger_member_count()}</option>
                <option value="SCHEDULED">{m.eve_trigger_scheduled()}</option>
              </select>
            </SettingsRow>
            {#if event.triggerType === 'MEMBER_COUNT'}
              <SettingsRow label={m.eve_field_target_members()} labelFor="ev-members">
                <input id="ev-members" class="input w-40" type="number" min="1" placeholder="1000" bind:value={event.triggerValue} />
              </SettingsRow>
            {:else if event.triggerType === 'SCHEDULED'}
              <SettingsRow label={m.eve_field_trigger_date()} labelFor="ev-when">
                <input id="ev-when" class="input w-full sm:w-72" type="datetime-local" bind:value={event.triggerValue} />
              </SettingsRow>
            {/if}
            {#if event.triggerType}
              <SettingsRow label={m.eve_trigger_status()}>
                <span class="text-sm font-medium text-on-surface">
                  {event.triggerStatus === 'TRIGGERED' ? m.eve_trigger_triggered() : event.triggerStatus === 'FAILED' ? m.eve_trigger_failed() : m.eve_trigger_pending()}
                </span>
              </SettingsRow>
            {/if}
          </div>
        </SectionCard>
      {/if}

      {#if event.type === 'CTF'}
        <SectionCard title={m.eve_ctf_challenges_title({ count: event.ctfChallenges?.length || 0 })} icon="Flag">
          {#snippet actions()}
            <Button variant="secondary" size="sm" icon="Plus" onclick={addCtfChallenge}>{m.eve_btn_add_challenge()}</Button>
          {/snippet}
          <div class="space-y-4">
            {#each event.ctfChallenges || [] as challenge, c}
              <div class="space-y-4 rounded-lg border border-outline-variant p-4">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-semibold text-success">{m.eve_challenge_label({ number: c + 1 })}</span>
                  <Button variant="ghost" size="sm" icon="Trash2" aria-label={m.eve_remove_challenge()} onclick={() => removeCtfChallenge(c)} />
                </div>
                <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label={m.eve_field_challenge_title()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" placeholder={m.eve_challenge_title_ph()} bind:value={challenge.title} />{/snippet}
                  </Field>
                  <Field label={m.eve_field_flag()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input font-mono" bind:value={challenge.flag} />{/snippet}
                  </Field>
                  <Field label={m.eve_field_challenge_desc()} class="md:col-span-2">
                    {#snippet children(id, d)}<textarea {id} aria-describedby={d} class="input" rows="3" placeholder={m.eve_challenge_desc_ph()} bind:value={challenge.description}></textarea>{/snippet}
                  </Field>
                  <Field label={m.eve_field_points()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" type="number" min="0" bind:value={challenge.points} />{/snippet}
                  </Field>
                  <Field label={m.eve_field_xp_reward()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" type="number" min="0" bind:value={challenge.xpReward} />{/snippet}
                  </Field>
                  <Field label={m.eve_field_role_reward()}>
                    {#snippet children(id, d)}
                      <select {id} aria-describedby={d} class="input" bind:value={challenge.roleIdReward}>
                        <option value="">{m.eve_role_none()}</option>
                        {#each dashboardStore.state.discordRoles || [] as role (role.id)}<option value={role.id}>@{role.name}</option>{/each}
                      </select>
                    {/snippet}
                  </Field>
                  <Field label={m.eve_field_image_url()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" placeholder="https://…" bind:value={challenge.imageUrl} />{/snippet}
                  </Field>
                </div>
              </div>
            {:else}
              <p class="text-sm text-on-surface-variant">{m.eve_no_challenges()}</p>
            {/each}
          </div>
        </SectionCard>
      {:else if event.type === 'QUIZ'}
        <SectionCard title={m.eve_quiz_questions_title({ count: event.questions?.length || 0 })} icon="HelpCircle">
          {#snippet actions()}
            <div class="flex gap-2">
              <input bind:this={csvInput} type="file" accept=".csv,.txt" class="hidden" onchange={handleCsvImport} />
              <Button variant="ghost" size="sm" icon="Upload" onclick={() => csvInput?.click()}>{m.eve_btn_import_csv()}</Button>
              <Button variant="secondary" size="sm" icon="Plus" onclick={addQuestion}>{m.eve_btn_add_question()}</Button>
            </div>
          {/snippet}
          <div class="space-y-4">
            {#each event.questions || [] as question, q}
              <div class="grid grid-cols-1 gap-4 rounded-lg border border-outline-variant p-4 md:grid-cols-2">
                <div class="space-y-4">
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-semibold text-primary">{m.eve_question_label({ number: q + 1 })}</span>
                    <Button variant="ghost" size="sm" icon="Trash2" aria-label={m.eve_remove_question()} onclick={() => removeQuestion(q)} />
                  </div>
                  <Field label={m.eve_field_question_text()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" placeholder={m.eve_question_text_ph()} bind:value={question.text} />{/snippet}
                  </Field>
                  <Field label={m.eve_field_image_url()}>
                    {#snippet children(id, d)}<input {id} aria-describedby={d} class="input" placeholder="https://…" bind:value={question.imageUrl} />{/snippet}
                  </Field>
                </div>
                <fieldset class="space-y-2">
                  <legend class="mb-2 text-sm font-medium text-on-surface">{m.eve_options_label()}</legend>
                  {#each question.options as _option, o}
                    <div class="flex items-center gap-2">
                      <input
                        type="radio"
                        name="correct-{q}"
                        class="h-4 w-4 accent-[var(--color-success)]"
                        aria-label={m.eve_mark_correct({ n: o + 1 })}
                        checked={question.correctOptionIndex === o}
                        onchange={() => (question.correctOptionIndex = o)}
                      />
                      <input class="input flex-1" aria-label={m.eve_option_n({ n: o + 1 })} bind:value={question.options[o]} />
                      <Button variant="ghost" size="sm" icon="X" aria-label={m.eve_remove_option()} disabled={question.options.length <= 2} disabledReason={m.eve_min_two_options()} onclick={() => removeOption(q, o)} />
                    </div>
                  {/each}
                  <div class="flex items-center justify-between pt-1">
                    <span class="text-xs text-on-surface-variant">{m.eve_correct_answer_hint()}</span>
                    <Button variant="ghost" size="sm" onclick={() => addOption(q)}>{m.eve_btn_add_option()}</Button>
                  </div>
                </fieldset>
              </div>
            {:else}
              <p class="text-sm text-on-surface-variant">{m.eve_no_questions()}</p>
            {/each}
          </div>
        </SectionCard>
      {/if}

      {#if registrationType && event.status !== 'DRAFT'}
        <Callout variant="info" title={m.eve_already_published_title()}>
          {m.eve_already_published_desc()}
          {#snippet actions()}
            <Button variant="secondary" size="sm" icon={isTournament ? 'Trophy' : 'Users'} href="/events/control/{eventId}">
              {isTournament ? m.ev_btn_manage_tournament() : m.ev_btn_registrations()}
            </Button>
          {/snippet}
        </Callout>
      {/if}
    </div>
  {/if}
</ModulePage>
