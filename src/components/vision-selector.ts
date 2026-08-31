import { Container, Input, Text, Spacer, type TUI, fuzzyFilter, getKeybindings } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";

function getModelSearchText(m: { id: string; provider: string; name?: string }): string {
  return `${m.provider} ${m.id} ${m.name ?? ""}`;
}

export type VisionModelItem = Model<any>;

export class VisionModelSelector extends Container {
  private searchInput: Input;
  private listContainer: Container;
  private allModels: VisionModelItem[];
  private filtered: VisionModelItem[];
  private selected = 0;
  private onDone: (m: VisionModelItem | undefined) => void;
  private theme: any;

  constructor(
    tui: TUI,
    models: VisionModelItem[],
    currentVisionId: string | undefined,
    onDone: (m: VisionModelItem | undefined) => void,
    theme?: any,
    initialSearch?: string,
  ) {
    super();
    // Sort: current visionModel pinned to top, then by provider/id
    const sorted = [...models].sort((a, b) => {
      const aIsCurrent = currentVisionId === `${a.provider}/${a.id}`;
      const bIsCurrent = currentVisionId === `${b.provider}/${b.id}`;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    });
    this.allModels = sorted;
    this.filtered = sorted;
    this.onDone = onDone;
    this.theme = theme;

    // pre-select current (now at 0 if exists)
    if (currentVisionId) {
      const idx = this.filtered.findIndex(m => `${m.provider}/${m.id}` === currentVisionId);
      if (idx >= 0) this.selected = idx;
    }

    const th = this.theme;
    this.addChild(new Text(th ? th.fg("accent", th.bold("Select visionModel")) : "Select visionModel", 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(th ? th.fg("muted", `> type to filter, enter to select, esc to cancel${currentVisionId ? ` | current: ${currentVisionId}` : ""}`) : `type to filter`, 1, 0));
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => {
      const pick = this.filtered[this.selected];
      this.onDone(pick);
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    const dim = this.theme ? this.theme.fg("dim", "↑↓ navigate · enter select · esc cancel") : "↑↓ navigate · enter select · esc cancel";
    this.addChild(new Text(dim, 1, 0));

    if (initialSearch) {
      this.searchInput.setValue(initialSearch);
      this.filter(initialSearch);
    } else {
      this.updateList();
    }
    // Focus search input
    (this as any).focused = true;
  }

  get focused(): boolean { return (this.searchInput as any).focused ?? false; }
  set focused(v: boolean) { (this.searchInput as any).focused = v; }

  private filter(q: string) {
    if (!q.trim()) {
      this.filtered = this.allModels;
    } else {
      this.filtered = fuzzyFilter(this.allModels, q, (m) => getModelSearchText({ id: m.id, provider: m.provider, name: m.name } as any));
      if (this.filtered.length === 0) {
        const term = q.toLowerCase();
        this.filtered = this.allModels.filter(m => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(term));
      }
    }
    // Pin current to top if it is in filtered and not already first (for empty query it's already first via sorting)
    // This ensures the selected visionModel is always visible at top when unfiltered
    this.selected = 0;
    this.updateList();
  }

  private updateList() {
    this.listContainer.clear();
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible/2), this.filtered.length - maxVisible));
    const end = Math.min(start + maxVisible, this.filtered.length);
    for (let i=start;i<end;i++) {
      const m = this.filtered[i]!;
      const isSel = i===this.selected;
      const label = `${m.provider}/${m.id} — ${m.name ?? m.id}`;
      const th2 = this.theme;
      const text = isSel ? (th2 ? th2.fg("accent", "→ " + label) : "→ " + label) : `  ${label}`;
      this.listContainer.addChild(new Text(text, 1, 0));
    }
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme ? this.theme.fg("muted", "  No matching models") : "  No matching models", 1, 0));
    } else if (start>0 || end<this.filtered.length) {
      this.listContainer.addChild(new Text(this.theme ? this.theme.fg("muted", `  (${this.selected+1}/${this.filtered.length})`) : `  (${this.selected+1}/${this.filtered.length})`, 1, 0));
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      if (this.filtered.length===0) return;
      this.selected = this.selected===0 ? this.filtered.length-1 : this.selected-1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      if (this.filtered.length===0) return;
      this.selected = this.selected===this.filtered.length-1 ? 0 : this.selected+1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
      const pick = this.filtered[this.selected];
      this.onDone(pick);
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.onDone(undefined);
      return;
    }
    // otherwise pass to search input and re-filter
    this.searchInput.handleInput(data);
    this.filter(this.searchInput.getValue());
  }
}
