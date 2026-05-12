"use client";

import { Children, type ReactNode, useState } from "react";

type ShowMoreProps = {
  children: ReactNode;
  initialCount?: number;
};

const buttonClasses =
  "mt-4 rounded-full border border-[var(--carysil-red)] px-4 py-2 text-sm font-medium text-[var(--carysil-red)] transition hover:bg-[var(--carysil-red)] hover:text-white";

export function ShowMoreList({ children, initialCount = 3 }: ShowMoreProps) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const visibleItems = expanded ? items : items.slice(0, initialCount);

  return (
    <>
      {visibleItems}
      {items.length > initialCount && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className={buttonClasses}>
          {expanded ? "Show less" : `Show more (${items.length - initialCount})`}
        </button>
      )}
    </>
  );
}

export function ShowMoreTableRows({ children, initialCount = 3 }: ShowMoreProps) {
  const [expanded, setExpanded] = useState(false);
  const rows = Children.toArray(children);
  const visibleRows = expanded ? rows : rows.slice(0, initialCount);

  return (
    <>
      {visibleRows}
      {rows.length > initialCount && (
        <tr>
          <td colSpan={7} className="px-4 py-4 text-center">
            <button type="button" onClick={() => setExpanded((value) => !value)} className={buttonClasses}>
              {expanded ? "Show less" : `Show more (${rows.length - initialCount})`}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
