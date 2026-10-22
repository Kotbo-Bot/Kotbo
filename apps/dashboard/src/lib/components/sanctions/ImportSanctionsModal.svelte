<script lang="ts">
  import Modal from '../Modal.svelte';
  import Papicon from '../Papicon.svelte';
  import FormSelect from '../FormSelect.svelte';
  import FormInput from '../FormInput.svelte';
  import ActionButton from '../ActionButton.svelte';
  import { importSanctions, type SanctionImportRow } from '../../api';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { m } from '../../i18n';
  import {
    guessColumnMapping,
    normalizeImportRow,
    parseSanctionImportFile,
    SANCTION_IMPORT_FIELDS,
    type ColumnMapping,
    type NormalizedImportRow,
    type ParsedImportRow,
    type SanctionImportField
  } from '../../sanctions/importParser';

  let { open = $bindable(false) } = $props<{ open?: boolean }>();

  const FIELD_LABELS: Record<SanctionImportField, () => string> = {
    type: m.sc_import_row_type,
    targetUserId: m.sc_import_row_target,
    targetTag: m.sc_import_row_target,
    moderatorUserId: m.sc_import_row_moderator,
    moderatorTag: m.sc_import_row_moderator,
    reason: m.sc_import_row_reason,
    createdAt: m.sc_import_row_date,
    durationSeconds: m.sc_import_row_duration
  };

  const PREVIEW_LIMIT = 20;

  let fileName = $state('');
  let headers = $state<string[]>([]);
  let rawRows = $state<ParsedImportRow[]>([]);
  let mapping = $state<ColumnMapping>({});
  let sourceLabel = $state('');
  let parseError = $state<string | null>(null);
  let parsing = $state(false);
  let importing = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const normalizedRows = $derived(rawRows.map((row) => normalizeImportRow(row, mapping)));
  const validRows = $derived(normalizedRows.filter((row): row is NormalizedImportRow & { type: string; targetUserId: string; createdAt: string } =>
    row.errors.length === 0));
  const invalidCount = $derived(normalizedRows.length - validRows.length);

  function reset() {
    fileName = '';
    headers = [];
    rawRows = [];
    mapping = {};
    sourceLabel = '';
    parseError = null;
    parsing = false;
    importing = false;
    if (fileInput) fileInput.value = '';
  }

  function closeModal() {
    open = false;
    reset();
  }

  async function onFileSelected(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    parseError = null;
    parsing = true;
    fileName = file.name;

    try {
      const { headers: parsedHeaders, rows } = await parseSanctionImportFile(file);
      headers = parsedHeaders;
      rawRows = rows;
      mapping = guessColumnMapping(parsedHeaders);
    } catch (err) {
      parseError = m.sc_import_parse_error({ error: err instanceof Error ? err.message : String(err) });
      headers = [];
      rawRows = [];
    } finally {
      parsing = false;
    }
  }

  function updateMapping(field: SanctionImportField, header: string) {
    mapping = { ...mapping, [field]: header || undefined };
  }

  async function submitImport() {
    if (validRows.length === 0) return;

    importing = true;
    try {
      const payload: SanctionImportRow[] = validRows.map((row) => ({
        type: row.type!,
        targetUserId: row.targetUserId!,
        targetTag: row.targetTag,
        moderatorUserId: row.moderatorUserId,
        moderatorTag: row.moderatorTag,
        reason: row.reason || 'Sanction importée (raison non renseignée).',
        createdAt: row.createdAt!,
        durationSeconds: row.durationSeconds
      }));

      const result = await importSanctions(payload, sourceLabel.trim() || undefined);
      toast.success(m.sc_import_result_summary({
        imported: result.imported,
        skipped: result.skippedDuplicates,
        errors: result.errors.length
      }));
      await dashboardStore.refresh();
      closeModal();
    } catch (err) {
      console.error('Sanction import error', err);
    } finally {
      importing = false;
    }
  }
</script>

<Modal bind:open onClose={closeModal} title={m.sc_import_title()} subtitle={m.sc_import_subtitle()} size="xl">
  <div class="space-y-6">
    <div class="space-y-2">
      <p class="field-label">{m.sc_import_step_file()}</p>
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="file"
          bind:this={fileInput}
          onchange={onFileSelected}
          accept=".json,.csv,.xlsx,.xls"
          style="display: none;"
        />
        <button
          type="button"
          onclick={() => fileInput?.click()}
          class="flex items-center gap-2 rounded-lg border-2 border-dashed border-outline-variant/30 px-5 py-3 text-xs font-semibold text-on-surface-variant hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all"
        >
          <Papicon icon="upload" size={16} />
          {fileName || m.sc_import_file_hint()}
        </button>
        {#if parsing}
          <div class="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full"></div>
        {/if}
      </div>

      <div class="max-w-xs">
        <label for="import-source" class="field-label">{m.sc_import_source_label()}</label>
        <FormInput id="import-source" type="text" bind:value={sourceLabel} placeholder={m.sc_import_source_ph()} className="mt-1 w-full rounded-lg px-3 py-2.5 bg-surface-container-high border border-outline-variant/10 text-sm" />
      </div>

      {#if parseError}
        <div class="rounded-lg bg-error/10 text-error text-xs font-medium p-3">{parseError}</div>
      {/if}
    </div>

    {#if headers.length > 0}
      <div class="space-y-3">
        <div>
          <p class="field-label">{m.sc_import_step_mapping()}</p>
          <p class="text-xs text-on-surface-variant">{m.sc_import_mapping_hint()}</p>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {#each SANCTION_IMPORT_FIELDS as field (field)}
            <div class="space-y-1">
              <label for="mapping-{field}" class="text-xs font-semibold text-on-surface-variant">{FIELD_LABELS[field]()}</label>
              <FormSelect
                id="mapping-{field}"
                value={mapping[field] ?? ''}
                onchange={(e) => updateMapping(field, (e.currentTarget as HTMLSelectElement).value)}
                className="w-full rounded-lg px-3 py-2 bg-surface-container-high border border-outline-variant/10 text-xs font-medium"
              >
                <option value="">{m.sc_import_col_none()}</option>
                {#each headers as header (header)}
                  <option value={header}>{header}</option>
                {/each}
              </FormSelect>
            </div>
          {/each}
        </div>
      </div>

      <div class="space-y-3">
        <div>
          <p class="field-label">{m.sc_import_step_preview()}</p>
          <p class="text-xs text-on-surface-variant">
            {m.sc_import_preview_hint({ valid: validRows.length, invalid: invalidCount })}
          </p>
        </div>

        {#if validRows.length === 0}
          <div class="rounded-lg bg-warning/10 text-warning text-xs font-medium p-4">
            {m.sc_import_no_valid_rows()}
          </div>
        {:else}
          <div class="overflow-x-auto rounded-lg border border-outline-variant/10">
            <table class="w-full text-xs">
              <thead class="bg-surface-container-high">
                <tr>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_type()}</th>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_target()}</th>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_moderator()}</th>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_reason()}</th>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_date()}</th>
                  <th class="px-3 py-2 text-left font-semibold text-on-surface-variant">{m.sc_import_row_duration()}</th>
                </tr>
              </thead>
              <tbody>
                {#each validRows.slice(0, PREVIEW_LIMIT) as row, index (index)}
                  <tr class="border-t border-outline-variant/5">
                    <td class="px-3 py-2 font-bold text-on-surface">{row.type}</td>
                    <td class="px-3 py-2 text-on-surface-variant">{row.targetTag || row.targetUserId}</td>
                    <td class="px-3 py-2 text-on-surface-variant">{row.moderatorTag || row.moderatorUserId || '-'}</td>
                    <td class="px-3 py-2 text-on-surface-variant max-w-[200px] truncate">{row.reason || '-'}</td>
                    <td class="px-3 py-2 text-on-surface-variant">{new Date(row.createdAt!).toLocaleString('fr-FR')}</td>
                    <td class="px-3 py-2 text-on-surface-variant">{row.durationSeconds ? `${row.durationSeconds}s` : '-'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if validRows.length > PREVIEW_LIMIT}
            <p class="text-2xs text-on-surface-variant">{m.sc_import_more_rows({ count: validRows.length - PREVIEW_LIMIT })}</p>
          {/if}
        {/if}

        {#if invalidCount > 0}
          <details class="text-xs text-on-surface-variant">
            <summary class="cursor-pointer font-semibold">{m.sc_import_row_errors()} ({invalidCount})</summary>
            <ul class="mt-2 space-y-1 list-disc list-inside">
              {#each normalizedRows.filter((r) => r.errors.length > 0).slice(0, PREVIEW_LIMIT) as row, index (index)}
                <li>{row.errors.join(' ')}</li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>

      <div class="flex justify-end pt-2">
        <ActionButton
          onClick={submitImport}
          variant="primary"
          disabled={validRows.length === 0 || importing}
          label={importing ? m.sc_import_importing() : m.sc_import_submit({ count: validRows.length })}
        />
      </div>
    {/if}
  </div>
</Modal>
