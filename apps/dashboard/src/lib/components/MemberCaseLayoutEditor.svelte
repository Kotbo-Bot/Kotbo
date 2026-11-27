<!--
  Réglage (admins) de la disposition des onglets de la fiche membre, par rôle :
  la première règle dont un rôle correspond au staff qui consulte s'applique.
-->
<script lang="ts">
  import { m } from '../i18n';
  import { dashboardFetch } from '../api';
  import { toast } from '../stores/toast.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import Modal from './Modal.svelte';
  import MultiSelect from './MultiSelect.svelte';
  import { Button } from './ui';

  let { open = $bindable(false), onSaved = () => {} }: { open?: boolean; onSaved?: () => void } = $props();

  // Aligné sur MEMBER_CASE_TABS côté bot ; « resume » reste toujours visible.
  const TABS: Array<{ id: string; label: string }> = [
    { id: 'resume', label: 'Résumé' }, { id: 'identite', label: 'Identité' }, { id: 'activite', label: 'Activité' },
    { id: 'analytics', label: 'Analytics' }, { id: 'contenu', label: 'Contenu' }, { id: 'messages', label: 'Messages' },
    { id: 'logs', label: 'Logs' }, { id: 'sanctions', label: 'Sanctions' }, { id: 'candidatures', label: 'Candidatures' },
    { id: 'invites', label: 'Invitations' }, { id: 'connexions', label: 'Connexions' }, { id: 'linked_accounts', label: 'Comptes liés' },
    { id: 'notes', label: 'Notes' }, { id: 'wellbeing', label: 'Suivi confidentiel' },
  ];

  type Rule = { name: string; roleIds: string[]; tabOrder: string[]; hiddenTabs: string[] };

  let rules = $state<Rule[]>([]);
  let saving = $state(false);

  const roleOptions = $derived(((dashboardStore.state.discordRoles ?? []) as Array<{ id: string; name: string }>).map((r) => ({ id: r.id, name: `@${r.name}` })));

  /** Onglets d'une règle dans son ordre, ceux non classés à la suite. */
  function ordered(rule: Rule) {
    const rank = (id: string) => { const i = rule.tabOrder.indexOf(id); return i === -1 ? 999 : i; };
    return [...TABS].sort((a, b) => rank(a.id) - rank(b.id));
  }

  function move(rule: Rule, id: string, delta: -1 | 1) {
    const ids = ordered(rule).map((t) => t.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    rule.tabOrder = ids;
  }

  function toggle(rule: Rule, id: string) {
    rule.hiddenTabs = rule.hiddenTabs.includes(id) ? rule.hiddenTabs.filter((t) => t !== id) : [...rule.hiddenTabs, id];
  }

  async function load() {
    const res = await dashboardFetch('/member-case-layout');
    if (!res.ok) return;
    const data = await res.json();
    rules = (data.rules ?? []).map((r: Rule) => ({ name: r.name, roleIds: [...r.roleIds], tabOrder: [...r.tabOrder], hiddenTabs: [...r.hiddenTabs] }));
  }

  async function save() {
    saving = true;
    try {
      const res = await dashboardFetch('/member-case-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Erreur');
      toast.success(m.toast_layout_saved());
      open = false;
      onSaved();
    } catch (err: any) {
      toast.error(err?.message || m.toast_save_error());
    } finally {
      saving = false;
    }
  }

  $effect(() => { if (open) load(); });
</script>

<Modal bind:open title="Disposition de la fiche membre" subtitle="La première règle dont un rôle correspond au staff s'applique. Sans règle, la fiche reste complète." size="lg" aboveCase>
  <div class="space-y-6">
    {#each rules as rule, ri (ri)}
      <section class="space-y-3 rounded-lg border border-outline-variant p-4">
        <div class="flex items-center gap-2">
          <input class="input flex-1" aria-label={m.a11y_rule_name()} bind:value={rule.name} maxlength="60" />
          <Button variant="ghost" onclick={() => (rules = rules.filter((_, i) => i !== ri))}>Supprimer</Button>
        </div>
        <div>
          <p class="mb-1 text-xs text-on-surface-variant">Rôles concernés</p>
          <MultiSelect bind:values={rule.roleIds} options={roleOptions} placeholder="Rechercher un rôle…" />
        </div>
        <ul class="space-y-1">
          {#each ordered(rule) as tab (tab.id)}
            <li class="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!rule.hiddenTabs.includes(tab.id)} disabled={tab.id === 'resume'} onchange={() => toggle(rule, tab.id)} aria-label={`Afficher ${tab.label}`} />
              <span class="flex-1">{tab.label}</span>
              <button type="button" class="px-2" aria-label={`Monter ${tab.label}`} onclick={() => move(rule, tab.id, -1)}>↑</button>
              <button type="button" class="px-2" aria-label={`Descendre ${tab.label}`} onclick={() => move(rule, tab.id, 1)}>↓</button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    <Button variant="secondary" onclick={() => (rules = [...rules, { name: `Règle ${rules.length + 1}`, roleIds: [], tabOrder: [], hiddenTabs: [] }])}>Ajouter une règle</Button>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Annuler</Button>
    <Button variant="primary" loading={saving} onclick={save}>Enregistrer</Button>
  {/snippet}
</Modal>
