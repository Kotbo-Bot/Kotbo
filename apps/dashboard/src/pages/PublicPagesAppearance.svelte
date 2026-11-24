<script lang="ts">
  /**
   * Apparence des pages publiques du serveur : un seul habillage (couleurs,
   * police, rayon, verre dépoli, bannière, CSS) appliqué aux classements, clans
   * et giveaways. L'aperçu à droite est la vraie coque `PublicShell`, alimentée
   * par le brouillon : ce qu'on y voit est ce que verront les visiteurs.
   */
  import { onMount } from 'svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import PublicShell from '../lib/components/public/PublicShell.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { Button, Field, FilterPills, SectionCard, ToggleSwitch } from '../lib/components/ui';
  import { fetchPublicThemeAdmin, savePublicTheme } from '../lib/api/publicTheme';
  import { PUBLIC_BACKGROUNDS, PUBLIC_DENSITIES, PUBLIC_FONTS, type PublicTheme } from '../lib/publicTheme';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';

  let loading = $state(true);
  let saving = $state(false);
  let theme = $state<PublicTheme>({});
  let saved = $state('{}');

  const guild = $derived(authStore.guilds.find((g) => g.id === authStore.selectedGuildId));
  const guildId = $derived(authStore.selectedGuildId ?? '');

  /** Le brouillon sans valeur vide : c'est ce qu'on envoie et ce qu'on prévisualise. */
  const draft = $derived.by(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(theme)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      out[k] = typeof v === 'string' ? v.trim() : v;
    }
    return out as PublicTheme;
  });
  const dirty = $derived(JSON.stringify(draft) !== saved);

  onMount(async () => {
    try {
      theme = (await fetchPublicThemeAdmin()) ?? {};
      saved = JSON.stringify(draft);
    } catch {
      toast.error(m.pph_load_error());
    } finally {
      loading = false;
    }
  });

  async function save() {
    saving = true;
    try {
      const res = await savePublicTheme(Object.keys(draft).length ? draft : null);
      theme = res ?? {};
      saved = JSON.stringify(draft);
      toast.success(m.pph_saved());
    } catch {
      toast.error(m.pph_save_error());
    } finally {
      saving = false;
    }
  }

  function reset() {
    theme = {};
  }

  const COLORS: Array<{ key: 'accentColor' | 'backgroundColor' | 'cardColor' | 'textColor'; label: () => string; fallback: string }> = [
    { key: 'accentColor', label: () => m.pph_color_accent(), fallback: '#818cf8' },
    { key: 'backgroundColor', label: () => m.pph_color_background(), fallback: '#09090b' },
    { key: 'cardColor', label: () => m.pph_color_cards(), fallback: '#111113' },
    { key: 'textColor', label: () => m.pph_color_text(), fallback: '#fafafa' },
  ];

  const PAGES = [
    { path: 'leveling/classement', label: () => m.pph_page_leveling() },
    { path: 'prestige/classement', label: () => m.pph_page_prestige() },
    { path: 'clan', label: () => m.pph_page_clans() },
    { path: 'clan-rpg', label: () => m.pph_page_clan_rpg() },
    { path: 'rpg', label: () => m.pph_page_rpg() },
    { path: 'giveaways', label: () => m.pph_page_giveaways() },
  ];

  const backgroundOptions = $derived(PUBLIC_BACKGROUNDS.map((v) => ({ value: v, label: m[`pph_bg_${v}` as 'pph_bg_plain']() })));
  const densityOptions = $derived(PUBLIC_DENSITIES.map((v) => ({ value: v, label: m[`pph_density_${v}` as 'pph_density_comfortable']() })));

  const input = 'w-full bg-surface-container rounded-lg px-3 py-2 text-sm outline-none border border-field-border focus:border-primary';
</script>

<ModulePage title={m.pph_title()} description={m.pph_desc()} icon="palette" featureKey="settings">
  {#if loading}
    <Skeleton height="520px" radius="1rem" />
  {:else}
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-6 items-start">
      <div class="space-y-5">
        <SectionCard title={m.pph_identity()} icon="user">
          <div class="space-y-4">
            <Field label={m.pph_site_title()} hint={m.pph_site_title_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class={input} maxlength="80" placeholder={guild?.name ?? ''} bind:value={theme.siteTitle} />
              {/snippet}
            </Field>
            <Field label={m.pph_logo()} hint={m.pph_image_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class={input} placeholder="https://…/logo.png" bind:value={theme.logoUrl} />
              {/snippet}
            </Field>
            <Field label={m.pph_banner()} hint={m.pph_image_hint()}>
              {#snippet children(id, describedBy)}
                <input {id} aria-describedby={describedBy} class={input} placeholder="https://…/banniere.png" bind:value={theme.bannerUrl} />
              {/snippet}
            </Field>
            <Field label={m.pph_welcome()} hint={m.pph_welcome_hint()}>
              {#snippet children(id, describedBy)}
                <textarea {id} aria-describedby={describedBy} class="{input} resize-none" rows="3" maxlength="500" bind:value={theme.welcomeText}></textarea>
              {/snippet}
            </Field>
          </div>
        </SectionCard>

        <SectionCard title={m.pph_look()} icon="palette">
          <div class="space-y-5">
            <div class="grid grid-cols-2 gap-3">
              {#each COLORS as c (c.key)}
                <div>
                  <p class="text-2xs font-semibold text-on-surface-variant mb-1">{c.label()}</p>
                  <div class="flex items-center gap-1.5">
                    <input
                      aria-label={c.label()}
                      type="color"
                      value={theme[c.key] || c.fallback}
                      oninput={(e) => (theme[c.key] = e.currentTarget.value)}
                      class="h-9 flex-1 min-w-0 rounded-lg bg-surface-container border border-outline-variant cursor-pointer"
                    />
                    {#if theme[c.key]}
                      <button type="button" class="p-1.5 rounded-md text-on-surface-variant hover:text-on-surface" aria-label={m.pph_color_reset()} title={m.pph_color_reset()} onclick={() => (theme[c.key] = undefined)}>
                        <Papicon icon="x" size={14} />
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
            <p class="text-xs text-on-surface-variant">{m.pph_colors_hint()}</p>

            <Field label={m.pph_font()}>
              {#snippet children(id)}
                <select {id} class={input} value={theme.fontFamily ?? ''} onchange={(e) => (theme.fontFamily = e.currentTarget.value || undefined)}>
                  <option value="">{m.pph_font_default()}</option>
                  {#each PUBLIC_FONTS as font}<option value={font}>{font}</option>{/each}
                </select>
              {/snippet}
            </Field>

            <Field label={m.pph_radius({ px: theme.borderRadius ?? 14 })}>
              {#snippet children(id)}
                <input {id} type="range" min="0" max="32" class="w-full accent-primary" value={theme.borderRadius ?? 14} oninput={(e) => (theme.borderRadius = Number(e.currentTarget.value))} />
              {/snippet}
            </Field>

            <div>
              <p class="text-2xs font-semibold text-on-surface-variant mb-1.5">{m.pph_background()}</p>
              <FilterPills label={m.pph_background()} options={backgroundOptions} value={theme.background ?? 'plain'} onchange={(v) => (theme.background = v as PublicTheme['background'])} />
            </div>
            <div>
              <p class="text-2xs font-semibold text-on-surface-variant mb-1.5">{m.pph_density()}</p>
              <FilterPills label={m.pph_density()} options={densityOptions} value={theme.density ?? 'comfortable'} onchange={(v) => (theme.density = v as PublicTheme['density'])} />
            </div>

            <div class="flex items-center justify-between gap-3">
              <span class="text-sm">{m.pph_glass()}</span>
              <ToggleSwitch checked={theme.glass ?? false} onToggle={(v) => (theme.glass = v)} ariaLabel={m.pph_glass()} />
            </div>
          </div>
        </SectionCard>

        <SectionCard title={m.pph_css()} description={m.pph_css_hint()} icon="code">
          <textarea
            aria-label={m.pph_css()}
            class="{input} font-mono text-xs resize-y"
            rows="6"
            spellcheck="false"
            placeholder={'.pub-root .pub-card { border-color: gold; }'}
            bind:value={theme.customCss}
          ></textarea>
        </SectionCard>

        <div class="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={saving} disabled={!dirty} onclick={save}>{m.pph_save()}</Button>
          <Button variant="secondary" disabled={saving || !Object.keys(draft).length} onclick={reset}>{m.pph_reset()}</Button>
          {#if dirty}<span class="text-xs text-on-surface-variant">{m.pph_unsaved()}</span>{/if}
        </div>
      </div>

      <div class="space-y-5 xl:sticky xl:top-4">
        <div class="rounded-2xl border border-outline-variant overflow-hidden">
          <PublicShell serverId={guildId} subtitle={m.pph_preview_subtitle()} icon="Trophy" guildName={guild?.name ?? 'Kotbo'} guildIcon={guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null} width="narrow" live embedded theme={draft}>
            <div class="grid grid-cols-3 gap-3">
              {#each [['128', m.pph_preview_members()], ['42', m.pph_preview_max()], ['18', m.pph_preview_avg()]] as [value, label]}
                <div class="pub-card p-4 text-center">
                  <p class="text-xl font-semibold">{value}</p>
                  <p class="text-xs text-on-surface-variant">{label}</p>
                </div>
              {/each}
            </div>
            <div class="pub-card divide-y divide-outline-variant overflow-hidden">
              {#each [1, 2, 3] as rank}
                <div class="flex items-center gap-3 px-4 py-3">
                  <span class="w-6 text-sm font-semibold {rank === 1 ? 'text-primary' : 'text-on-surface-variant'}">{rank}</span>
                  <span class="w-8 h-8 rounded-full bg-surface-container-high shrink-0"></span>
                  <span class="text-sm font-medium flex-1 truncate">{m.pph_preview_member({ n: rank })}</span>
                  <span class="text-xs font-mono text-on-surface-variant">{(4 - rank) * 12400} XP</span>
                </div>
              {/each}
            </div>
          </PublicShell>
        </div>

        <SectionCard title={m.pph_pages()} description={m.pph_pages_hint()} icon="globe">
          <ul class="space-y-1">
            {#each PAGES as p (p.path)}
              <li>
                <a href="/{guildId}/{p.path}" target="_blank" rel="noopener" class="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-hover">
                  <span>{p.label()}</span>
                  <span class="flex items-center gap-1.5 text-xs text-on-surface-variant font-mono">/{p.path}<Papicon icon="external-link" size={12} /></span>
                </a>
              </li>
            {/each}
          </ul>
        </SectionCard>
      </div>
    </div>
  {/if}
</ModulePage>
