import { NextRequest } from "next/server";

import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { AGENT_IDENTITIES } from "@/lib/tome/agent-identities";
import { auditTome, tomeActorFromAuth } from "@/lib/tome/audit";
import {
  ensureFoldersForPages,
  FolderValidationError,
  listFolders,
} from "@/lib/tome/folder-store";
import {
  ensurePagePlacements,
  moveNavigationItem,
  NavigationValidationError,
  type NavigationDropTarget,
  type NavigationItemRef,
} from "@/lib/tome/navigation-store";
import { getPageStore } from "@/lib/tome/page-store";
import { guardNotLocked, loadTomeProject, requireTomeEditor } from "@/lib/tome/tome-api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function parseItem(value: unknown, field: string): NavigationItemRef {
  const item = value as { kind?: unknown; id?: unknown } | null;
  if (
    !item ||
    (item.kind !== "page" && item.kind !== "folder") ||
    typeof item.id !== "string" ||
    !item.id
  ) {
    throw new ApiError(`\`${field}\` must identify a page or folder`, 400, "BAD_REQUEST");
  }
  return { kind: item.kind, id: item.id };
}

function parseTarget(value: unknown): NavigationDropTarget {
  const target = value as { position?: unknown; item?: unknown } | null;
  if (target?.position === "root") return { position: "root" };
  if (
    target?.position !== "inside" &&
    target?.position !== "before" &&
    target?.position !== "after"
  ) {
    throw new ApiError("Invalid navigation drop position", 400, "BAD_REQUEST");
  }
  return { position: target.position, item: parseItem(target.item, "target.item") };
}

export const PATCH = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug } = await ctx.params;
  const tctx = await loadTomeProject(request, slug);
  requireTomeEditor(tctx);
  await guardNotLocked(tctx.projectId, tctx.project.locked ?? false);
  const body = (await request.json().catch(() => null)) as {
    item?: unknown;
    target?: unknown;
  } | null;
  if (!body) throw new ApiError("A JSON body is required", 400, "BAD_REQUEST");
  const item = parseItem(body.item, "item");
  const target = parseTarget(body.target);
  const actor = tctx.user.email ?? AGENT_IDENTITIES.default;

  const pages = await (await getPageStore()).listPages(tctx.projectId);
  await ensureFoldersForPages(tctx.projectId, Object.keys(pages), actor);
  const folders = await listFolders(tctx.projectId);
  await ensurePagePlacements(tctx.projectId, pages, folders, actor);
  try {
    await moveNavigationItem({
      projectId: tctx.projectId,
      item,
      target,
      actor,
    });
  } catch (error) {
    if (error instanceof NavigationValidationError || error instanceof FolderValidationError) {
      throw new ApiError(error.message, error.status, error.code);
    }
    throw error;
  }

  auditTome({
    action: "tome.navigation.move",
    actor: tomeActorFromAuth({ user: tctx.user, session: tctx.session }),
    projectSlug: slug,
    page: item.kind === "page" ? item.id : undefined,
    metadata: { item, target },
  });
  return successResponse({ moved: true, item, target });
});
