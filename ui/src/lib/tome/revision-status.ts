import type { PageRevision } from "@/types/tome";

/** Latest revision visible to wiki readers; history is already newest first. */
export function currentLiveRevision(
  revisions: readonly PageRevision[],
): PageRevision | undefined {
  return revisions.find(
    (revision) => revision.status === undefined || revision.status === "live",
  );
}
