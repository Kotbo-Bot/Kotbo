<!--
  Un nœud de l'arbre de conditions Auto-Thread : une condition, ou un groupe
  « toutes / au moins une » qui en contient d'autres. Le nœud est modifié en
  place ; le parent le retire via `onremove`.
-->
<script lang="ts">
  import Self from './AutoThreadConditionEditor.svelte';
  import MultiSelect from '../MultiSelect.svelte';
  import Papicon from '../Papicon.svelte';
  import ToggleSwitch from '../ToggleSwitch.svelte';
  import { Button } from '../ui';
  import { m } from '../../i18n';
  import {
    AUTO_THREAD_CONDITION_TYPES,
    AUTO_THREAD_CONDITION_VALUE_KIND,
    AUTO_THREAD_LIMITS,
    type AutoThreadCondition,
    type AutoThreadConditionType,
  } from '@kotbo/shared';

  let {
    node,
    depth = 0,
    roleOptions = [],
    onremove = undefined,
  }: {
    node: AutoThreadCondition;
    depth?: number;
    roleOptions?: Array<{ id: string; name: string }>;
    onremove?: () => void;
  } = $props();

  const TYPE_LABEL: Record<AutoThreadConditionType, () => string> = {
    always: () => m.at_cond_always(),
    has_text: () => m.at_cond_has_text(),
    has_link: () => m.at_cond_has_link(),
    has_media: () => m.at_cond_has_media(),
    has_attachment: () => m.at_cond_has_attachment(),
    contains: () => m.at_cond_contains(),
    starts_with: () => m.at_cond_starts_with(),
    matches_regex: () => m.at_cond_matches_regex(),
    min_length: () => m.at_cond_min_length(),
    max_length: () => m.at_cond_max_length(),
    author_has_role: () => m.at_cond_author_has_role(),
    author_is: () => m.at_cond_author_is(),
    is_bot: () => m.at_cond_is_bot(),
    is_webhook: () => m.at_cond_is_webhook(),
    is_reply: () => m.at_cond_is_reply(),
  };

  const valueKind = $derived(node.kind === 'rule' ? AUTO_THREAD_CONDITION_VALUE_KIND[node.type] : 'none');
  const canNest = $derived(depth < AUTO_THREAD_LIMITS.conditionDepth - 1);

  /** Membres saisis comme identifiants séparés par des virgules ou des espaces. */
  let usersText = $state('');
  $effect(() => {
    if (node.kind === 'rule' && node.type === 'author_is') usersText = (node.ids ?? []).join(', ');
  });

  function setKind(kind: 'rule' | 'group') {
    if (kind === node.kind) return;
    const target = node as unknown as Record<string, unknown>;
    for (const key of ['type', 'value', 'ids', 'op', 'children']) delete target[key];
    if (kind === 'group') {
      Object.assign(target, { kind: 'group', op: 'all', children: [{ kind: 'rule', type: 'has_text' }] });
    } else {
      Object.assign(target, { kind: 'rule', type: 'always' });
    }
  }

  function setType(type: AutoThreadConditionType) {
    if (node.kind !== 'rule') return;
    node.type = type;
    const kind = AUTO_THREAD_CONDITION_VALUE_KIND[type];
    node.value = kind === 'number' ? '10' : kind === 'text' || kind === 'regex' ? '' : undefined;
    node.ids = kind === 'roles' || kind === 'users' ? [] : undefined;
  }

  function commitUsers() {
    if (node.kind !== 'rule') return;
    node.ids = usersText.split(/[\s,;]+/).filter((id) => /^\d{17,20}$/.test(id));
  }

  function addChild(kind: 'rule' | 'group') {
    if (node.kind !== 'group') return;
    node.children.push(kind === 'group'
      ? { kind: 'group', op: 'any', children: [{ kind: 'rule', type: 'has_link' }] }
      : { kind: 'rule', type: 'has_text' });
  }

  function removeChild(index: number) {
    if (node.kind !== 'group') return;
    node.children.splice(index, 1);
  }

  const hint = $derived.by(() => {
    if (node.kind === 'group') {
      return node.op === 'any' ? m.at_cond_group_any_hint() : m.at_cond_group_all_hint();
    }
    if (node.type === 'always') return node.negate ? m.at_cond_always_negated_hint() : m.at_cond_always_hint();
    if (node.type === 'matches_regex') return m.at_cond_regex_hint();
    return '';
  });
</script>

<div class="at-cond {depth > 0 ? 'at-cond--nested' : ''}">
  <div class="at-cond__row">
    <select
      class="input at-cond__select"
      aria-label={m.at_cond_kind_label()}
      value={node.kind}
      onchange={(e) => setKind((e.currentTarget as HTMLSelectElement).value as 'rule' | 'group')}
    >
      <option value="rule">{m.at_cond_kind_rule()}</option>
      {#if canNest || node.kind === 'group'}
        <option value="group">{m.at_cond_kind_group()}</option>
      {/if}
    </select>

    {#if node.kind === 'rule'}
      <select
        class="input at-cond__select"
        aria-label={m.at_cond_type_label()}
        value={node.type}
        onchange={(e) => setType((e.currentTarget as HTMLSelectElement).value as AutoThreadConditionType)}
      >
        {#each AUTO_THREAD_CONDITION_TYPES as type (type)}
          <option value={type}>{TYPE_LABEL[type]()}</option>
        {/each}
      </select>
    {:else}
      <select class="input at-cond__select" aria-label={m.at_cond_op_label()} bind:value={node.op}>
        <option value="all">{m.at_cond_op_all()}</option>
        <option value="any">{m.at_cond_op_any()}</option>
      </select>
    {/if}

    <label class="at-cond__negate">
      <ToggleSwitch size="sm" checked={!!node.negate} onToggle={(v) => (node.negate = v)} ariaLabel={m.at_cond_negate()} />
      <span>{m.at_cond_negate()}</span>
    </label>

    {#if onremove}
      <Button variant="ghost" size="sm" icon="trash-2" aria-label={m.at_cond_remove()} onclick={onremove} />
    {/if}
  </div>

  {#if node.kind === 'rule'}
    {#if valueKind === 'text' || valueKind === 'regex'}
      <input
        class="input mt-2"
        type="text"
        maxlength={AUTO_THREAD_LIMITS.conditionText}
        aria-label={m.at_cond_value_label()}
        placeholder={valueKind === 'regex' ? '^\\[bug\\]' : m.at_cond_text_placeholder()}
        bind:value={node.value}
      />
    {:else if valueKind === 'number'}
      <input
        class="input mt-2 w-32"
        type="number"
        min="0"
        max="4000"
        aria-label={m.at_cond_length_label()}
        bind:value={node.value}
      />
    {:else if valueKind === 'roles'}
      <div class="mt-2">
        <MultiSelect bind:values={node.ids} options={roleOptions} placeholder={m.at_cond_roles_placeholder()} />
      </div>
    {:else if valueKind === 'users'}
      <input
        class="input mt-2"
        type="text"
        aria-label={m.at_cond_users_label()}
        placeholder={m.at_cond_users_placeholder()}
        bind:value={usersText}
        onblur={commitUsers}
      />
    {/if}
  {:else}
    <div class="at-cond__children">
      {#each node.children as child, index (index)}
        <Self node={child} depth={depth + 1} {roleOptions} onremove={() => removeChild(index)} />
      {/each}
      <div class="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" icon="plus" onclick={() => addChild('rule')}>{m.at_cond_add_rule()}</Button>
        {#if canNest}
          <Button variant="ghost" size="sm" icon="plus" onclick={() => addChild('group')}>{m.at_cond_add_group()}</Button>
        {/if}
      </div>
    </div>
  {/if}

  {#if hint}
    <p class="at-cond__hint"><Papicon icon="info" size={12} /> {hint}</p>
  {/if}
</div>

<style>
  .at-cond {
    border: 1px solid var(--color-outline-variant, rgb(255 255 255 / 0.08));
    border-radius: 0.75rem;
    padding: 0.75rem;
    background: var(--color-surface-container-low, transparent);
  }

  .at-cond--nested {
    background: transparent;
  }

  .at-cond__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .at-cond__select {
    width: auto;
    min-width: 9rem;
    flex: 1 1 9rem;
  }

  .at-cond__negate {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
    min-height: 2.75rem;
  }

  .at-cond__children {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--color-outline-variant, rgb(255 255 255 / 0.08));
  }

  .at-cond__hint {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }
</style>
