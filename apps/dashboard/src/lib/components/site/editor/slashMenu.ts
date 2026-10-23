/**
 * Menu « / » de l'éditeur : taper « / » ouvre la liste des blocs, la frappe
 * filtre, flèches et Entrée choisissent, Échap ferme.
 *
 * Le menu est un simple élément DOM positionné sous le curseur : il vit hors
 * de Svelte pour suivre le cycle de vie du plugin de suggestion de Tiptap.
 */
import { Extension, type Editor, type Range } from '@tiptap/core';
import { Suggestion, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { siteIconSvg, type SiteIconName } from '@kotbo/shared';

export interface SlashItem {
  id: string;
  group: string;
  label: string;
  description: string;
  icon: SiteIconName;
  /** Mots qui retrouvent l'élément en plus de son libellé. */
  keywords?: string;
  disabled?: boolean;
  run: (editor: Editor, range: Range) => void;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = fold(query.trim());
  if (!q) return items;
  return items.filter((item) => fold(`${item.label} ${item.description} ${item.keywords ?? ''} ${item.id}`).includes(q));
}

class SlashMenuView {
  private root: HTMLDivElement;
  private items: SlashItem[] = [];
  private index = 0;
  private command: ((item: SlashItem) => void) | null = null;

  constructor(private readonly emptyLabel: string) {
    this.root = document.createElement('div');
    this.root.className = 'site-slash-menu';
    this.root.setAttribute('role', 'listbox');
    document.body.append(this.root);
  }

  update(props: SuggestionProps<SlashItem>): void {
    this.items = props.items;
    this.command = (item) => props.command(item);
    this.index = Math.min(this.index, Math.max(0, this.items.length - 1));
    this.render();
    const rect = props.clientRect?.();
    if (rect) {
      const top = rect.bottom + 6;
      const left = Math.min(rect.left, window.innerWidth - 340);
      this.root.style.top = `${Math.min(top, window.innerHeight - 20)}px`;
      this.root.style.left = `${Math.max(8, left)}px`;
      // Pas la place en dessous : le menu s'ouvre au-dessus du curseur.
      const height = this.root.offsetHeight;
      if (top + height > window.innerHeight - 8) this.root.style.top = `${Math.max(8, rect.top - height - 6)}px`;
    }
  }

  private render(): void {
    this.root.textContent = '';
    if (this.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'site-slash-empty';
      empty.textContent = this.emptyLabel;
      this.root.append(empty);
      return;
    }
    let group = '';
    this.items.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        const heading = document.createElement('p');
        heading.className = 'site-slash-group';
        heading.textContent = group;
        this.root.append(heading);
      }
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `site-slash-item${i === this.index ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', i === this.index ? 'true' : 'false');
      const icon = document.createElement('span');
      icon.className = 'site-slash-icon';
      // SVG constant du jeu partagé, jamais une donnée saisie.
      icon.innerHTML = siteIconSvg(item.icon, 18);
      const text = document.createElement('span');
      text.className = 'site-slash-text';
      const name = document.createElement('strong');
      name.textContent = item.label;
      const desc = document.createElement('small');
      desc.textContent = item.description;
      text.append(name, desc);
      option.append(icon, text);
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('mouseenter', () => {
        this.index = i;
        this.highlight();
      });
      option.addEventListener('click', () => this.select(i));
      this.root.append(option);
    });
  }

  private highlight(): void {
    this.root.querySelectorAll('.site-slash-item').forEach((el, i) => {
      el.classList.toggle('is-active', i === this.index);
      el.setAttribute('aria-selected', i === this.index ? 'true' : 'false');
      if (i === this.index) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  }

  private select(i: number): void {
    const item = this.items[i];
    if (item && !item.disabled) this.command?.(item);
  }

  keydown(props: SuggestionKeyDownProps): boolean {
    if (this.items.length === 0) return false;
    if (props.event.key === 'ArrowDown') {
      this.index = (this.index + 1) % this.items.length;
      this.highlight();
      return true;
    }
    if (props.event.key === 'ArrowUp') {
      this.index = (this.index - 1 + this.items.length) % this.items.length;
      this.highlight();
      return true;
    }
    if (props.event.key === 'Enter' || props.event.key === 'Tab') {
      this.select(this.index);
      return true;
    }
    return false;
  }

  destroy(): void {
    this.root.remove();
  }
}

export interface SlashMenuOptions {
  items: () => SlashItem[];
  emptyLabel: string;
}

export const SlashMenu = Extension.create<SlashMenuOptions>({
  name: 'siteSlashMenu',
  addOptions() {
    return { items: () => [], emptyLabel: '' };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('siteSlashMenu'),
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }) => filterSlashItems(options.items(), query).slice(0, 60),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let view: SlashMenuView | null = null;
          return {
            onStart: (props) => {
              view = new SlashMenuView(options.emptyLabel);
              view.update(props);
            },
            onUpdate: (props) => view?.update(props),
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                view?.destroy();
                view = null;
                return true;
              }
              return view?.keydown(props) ?? false;
            },
            onExit: () => {
              view?.destroy();
              view = null;
            },
          };
        },
      }),
    ];
  },
});
