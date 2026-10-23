<script lang="ts">
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { dashboardFetch } from '../lib/api';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { m } from '../lib/i18n';

  const { eventId } = $props<{ eventId: string }>();

  let event = $state<any>(null);
  let isFetching = $state(false);
  let isSaving = $state(false);
  let customForms = $state<any[]>([]);
  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  onMount(async () => {
    await Promise.all([
      loadEvent(),
      dashboardStore.refresh()
    ]);
  });

  async function loadEvent() {
    isFetching = true;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}`, { guildId,
        });
      const data = await res.json();
      event = data.event;
      if (event) {
        if (!event.config || typeof event.config !== 'object') {
          event.config = {
            createDiscordEvent: true,
            sendEmbed: true,
            location: 'Discord',
            endTime: ''
          };
        }
        if (event.type === 'CUSTOM') {
          await loadCustomForms();
        }
      }
    } catch (err) {
      toast.error('Erreur chargement événement');
    } finally {
      isFetching = false;
    }
  }

  async function loadCustomForms() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/custom-forms`, { guildId,
        });
      const data = await res.json();
      customForms = data.forms || [];
    } catch {}
  }

  function addQuestion() {
    if (!event.questions) event.questions = [];
    event.questions = [...event.questions, {
      text: m.eve_new_question_default(),
      options: ['Option 1', 'Option 2'],
      correctOptionIndex: 0,
      imageUrl: ''
    }];
  }

  function removeQuestion(index: number) {
    event.questions = event.questions.filter((_: any, i: number) => i !== index);
  }

  function addOption(qIdx: number) {
    event.questions[qIdx].options = [...event.questions[qIdx].options, `Option ${event.questions[qIdx].options.length + 1}`];
  }

  function removeOption(qIdx: number, oIdx: number) {
    event.questions[qIdx].options = event.questions[qIdx].options.filter((_: any, i: number) => i !== oIdx);
  }

  function addCtfChallenge() {
    if (!event.ctfChallenges) event.ctfChallenges = [];
    event.ctfChallenges = [...event.ctfChallenges, {
      title: m.eve_new_challenge_default(),
      description: '',
      flag: 'FLAG{...}',
      points: 100,
      xpReward: 0,
      roleIdReward: '',
      imageUrl: ''
    }];
  }

  function removeCtfChallenge(index: number) {
    event.ctfChallenges = event.ctfChallenges.filter((_: any, i: number) => i !== index);
  }

  async function save() {
    isSaving = true;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}`, { guildId,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'},
        body: JSON.stringify(event)
      });
      if (res.ok) {
        toast.success(m.eve_saved_toast());
        await loadEvent();
      } else {
        toast.error(m.eve_save_error_toast());
      }
    } catch (err) {
      toast.error('Erreur réseau');
    } finally {
      isSaving = false;
    }
  }

  async function publish() {
    await save();
    try {
      const guildId = authStore.selectedGuildId;
      const res = await dashboardFetch(`/events/${eventId}/publish`, { guildId,
        method: 'POST'
        });
      if (res.ok) {
        toast.success(m.eve_published_toast());
        router.goto('/events');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erreur publication');
      }
    } catch (err) {
      toast.error('Erreur réseau');
    }
  }
  function handleCsvImport(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (readerEvent) => {
      const text = readerEvent.target?.result as string;
      if (!text) return;

      const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
      if (lines.length < 2) return;

      // Detect separator (tab or semicolon or comma)
      const header = lines[0];
      const sep = header.includes('\t') ? '\t' : (header.includes(';') ? ';' : ',');
      const columns = header.split(sep).map(c => c.trim().toLowerCase());

      const questionCol = columns.findIndex(c => c.includes('question'));
      const responseCol = columns.findIndex(c => c.includes('réponse') || c.includes('reponse'));
      const optionCols = columns.map((c, i) => ({ name: c, index: i }))
        .filter(c => c.name.startsWith('option'));

      if (questionCol === -1 || responseCol === -1 || optionCols.length === 0) {
        toast.error(m.eve_csv_format_error());
        return;
      }

      const newQuestions = lines.slice(1).map(line => {
        const cells = line.split(sep).map(c => c.trim());
        const options = optionCols.map(oc => cells[oc.index]).filter(val => val !== undefined && val !== '');
        
        // Map correct answer (A, B, C... or index 1, 2, 3...)
        const rawAnswer = (cells[responseCol] || '').toUpperCase();
        let correctIndex = 0;
        if (/^[A-Z]$/.test(rawAnswer)) {
          correctIndex = rawAnswer.charCodeAt(0) - 65;
        } else {
          correctIndex = parseInt(rawAnswer) - 1;
        }

        return {
          text: cells[questionCol] || 'Nouvelle Question',
          imageUrl: '',
          options: options.length > 0 ? options : ['Option 1', 'Option 2'],
          correctOptionIndex: isNaN(correctIndex) ? 0 : Math.max(0, Math.min(correctIndex, options.length - 1))
        };
      });

      if (!event) return;
      if (!event.questions) event.questions = [];
      event.questions = [...event.questions, ...newQuestions];
      input.value = ''; // Reset for next import
    };

    reader.readAsText(file);
  }

  function triggerImport() {
    document.getElementById('csvInput')?.click();
  }
</script>

<ModulePage
  title={event ? (event.type === 'CTF' ? m.eve_ctf_editor_title() : event.type === 'CUSTOM' ? m.eve_custom_editor_title() : m.eve_quiz_editor_title()) : m.eve_custom_editor_title()}
  description={event?.type === 'CTF' ? m.eve_ctf_editor_desc() : event?.type === 'CUSTOM' ? m.eve_custom_editor_desc() : m.eve_quiz_editor_desc()}
  icon={event?.type === 'CUSTOM' ? 'Calendar' : 'Edit3'}
  featureKey="events"
>
  {#snippet actions()}
    <div class="flex gap-3">
      <button 
        onclick={() => router.goto('/events')}
        class="px-5 py-2.5 bg-surface-container-high rounded-xl font-medium text-body-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-colors"
      >
        {m.eve_btn_back()}
      </button>
      <button
        onclick={save}
        disabled={isSaving}
        class="px-5 py-2.5 bg-surface-container-highest text-on-surface rounded-xl font-medium text-body-sm border border-outline-variant/10 transition-transform"
      >
        {isSaving ? m.eve_btn_saving() : m.eve_btn_save()}
      </button>
      <button
        onclick={publish}
        class="px-4 py-2 bg-primary text-on-primary rounded-xl font-medium text-body-sm transition-transform"
      >
        {m.eve_btn_publish_discord()}
      </button>
    </div>
  {/snippet}

  {#if event}
    <div class="space-y-10 pb-20">
      {#if event.type === 'CUSTOM'}
        <!-- CUSTOM EVENT SPECIFIC CONFIGURATION -->
        <section class="bg-surface-container-low/30 rounded-xl p-10 border border-outline-variant/10 space-y-8 animate-in fade-in duration-300">
          <div class="flex items-center gap-4 mb-2">
            <div class="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center">
              <Papicon icon="Settings" size={20} />
            </div>
            <h3 class="text-xl font-semibold text-on-surface">{m.eve_config_section_title()}</h3>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label for="event-title" class="field-label">{m.eve_field_title()}</label>
              <FormInput 
                id="event-title"
                bind:value={event.title} 
                placeholder={m.eve_field_title()} 
                className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
              />
            </div>
            <div class="space-y-2">
              <label for="announcement-channel" class="field-label">{m.eve_field_announcement_channel()}</label>
              <select
                id="announcement-channel"
                bind:value={event.announcementChannelId}
                class="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/50 transition-all text-on-surface"
              >
                <option value={null}>{m.eve_channel_none()}</option>
                {#each availableChannels.filter(c => c.type === 'text' || c.type === 'announcement') as c}
                  <option value={c.id}>#{c.name}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="space-y-2">
            <label for="event-description" class="field-label">{m.eve_field_description()}</label>
            <FormTextarea 
              id="event-description"
              bind:value={event.description} 
              placeholder={m.eve_desc_placeholder()} 
              className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface resize-none"
              rows={4}
            />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label for="linked-form" class="field-label">{m.eve_field_linked_form()}</label>
              <select
                id="linked-form"
                bind:value={event.formId}
                class="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/50 transition-all text-on-surface"
              >
                <option value={null}>{m.eve_form_none()}</option>
                {#each customForms as form}
                  <option value={form.id}>{form.name}</option>
                {/each}
              </select>
            </div>

            <div class="space-y-2">
              <label for="start-date" class="field-label">{m.eve_field_start_date()}</label>
              <input
                id="start-date"
                type="datetime-local"
                bind:value={event.triggerValue}
                class="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/35 transition-all text-on-surface font-sans"
                onchange={() => { event.triggerType = event.triggerValue ? 'SCHEDULED' : null; }}
              />
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label for="location" class="field-label">{m.eve_field_location()}</label>
              <FormInput
                id="location"
                bind:value={event.config.location}
                placeholder={m.eve_location_ph()}
                className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
              />
            </div>

            <div class="space-y-2">
              <label for="end-date" class="field-label">{m.eve_field_end_date()}</label>
              <input
                id="end-date"
                type="datetime-local"
                bind:value={event.config.endTime}
                class="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/35 transition-all text-on-surface font-sans"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-4">
            <div class="flex items-center justify-between bg-surface-container-high/20 border border-outline-variant/10 rounded-lg p-5">
              <div>
                <span class="text-sm font-bold text-on-surface font-sans">{m.eve_create_discord_event()}</span>
                <p class="text-xs text-on-surface-variant font-sans">{m.eve_create_discord_event_desc()}</p>
              </div>
              <ToggleSwitch
                checked={event.config.createDiscordEvent}
                onToggle={(v: boolean) => event.config.createDiscordEvent = v}
              />
            </div>

            <div class="flex items-center justify-between bg-surface-container-high/20 border border-outline-variant/10 rounded-lg p-5">
              <div>
                <span class="text-sm font-bold text-on-surface font-sans">{m.eve_send_announcement_embed()}</span>
                <p class="text-xs text-on-surface-variant font-sans">{m.eve_send_announcement_embed_desc()}</p>
              </div>
              <ToggleSwitch
                checked={event.config.sendEmbed}
                onToggle={(v: boolean) => event.config.sendEmbed = v}
              />
            </div>
          </div>
        </section>
      {:else}
        <!-- STANDARD EVENT CONFIGURATION (Quiz / CTF) -->
        <section class="bg-surface-container-low/30 rounded-xl p-10 border border-outline-variant/10 space-y-8">
          <div class="flex items-center gap-4 mb-2">
            <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Papicon icon="Settings" size={20} />
            </div>
            <h3 class="text-xl font-semibold text-on-surface">{m.eve_general_config_title()}</h3>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="space-y-2">
              <label for="event-title" class="field-label">{m.eve_field_title()}</label>
              <FormInput 
                id="event-title"
                bind:value={event.title} 
                placeholder="Quiz Culture G" 
                className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
              />
            </div>
            <div class="space-y-2">
              <label for="event-channel-id" class="field-label">{m.eve_field_channel_id()}</label>
              <FormInput 
                id="event-channel-id"
                bind:value={event.channelId} 
                placeholder="1234567890..." 
                className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
              />
            </div>
          </div>

          <div class="space-y-2">
            <label for="event-description" class="field-label">{m.eve_field_description()}</label>
            <FormTextarea 
              id="event-description"
              bind:value={event.description} 
              placeholder={m.eve_desc_placeholder()} 
              className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface resize-none"
              rows={4}
            />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-8 pt-4">
            <div class="space-y-2">
              <label for="event-trigger-type" class="field-label">{m.eve_field_trigger_type()}</label>
              <select
                id="event-trigger-type"
                bind:value={event.triggerType}
                class="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/50 transition-all text-on-surface"
              >
                <option value={null}>{m.eve_trigger_manual()}</option>
                <option value="MEMBER_COUNT">{m.eve_trigger_member_count()}</option>
                <option value="SCHEDULED">{m.eve_trigger_scheduled()}</option>
              </select>
            </div>

            {#if event.triggerType === 'MEMBER_COUNT'}
              <div class="space-y-2">
                <label for="event-trigger-value-members" class="field-label">{m.eve_field_target_members()}</label>
                <FormInput 
                  id="event-trigger-value-members"
                  bind:value={event.triggerValue} 
                  placeholder="Ex: 1000" 
                  className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/35 transition-all text-on-surface"
                />
              </div>
            {/if}

            {#if event.triggerType === 'SCHEDULED'}
              <div class="space-y-2">
                <label for="event-trigger-value-date" class="field-label">{m.eve_field_trigger_date()}</label>
                <FormInput 
                  id="event-trigger-value-date"
                  type="datetime-local"
                  bind:value={event.triggerValue} 
                  className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/35 transition-all text-on-surface font-sans"
                />
              </div>
            {/if}

            {#if event.triggerType}
              <div class="space-y-2 flex flex-col justify-end pb-3">
                <span class="text-xs font-medium text-on-surface-variant/40 ml-4">{m.eve_trigger_status()}</span>
                <span class="text-sm font-bold ml-4 text-primary">
                  {#if event.triggerStatus === 'PENDING'}
                    {m.eve_trigger_pending()}
                  {:else if event.triggerStatus === 'TRIGGERED'}
                    {m.eve_trigger_triggered()}
                  {:else if event.triggerStatus === 'FAILED'}
                    {m.eve_trigger_failed()}
                  {:else}
                    {event.triggerStatus || m.eve_trigger_pending()}
                  {/if}
                </span>
              </div>
            {/if}
          </div>
        </section>
      {/if}

      {#if event.type === 'CTF'}
        <section class="space-y-8">
          <div class="flex items-center justify-between px-2">
            <h3 class="text-xl font-semibold text-on-surface">{m.eve_ctf_challenges_title({ count: event.ctfChallenges?.length || 0 })}</h3>
            <button onclick={addCtfChallenge} class="text-primary font-semibold text-xs flex items-center gap-2">
              <Papicon icon="Plus" size={14} /> {m.eve_btn_add_challenge()}
            </button>
          </div>

          <div class="space-y-8">
            {#each event.ctfChallenges || [] as challenge, cIdx}
              <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 p-10 space-y-8 relative overflow-hidden group">
                <div class="absolute top-0 left-0 w-2 h-full bg-success/20"></div>
                
                <div class="flex flex-col gap-6">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-medium text-success">{m.eve_challenge_label({ number: cIdx + 1 })}</span>
                    <button onclick={() => removeCtfChallenge(cIdx)} class="text-error hover:text-error transition-colors">
                      <Papicon icon="Trash2" size={16} />
                    </button>
                  </div>
                  
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div class="space-y-6">
                      <div class="space-y-2">
                        <label for={`challenge-${cIdx}-title`} class="field-label">{m.eve_field_challenge_title()}</label>
                        <FormInput 
                          id={`challenge-${cIdx}-title`}
                          bind:value={challenge.title} 
                          placeholder={m.eve_challenge_title_ph()} 
                          className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                        />
                      </div>

                      <div class="space-y-2">
                        <label for={`challenge-${cIdx}-description`} class="field-label">{m.eve_field_challenge_desc()}</label>
                        <FormTextarea 
                          id={`challenge-${cIdx}-description`}
                          bind:value={challenge.description} 
                          placeholder={m.eve_challenge_desc_ph()} 
                          className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface resize-none"
                          rows={4}
                        />
                      </div>
                    </div>

                    <div class="space-y-6">
                      <div class="grid grid-cols-2 gap-4">
                        <div class="space-y-2">
                          <label for={`challenge-${cIdx}-flag`} class="field-label">{m.eve_field_flag()}</label>
                          <FormInput 
                            id={`challenge-${cIdx}-flag`}
                            bind:value={challenge.flag} 
                            placeholder={'FLAG{...}'} 
                            className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                          />
                        </div>

                        <div class="space-y-2">
                          <label for={`challenge-${cIdx}-points`} class="field-label">{m.eve_field_points()}</label>
                          <FormInput 
                            id={`challenge-${cIdx}-points`}
                            type="number"
                            bind:value={challenge.points} 
                            placeholder="100" 
                            className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                          />
                        </div>
                      </div>

                      <div class="grid grid-cols-2 gap-4">
                        <div class="space-y-2">
                          <label for={`challenge-${cIdx}-xp`} class="field-label">{m.eve_field_xp_reward()}</label>
                          <FormInput 
                            id={`challenge-${cIdx}-xp`}
                            type="number"
                            bind:value={challenge.xpReward} 
                            placeholder="50" 
                            className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                          />
                        </div>

                        <div class="space-y-2">
                          <label for={`challenge-${cIdx}-role`} class="field-label">{m.eve_field_role_reward()}</label>
                          <FormInput 
                            id={`challenge-${cIdx}-role`}
                            bind:value={challenge.roleIdReward} 
                            placeholder={m.eve_role_reward_ph()} 
                            className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                          />
                        </div>
                      </div>

                      <div class="space-y-2">
                        <label for={`challenge-${cIdx}-image`} class="field-label">{m.eve_field_image_url()}</label>
                        <FormInput 
                          id={`challenge-${cIdx}-image`}
                          bind:value={challenge.imageUrl} 
                          placeholder="https://..." 
                          className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {:else if event.type === 'QUIZ'}
        <section class="space-y-8">
          <div class="flex items-center justify-between px-2">
            <h3 class="text-xl font-semibold text-on-surface">{m.eve_quiz_questions_title({ count: event.questions?.length || 0 })}</h3>
            <div class="flex items-center gap-4">
              <input 
                type="file" 
                id="csvInput" 
                accept=".csv,.txt" 
                class="hidden" 
                onchange={handleCsvImport}
              />
              <button 
                onclick={triggerImport} 
                class="px-4 py-2 bg-surface-container-high text-on-surface-variant rounded-xl font-bold text-body-sm border border-outline-variant/10 hover:bg-surface-container-highest transition-colors flex items-center gap-2"
              >
                <Papicon icon="FileUp" size={14} /> {m.eve_btn_import_csv()}
              </button>
              <button onclick={addQuestion} class="text-primary font-semibold text-xs flex items-center gap-2">
                <Papicon icon="Plus" size={14} /> {m.eve_btn_add_question()}
              </button>
            </div>
          </div>

          <div class="space-y-8">
            {#each event.questions || [] as question, qIdx}
              <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 p-10 space-y-8 relative overflow-hidden group">
                <div class="absolute top-0 left-0 w-2 h-full bg-primary/20"></div>
                
                <div class="flex flex-col md:flex-row gap-8">
                  <div class="flex-1 space-y-6">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium text-primary">{m.eve_question_label({ number: qIdx + 1 })}</span>
                      <button onclick={() => removeQuestion(qIdx)} class="text-error hover:text-error transition-colors">
                        <Papicon icon="Trash2" size={16} />
                      </button>
                    </div>
                    
                    <div class="space-y-2">
                      <label for={`question-${qIdx}-text`} class="field-label">{m.eve_field_question_text()}</label>
                      <FormInput 
                        id={`question-${qIdx}-text`}
                        bind:value={question.text} 
                        placeholder={m.eve_question_text_ph()} 
                        className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                      />
                    </div>
                    <div class="space-y-2">
                      <label for={`question-${qIdx}-image-url`} class="field-label">{m.eve_field_image_url()}</label>
                      <FormInput 
                        id={`question-${qIdx}-image-url`}
                        bind:value={question.imageUrl} 
                        placeholder="https://..." 
                        className="w-full bg-surface-container-high/50 border border-outline-variant/10 rounded-lg px-6 py-4 text-sm font-bold focus:outline-none focus:border-primary/30 transition-all text-on-surface"
                      />
                    </div>
                  </div>

                  <div class="flex-1 space-y-6">
                    <div class="flex items-center justify-between">
                      <span class="text-xs font-medium text-on-surface-variant/40">{m.eve_options_label()}</span>
                      <button onclick={() => addOption(qIdx)} class="text-xs font-medium text-primary hover:underline">
                        {m.eve_btn_add_option()}
                      </button>
                    </div>

                    <div class="space-y-3">
                      {#each question.options as _option, oIdx}
                        <div class="flex items-center gap-3">
                          <button 
                            onclick={() => question.correctOptionIndex = oIdx}
                            class="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all {question.correctOptionIndex === oIdx ? 'bg-emerald-500 border-success text-white' : 'border-outline-variant/20 text-transparent'}"
                          >
                            <Papicon icon="Check" size={12} />
                          </button>
                          <input 
                            type="text" 
                            bind:value={question.options[oIdx]} 
                            class="flex-1 bg-surface-container-high/50 border border-outline-variant/10 rounded-xl px-4 py-2.5 text-sm font-bold text-on-surface focus:outline-none focus:border-primary/50 transition-colors"
                          />
                          <button onclick={() => removeOption(qIdx, oIdx)} class="text-on-surface-variant/20 hover:text-error transition-colors">
                            <Papicon icon="X" size={14} />
                          </button>
                        </div>
                      {/each}
                    </div>
                    <p class="text-2xs font-bold text-on-surface-variant/30 italic font-bold">{m.eve_correct_answer_hint()}</p>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {:else}
    <div class="flex items-center justify-center py-40">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
    </div>
  {/if}
</ModulePage>
