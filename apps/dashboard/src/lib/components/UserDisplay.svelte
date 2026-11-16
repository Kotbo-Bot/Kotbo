<script lang="ts">
  /**
   * Identite d'un membre : photo, pseudo, @ et tag de serveur, rendus de la
   * meme facon partout.
   *
   * Chaque page reimplementait ce rendu a sa maniere (initiales dans un rond,
   * <img> sans repli, identifiant brut quand le pseudo manquait), et le tag
   * n'apparaissait que la ou la route pensait a le joindre. Avec le seul
   * `userId`, le composant complete ce qui lui manque depuis le store partage
   * `memberIdentities` ; les valeurs passees en props restent prioritaires.
   * Les options `avatar`, `handle` et `tag` choisissent ce qui s'affiche.
   */
  import { memberAvatarSrc } from '../discordMedia';
  import { memberIdentities } from '../stores/memberIdentities.svelte';
  import ServerTagPill from './ServerTagPill.svelte';

  const {
    userId = null,
    name = null,
    username = null,
    avatarUrl = null,
    serverTag = undefined,
    subtitle = null,
    size = 'md',
    prefix = '',
    avatar = true,
    handle = false,
    tag = true,
    resolve = true,
    onClick = null,
    class: className = '',
  }: {
    /** Identifiant Discord : repli d'affichage, graine de couleur et cle de resolution. */
    userId?: string | null;
    /** Pseudo a afficher. A defaut, celui du store, puis l'identifiant. */
    name?: string | null;
    /** Nom d'utilisateur Discord, affiche en `@` avec `handle`. */
    username?: string | null;
    avatarUrl?: string | null;
    /** Tag deja connu de l'appelant ; `null` force l'absence de tag. */
    serverTag?: { tag: string; badgeUrl?: string | null } | null;
    /** Seconde ligne facultative (role, date, compteur...). */
    subtitle?: string | null;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** Prefixe colle au pseudo, typiquement '@'. */
    prefix?: string;
    /** Affiche la photo. */
    avatar?: boolean;
    /** Affiche le `@nom` sous le pseudo. */
    handle?: boolean;
    /** Affiche le tag de serveur a cote du pseudo, comme Discord. */
    tag?: boolean;
    /** Complete les champs manquants depuis le store ; false pour un rendu fige. */
    resolve?: boolean;
    /** Rend l'ensemble cliquable (ouverture de la fiche membre). */
    onClick?: ((userId: string) => void) | null;
    class?: string;
  } = $props();

  const AVATAR_CLASSES = {
    xs: 'h-5 w-5 rounded-md',
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-9 w-9 rounded-lg',
    lg: 'h-12 w-12 rounded-xl',
  } as const;

  const NAME_CLASSES = {
    xs: 'text-2xs',
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  } as const;

  const GAP_CLASSES = {
    xs: 'gap-1.5',
    sm: 'gap-2',
    md: 'gap-2.5',
    lg: 'gap-3',
  } as const;

  const known = $derived(resolve ? memberIdentities.get(userId) : undefined);
  // Un membre parti du serveur n'a plus que son identifiant : l'afficher reste
  // preferable a une ligne vide, et le title porte l'id dans tous les cas.
  const label = $derived(name?.trim() || known?.displayName || userId || '-');
  const avatarSrc = $derived(memberAvatarSrc(avatarUrl ?? known?.avatarUrl ?? null, label, userId));
  const at = $derived(username || known?.username || null);
  const shownTag = $derived(tag ? (serverTag === undefined ? known?.serverTag : serverTag) ?? null : null);
  const secondLine = $derived([handle && at ? `@${at}` : null, subtitle].filter(Boolean).join(' · '));
  const clickable = $derived(!!onClick && !!userId);
</script>

{#snippet body()}
  {#if avatar}
    <img
      src={avatarSrc}
      alt=""
      loading="lazy"
      class="{AVATAR_CLASSES[size]} shrink-0 object-cover bg-surface-container"
    />
  {/if}
  <span class="min-w-0 flex flex-col text-left">
    <span class="flex min-w-0 items-center gap-1.5">
      <span class="{NAME_CLASSES[size]} font-semibold text-on-surface truncate">{prefix}{label}</span>
      {#if shownTag}
        <ServerTagPill tag={shownTag.tag} badgeUrl={shownTag.badgeUrl} />
      {/if}
    </span>
    {#if secondLine}
      <span class="text-2xs font-medium text-on-surface-variant truncate">{secondLine}</span>
    {/if}
  </span>
{/snippet}

{#if clickable}
  <button
    type="button"
    onclick={() => onClick?.(userId!)}
    title={userId ?? undefined}
    class="inline-flex items-center {GAP_CLASSES[size]} min-w-0 rounded-lg transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 {className}"
  >
    {@render body()}
  </button>
{:else}
  <span
    title={userId ?? undefined}
    class="inline-flex items-center {GAP_CLASSES[size]} min-w-0 {className}"
  >
    {@render body()}
  </span>
{/if}
