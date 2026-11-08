import { m } from '../i18n';
import { toast } from './toast.svelte';

export interface HistoryAction {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

class HistoryStore {
  private undoStack = $state<HistoryAction[]>([]);
  private redoStack = $state<HistoryAction[]>([]);

  canUndo = $derived(this.undoStack.length > 0);
  canRedo = $derived(this.redoStack.length > 0);

  push(action: HistoryAction) {
    this.undoStack.push(action);
    this.redoStack = []; // Clear redo stack on new action
  }

  async undo() {
    const action = this.undoStack.pop();
    if (!action) return;
    try {
      await action.undo();
      this.redoStack.push(action);
      toast.info(m.hist_undone({ label: action.label }));
    } catch (e) {
      console.error('History undo error:', e);
      toast.error(m.hist_undo_failed({ label: action.label }));
    }
  }

  async redo() {
    const action = this.redoStack.pop();
    if (!action) return;
    try {
      await action.redo();
      this.undoStack.push(action);
      toast.info(m.hist_redone({ label: action.label }));
    } catch (e) {
      console.error('History redo error:', e);
      toast.error(m.hist_redo_failed({ label: action.label }));
    }
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export const historyStore = new HistoryStore();
