<script lang="ts">
  import { explainDisabled } from '../lib/actions/explainDisabled';
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount } from 'svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import { sendOrUpdateEmbed } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { Embed, type EmbedView, type MessageEntities } from '@arcscord/discord-ui-svelte';
  import DiscordPreview from '../lib/components/onboarding/DiscordPreview.svelte';
  import { mergeEntities, toPreviewMarkdown } from '../lib/components/discord/previewEntities.svelte';

  const actionState = createAsyncActionState();
  const templateAction = createAsyncActionState();
  let loading = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.embed_builder?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);

  let targetChannelId = $state('');
  let targetMessageId = $state('');

  // Embed Model
  type EmbedModel = {
    title: string;
    description: string;
    color: string;
    thumbnailUrl: string;
    imageUrl: string;
    url: string;
    authorName: string;
    authorIconUrl: string;
    authorUrl: string;
    footerText: string;
    footerIconUrl: string;
    timestamp: boolean;
    fields: Array<{ name: string; value: string; inline: boolean }>;
  };

  type SavedEmbedTemplate = {
    id: string;
    name: string;
    createdAt: string;
    embed: EmbedModel;
    content?: string;
    targetChannelId?: string;
    targetMessageId?: string;
  };

  const emptyEmbed = (): EmbedModel => ({
    title: '',
    description: '',
    color: '#5865F2',
    thumbnailUrl: '',
    imageUrl: '',
    url: '',
    authorName: '',
    authorIconUrl: '',
    authorUrl: '',
    footerText: '',
    footerIconUrl: '',
    timestamp: false,
    fields: [],
  });

  function cloneEmbed(source: EmbedModel): EmbedModel {
    return {
      ...emptyEmbed(),
      ...source,
      fields: Array.isArray(source.fields)
        ? source.fields.map((field) => ({ ...field }))
        : [],
    };
  }

  let embed = $state<EmbedModel>(emptyEmbed());
  let content = $state('');

  // ── Aperçu, rendu par @arcscord/discord-ui ─────────────────────────────
  const hasEmbed = $derived(Boolean(
    embed.title || embed.description || embed.authorName || embed.footerText || embed.fields.length > 0 || embed.imageUrl || embed.thumbnailUrl,
  ));
  const previewChannel = $derived(availableChannels.find((channel) => channel.id === targetChannelId)?.name ?? 'general');

  /** Champ visible seulement complet, comme Discord le refuserait sinon. */
  const previewEmbed = $derived<EmbedView>({
    id: 'builder',
    color: embed.color || '#5865F2',
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.url ? { url: embed.url } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(embed.authorName ? { author: { name: embed.authorName, ...(embed.authorUrl ? { url: embed.authorUrl } : {}), ...(embed.authorIconUrl ? { iconUrl: embed.authorIconUrl } : {}) } } : {}),
    ...(embed.thumbnailUrl ? { thumbnail: { id: 'thumbnail', url: embed.thumbnailUrl, alt: '' } } : {}),
    ...(embed.imageUrl ? { image: { id: 'image', url: embed.imageUrl, alt: '' } } : {}),
    fields: embed.fields
      .filter((field) => field.name && field.value)
      .map((field, index) => ({ id: String(index), name: field.name, value: field.value, inline: field.inline })),
    ...(embed.footerText ? { footer: { text: embed.footerText, ...(embed.footerIconUrl ? { iconUrl: embed.footerIconUrl } : {}) } } : {}),
    ...(embed.timestamp ? { timestamp: new Date().toISOString() } : {}),
  });

  /** Rôles et salons du serveur pour les mentions `<@&id>` et `<#id>`, émojis du serveur cités. */
  const previewEntities = $derived.by((): MessageEntities => {
    const roles: NonNullable<MessageEntities['roles']> = {};
    for (const role of dashboardStore.state.discordRoles || []) roles[role.id] = { name: role.name, ...(role.color ? { color: role.color } : {}) };
    const channels: NonNullable<MessageEntities['channels']> = {};
    for (const channel of availableChannels) channels[channel.id] = { name: channel.name };
    const texts = [embed.title, embed.description, embed.authorName, embed.footerText, ...embed.fields.flatMap((field) => [field.name, field.value])];
    return mergeEntities([{ roles, channels }, ...texts.filter(Boolean).map((text) => toPreviewMarkdown(text, { mentions: false }).entities)]);
  });
  let savedTemplates = $state<SavedEmbedTemplate[]>([]);
  let templateName = $state('');
  let selectedTemplateId = $state<string | null>(null);

  function templatesStorageKey() {
    const guildId = authStore.selectedGuildId || 'global';
    return `kotbo-embed-templates:${guildId}`;
  }

  function loadTemplatesFromStorage() {
    try {
      const raw = localStorage.getItem(templatesStorageKey());
      savedTemplates = raw ? (JSON.parse(raw) as SavedEmbedTemplate[]) : [];
    } catch {
      savedTemplates = [];
    }
  }

  function persistTemplates() {
    localStorage.setItem(templatesStorageKey(), JSON.stringify(savedTemplates));
  }

  function saveCurrentAsTemplate() {
    if (!canManageSettings) return;
    const name = templateName.trim() || m.embed_builder_default_template_name({ date: new Date().toLocaleDateString() });
    const entry: SavedEmbedTemplate = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      embed: cloneEmbed(embed),
      content: content || undefined,
      targetChannelId: targetChannelId || undefined,
      targetMessageId: targetMessageId.trim() || undefined,
    };
    savedTemplates = [entry, ...savedTemplates].slice(0, 30);
    templateName = '';
    persistTemplates();
    templateAction.setMessage(m.embed_builder_template_saved_toast({ name }));
  }

  function loadTemplate(id: string) {
    const tpl = savedTemplates.find((t) => t.id === id);
    if (!tpl) return;
    embed = cloneEmbed(tpl.embed);
    content = tpl.content || '';
    targetChannelId = tpl.targetChannelId || '';
    targetMessageId = tpl.targetMessageId || '';
    selectedTemplateId = id;
    templateAction.setMessage(m.embed_builder_template_loaded_toast({ name: tpl.name }));
  }

  function deleteTemplate(id: string) {
    savedTemplates = savedTemplates.filter((t) => t.id !== id);
    if (selectedTemplateId === id) selectedTemplateId = null;
    persistTemplates();
    templateAction.setMessage(m.embed_builder_template_deleted_toast());
  }

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      loadTemplatesFromStorage();
    } finally {
      loading = false;
    }
  });

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (!guildId) return;
    loadTemplatesFromStorage();
  });

  function addField() {
    if (embed.fields.length >= 25) return; // Discord limit
    embed.fields = [...embed.fields, { name: '', value: '', inline: false }];
  }

  function removeField(idx: number) {
    embed.fields = embed.fields.filter((_, i) => i !== idx);
  }

  async function handleSend() {
    if (!canManageSettings || !targetChannelId) return;
    
    // Validate empty fields if any exist
    const hasEmptyField = embed.fields.some(f => !f.name.trim() || !f.value.trim());
    if (hasEmptyField) {
      actionState.setError(m.embed_builder_err_empty_field());
      return;
    }

    const hasEmbedData = embed.title || embed.description || embed.authorName || embed.footerText || embed.fields.length > 0 || embed.imageUrl || embed.thumbnailUrl;
    if (!content.trim() && !hasEmbedData) {
      actionState.setError(m.embed_builder_err_no_content());
      return;
    }

    await actionState.run(async () => {
      const payload = {
        channelId: targetChannelId,
        messageId: targetMessageId.trim() || null,
        content: content.trim() || undefined,
        embed: hasEmbedData ? {
          title: embed.title || undefined,
          description: embed.description || undefined,
          color: embed.color || undefined,
          thumbnailUrl: embed.thumbnailUrl || undefined,
          imageUrl: embed.imageUrl || undefined,
          url: embed.url || undefined,
          authorName: embed.authorName || undefined,
          authorIconUrl: embed.authorIconUrl || undefined,
          authorUrl: embed.authorUrl || undefined,
          footerText: embed.footerText || undefined,
          footerIconUrl: embed.footerIconUrl || undefined,
          timestamp: embed.timestamp || undefined,
          fields: embed.fields.length > 0 ? embed.fields : undefined
        } : undefined
      };

      const res = await sendOrUpdateEmbed(payload);
      if (!res || !res.ok) throw new Error(m.embed_builder_err_send());
      
      if (res.messageId) {
        targetMessageId = res.messageId;
      }
      return true;
    }, { successMessage: targetMessageId.trim() ? m.embed_builder_edit_success() : m.embed_builder_send_success() });
  }

</script>

<ModulePage
  title={m.embed_builder_title()}
  description={m.embed_builder_desc()}
  icon="file-plus"
  featureKey="embed_builder"
>
  <InlineFeedback state={actionState} />
  <InlineFeedback state={templateAction} />

  {#if loading}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <Skeleton height="600px" radius="2.5rem" />
      <Skeleton height="600px" radius="2.5rem" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <!-- Editor Form -->
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 h-fit max-h-[85vh] overflow-y-auto scrollbar-thin pr-3">
        <div class="p-5 rounded-lg bg-surface-container-high/20 border border-outline-variant/10 space-y-4">
          <h3 class="text-sm font-semibold text-on-surface-variant/80">{m.embed_builder_templates_title()}</h3>
          {#if canManageSettings}
            <div class="flex flex-col sm:flex-row gap-2">
              <input aria-label={m.embed_builder_template_name_ph()}
                type="text"
                bind:value={templateName}
                placeholder={m.embed_builder_template_name_ph()}
                class="flex-1 bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <button
                type="button"
                onclick={saveCurrentAsTemplate}
                class="px-4 py-2.5 bg-secondary/20 text-secondary font-semibold text-xs rounded-xl hover:bg-secondary/30 transition-all"
              >
                {m.embed_builder_save_template_btn()}
              </button>
            </div>
          {/if}
          {#if savedTemplates.length === 0}
            <p class="text-xs text-on-surface-variant font-medium">{m.embed_builder_no_templates()}</p>
          {:else}
            <ul class="space-y-2 max-h-40 overflow-y-auto pr-1">
              {#each savedTemplates as tpl (tpl.id)}
                <li class="flex items-center gap-2 p-2 rounded-xl bg-surface-container-low/50 border border-outline-variant/10">
                  <button
                    type="button"
                    onclick={() => loadTemplate(tpl.id)}
                    class="flex-1 min-w-0 text-left text-xs font-bold hover:text-primary transition-colors truncate"
                    title={tpl.name}
                  >
                    {tpl.name}
                  </button>
                  <span class="text-2xs text-on-surface-variant/40 shrink-0">
                    {new Date(tpl.createdAt).toLocaleDateString()}
                  </span>
                  {#if canManageSettings}
                    <button
                      type="button"
                      onclick={() => deleteTemplate(tpl.id)}
                      class="p-1.5 text-error hover:bg-error/10 rounded-lg transition-colors"
                      title={m.reaction_roles_delete_tooltip()}
                    >
                      <Papicon icon="Trash" size={14} />
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="Pen" size={20} class="text-primary" />
          {m.embed_builder_editor_title()}
        </h3>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label for="targetChan" class="text-xs font-semibold text-on-surface-variant ml-2">{m.embed_builder_channel_label()}</label>
            <SearchableSelect 
              id="targetChan"
              bind:value={targetChannelId} 
              options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
              placeholder={m.embed_builder_channel_ph()} 
              className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="msgId" class="text-xs font-semibold text-on-surface-variant ml-2">{m.embed_builder_msg_id_label()}</label>
            <input 
              id="msgId"
              type="text" 
              bind:value={targetMessageId} 
              placeholder={m.embed_builder_msg_id_ph()}
              class="w-full bg-surface-container-high/40 border border-field-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all text-on-surface"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <div class="space-y-4 pt-4 border-t border-outline-variant/10">
          <h4 class="text-xs font-semibold text-on-surface-variant/80">{m.embed_builder_msg_text_header()}</h4>
          <div class="space-y-1.5">
            <label for="msgContent" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_content_label()}</label>
            <textarea 
              id="msgContent"
              bind:value={content} 
              placeholder={m.embed_builder_content_ph()}
              class="w-full bg-surface-container-high/40 border border-field-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary h-20 resize-none text-on-surface"
              disabled={!canManageSettings}
            ></textarea>
          </div>
        </div>

        <div class="space-y-4 pt-4 border-t border-outline-variant/10">
          <h4 class="text-xs font-semibold text-on-surface-variant/80">{m.embed_builder_author_header()}</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label for="authorName" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_author_name_label()}</label>
              <input 
                id="authorName"
                type="text" 
                bind:value={embed.authorName} 
                placeholder={m.embed_builder_author_name_ph()}
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="authorIcon" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_author_icon_label()}</label>
              <input 
                id="authorIcon"
                type="url" 
                bind:value={embed.authorIconUrl} 
                placeholder="https://example.com/icon.png"
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5 sm:col-span-2">
              <label for="authorUrl" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_author_url_label()}</label>
              <input 
                id="authorUrl"
                type="url" 
                bind:value={embed.authorUrl} 
                placeholder="https://example.com/author"
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
          </div>
        </div>

        <div class="space-y-4 pt-4 border-t border-outline-variant/10">
          <h4 class="text-xs font-semibold text-on-surface-variant/80">{m.embed_builder_main_content_header()}</h4>
          <div class="space-y-1.5">
            <label for="embedTitle" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_embed_title_label()}</label>
            <input 
              id="embedTitle"
              type="text" 
              bind:value={embed.title} 
              placeholder={m.embed_builder_embed_title_ph()}
              class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="embedUrl" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_embed_url_label()}</label>
            <input 
              id="embedUrl"
              type="url" 
              bind:value={embed.url} 
              placeholder="https://example.com/details"
              class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={!canManageSettings}
            />
          </div>

          <div class="space-y-1.5">
            <label for="embedDesc" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_desc_label()}</label>
            <textarea 
              id="embedDesc"
              bind:value={embed.description} 
              placeholder={m.embed_builder_desc_ph()}
              class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary h-24 resize-none"
              disabled={!canManageSettings}
            ></textarea>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label for="embedColor" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_color_label()}</label>
              <div class="flex gap-2">
                <input 
                  id="embedColor"
                  type="color" 
                  bind:value={embed.color} 
                  class="w-10 h-10 border-0 bg-transparent rounded-xl cursor-pointer"
                  disabled={!canManageSettings}
                />
                <input aria-label={m.a11y_hex_color()} 
                  type="text" 
                  bind:value={embed.color} 
                  placeholder="#5865F2"
                  class="flex-1 bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary font-mono"
                  disabled={!canManageSettings}
                />
              </div>
            </div>
            
            <div class="space-y-1.5">
              <label for="embedThumbnail" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_thumbnail_label()}</label>
              <input 
                id="embedThumbnail"
                type="url" 
                bind:value={embed.thumbnailUrl} 
                placeholder="https://example.com/thumbnail.png"
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
          </div>

          <div class="space-y-1.5">
            <label for="embedImage" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_image_label()}</label>
            <input 
              id="embedImage"
              type="url" 
              bind:value={embed.imageUrl} 
              placeholder="https://example.com/banner.png"
              class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={!canManageSettings}
            />
          </div>
        </div>

        <!-- Fields Builder -->
        <div class="space-y-4 pt-4 border-t border-outline-variant/10">
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-semibold text-on-surface-variant/80">{m.embed_builder_fields_header({ n: embed.fields.length })}</h4>
            <button 
              type="button" 
              onclick={addField} 
              disabled={embed.fields.length >= 25}
              use:explainDisabled={(!canManageSettings) ? m.common_reason_no_permission() : ''}
              class="text-xs font-bold text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
            >
              <Papicon icon="Plus" size={14} /> {m.embed_builder_add_field_btn()}
            </button>
          </div>

          <div class="space-y-3">
            {#each embed.fields as fld, idx}
              <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-3 relative group">
                <div class="flex gap-2">
                  <div class="flex-1 space-y-1">
                    <label for={`fldName-${idx}`} class="text-2xs font-bold text-on-surface-variant ml-1 uppercase">{m.embed_builder_field_title_label()}</label>
                    <input 
                      id={`fldName-${idx}`}
                      type="text" 
                      bind:value={fld.name} 
                      placeholder={m.embed_builder_field_title_ph()} 
                      class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      required
                      disabled={!canManageSettings}
                    />
                  </div>
                  {#if canManageSettings}
                    <button 
                      type="button" 
                      onclick={() => removeField(idx)}
                      class="self-end p-2 text-error hover:bg-error/10 rounded-lg transition-colors"
                      title={m.reaction_roles_remove_button_title()}
                    >
                      <Papicon icon="Minus" size={14} />
                    </button>
                  {/if}
                </div>

                <div class="space-y-1">
                  <label for={`fldVal-${idx}`} class="text-2xs font-bold text-on-surface-variant ml-1 uppercase">{m.embed_builder_field_val_label()}</label>
                  <textarea 
                    id={`fldVal-${idx}`}
                    bind:value={fld.value} 
                    placeholder={m.embed_builder_field_val_ph()} 
                    class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-primary h-14 resize-none"
                    required
                    disabled={!canManageSettings}
                  ></textarea>
                </div>

                <div class="flex items-center gap-2">
                  <input 
                    id={`fldInline-${idx}`}
                    type="checkbox" 
                    bind:checked={fld.inline} 
                    class="rounded border-outline-variant/20 text-primary focus:ring-primary/20"
                    disabled={!canManageSettings}
                  />
                  <label for={`fldInline-${idx}`} class="text-2xs font-bold text-on-surface-variant uppercase">{m.embed_builder_field_inline_label()}</label>
                </div>
              </div>
            {/each}
          </div>
        </div>

        <div class="space-y-4 pt-4 border-t border-outline-variant/10">
          <h4 class="text-xs font-semibold text-on-surface-variant/80">{m.embed_builder_footer_header()}</h4>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label for="footerText" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_footer_text_label()}</label>
              <input 
                id="footerText"
                type="text" 
                bind:value={embed.footerText} 
                placeholder="Kotbo Bot © 2026"
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
            <div class="space-y-1.5">
              <label for="footerIcon" class="text-2xs font-bold text-on-surface-variant ml-2 uppercase">{m.embed_builder_footer_icon_label()}</label>
              <input 
                id="footerIcon"
                type="url" 
                bind:value={embed.footerIconUrl} 
                placeholder="https://example.com/footer.png"
                class="w-full bg-surface-container-high/40 border border-field-border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                disabled={!canManageSettings}
              />
            </div>
            <div class="flex items-center gap-2 pt-2 sm:col-span-2">
              <input 
                id="embedTimestamp"
                type="checkbox" 
                bind:checked={embed.timestamp} 
                class="rounded border-outline-variant/20 text-primary focus:ring-primary/20"
                disabled={!canManageSettings}
              />
              <label for="embedTimestamp" class="text-2xs font-bold text-on-surface-variant uppercase">{m.embed_builder_timestamp_label()}</label>
            </div>
          </div>
        </div>

        {#if canManageSettings}
          <div class="pt-6 border-t border-outline-variant/15 flex justify-end">
            <button 
              onclick={handleSend}
              disabled={actionState.state.loading}
              use:explainDisabled={(!targetChannelId) ? m.common_reason_pick_channel() : ''}
              class="px-8 py-3.5 bg-primary text-on-primary font-medium text-body-sm rounded-lg transition-all disabled:opacity-50"
            >
              {targetMessageId.trim() ? m.embed_builder_edit_btn() : m.embed_builder_publish_btn()}
            </button>
          </div>
        {/if}
      </section>

      <!-- Live Preview -->
      <section class="space-y-6 h-fit">
        <h3 class="text-xl font-semibold flex items-center gap-3">
          <Papicon icon="Camera" size={20} class="text-secondary" />
          {m.embed_builder_live_preview()}
        </h3>

        <div class="select-none">
          {#if hasEmbed || content.trim()}
            <DiscordPreview channel={previewChannel} content={content.trim() ? content : undefined} mentions={false} entities={previewEntities}>
              {#if hasEmbed}<Embed embed={previewEmbed} />{/if}
            </DiscordPreview>
          {:else}
            <p class="text-xs text-on-surface-variant/40 italic">{m.embed_builder_preview_empty_hint()}</p>
          {/if}
        </div>
      </section>
    </div>
  {/if}
</ModulePage>
