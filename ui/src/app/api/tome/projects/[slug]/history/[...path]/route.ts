// Revision history for one page (newest first) — summaries for the diff/history
// view. Revisions carry `report_id` when produced by an ingest, so an ingest's
// changes are attributable.

import { NextRequest } from "next/server";

import { successResponse, withErrorHandler } from "@/lib/api-middleware";
import { loadTomeProject } from "@/lib/tome/tome-api";
import { getPageStore } from "@/lib/tome/page-store";
import { currentLiveRevision } from "@/lib/tome/revision-status";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; path: string[] }> };

export const GET = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug, path } = await ctx.params;
  const { projectId } = await loadTomeProject(request, slug);
  const pagePath = path.join("/");

  const store = await getPageStore();
  const revisions = await store.pageHistory(projectId, pagePath);
  const current = currentLiveRevision(revisions);

  const summaries = revisions.map((r) => ({
    id: String(r._id),
    author: r.author,
    message: r.message,
    created_at: r.created_at,
    report_id: r.report_id ?? null,
    status: r.status ?? "live",
    deleted: Boolean(r.deleted),
    reverted_from: r.reverted_from ?? null,
    draft_created_at: r.draft_created_at ?? null,
    reviewed_at: r.reviewed_at ?? null,
    reviewed_by: r.reviewed_by ?? null,
    review_outcome: r.review_outcome ?? null,
  }));

  return successResponse({
    path: pagePath,
    current_revision_id: current?._id ? String(current._id) : null,
    revisions: summaries,
  });
});
