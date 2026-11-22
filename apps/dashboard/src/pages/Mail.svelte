<script lang="ts">
  /**
   * Boîte mail BYOP (Bring Your Own Provider) : réception et envoi d'emails
   * via AWS SES, Resend ou SMTP/IMAP connecté par le serveur.
   */
  import { onMount } from 'svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import {
    Button,
    Callout,
    EmptyState,
    Field,
    FilterPills,
    Modal,
    SectionCard,
    ToggleSwitch,
    type FilterOption,
  } from '../lib/components/ui';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { dateLocale } from '../lib/i18n';
  import {
    buildInboundWebhookUrl,
    createMailAccount,
    deleteMailAccount,
    fetchMailAccounts,
    fetchMailThread,
    fetchMailThreads,
    revealMailWebhookSecret,
    rotateMailWebhookSecret,
    sendMail,
    updateMailAccount,
    updateMailThreadStatus,
    verifyMailAccount,
    type MailAccount,
    type MailCredentialsPayload,
    type MailProvider,
    type MailThread,
    type MailThreadDetail,
    type MailThreadStatus,
  } from '../lib/api';

  const PROVIDER_LABEL: Record<MailProvider, string> = {
    AWS_SES: 'AWS SES',
    RESEND: 'Resend',
    SMTP_IMAP: 'SMTP / IMAP',
  };

  const STATUS_BADGE: Record<MailAccount['status'], { label: string; cls: string }> = {
    VERIFIED: { label: 'Vérifié', cls: 'bg-success/10 text-on-success-container' },
    PENDING: { label: 'En attente', cls: 'bg-warning/10 text-on-warning-container' },
    ERROR: { label: 'Erreur', cls: 'bg-error/10 text-on-error-container' },
  };

  const THREAD_FILTERS: FilterOption<'' | MailThreadStatus>[] = [
    { value: '', label: 'Tous' },
    { value: 'OPEN', label: 'Ouverts' },
    { value: 'CLOSED', label: 'Fermés' },
    { value: 'ARCHIVED', label: 'Archivés' },
  ];

  let accounts = $state<MailAccount[]>([]);
  let threads = $state<MailThread[]>([]);
  let selectedThread = $state<MailThreadDetail | null>(null);

  let loadingAccounts = $state(true);
  let loadingThreads = $state(true);
  let loadingThreadDetail = $state(false);

  let filterAccountId = $state('');
  let filterStatus = $state<'' | MailThreadStatus>('OPEN');
  let searchQuery = $state('');

  // Éditeur de réponse
  let replyText = $state('');
  let sendingReply = $state(false);

  // Modale de configuration des fournisseurs
  let configModalOpen = $state(false);
  let addingProvider = $state(false);
  let newProvider = $state<MailProvider>('RESEND');
  let newFromEmail = $state('');
  let newDisplayName = $state('');
  // AWS SES
  let awsRegion = $state('eu-west-1');
  let awsAccessKeyId = $state('');
  let awsSecretAccessKey = $state('');
  // Resend
  let resendApiKey = $state('');
  let resendWebhookSecret = $state('');
  // SMTP
  let smtpHost = $state('');
  let smtpPort = $state(587);
  let smtpSecure = $state(false);
  let smtpUser = $state('');
  let smtpPass = $state('');
  let savingAccount = $state(false);
  let testingAccountId = $state<string | null>(null);

  // Secret webhook révélé par compte
  let revealedSecrets = $state<Record<string, string>>({});

  // Modale nouveau message
  let composeModalOpen = $state(false);
  let composeAccountId = $state('');
  let composeTo = $state('');
  let composeCc = $state('');
  let composeSubject = $state('');
  let composeText = $state('');
  let sendingCompose = $state(false);

  async function loadAccounts() {
    loadingAccounts = true;
    try {
      const res = await fetchMailAccounts();
      accounts = res.accounts;
      if (!composeAccountId && accounts.length > 0) {
        composeAccountId = accounts[0].id;
      }
    } catch {
      toast.error('Impossible de charger les comptes mail.');
    } finally {
      loadingAccounts = false;
    }
  }

  async function loadThreads() {
    loadingThreads = true;
    try {
      const res = await fetchMailThreads({
        accountId: filterAccountId || undefined,
        status: filterStatus || undefined,
        search: searchQuery || undefined,
      });
      threads = res.threads;
      if (selectedThread && !threads.some((t) => t.id === selectedThread?.id)) {
        selectedThread = null;
      }
    } catch {
      toast.error('Impossible de charger les fils de discussion.');
    } finally {
      loadingThreads = false;
    }
  }

  async function openThread(threadId: string) {
    loadingThreadDetail = true;
    try {
      const res = await fetchMailThread(threadId);
      selectedThread = res.thread;
    } catch {
      toast.error('Impossible de charger le fil sélectionné.');
    } finally {
      loadingThreadDetail = false;
    }
  }

  onMount(async () => {
    await Promise.all([loadAccounts(), loadThreads()]);
  });

  function formatDate(value: string): string {
    return new Date(value).toLocaleString(dateLocale(), {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  async function handleSendReply(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedThread || !replyText.trim()) return;
    const account = accounts.find((a) => a.id === selectedThread?.accountId);
    const selfEmail = account?.fromEmail.toLowerCase();
    const recipients = selectedThread.participants.filter((p) => p.toLowerCase() !== selfEmail);
    const to = recipients.length > 0 ? recipients : selectedThread.participants.slice(0, 1);

    if (to.length === 0) {
      toast.error('Aucun destinataire trouvé dans ce fil.');
      return;
    }

    sendingReply = true;
    try {
      const subject = selectedThread.subject.toLowerCase().startsWith('re:')
        ? selectedThread.subject
        : `Re: ${selectedThread.subject}`;
      await sendMail({
        accountId: selectedThread.accountId,
        threadId: selectedThread.id,
        to,
        subject,
        text: replyText.trim(),
      });
      replyText = '';
      toast.success('Réponse envoyée.');
      await Promise.all([openThread(selectedThread.id), loadThreads()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec de l’envoi.');
    } finally {
      sendingReply = false;
    }
  }

  async function handleThreadStatus(status: MailThreadStatus) {
    if (!selectedThread) return;
    try {
      await updateMailThreadStatus(selectedThread.id, status);
      selectedThread = { ...selectedThread, status };
      toast.success('Statut du fil mis à jour.');
      await loadThreads();
    } catch {
      toast.error('Impossible de mettre à jour le statut.');
    }
  }

  function buildCredentialsPayload(): MailCredentialsPayload {
    if (newProvider === 'AWS_SES') {
      return {
        provider: 'AWS_SES',
        region: awsRegion.trim(),
        accessKeyId: awsAccessKeyId.trim(),
        secretAccessKey: awsSecretAccessKey.trim(),
      };
    }
    if (newProvider === 'RESEND') {
      return {
        provider: 'RESEND',
        apiKey: resendApiKey.trim(),
        ...(resendWebhookSecret.trim() ? { webhookSigningSecret: resendWebhookSecret.trim() } : {}),
      };
    }
    return {
      provider: 'SMTP_IMAP',
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort),
      smtpSecure,
      smtpUser: smtpUser.trim(),
      smtpPass,
    };
  }

  function resetAddForm() {
    newFromEmail = '';
    newDisplayName = '';
    awsAccessKeyId = '';
    awsSecretAccessKey = '';
    resendApiKey = '';
    resendWebhookSecret = '';
    smtpHost = '';
    smtpPort = 587;
    smtpSecure = false;
    smtpUser = '';
    smtpPass = '';
    addingProvider = false;
  }

  async function handleCreateAccount(event: SubmitEvent) {
    event.preventDefault();
    savingAccount = true;
    try {
      const res = await createMailAccount({
        provider: newProvider,
        fromEmail: newFromEmail.trim(),
        displayName: newDisplayName.trim() || null,
        credentials: buildCredentialsPayload(),
      });
      if (res.webhookSecret) {
        revealedSecrets = { ...revealedSecrets, [res.account.id]: res.webhookSecret };
      }
      toast.success('Compte mail ajouté. Lancez un test de connexion pour le vérifier.');
      resetAddForm();
      await loadAccounts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible d’ajouter le compte.');
    } finally {
      savingAccount = false;
    }
  }

  async function handleVerifyAccount(accountId: string) {
    testingAccountId = accountId;
    try {
      const res = await verifyMailAccount(accountId);
      accounts = accounts.map((a) => (a.id === accountId ? res.account : a));
      if (res.result.ok) {
        toast.success('Connexion au fournisseur vérifiée.');
      } else {
        toast.error(res.result.error || 'Vérification échouée.');
      }
    } catch {
      toast.error('Erreur lors de la vérification.');
    } finally {
      testingAccountId = null;
    }
  }

  async function handleToggleAccount(account: MailAccount) {
    try {
      const res = await updateMailAccount(account.id, { enabled: !account.enabled });
      accounts = accounts.map((a) => (a.id === account.id ? res.account : a));
    } catch {
      toast.error('Impossible de modifier le compte.');
    }
  }

  async function handleDeleteAccount(account: MailAccount) {
    const ok = await confirmDialog.ask({
      title: 'Supprimer ce compte mail ?',
      message: `Les identifiants chiffrés et les fils associés à ${account.fromEmail} seront supprimés.`,
      confirmText: 'Supprimer',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await deleteMailAccount(account.id);
      toast.success('Compte supprimé.');
      await Promise.all([loadAccounts(), loadThreads()]);
    } catch {
      toast.error('Impossible de supprimer ce compte.');
    }
  }

  async function handleRevealWebhook(accountId: string) {
    try {
      const res = await revealMailWebhookSecret(accountId);
      revealedSecrets = { ...revealedSecrets, [accountId]: res.secret };
    } catch {
      toast.error('Impossible de récupérer le secret webhook.');
    }
  }

  async function handleRotateWebhook(accountId: string) {
    try {
      const res = await rotateMailWebhookSecret(accountId);
      revealedSecrets = { ...revealedSecrets, [accountId]: res.secret };
      toast.success('Secret webhook régénéré.');
    } catch {
      toast.error('Impossible de régénérer le secret.');
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copié dans le presse-papiers.');
    } catch {
      toast.error('Copie impossible.');
    }
  }

  async function handleComposeSubmit(event: SubmitEvent) {
    event.preventDefault();
    const to = composeTo.split(',').map((s) => s.trim()).filter(Boolean);
    const cc = composeCc.split(',').map((s) => s.trim()).filter(Boolean);
    if (!composeAccountId || to.length === 0 || !composeSubject.trim() || !composeText.trim()) {
      toast.error('Complétez le compte, les destinataires, l’objet et le message.');
      return;
    }

    sendingCompose = true;
    try {
      const res = await sendMail({
        accountId: composeAccountId,
        to,
        ...(cc.length ? { cc } : {}),
        subject: composeSubject.trim(),
        text: composeText.trim(),
      });
      composeModalOpen = false;
      composeTo = '';
      composeCc = '';
      composeSubject = '';
      composeText = '';
      toast.success('Email envoyé.');
      await loadThreads();
      await openThread(res.thread.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec de l’envoi.');
    } finally {
      sendingCompose = false;
    }
  }
</script>

<ModulePage
  title="Mail (BYOP)"
  description="Connectez vos propres fournisseurs (AWS SES, Resend, SMTP) pour envoyer et recevoir des emails depuis Kotbo."
  icon="mail"
  featureKey="settings"
>
  {#snippet actions()}
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="secondary" icon="settings" onclick={() => (configModalOpen = true)}>
        Fournisseurs ({accounts.length})
      </Button>
      <Button
        variant="primary"
        icon="send"
        disabled={accounts.length === 0}
        disabledReason="Connectez d’abord un fournisseur mail"
        onclick={() => (composeModalOpen = true)}
      >
        Nouveau message
      </Button>
    </div>
  {/snippet}

  {#if !loadingAccounts && accounts.length === 0}
    <SectionCard>
      <EmptyState
        icon="mail"
        title="Aucun fournisseur mail connecté"
        description="Ajoutez vos identifiants AWS SES, Resend ou SMTP pour activer la boîte de réception sans hébergement tiers."
      >
        <Button variant="primary" icon="plus" onclick={() => { configModalOpen = true; addingProvider = true; }}>
          Connecter un fournisseur
        </Button>
      </EmptyState>
    </SectionCard>
  {:else}
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <!-- Colonne gauche : liste des fils -->
      <div class="lg:col-span-5 xl:col-span-4 flex flex-col gap-3">
        <SectionCard class="flex flex-col gap-3">
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <input
                type="search"
                class="input w-full"
                placeholder="Rechercher un sujet ou extrait…"
                bind:value={searchQuery}
                onkeydown={(e) => e.key === 'Enter' && loadThreads()}
              />
              <Button variant="secondary" size="sm" icon="refresh-cw" aria-label="Actualiser" onclick={loadThreads} />
            </div>

            {#if accounts.length > 1}
              <select
                class="input w-full"
                bind:value={filterAccountId}
                onchange={() => loadThreads()}
              >
                <option value="">Toutes les adresses</option>
                {#each accounts as acc (acc.id)}
                  <option value={acc.id}>{acc.fromEmail} ({PROVIDER_LABEL[acc.provider]})</option>
                {/each}
              </select>
            {/if}

            <FilterPills
              options={THREAD_FILTERS}
              bind:value={filterStatus}
              onchange={() => loadThreads()}
            />
          </div>

          <div class="divide-y divide-edge max-h-[60vh] overflow-y-auto -mx-4 px-4">
            {#if loadingThreads}
              <div class="space-y-3 py-2">
                <Skeleton class="h-14 w-full" />
                <Skeleton class="h-14 w-full" />
                <Skeleton class="h-14 w-full" />
              </div>
            {:else if threads.length === 0}
              <p class="py-8 text-center text-sm text-fg-muted">
                Aucun fil de discussion pour ces critères.
              </p>
            {:else}
              {#each threads as thread (thread.id)}
                <button
                  type="button"
                  class="w-full text-left py-3 px-2 rounded-lg transition-colors hover:bg-surface-2 {selectedThread?.id === thread.id ? 'bg-surface-2 ring-1 ring-accent/40' : ''}"
                  onclick={() => openThread(thread.id)}
                >
                  <div class="flex items-start justify-between gap-2">
                    <span class="font-medium text-sm text-fg line-clamp-1">{thread.subject}</span>
                    <span class="shrink-0 text-[11px] text-fg-muted">{formatDate(thread.lastMessageAt)}</span>
                  </div>
                  <p class="mt-0.5 text-xs text-fg-muted line-clamp-1">
                    {thread.participants.join(', ')}
                  </p>
                  {#if thread.lastMessageSnippet}
                    <p class="mt-1 text-xs text-fg-muted/80 line-clamp-2">{thread.lastMessageSnippet}</p>
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        </SectionCard>
      </div>

      <!-- Colonne droite : lecture du fil + réponse -->
      <div class="lg:col-span-7 xl:col-span-8">
        <SectionCard class="flex flex-col gap-4 min-h-[62vh]">
          {#if loadingThreadDetail}
            <div class="space-y-3">
              <Skeleton class="h-8 w-2/3" />
              <Skeleton class="h-32 w-full" />
              <Skeleton class="h-32 w-full" />
            </div>
          {:else if !selectedThread}
            <EmptyState
              icon="mail"
              title="Sélectionnez un fil de discussion"
              description="Choisissez une conversation à gauche pour lire les messages et y répondre."
            />
          {:else}
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-edge pb-3">
              <div>
                <h2 class="text-base font-semibold text-fg">{selectedThread.subject}</h2>
                <p class="text-xs text-fg-muted mt-0.5">
                  Via {selectedThread.account?.fromEmail ?? 'compte'} · {selectedThread.participants.join(', ')}
                </p>
              </div>
              <div class="flex items-center gap-1.5">
                {#each (['OPEN', 'CLOSED', 'ARCHIVED'] as const) as st (st)}
                  <Button
                    size="sm"
                    variant={selectedThread.status === st ? 'primary' : 'ghost'}
                    onclick={() => handleThreadStatus(st)}
                  >
                    {st === 'OPEN' ? 'Ouvert' : st === 'CLOSED' ? 'Fermé' : 'Archivé'}
                  </Button>
                {/each}
              </div>
            </div>

            <div class="flex-1 space-y-3 overflow-y-auto max-h-[45vh] pr-1">
              {#each selectedThread.messages as msg (msg.id)}
                <div
                  class="rounded-xl border border-edge p-3.5 {msg.direction === 'OUTBOUND' ? 'bg-surface-2/70 ml-4' : 'bg-surface-1 mr-4'}"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-fg">
                        {msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail}
                      </span>
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] font-medium {msg.direction === 'OUTBOUND' ? 'bg-accent/15 text-accent' : 'bg-surface-3 text-fg-muted'}"
                      >
                        {msg.direction === 'OUTBOUND' ? 'Envoyé' : 'Reçu'}
                      </span>
                    </div>
                    <span class="text-fg-muted">{formatDate(msg.receivedAt)}</span>
                  </div>

                  {#if msg.textBody}
                    <pre class="mt-2 whitespace-pre-wrap font-sans text-sm text-fg leading-relaxed">{msg.textBody}</pre>
                  {:else if msg.htmlBody}
                    <iframe
                      title="Aperçu HTML du message"
                      sandbox=""
                      srcdoc={msg.htmlBody}
                      class="mt-2 w-full min-h-[180px] rounded-lg border border-edge bg-white"
                    ></iframe>
                  {/if}

                  {#if msg.attachments && msg.attachments.length > 0}
                    <div class="mt-2 flex flex-wrap gap-1.5 pt-2 border-t border-edge/60">
                      {#each msg.attachments as att (att.filename)}
                        <span class="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-muted">
                          <Papicon icon="paperclip" size={12} />
                          {att.filename}
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>

            <form class="border-t border-edge pt-3 flex flex-col gap-2" onsubmit={handleSendReply}>
              <textarea
                class="input w-full min-h-[96px]"
                placeholder="Écrire une réponse…"
                bind:value={replyText}
              ></textarea>
              <div class="flex justify-end">
                <Button type="submit" variant="primary" icon="send" loading={sendingReply} disabled={!replyText.trim()}>
                  Envoyer la réponse
                </Button>
              </div>
            </form>
          {/if}
        </SectionCard>
      </div>
    </div>
  {/if}
</ModulePage>

<!-- Modale configuration des fournisseurs & webhooks -->
<Modal bind:open={configModalOpen} title="Fournisseurs Mail (BYOP)" size="lg">
  <div class="space-y-4">
    <Callout variant="info">
      Vos clés API et mots de passe SMTP sont chiffrés en AES-256-GCM avant stockage. Kotbo n’héberge aucun serveur mail.
    </Callout>

    {#if accounts.length > 0}
      <div class="space-y-3">
        {#each accounts as acc (acc.id)}
          {@const badge = STATUS_BADGE[acc.status]}
          {@const secret = revealedSecrets[acc.id]}
          <div class="rounded-xl border border-edge bg-surface-1 p-3.5 space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm text-fg">{acc.fromEmail}</span>
                  <span class="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg-muted">{PROVIDER_LABEL[acc.provider]}</span>
                  <span class="rounded-full px-2 py-0.5 text-xs font-medium {badge.cls}">{badge.label}</span>
                </div>
                {#if acc.lastError}
                  <p class="text-xs text-on-error-container mt-1">{acc.lastError}</p>
                {/if}
              </div>

              <div class="flex items-center gap-2">
                <ToggleSwitch checked={acc.enabled} onchange={() => handleToggleAccount(acc)} />
                <Button
                  size="sm"
                  variant="secondary"
                  loading={testingAccountId === acc.id}
                  onclick={() => handleVerifyAccount(acc.id)}
                >
                  Tester
                </Button>
                <Button size="sm" variant="ghost" onclick={() => handleRevealWebhook(acc.id)}>
                  Webhook
                </Button>
                <Button size="sm" variant="danger" icon="trash" aria-label="Supprimer" onclick={() => handleDeleteAccount(acc)} />
              </div>
            </div>

            {#if secret}
              <div class="rounded-lg bg-surface-2 p-2.5 text-xs space-y-1.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium text-fg">URL de webhook entrant (copier dans {PROVIDER_LABEL[acc.provider]})</span>
                  <div class="flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" onclick={() => copyText(buildInboundWebhookUrl(acc.id, secret))}>
                      Copier
                    </Button>
                    <Button size="sm" variant="ghost" onclick={() => handleRotateWebhook(acc.id)}>
                      Régénérer
                    </Button>
                  </div>
                </div>
                <code class="block break-all text-[11px] text-fg-muted">
                  {buildInboundWebhookUrl(acc.id, secret)}
                </code>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if !addingProvider}
      <Button variant="primary" icon="plus" onclick={() => (addingProvider = true)}>
        Ajouter un fournisseur
      </Button>
    {:else}
      <form class="rounded-xl border border-edge bg-surface-1 p-4 space-y-3" onsubmit={handleCreateAccount}>
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-fg">Nouveau fournisseur</h3>
          <Button size="sm" variant="ghost" onclick={resetAddForm}>Annuler</Button>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Fournisseur" required>
            {#snippet children(id)}
              <select {id} class="input w-full" bind:value={newProvider}>
                <option value="RESEND">Resend</option>
                <option value="AWS_SES">AWS SES</option>
                <option value="SMTP_IMAP">SMTP / IMAP</option>
              </select>
            {/snippet}
          </Field>

          <Field label="Adresse d’envoi" required>
            {#snippet children(id)}
              <input {id} type="email" class="input w-full" placeholder="support@domaine.fr" bind:value={newFromEmail} required />
            {/snippet}
          </Field>
        </div>

        <Field label="Nom d’affichage">
          {#snippet children(id)}
            <input {id} type="text" class="input w-full" placeholder="Support Kotbo" bind:value={newDisplayName} />
          {/snippet}
        </Field>

        {#if newProvider === 'AWS_SES'}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Région AWS" required>
              {#snippet children(id)}
                <input {id} type="text" class="input w-full" bind:value={awsRegion} required />
              {/snippet}
            </Field>
            <Field label="Access Key ID" required>
              {#snippet children(id)}
                <input {id} type="text" class="input w-full" bind:value={awsAccessKeyId} required />
              {/snippet}
            </Field>
            <Field label="Secret Access Key" required>
              {#snippet children(id)}
                <input {id} type="password" class="input w-full" bind:value={awsSecretAccessKey} required />
              {/snippet}
            </Field>
          </div>
        {:else if newProvider === 'RESEND'}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Clé API Resend" required>
              {#snippet children(id)}
                <input {id} type="password" class="input w-full" placeholder="re_..." bind:value={resendApiKey} required />
              {/snippet}
            </Field>
            <Field label="Secret Svix entrant (optionnel)">
              {#snippet children(id)}
                <input {id} type="password" class="input w-full" placeholder="whsec_..." bind:value={resendWebhookSecret} />
              {/snippet}
            </Field>
          </div>
        {:else}
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Hôte SMTP" required>
              {#snippet children(id)}
                <input {id} type="text" class="input w-full" placeholder="smtp.exemple.fr" bind:value={smtpHost} required />
              {/snippet}
            </Field>
            <Field label="Port SMTP" required>
              {#snippet children(id)}
                <input {id} type="number" class="input w-full" bind:value={smtpPort} required />
              {/snippet}
            </Field>
            <Field label="Utilisateur SMTP" required>
              {#snippet children(id)}
                <input {id} type="text" class="input w-full" bind:value={smtpUser} required />
              {/snippet}
            </Field>
            <Field label="Mot de passe SMTP" required>
              {#snippet children(id)}
                <input {id} type="password" class="input w-full" bind:value={smtpPass} required />
              {/snippet}
            </Field>
          </div>
          <label class="inline-flex items-center gap-2 text-xs text-fg-muted">
            <input type="checkbox" bind:checked={smtpSecure} />
            Connexion TLS implicite (port 465)
          </label>
        {/if}

        <div class="flex justify-end">
          <Button type="submit" variant="primary" loading={savingAccount}>Enregistrer le fournisseur</Button>
        </div>
      </form>
    {/if}
  </div>
</Modal>

<!-- Modale nouveau message -->
<Modal bind:open={composeModalOpen} title="Nouveau message" size="lg">
  <form class="space-y-3" onsubmit={handleComposeSubmit}>
    <Field label="Compte d’envoi" required>
      {#snippet children(id)}
        <select {id} class="input w-full" bind:value={composeAccountId}>
          {#each accounts as acc (acc.id)}
            <option value={acc.id}>{acc.fromEmail} ({PROVIDER_LABEL[acc.provider]})</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Destinataires (séparés par virgule)" required>
        {#snippet children(id)}
          <input {id} type="text" class="input w-full" placeholder="alice@exemple.fr" bind:value={composeTo} required />
        {/snippet}
      </Field>
      <Field label="Cc (optionnel)">
        {#snippet children(id)}
          <input {id} type="text" class="input w-full" placeholder="copie@exemple.fr" bind:value={composeCc} />
        {/snippet}
      </Field>
    </div>

    <Field label="Objet" required>
      {#snippet children(id)}
        <input {id} type="text" class="input w-full" bind:value={composeSubject} required />
      {/snippet}
    </Field>

    <Field label="Message" required>
      {#snippet children(id)}
        <textarea {id} class="input w-full min-h-[140px]" bind:value={composeText} required></textarea>
      {/snippet}
    </Field>

    <div class="flex justify-end gap-2 pt-2">
      <Button variant="ghost" onclick={() => (composeModalOpen = false)}>Annuler</Button>
      <Button type="submit" variant="primary" icon="send" loading={sendingCompose}>Envoyer</Button>
    </div>
  </form>
</Modal>
