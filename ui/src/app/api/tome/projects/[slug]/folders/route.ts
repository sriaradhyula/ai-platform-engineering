import { NextRequest } from "next/server";

import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { tomeActorFromAuth, auditTome } from "@/lib/tome/audit";
import {
  createFolder,
  ensureFoldersForPages,
  FolderValidationError,
  listFolders,
} from "@/lib/tome/folder-store";
import { getPageStore } from "@/lib/tome/page-store";
import { guardNotLocked, loadTomeProject, requireTomeEditor } from "@/lib/tome/tome-api";
import { AGENT_IDENTITIES } from "@/lib/tome/agent-identities";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function folderApiError(error: unknown): never {
  if (error instanceof FolderValidationError) {
    throw new ApiError(error.message, error.status, error.code);
  }
  throw error;
}

export const GET = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  const pages = await (await getPageStore()).listPages(tctx.projectId);
  await ensureFoldersForPages(
    tctx.projectId,
    Object.keys(pages),
    tctx.user.email ?? AGENT_IDENTITIES.default,
  );
  return successResponse({ folders: await listFolders(tctx.projectId) });
});

export const POST = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  requireTomeEditor(tctx);
  await guardNotLocked(tctx.projectId, tctx.project.locked ?? false);
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    parent_id?: unknown;
  } | null;
  if (typeof body?.name !== "string") {
    throw new ApiError("`name` (string) is required", 400, "BAD_REQUEST");
  }
  if (body.parent_id !== undefined && body.parent_id !== null && typeof body.parent_id !== "string") {
    throw new ApiError("`parent_id` must be a string or null", 400, "BAD_REQUEST");
  }
  const parentId = typeof body.parent_id === "string" ? body.parent_id : null;

  try {
    const folder = await createFolder({
      projectId: tctx.projectId,
      parentId,
      name: body.name,
      actor: tctx.user.email ?? AGENT_IDENTITIES.default,
    });
    auditTome({
      action: "tome.folder.create",
      actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
      projectSlug: slug,
      metadata: { folder_id: folder.id, name: folder.name, parent_id: folder.parent_id },
    });
    return successResponse({ folder }, 201);
  } catch (error) {
    return folderApiError(error);
  }
});
