import { NextRequest } from "next/server";

import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { AGENT_IDENTITIES } from "@/lib/tome/agent-identities";
import { auditTome, tomeActorFromAuth } from "@/lib/tome/audit";
import {
  deleteFolder,
  FolderValidationError,
  reorderFolder,
  updateFolder,
} from "@/lib/tome/folder-store";
import { getPageStore } from "@/lib/tome/page-store";
import { guardNotLocked, loadTomeProject, requireTomeEditor } from "@/lib/tome/tome-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; folderId: string }> };

function folderApiError(error: unknown): never {
  if (error instanceof FolderValidationError) {
    throw new ApiError(error.message, error.status, error.code);
  }
  throw error;
}

export const PATCH = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug, folderId } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  requireTomeEditor(tctx);
  await guardNotLocked(tctx.projectId, tctx.project.locked ?? false);
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    parent_id?: unknown;
    order?: unknown;
    direction?: unknown;
  } | null;
  if (!body) throw new ApiError("A JSON body is required", 400, "BAD_REQUEST");
  const actor = tctx.user.email ?? AGENT_IDENTITIES.default;

  try {
    if (body.direction !== undefined) {
      if (body.direction !== "up" && body.direction !== "down") {
        throw new ApiError("`direction` must be `up` or `down`", 400, "BAD_REQUEST");
      }
      const folders = await reorderFolder({
        projectId: tctx.projectId,
        folderId,
        actor,
        direction: body.direction,
      });
      auditTome({
        action: "tome.folder.reorder",
        actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
        projectSlug: slug,
        metadata: { folder_id: folderId, direction: body.direction },
      });
      return successResponse({ folders });
    }

    if (body.name !== undefined && typeof body.name !== "string") {
      throw new ApiError("`name` must be a string", 400, "BAD_REQUEST");
    }
    if (body.parent_id !== undefined && body.parent_id !== null && typeof body.parent_id !== "string") {
      throw new ApiError("`parent_id` must be a string or null", 400, "BAD_REQUEST");
    }
    if (body.order !== undefined && typeof body.order !== "number") {
      throw new ApiError("`order` must be a number", 400, "BAD_REQUEST");
    }
    if (body.name === undefined && body.parent_id === undefined && body.order === undefined) {
      throw new ApiError("At least one folder field is required", 400, "BAD_REQUEST");
    }
    const folder = await updateFolder({
      projectId: tctx.projectId,
      folderId,
      actor,
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.parent_id !== undefined ? { parentId: body.parent_id as string | null } : {}),
      ...(body.order !== undefined ? { order: body.order as number } : {}),
    });
    auditTome({
      action: "tome.folder.update",
      actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
      projectSlug: slug,
      metadata: { folder_id: folder.id, name: folder.name, parent_id: folder.parent_id },
    });
    return successResponse({ folder });
  } catch (error) {
    return folderApiError(error);
  }
});

export const DELETE = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug, folderId } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  requireTomeEditor(tctx);
  await guardNotLocked(tctx.projectId, tctx.project.locked ?? false);
  const pages = await (await getPageStore()).listPages(tctx.projectId);
  try {
    const folder = await deleteFolder(tctx.projectId, folderId, Object.keys(pages));
    auditTome({
      action: "tome.folder.delete",
      actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
      projectSlug: slug,
      metadata: { folder_id: folder.id, name: folder.name, parent_id: folder.parent_id },
    });
    return successResponse({ deleted: true, folder_id: folder.id });
  } catch (error) {
    return folderApiError(error);
  }
});
