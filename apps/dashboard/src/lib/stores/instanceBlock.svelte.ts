import type { InstanceBlock } from '../instanceBlock';

/** Dernier blocage d'instance signalé par l'API (voir `instanceBlock.ts`). */
class InstanceBlockStore {
  current = $state<InstanceBlock | null>(null);

  report(block: InstanceBlock) {
    this.current = block;
  }
}

export const instanceBlock = new InstanceBlockStore();
