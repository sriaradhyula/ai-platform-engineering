// Resolve a report-less legacy draft that predates chat-write auto-publish.
// Report-backed drafts stay in the normal ingest review workflow.

import { NextRequest, NextResponse } from "next/server";

import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { auditTome, tomeActorFromAuth } from "@/lib/tome/audit";
import { getPageStore } from "@/lib/tome/page-store";
import { currentLiveRevision } from "@/lib/tome/revision-status";
import { guardNotLocked, loadTomeProject, requireTomeEditor } from "@/lib/tome/tome-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

export const POST = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug, id } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  requireTomeEditor(tctx);
  await guardNotLocked(tctx.projectId, tctx.project.locked ?? false);

  const body = (await request.json().catch(() => ({}))) as {
    action?: "publish" | "reject";
    base_revision_id?: string | null;
  };
  if (body.action !== "publish" && body.action !== "reject") {
    throw new ApiError("`action` must be `publish` or `reject`", 400, "BAD_REQUEST");
  }

  const store = await getPageStore();
  const draft = await store.readRevision(tctx.projectId, id);
  if (!draft) {
    throw new ApiError("Revision not found", 404, "REVISION_NOT_FOUND");
  }
  if (draft.status !== "draft") {
    throw new ApiError("Revision is not an unresolved draft", 409, "REVISION_NOT_DRAFT");
  }
  if (draft.report_id) {
    throw new ApiError(
      "This draft belongs to an ingest run and must be resolved from its review screen",
      409,
      "INGEST_REVIEW_REQUIRED",
    );
  }

  const history = await store.pageHistory(tctx.projectId, draft.path);
  const current = currentLiveRevision(history);
  const currentId = current?._id ? String(current._id) : null;
  if (body.action === "publish" && body.base_revision_id !== currentId) {
    return NextResponse.json(
      {
        error: "The live page changed after this history view was loaded.",
        code: "PAGE_EDIT_CONFLICT",
        data: { current_revision_id: currentId },
      },
      { status: 409 },
    );
  }

  const reviewedBy = tctx.user.email ?? "unknown";
  const resolved = await store.resolveOrphanDraft(
    tctx.projectId,
    id,
    body.action,
    reviewedBy,
  );
  if (!resolved) {
    throw new ApiError(
      "This draft was already resolved by another reviewer",
      409,
      "DRAFT_ALREADY_RESOLVED",
    );
  }

  auditTome({
    action: body.action === "publish" ? "tome.page.draft.publish" : "tome.page.draft.reject",
    actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
    projectSlug: slug,
    page: draft.path,
    metadata: {
      revision_id: id,
      prior_live_revision_id: currentId,
      reviewed_by: reviewedBy,
    },
  });

  return successResponse({
    ok: true,
    path: draft.path,
    revision_id: id,
    status: body.action === "publish" ? "live" : "rejected",
    current_revision_id: body.action === "publish" ? id : currentId,
  });
});
