import type { PageRevision } from "@/types/tome";

/** Latest revision visible to readers; review-only drafts do not participate. */
export function currentLiveRevision(
  revisions: readonly PageRevision[],
): PageRevision | undefined {
  return revisions.find(
    (revision) => revision.status !== "draft" && revision.status !== "rejected",
  );
}

export function hasPageEditConflict(
  revisions: readonly PageRevision[],
  baseRevisionId: string | null,
): boolean {
  const current = currentLiveRevision(revisions);
  return (current?._id ? String(current._id) : null) !== baseRevisionId;
}
