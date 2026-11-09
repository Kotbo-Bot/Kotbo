type Entry = {
  callback: () => void;
  remaining: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | null;
};

/**
 * Minuteries par identifiant qu'on peut suspendre : une bulle survolee ou
 * atteinte au clavier ne doit pas disparaitre pendant qu'on la lit (RGAA 13.1).
 */
export class PausableTimers {
  private entries = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  start(id: string, duration: number, callback: () => void): void {
    this.clear(id);
    if (duration <= 0) return;
    const entry: Entry = { callback, remaining: duration, startedAt: 0, handle: null };
    this.entries.set(id, entry);
    this.run(id, entry);
  }

  pause(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.handle) return;
    clearTimeout(entry.handle);
    entry.handle = null;
    entry.remaining = Math.max(0, entry.remaining - (this.now() - entry.startedAt));
  }

  resume(id: string): void {
    const entry = this.entries.get(id);
    if (entry && !entry.handle) this.run(id, entry);
  }

  remaining(id: string): number | undefined {
    return this.entries.get(id)?.remaining;
  }

  clear(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.handle) clearTimeout(entry.handle);
    this.entries.delete(id);
  }

  private run(id: string, entry: Entry): void {
    entry.startedAt = this.now();
    entry.handle = setTimeout(() => {
      this.entries.delete(id);
      entry.callback();
    }, entry.remaining);
  }
}
