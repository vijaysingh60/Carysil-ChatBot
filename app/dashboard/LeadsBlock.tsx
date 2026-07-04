"use client";

import { useMemo, useState } from "react";
import { formatDashboardDate } from "@/lib/dashboardFormat";
import { InterestedProductsCell, type InterestedProductItem } from "./InterestedProductsCell";
import { showMoreButtonClasses } from "./ShowMore";
import { EmptyState } from "./_components/EmptyState";
import { Badge } from "./_components/Badge";

export type DashboardLeadRow = {
  session_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  intent: string | null;
  interested_product: string | null;
  interested_products: InterestedProductItem[] | null;
  followup_stage: string | null;
  lead_score: number;
  created_at: Date | string;
  updated_at: Date | string | null;
};

const showMoreBtn = showMoreButtonClasses.replace("mt-4 ", "");

export function LeadsBlock({ leads }: { leads: DashboardLeadRow[] }) {
  const [expanded, setExpanded] = useState(false);

  const visibleLeads = useMemo(
    () => (expanded ? leads : leads.slice(0, 3)),
    [expanded, leads]
  );

  if (leads.length === 0) {
    return (
      <EmptyState>
        No leads captured yet. Try a chat flow where the user shares phone, email, city, or asks for dealer/pricing help.
      </EmptyState>
    );
  }

  const showMoreRow = leads.length > 3 && (
    <tr>
      <td colSpan={7} className="px-2 py-3 text-center md:px-4 md:py-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} className={showMoreBtn}>
          {expanded ? "Show less" : `Show more (${leads.length - 3})`}
        </button>
      </td>
    </tr>
  );

  return (
    <>
      {/* Mobile: compact cards, 2-column feel for meta */}
      <div className="space-y-3 md:hidden">
        {visibleLeads.map((lead) => (
          <article
            key={lead.session_id}
            className="rounded-xl border border-gray-200 bg-gray-50/80 p-3 text-sm shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-carysil-stone">{lead.name || "Unknown"}</p>
                <p className="text-xs text-gray-500">{lead.phone || lead.email || "No contact yet"}</p>
              </div>
              <span className="shrink-0 rounded-lg bg-white px-2 py-1 text-xs font-bold text-carysil-stone ring-1 ring-gray-200">
                {lead.lead_score}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <div>
                <span className="text-gray-500">City</span>
                <p className="font-medium text-gray-800">{lead.city || "—"}</p>
              </div>
              <div>
                <span className="text-gray-500">Stage</span>
                <p>
                  <Badge tone="stone">{lead.followup_stage || "browsing"}</Badge>
                </p>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500">Intent</span>
                <p className="font-medium text-gray-800">{lead.intent || "—"}</p>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500">Interested products</span>
                <div className="mt-0.5">
                  <InterestedProductsCell
                    items={lead.interested_products}
                    interestedProduct={lead.interested_product}
                  />
                </div>
              </div>
              <div className="col-span-2 text-[11px] text-gray-500">
                {formatDashboardDate(lead.updated_at || lead.created_at)}
              </div>
            </div>
          </article>
        ))}
        {leads.length > 3 && (
          <div className="flex justify-center pt-1">
            <button type="button" onClick={() => setExpanded((v) => !v)} className={showMoreBtn}>
              {expanded ? "Show less" : `Show more (${leads.length - 3})`}
            </button>
          </div>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">City</th>
              <th className="px-4 py-3">Intent</th>
              <th className="px-4 py-3">Stage</th>
              <th className="px-4 py-3">Interested Products</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visibleLeads.map((lead) => (
              <tr key={lead.session_id}>
                <td className="px-4 py-3 font-semibold text-carysil-stone">{lead.lead_score}</td>
                <td className="px-4 py-3">
                  <p className="font-medium text-carysil-stone">{lead.name || "Unknown"}</p>
                  <p className="text-gray-500">{lead.phone || lead.email || "No contact yet"}</p>
                </td>
                <td className="px-4 py-3 text-gray-700">{lead.city || "-"}</td>
                <td className="px-4 py-3 text-gray-700">{lead.intent || "-"}</td>
                <td className="px-4 py-3 text-gray-700">
                  <Badge tone="neutral">{lead.followup_stage || "browsing"}</Badge>
                </td>
                <td className="px-4 py-3 text-gray-700">
                  <InterestedProductsCell
                    items={lead.interested_products}
                    interestedProduct={lead.interested_product}
                  />
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {formatDashboardDate(lead.updated_at || lead.created_at)}
                </td>
              </tr>
            ))}
            {showMoreRow}
          </tbody>
        </table>
      </div>
    </>
  );
}
