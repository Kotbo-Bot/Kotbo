<script lang="ts">
  /**
   * Espace d'un membre sans role de staff : sa fiche et sa carte `/rank`.
   *
   * Pas de barre laterale : elle ne liste que des pages de pilotage, toutes
   * fermees a ce compte. L'en-tete n'apparait que si la personne est staff sur
   * un autre serveur Kotbo - il lui sert alors a y retourner.
   *
   * Les textes restent au vouvoiement : ils s'adressent aux membres, pas au staff.
   */
  import { authStore } from '../lib/stores/auth.svelte';
  import { API_BASE_URL, authorizedFetch } from '../lib/api/client';
  import { resolveUserAvatarSrc } from '../lib/discordMedia';
  import { toast } from '../lib/stores/toast.svelte';
  import { m } from '../lib/i18n';
  import { Button, Callout, SectionCard, ToggleSwitch } from '../lib/components/ui';
  import Navbar from '../lib/components/Navbar.svelte';
  import ServerSwitcherModal from '../lib/components/ServerSwitcherModal.svelte';
  import RankCardCustomizer from '../lib/components/RankCardCustomizer.svelte';
  import SiteEditorSpace from '../lib/components/site/SiteEditorSpace.svelte';

  const BIO_MAX = 500;

  const userId = $derived(authStore.user?.id ?? '');
  const hasDashboard = $derived(authStore.guilds.length > 0);

  let loading = $state(true);
  let saving = $state(false);
  let missingProfile = $state(false);
  let bio = $state('');
  let isPublic = $state(false);
  let saved = $state({ bio: '', isPublic: false });

  const dirty = $derived(bio.trim() !== saved.bio || isPublic !== saved.isPublic);

  $effect(() => {
    if (userId) void load(userId);
  });

  async function load(id: string) {
    loading = true;
    try {
      const response = await authorizedFetch(`${API_BASE_URL}/api/public/profile/${id}`);
      if (!response.ok) throw new Error(String(response.status));
      const profile = await response.json();
      bio = profile.bio ?? '';
      isPublic = profile.isPrivate === false;
      saved = { bio: bio.trim(), isPublic };
    } catch {
      toast.error(m.me_load_error());
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!userId || saving) return;
    saving = true;
    try {
      const response = await authorizedFetch(`${API_BASE_URL}/api/public/profile/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: bio.trim() || null, isProfilePrivate: !isPublic }),
      });
      // Pas de ligne de profil tant que le bot n'a jamais vu la personne ecrire :
      // la lecture rend alors un profil reconstitue, l'ecriture un 404.
      if (response.status === 404) {
        missingProfile = true;
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      bio = data.profile?.bio ?? '';
      isPublic = data.profile?.isProfilePrivate === false;
      saved = { bio: bio.trim(), isPublic };
      toast.success(m.me_saved());
    } catch {
      toast.error(m.me_save_error());
    } finally {
      saving = false;
    }
  }
</script>

{#if hasDashboard}
  <Navbar standalone />
  <ServerSwitcherModal />
{/if}

<main id="main-content" class="min-h-screen bg-background text-on-background">
  <div class="mx-auto w-full max-w-3xl px-4 sm:px-6 py-10 space-y-6">
    <header class="flex flex-wrap items-center gap-4">
      <img
        src={resolveUserAvatarSrc(authStore.user?.id, authStore.user?.avatar)}
        alt=""
        width="56"
        height="56"
        class="w-14 h-14 rounded-full object-cover bg-surface-container shrink-0"
      />
      <div class="min-w-0 flex-1">
        <h1 class="text-xl font-semibold text-on-surface">{m.me_title()}</h1>
        <p class="mt-0.5 text-body-sm text-on-surface-variant">{m.me_subtitle()}</p>
      </div>
      {#if hasDashboard}
        <Button href="/" size="sm" icon="arrow-left">{m.me_back_dashboard()}</Button>
      {:else}
        <Button size="sm" variant="ghost" icon="log-out" onclick={() => authStore.logout()}>{m.navbar_logout()}</Button>
      {/if}
    </header>

    <SectionCard title={m.me_profile_title()} description={m.me_profile_desc()}>
      {#snippet actions()}
        {#if userId}
          <Button href={`/profile/${userId}`} size="sm" variant="ghost">{m.me_view_public()}</Button>
        {/if}
      {/snippet}

      {#if loading}
        <div class="space-y-4 animate-pulse" aria-busy="true">
          <div class="h-28 rounded-lg bg-surface-container"></div>
          <div class="h-10 rounded-lg bg-surface-container"></div>
        </div>
      {:else}
        <div class="space-y-5">
          <div>
            <label for="me-bio" class="field-label">{m.me_bio_label()}</label>
            <textarea
              id="me-bio"
              bind:value={bio}
              maxlength={BIO_MAX}
              rows={5}
              placeholder={m.me_bio_ph()}
              class="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:border-primary resize-y"
            ></textarea>
            <p class="mt-1 text-right text-xs text-on-surface-variant">{bio.length}/{BIO_MAX}</p>
          </div>

          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-sm font-medium text-on-surface">{m.me_public_label()}</p>
              <p class="mt-0.5 text-body-sm text-on-surface-variant">{m.me_public_desc()}</p>
            </div>
            <ToggleSwitch checked={isPublic} onToggle={(value) => (isPublic = value)} ariaLabel={m.me_public_label()} />
          </div>

          {#if missingProfile}
            <Callout variant="info">{m.me_no_profile()}</Callout>
          {/if}

          <div class="flex justify-end">
            <Button variant="primary" onclick={save} loading={saving} disabled={!dirty || missingProfile}>
              {m.me_save()}
            </Button>
          </div>
        </div>
      {/if}
    </SectionCard>

    <SiteEditorSpace />

    <section class="section-card p-5">
      <RankCardCustomizer />
    </section>

    {#if !hasDashboard}
      <p class="text-center text-body-sm text-on-surface-variant">
        <a href="/servers" class="text-primary hover:underline">{m.me_manage_server()}</a>
      </p>
    {/if}
  </div>
</main>
