<script lang="ts">
  /**
   * Identite d'un membre : sa photo et son pseudo, rendus de la meme facon
   * partout.
   *
   * Chaque page reimplementait ce duo a sa maniere (initiales dans un rond,
   * <img> sans repli, identifiant brut quand le pseudo manquait), d'ou des
   * rendus incoherents d'un ecran a l'autre. Passer par memberAvatarSrc donne
   * a chaque membre sans photo une vignette a initiale coloree par son
   * identifiant, donc distincte de celle de ses voisins.
   */
  import { memberAvatarSrc } from '../discordMedia';

  const {
    userId = null,
    name = null,
    avatarUrl = null,
    subtitle = null,
    size = 'md',
    prefix = '',
    onClick = null,
    class: className = '',
  }: {
    /** Identifiant Discord, utilise comme repli d'affichage et graine de couleur. */
    userId?: string | null;
    /** Pseudo a afficher. A defaut, l'identifiant sert de libelle. */
    name?: string | null;
    avatarUrl?: string | null;
    /** Seconde ligne facultative (role, date, compteur...). */
    subtitle?: string | null;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** Prefixe colle au pseudo, typiquement '@'. */
    prefix?: string;
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

  // Un membre parti du serveur n'a plus que son identifiant : l'afficher reste
  // preferable a une ligne vide, et le title porte l'id dans tous les cas.
  const label = $derived(name?.trim() || userId || '-');
  const avatarSrc = $derived(memberAvatarSrc(avatarUrl, label, userId));
  const clickable = $derived(!!onClick && !!userId);
</script>

{#snippet body()}
  <img
    src={avatarSrc}
    alt=""
    loading="lazy"
    class="{AVATAR_CLASSES[size]} shrink-0 object-cover bg-surface-container"
  />
  <span class="min-w-0 flex flex-col text-left">
    <span class="{NAME_CLASSES[size]} font-semibold text-on-surface truncate">{prefix}{label}</span>
    {#if subtitle}
      <span class="text-2xs font-medium text-on-surface-variant truncate">{subtitle}</span>
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
