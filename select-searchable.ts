/**
 * Inline searchable selector.
 *
 * Renders in the prompt's editor container exactly like `ctx.ui.select()`
 * (native `ExtensionSelectorComponent`) — same border/title/list layout — but
 * adds a search field so long server/tool lists are filterable.
 *
 * `ctx.ui.select()` itself has no filter hook: its `ExtensionSelectorComponent`
 * ignores printable keys and `ExtensionUIDialogOptions` only exposes
 * `signal`/`timeout`. So the only way to get search while keeping the native
 * look is to rebuild the window from the same TUI building blocks
 * (`SelectList`, `Input`, `Container`) and mount it with `ctx.ui.custom()`
 * *without* `{ overlay: true }`.
 */
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  Text,
  type Component,
  type Focusable,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal theme surface needed by the selector (matches `Theme`). */
export interface SelectThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface SearchableSelectItem {
  /** Returned by the selector on confirm. */
  value: string;
  /** Rendered text. */
  label: string;
  description?: string;
  /**
   * Text used for fuzzy matching. Defaults to `label`. Set this when the label
   * carries status decoration (e.g. "● my_tool", "server ✓ connected") so a
   * plain name query still matches.
   */
  searchText?: string;
}

export interface SearchableSelectOptions {
  title: string;
  items: SearchableSelectItem[];
  theme: SelectThemeLike;
  /** Called whenever the component state needs a redraw. */
  requestRender: () => void;
  /** Resolves the enclosing `ctx.ui.custom()` promise. */
  onDone: (value: string | null) => void;
  /** Max rows shown at once. Defaults to 12. */
  maxVisible?: number;
}

class BorderLine implements Component {
  constructor(private readonly color: (text: string) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

export class SearchableSelect extends Container implements Focusable {
  private readonly search: Input;
  private readonly listContainer = new Container();
  private readonly items: SearchableSelectItem[];
  private readonly theme: SelectThemeLike;
  private readonly selectTheme: SelectListTheme;
  private readonly requestRender: () => void;
  private readonly onDone: (value: string | null) => void;
  private readonly maxVisible: number;
  private list?: SelectList;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    // Propagate so the hardware cursor/IME tracks the search field.
    this.search.focused = value;
  }

  constructor(options: SearchableSelectOptions) {
    super();
    this.items = options.items;
    this.theme = options.theme;
    this.requestRender = options.requestRender;
    this.onDone = options.onDone;
    this.maxVisible = options.maxVisible ?? 12;

    this.selectTheme = {
      selectedPrefix: (t) => this.theme.fg("accent", t),
      selectedText: (t) => this.theme.fg("accent", t),
      description: (t) => this.theme.fg("muted", t),
      scrollInfo: (t) => this.theme.fg("dim", t),
      noMatch: (t) => this.theme.fg("warning", t),
    };

    this.addChild(new BorderLine((s) => this.theme.fg("border", s)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(options.title)), 1, 0));
    this.addChild(new Spacer(1));

    this.search = new Input();
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(this.theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(new BorderLine((s) => this.theme.fg("border", s)));

    this.rebuildList();
  }

  /** Re-filter and swap the SelectList. SelectList has no `setItems`, and its
   * `setFilter` only prefix-matches raw `value`, so we rebuild from scratch. */
  private rebuildList(): void {
    const query = this.search.getValue();
    const filtered = fuzzyFilter(this.items, query, (item) => item.searchText ?? item.label);
    const visible = Math.min(this.maxVisible, Math.max(filtered.length, 1));

    const list = new SelectList(
      filtered.map((item) => ({
        value: item.value,
        label: item.label,
        description: item.description,
      })),
      visible,
      this.selectTheme,
    );
    list.onSelect = (picked) => this.onDone(picked.value);
    list.onCancel = () => this.onDone(null);
    list.onSelectionChange = () => this.requestRender();

    this.list = list;
    this.listContainer.clear();
    this.listContainer.addChild(list);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.cancel")) {
      this.onDone(null);
      return;
    }
    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.list?.handleInput(data);
      this.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.list?.getSelectedItem();
      if (selected) this.onDone(selected.value);
      return;
    }

    // Everything else edits the search query.
    const before = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue() !== before) {
      this.rebuildList();
    }
    this.requestRender();
  }
}

/**
 * Drop-in replacement for `ctx.ui.select()` that adds fuzzy search.
 *
 * Only uses a custom component in interactive ("tui") mode; in RPC/print/json
 * modes `ctx.ui.custom()` is a no-op, so it falls back to the plain native
 * selector to preserve existing behaviour.
 */
export async function selectSearchable(
  ctx: ExtensionContext,
  title: string,
  items: SearchableSelectItem[],
): Promise<string | undefined> {
  if (items.length === 0) return undefined;

  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return ctx.ui.select(title, items.map((item) => item.value));
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) =>
    new SearchableSelect({
      title,
      items,
      theme,
      requestRender: () => tui.requestRender(),
      onDone: done,
    }),
  );

  return result ?? undefined;
}
