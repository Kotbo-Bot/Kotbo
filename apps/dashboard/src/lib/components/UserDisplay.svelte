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
   *
   * Par defaut, la photo et le pseudo ouvrent la fiche membre et la pastille de
   * tag ouvre la fiche du serveur du tag. `onClick={null}` fige la photo et le pseudo ; pose
   * dans un bouton ou un lien, le composant le detecte et ne capte aucun clic.
   */
  import { memberAvatarSrc } from '../discordMedia';
  import { memberIdentities } from '../stores/memberIdentities.svelte';
  import ServerTagPill from './ServerTagPill.svelte';
  import BoosterBadge from './BoosterBadge.svelte';
  import { memberCaseModal } from '../stores/memberCaseModal.svelte';
  import { serverDetailsModal } from '../stores/serverDetailsModal.svelte';

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
    boost = true,
    resolve = true,
    onClick = undefined,
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
    serverTag?: { tag: string; badgeUrl?: string | null; guildId?: string | null } | null;
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
    /** Affiche le badge de booster quand le membre booste le serveur. */
    boost?: boolean;
    /** Complete les champs manquants depuis le store ; false pour un rendu fige. */
    resolve?: boolean;
    /** Clic sur la photo ou le pseudo ; par defaut la fiche membre, `null` pour aucun. */
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
  const boostingSince = $derived(boost ? known?.boostingSince ?? null : null);
  const secondLine = $derived([handle && at ? `@${at}` : null, subtitle].filter(Boolean).join(' · '));
  let nested = $state(false);
  let root: HTMLElement | undefined = $state();
  // Un bouton dans un bouton est invalide et ferait partir deux clics : le parent garde la main.
  $effect(() => {
    nested = !!root?.parentElement?.closest('button, a, [role="button"], [role="link"]');
  });
  const handler = $derived(
    onClick === undefined ? (memberCaseModal.canOpen ? (id: string) => void memberCaseModal.show(id, label) : null) : onClick,
  );
  const clickable = $derived(!nested && !!handler && !!userId);
  const tagGuildId = $derived(shownTag && 'guildId' in shownTag ? shownTag.guildId ?? null : null);
  const openTag = $derived(
    !nested && tagGuildId && shownTag
      ? () => serverDetailsModal.show(tagGuildId, shownTag.tag)
      : null,
  );
</script>

<span
  bind:this={root}
  title={userId ?? undefined}
  class="inline-flex items-center {GAP_CLASSES[size]} min-w-0 {className}"
>
  {#if avatar}
    {#if clickable}
      <!-- Doublon souris du pseudo, deja atteignable au clavier : hors de l'ordre de tabulation. -->
      <button type="button" tabindex="-1" aria-hidden="true" class="shrink-0" onclick={() => handler?.(userId!)}>
        <img src={avatarSrc} alt="" loading="lazy" class="{AVATAR_CLASSES[size]} object-cover bg-surface-container" />
      </button>
    {:else}
      <img
        src={avatarSrc}
        alt=""
        loading="lazy"
        class="{AVATAR_CLASSES[size]} shrink-0 object-cover bg-surface-container"
      />
    {/if}
  {/if}
  <span class="min-w-0 flex flex-col text-left">
    <span class="flex min-w-0 items-center gap-1.5">
      {#if clickable}
        <button
          type="button"
          onclick={() => handler?.(userId!)}
          class="{NAME_CLASSES[size]} font-semibold text-on-surface truncate text-left rounded transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >{prefix}{label}</button>
      {:else}
        <span class="{NAME_CLASSES[size]} font-semibold text-on-surface truncate">{prefix}{label}</span>
      {/if}
      {#if shownTag}
        <ServerTagPill tag={shownTag.tag} badgeUrl={shownTag.badgeUrl} onclick={openTag} />
      {/if}
      {#if boostingSince}
        <BoosterBadge since={boostingSince} size={size === 'lg' ? 15 : 13} />
      {/if}
    </span>
    {#if secondLine}
      <span class="text-2xs font-medium text-on-surface-variant truncate">{secondLine}</span>
    {/if}
  </span>
</span>
