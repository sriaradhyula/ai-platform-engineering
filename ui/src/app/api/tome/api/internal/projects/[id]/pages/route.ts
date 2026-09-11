// Internal agent callback: POST a page write (the agent's persist hook).
// Body = WritePageRequest { path, body, message, author, report_id? }.
// Matches agent/http_client.py write_page.

import { NextRequest } from "next/server";

import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { requireAgentToken, resolveProject } from "@/lib/tome/internal-api";
import { getPageStore } from "@/lib/tome/page-store";
import { getTomeIngestRunsCollection } from "@/lib/tome/mongo-collections";
import { canWriteAs } from "@/lib/tome/data-steward";
import {
  getExperiment,
  getExperimentArtifact,
  writeExperimentArtifactPage,
} from "@/lib/tome/evaluation-store";
import { blocksStableBodyEdit, preserveStoredKind } from "@/lib/tome/page-kind-guard";
import { parseFrontmatter, SPEC_BY_PATH } from "@/lib/tome/schema";
import type { TomeReviewMode } from "@/types/projects";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// All current pages as a `{ path: markdown }` map. The agent calls this at the
// start of each chat/ingest turn to rehydrate its `/project` working copy from
// the source of truth (Mongo), so it never reads stale files.
export const GET = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  requireAgentToken(request);
  const { id } = await ctx.params;
  const project = await resolveProject(id);
  const store = await getPageStore();
  const pages = await store.listPages(project._id);
  return Response.json(pages);
});

export const POST = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  requireAgentToken(request);
  const { id } = await ctx.params;
  const project = await resolveProject(id);

  const body = (await request.json().catch(() => ({}))) as {
    path?: string;
    body?: string;
    message?: string;
    author?: string;
    report_id?: string | null;
    actor_sub?: string | null;
    experiment_id?: string | null;
    artifact_id?: string | null;
  };
  if (typeof body.path !== "string" || typeof body.body !== "string") {
    throw new ApiError("`path` and `body` are required", 400, "BAD_REQUEST");
  }

  // Experiment writes are isolated by construction: validate both foreign
  // keys and persist only to the candidate artifact collection. They never
  // become PageRevisions and therefore cannot appear in the wiki or history.
  if (body.experiment_id || body.artifact_id) {
    if (!body.experiment_id || !body.artifact_id) {
      throw new ApiError(
        "Both `experiment_id` and `artifact_id` are required",
        400,
        "BAD_EXPERIMENT_WRITE",
      );
    }
    const [experiment, artifact] = await Promise.all([
      getExperiment(body.experiment_id),
      getExperimentArtifact(body.artifact_id),
    ]);
    if (
      !experiment ||
      !artifact ||
      experiment.project_id !== project._id ||
      artifact.project_id !== project._id ||
      artifact.experiment_id !== experiment._id
    ) {
      throw new ApiError(
        "Experiment artifact does not belong to this project",
        404,
        "EXPERIMENT_ARTIFACT_NOT_FOUND",
      );
    }
    if (experiment.config?.evaluation_mode === "quick") {
      const allowedPaths = new Set(experiment.config.evaluation_page_scope?.paths ?? []);
      if (!allowedPaths.has(body.path)) {
        throw new ApiError(
          `Quick evaluation writes are limited to selected pages; rejected ${body.path}`,
          403,
          "QUICK_EVALUATION_PAGE_SCOPE",
        );
      }
    }
    await writeExperimentArtifactPage(body.artifact_id, body.path, body.body);
    return Response.json({ ok: true, isolated: true });
  }

  // Chat-initiated writes (no report_id) carry actor_sub so we can enforce
  // FGA can_write. Ingest writes are already gated (requireTomeEditor on the
  // ingest dispatch route), so they skip this check.
  if (!body.report_id) {
    if (!body.actor_sub) {
      throw new ApiError(
        "Only a data steward may edit pages via the chat agent",
        403,
        "DATA_STEWARD_REQUIRED",
      );
    }
    const allowed = await canWriteAs(body.actor_sub, project);
    if (!allowed) {
      throw new ApiError(
        "Only a data steward may edit pages via the chat agent",
        403,
        "DATA_STEWARD_REQUIRED",
      );
    }
  }

  const store = await getPageStore();

  // `kind` is code-owned on agent writes (#369, #348): an agent may set the
  // kind of a page it creates, but may never change one an existing page
  // already declares — that is a human decision made through the UI toggle
  // on the user-facing PUT route. Applied BEFORE the review gate below so
  // the gate sees the page's real kind, not the one the agent proposed; a
  // write that de-pinned a stable page used to be classified `dynamic` by
  // its own new frontmatter and so skipped stable-page review entirely.
  const stored = await store
    .readPage(project._id, body.path)
    .catch(() => null);
  const guard = preserveStoredKind(stored, body.body);
  if (guard.blocked) {
    console.warn(
      `[tome-page-kind] refused agent kind change on ${project._id}/${body.path}: ` +
        `${guard.storedKind} -> ${guard.attemptedKind ?? "(none)"}; kept ${guard.storedKind}`,
    );
  }
  const markdown = guard.markdown;

  // One lookup, two gates: the stable-edit block below and the review gate.
  // Scoped to this project as well as the report: the run record is read as
  // authorization, so it must belong to the project being written. Report ids
  // are UUIDs and this endpoint is agent-token gated, which makes a crossed
  // lookup unlikely rather than impossible — an authorization read should not
  // rest on that.
  const run = body.report_id
    ? await getTomeIngestRunsCollection().then((runs) =>
        runs.findOne({ report_id: body.report_id, project_id: project._id }),
      )
    : null;

  // Stable pages are human-owned: "don't rewrite unless asked" (CHAT.md).
  // Until now nothing enforced the "unless asked" half — stable pages were
  // protected from deletion but not from unprompted rewriting.
  //
  // So the guard turns on exactly when nobody asked. `wasAskedFor` below
  // decides that; a chat edit never reaches it, since chat carries no
  // `report_id` and is by construction a person asking.
  if (body.report_id && !wasAskedFor(run)) {
    if (blocksStableBodyEdit(stored, markdown)) {
      console.warn(
        `[tome-page-kind] refused agent body edit on ${project._id}/${body.path}: ` +
          "page is human-owned (kind: stable)",
      );
      throw new ApiError(
        `\`${body.path}\` is a stable page — human-owned, and nobody asked for ` +
          "this change. Stable pages are rewritten only when a person asks, so " +
          "this write was discarded and the page is unchanged. If the content is " +
          "wrong, a person can edit it directly, ask in chat, or start a quick " +
          "reingest naming the correction.",
        409,
        "STABLE_PAGE_READ_ONLY",
      );
    }
  }

  // Chat writes are explicit, data-steward-authorized user requests. They do
  // not have an ingest report or a review surface, so publishing them as
  // drafts would create revisions that neither the user nor agent can resolve.
  const status = body.report_id
    ? await draftStatusForWrite({
        run,
        reviewMode: project.review_mode,
        path: body.path,
        markdown,
      })
    : "live";

  await store.writePage(project._id, body.path, markdown, {
    message: body.message || `agent wrote ${body.path}`,
    author: body.author || "tome-agent",
    reportId: body.report_id ?? undefined,
    ...(status === "draft" ? { status: "draft" as const } : {}),
  });
  return Response.json({ ok: true, kind_change_blocked: guard.blocked });
});

/**
 * Did a person ask this run to touch stable pages?
 *
 * The rule for stable pages is "don't rewrite unless asked", so the edit
 * guard has to be able to recognise being asked. Two shapes count, and both
 * are recorded on the run rather than inferred from the agent's behaviour:
 *
 * - A greenfield run with `dispatch.seedStablePages` — the team's explicit
 *   opt-in, at founding, to a best-effort first draft of the stable pages.
 *   `greenfield` is checked here and not taken on trust: the reingest route
 *   accepts `seedStablePages` on any run and `createRunRecord` stores the
 *   caller's value verbatim, so the run record can carry the flag on a
 *   non-greenfield run. `prepareRun` clamps it to `isGreenfield &&
 *   seedStablePages` when building the agent request, but that clamp governs
 *   what the agent is *told*, not what this route authorizes — without the
 *   check here, a plain reingest with the flag set would license stable-page
 *   edits the agent was never asked to make.
 * - A human-triggered quick edit — `mode: "quick"` with a non-empty `seed`,
 *   which is a person naming one targeted correction ("the charter is wrong
 *   about X, fix it"). The ingest prompt calls this mode "the team asked for
 *   one targeted correction" in as many words.
 *
 * `triggered_by === "auto"` excludes the scheduler, which also dispatches
 * `mode: "quick"` runs when a meeting transcript lands — with `seed: null`,
 * but the flag makes the intent explicit rather than resting on that. A
 * seed on a *full* reingest is a steering hint for a general refresh, not a
 * request to edit a specific human-owned page, so it does not count.
 *
 * Being asked still does not mean publishing unreviewed: under the default
 * `stable_only` review mode these writes land as drafts for approval.
 */
function wasAskedFor(
  run: {
    greenfield?: boolean;
    triggered_by?: string;
    dispatch?: { seedStablePages?: boolean; mode?: string; seed?: string | null };
  } | null,
): boolean {
  if (!run) return false;
  if (run.greenfield === true && run.dispatch?.seedStablePages) return true;
  return (
    run.triggered_by !== "auto" &&
    run.dispatch?.mode === "quick" &&
    typeof run.dispatch?.seed === "string" &&
    run.dispatch.seed.trim() !== ""
  );
}

/** True if `path`/`markdown` resolve to `kind: stable` (or `hidden` — same
 *  preserve-on-incremental semantics), same rule `buildTree` uses: explicit
 *  frontmatter wins, else the page's template spec, else "stable". */
function isStableWrite(path: string, markdown: string): boolean {
  const [fm] = parseFrontmatter(markdown);
  const rawKind = fm.kind;
  if (typeof rawKind === "string") return rawKind === "stable" || rawKind === "hidden";
  const spec = SPEC_BY_PATH.get(path);
  return !spec || spec.kind === "stable" || spec.kind === "hidden";
}

/**
 * Whether this write should land as a "draft" (held for human review) or
 * straight to "live", combining three gates in precedence order:
 *
 * 1. Enforced quality policies always draft; lower-precedence settings cannot
 *    publish before that gate is satisfied.
 * 2. An ingest run's opt-out (`dispatch.skipReview`) — set on the run that
 *    owns `reportId`, if any — bypasses project review.
 * 3. The project's own `review_mode` setting (#291): `none` never drafts,
 *    `all` always drafts, `stable_only` (the default) drafts only when the
 *    write targets a stable/hidden page. This applies to report-backed
 *    automation (ingest, compact, and synthesis); authorized chat edits
 *    publish live because chat has no draft-review lifecycle.
 */
async function draftStatusForWrite(args: {
  /** The run owning this write, already fetched by the caller; null for chat. */
  run: { [key: string]: unknown; dispatch?: { skipReview?: boolean } } | null;
  reviewMode: TomeReviewMode | undefined;
  path: string;
  markdown: string;
}): Promise<"live" | "draft"> {
  const run = args.run as {
    quality_policy_mode?: string;
    quality_require_human_review?: boolean;
    dispatch?: { skipReview?: boolean };
  } | null;
  if (run) {
    // Quality-policy enforcement is stronger than both the project setting
    // and a caller's run-level opt-out. createRunRecord also forces
    // skipReview=false for these runs; keep the write path independently
    // defensive so an enforced evaluation can never publish directly live.
    if (
      run?.quality_policy_mode === "enforce" ||
      (run?.quality_policy_mode !== undefined &&
        run.quality_policy_mode !== "off" &&
        run.quality_require_human_review)
    ) {
      return "draft";
    }
    if (run?.dispatch?.skipReview) return "live";
  }

  const mode = args.reviewMode ?? "stable_only";
  if (mode === "none") return "live";
  if (mode === "all") return "draft";
  return isStableWrite(args.path, args.markdown) ? "draft" : "live";
}

// Tombstone a page (soft delete — appends a deleted revision). The agent's
// delete_page tool enforces the protected-class guard (stable/hidden/template)
// before calling; this endpoint is the tombstone op and is agent-token gated.
// No `locked` check: the agent deletes DURING an ingest, which holds the lock.
export const DELETE = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  requireAgentToken(request);
  const { id } = await ctx.params;
  const project = await resolveProject(id);

  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    throw new ApiError("`path` query param is required", 400, "BAD_REQUEST");
  }
  const author = request.nextUrl.searchParams.get("author") || "tome-agent";
  const message = request.nextUrl.searchParams.get("message") || undefined;

  const store = await getPageStore();
  await store.deletePage(project._id, path, { author, message });
  return Response.json({ deleted: true, path });
});
