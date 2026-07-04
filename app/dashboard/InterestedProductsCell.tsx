"use client";

import { useMemo, useState } from "react";

export type InterestedProductItem = {
  id?: string;
  name?: string;
  category?: string;
};

type Props = {
  items: InterestedProductItem[] | null;
  interestedProduct: string | null;
};

/** Roughly >2 lines in a narrow table cell — show Read more */
const READ_MORE_MIN_CHARS = 88;
const READ_MORE_MIN_ITEMS = 3;

export function InterestedProductsCell({ items, interestedProduct }: Props) {
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => {
    const arr = Array.isArray(items) ? items : [];
    const fromJson = arr
      .map((p) => p?.name || p?.category || (p?.id ? String(p.id) : ""))
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromJson.length > 0) return fromJson;
    if (interestedProduct?.trim()) {
      return interestedProduct
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }, [items, interestedProduct]);

  const fullLine = useMemo(() => {
    if (lines.length > 0) return lines.join(", ");
    if (interestedProduct?.trim()) return interestedProduct.trim();
    return "—";
  }, [lines, interestedProduct]);

  const needsReadMore =
    lines.length >= READ_MORE_MIN_ITEMS || fullLine.length >= READ_MORE_MIN_CHARS;

  if (!needsReadMore) {
    return <span className="break-words text-gray-700">{fullLine}</span>;
  }

  if (expanded) {
    return (
      <div className="max-w-[14rem] text-gray-700 sm:max-w-xs md:max-w-md">
        {lines.length > 1 ? (
          <ul className="list-inside list-disc space-y-0.5 break-words text-sm">
            {lines.map((line, i) => (
              <li key={`${line}-${i}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="break-words text-sm">{fullLine}</p>
        )}
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1.5 text-left text-xs font-semibold text-carysil-red hover:underline"
        >
          Show less
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-[14rem] sm:max-w-xs md:max-w-md">
      <p className="line-clamp-2 break-words text-gray-700">{fullLine}</p>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1 text-left text-xs font-semibold text-carysil-red hover:underline"
      >
        Read more
      </button>
    </div>
  );
}
