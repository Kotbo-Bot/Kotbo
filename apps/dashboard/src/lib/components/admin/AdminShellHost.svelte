<script lang="ts">
  /**
   * Hote persistant de la console admin.
   *
   * Monte une seule fois autour des routes `/admin/*` dans `App.svelte` pour que
   * la barre laterale, le bandeau d'en-tete, la sonde de sante et le theme
   * restent stables pendant toute la navigation (aucun rechargement visuel ni
   * clignotement entre deux pages admin).
   */
  import type { Snippet } from 'svelte';
  import { setContext } from 'svelte';
  import AdminShell, { ADMIN_SHELL_HOST_KEY, type AdminShellHeaderProps } from './AdminShell.svelte';

  const { children }: { children?: Snippet } = $props();

  let header = $state<AdminShellHeaderProps>({});

  setContext(ADMIN_SHELL_HOST_KEY, {
    setHeader(next: AdminShellHeaderProps) {
      header = next;
    },
    clearHeader() {
      header = {};
    },
  });
</script>

<AdminShell
  title={header.title}
  description={header.description}
  heading={header.heading}
  backHref={header.backHref}
  backLabel={header.backLabel}
  lead={header.lead}
  actions={header.actions}
  isHost
>
  {@render children?.()}
</AdminShell>

