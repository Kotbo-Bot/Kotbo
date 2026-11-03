/**
 * Message tenu à jour : publié au premier passage, puis modifié.
 *
 * Le bot retient le message publié par chaque étape. Un message supprimé
 * entre-temps, ou un salon changé dans l'éditeur, en fait publier un nouveau :
 * l'étape ne reste jamais bloquée sur un message disparu.
 */
export interface KeptMessage {
  channelId: string;
  messageId: string;
}

export interface KeptMessageDeps {
  load(): Promise<KeptMessage | null>;
  save(ref: KeptMessage): Promise<void>;
  /** `false` quand le message n'existe plus. */
  edit(ref: KeptMessage, text: string): Promise<boolean>;
  /** Publie et rend l'identifiant du message. */
  send(channelId: string, text: string): Promise<string>;
}

export async function keepMessage(channelId: string, text: string, deps: KeptMessageDeps): Promise<KeptMessage> {
  const existing = await deps.load();
  if (existing && existing.channelId === channelId && await deps.edit(existing, text)) return existing;

  const ref = { channelId, messageId: await deps.send(channelId, text) };
  await deps.save(ref);
  return ref;
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Fait passer les tâches d'une même clé l'une après l'autre.
 *
 * Deux exécutions simultanées d'une même étape publieraient sinon chacune un
 * message au premier passage, et l'un d'eux ne serait plus jamais tenu à
 * jour. Un serveur n'est servi que par un seul processus : une file en mémoire
 * suffit.
 */
export async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}
