export interface CheckedFold {
  /** 1-based, among the editor's blocks. */
  block: number;
  /** 1-based, among the list's items. */
  first: number;
  last: number;
}

/** [blocks]: each list's item states (`data-list`), and null for any other block. */
export function findCheckedFolds(
  blocks: (readonly (string | null)[] | null)[],
): CheckedFold[] {
  const folds: CheckedFold[] = [];
  const isChecklist = (state: string | null) =>
    state === "checked" || state === "unchecked";
  blocks.forEach((items, blockIndex) => {
    if (!items) return;
    for (let start = 0; start < items.length; ) {
      if (!isChecklist(items[start])) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < items.length && isChecklist(items[end + 1])) end++;
      let firstChecked = end + 1;
      while (firstChecked > start && items[firstChecked - 1] === "checked")
        firstChecked--;
      if (firstChecked <= end)
        folds.push({
          block: blockIndex + 1,
          first: firstChecked + 1,
          last: end + 1,
        });
      start = end + 1;
    }
  });
  return folds;
}

export function checkedFoldStyles(
  scope: string,
  folds: CheckedFold[],
  isFolded: boolean,
): string {
  return folds
    .map(({ block, first, last }) => {
      const list = `${scope} .ql-editor > :nth-child(${block}) >`;
      const firstItem = `${list} li:nth-child(${first})`;
      if (!isFolded)
        return `${firstItem}{margin-top:calc(var(--fold-row) * var(--fold-rows))}`;
      return [
        `${firstItem}{margin-top:calc(var(--fold-row) * var(--fold-rows));height:0;padding-block:0;overflow:hidden;visibility:hidden}`,
        last > first
          ? `${list} li:nth-child(n+${first + 1}):nth-child(-n+${last}){display:none}`
          : "",
      ].join("");
    })
    .join("\n");
}

/** The delta that puts an empty unchecked item right before the fold's first checked item. */
export const addItemDelta = (at: number) => ({
  ops: [
    ...(at ? [{ retain: at }] : []),
    { insert: "\n", attributes: { list: "unchecked" } },
  ],
});

export const foldCount = (fold: CheckedFold) => fold.last - fold.first + 1;

export const checkedItemsLabel = (count: number) =>
  count === 1 ? "1 checked item" : `${count} checked items`;
