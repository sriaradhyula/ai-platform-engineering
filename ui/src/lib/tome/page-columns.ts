export const TOME_COLUMN_MARKER = "[!column]";

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 3;

export function serializeTomeColumns(columnCount: number): string {
  const count = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(columnCount)));
  const columns = Array.from({ length: count }, (_, index) =>
    [
      `> ${TOME_COLUMN_MARKER}`,
      ">",
      `> ### Column ${index + 1}`,
      ">",
      "> Add content here.",
    ].join("\n"),
  );
  return `\n\n${columns.join("\n\n")}\n\n`;
}

function markerParagraph(blockquote: HTMLElement): HTMLParagraphElement | null {
  const first = blockquote.firstElementChild;
  return first instanceof HTMLParagraphElement &&
    first.textContent?.trim().toLowerCase() === TOME_COLUMN_MARKER
    ? first
    : null;
}

type ColumnRun = {
  columns: HTMLElement[];
  separators: HTMLElement[];
};

function isColumnSeparator(element: HTMLElement): boolean {
  if (element.tagName === "BR") return true;
  if (element.tagName !== "P") return false;
  return (
    element.textContent?.trim() === "" &&
    Array.from(element.children).every((child) => child.tagName === "BR")
  );
}

function directColumnRuns(root: ParentNode): ColumnRun[] {
  const runs: ColumnRun[] = [];
  const parents = new Set<HTMLElement>();
  root.querySelectorAll<HTMLElement>("blockquote").forEach((blockquote) => {
    if (markerParagraph(blockquote) && blockquote.parentElement) {
      parents.add(blockquote.parentElement);
    }
  });

  parents.forEach((parent) => {
    const children = Array.from(parent.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    for (let start = 0; start < children.length;) {
      const first = children[start];
      if (first.tagName !== "BLOCKQUOTE" || !markerParagraph(first)) {
        start += 1;
        continue;
      }

      const columns = [first];
      const separators: HTMLElement[] = [];
      let pendingSeparators: HTMLElement[] = [];
      let cursor = start + 1;
      while (cursor < children.length) {
        const child = children[cursor];
        if (isColumnSeparator(child)) {
          pendingSeparators.push(child);
          cursor += 1;
          continue;
        }
        if (child.tagName === "BLOCKQUOTE" && markerParagraph(child)) {
          separators.push(...pendingSeparators);
          pendingSeparators = [];
          columns.push(child);
          cursor += 1;
          continue;
        }
        break;
      }
      runs.push({ columns, separators });
      start = cursor;
    }
  });
  return runs;
}

/** Turn consecutive column blockquotes into a static responsive grid. */
export function decorateTomeColumns(root: ParentNode): void {
  directColumnRuns(root).forEach(({ columns, separators }) => {
    if (columns.length < MIN_COLUMNS || columns.length > MAX_COLUMNS) return;

    const wrapper = document.createElement("div");
    wrapper.className = "tome-columns";
    wrapper.dataset.columnCount = String(columns.length);
    columns[0].before(wrapper);
    separators.forEach((separator) => separator.remove());
    columns.forEach((column) => {
      markerParagraph(column)?.remove();
      column.classList.add("tome-column");
      wrapper.appendChild(column);
    });
  });
}
