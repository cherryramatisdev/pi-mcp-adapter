import { describe, expect, it, vi } from "vitest";
import { SearchableSelect, selectSearchable, type SearchableSelectItem } from "../select-searchable.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const items: SearchableSelectItem[] = [
  { value: "alpha", label: "alpha  ✓ connected", searchText: "alpha" },
  { value: "beta", label: "beta  ○ idle", searchText: "beta" },
];

function drive(keys: string[]): { result: string | null; component: SearchableSelect } {
  let result: string | null | undefined;
  const component = new SearchableSelect({
    title: "Pick:",
    items,
    theme,
    requestRender: () => {},
    onDone: (value) => {
      result = value;
    },
  });
  for (const key of keys) component.handleInput(key);
  return { result: result ?? null, component };
}

describe("SearchableSelect", () => {
  it("selects the first item on enter", () => {
    expect(drive([ENTER]).result).toBe("alpha");
  });

  it("moves down before selecting", () => {
    expect(drive([DOWN, ENTER]).result).toBe("beta");
  });

  it("filters by typed query", () => {
    expect(drive(["b", "e", "t", "a", ENTER]).result).toBe("beta");
  });

  it("fuzzy-matches on plain searchText despite decorated labels", () => {
    const decorated: SearchableSelectItem[] = [
      { value: "● do_thing", label: "● do_thing", searchText: "do_thing" },
      { value: "● other", label: "● other", searchText: "other" },
    ];
    let result: string | null = null;
    const component = new SearchableSelect({
      title: "Tools:",
      items: decorated,
      theme,
      requestRender: () => {},
      onDone: (value) => {
        result = value;
      },
    });
    for (const key of ["t", "h", "i", "n", "g"]) component.handleInput(key);
    component.handleInput(ENTER);
    expect(result).toBe("● do_thing");
  });

  it("cancels on escape", () => {
    expect(drive([ESC]).result).toBeNull();
  });

  it("renders the search query and a no-match message", () => {
    const component = new SearchableSelect({
      title: "Pick:",
      items,
      theme,
      requestRender: () => {},
      onDone: () => {},
    });
    expect(component.render(60).join("\n")).toContain("> ");
    for (const key of ["z", "z", "z"]) component.handleInput(key);
    expect(component.render(60).join("\n")).toContain("No matching commands");
  });
});

describe("selectSearchable", () => {
  it("uses the searchable component in tui mode", async () => {
    const custom = vi.fn(
      (factory: any) =>
        new Promise((resolve) => {
          const component = factory({ requestRender: () => {} }, theme, {}, resolve);
          for (const key of ["b", "e", "t", "a", ENTER]) component.handleInput(key);
        }),
    );
    const select = vi.fn();
    const ctx = { mode: "tui", ui: { custom, select } } as any;

    await expect(selectSearchable(ctx, "Pick:", items)).resolves.toBe("beta");
    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("falls back to native select outside tui mode", async () => {
    const select = vi.fn(async () => "alpha");
    const custom = vi.fn();
    const ctx = { mode: "rpc", ui: { custom, select } } as any;

    await expect(selectSearchable(ctx, "Pick:", items)).resolves.toBe("alpha");
    expect(select).toHaveBeenCalledWith("Pick:", ["alpha", "beta"]);
    expect(custom).not.toHaveBeenCalled();
  });

  it("returns undefined without opening a dialog for empty items", async () => {
    const select = vi.fn();
    const ctx = { mode: "tui", ui: { custom: vi.fn(), select } } as any;
    await expect(selectSearchable(ctx, "Pick:", [])).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});
