# GitHub Projects V2 status synchronization

TOME accepts GitHub's organization-level `projects_v2_item` webhook and uses
the current Project V2 Status value as the issue-board status in CAIPE. The
existing repository webhook remains responsible for issue, label, discussion,
and pull-request events.

## GitHub configuration

Configure the CAIPE GitHub App or organization webhook with:

- Organization **Projects: read** permission.
- The `projects_v2_item` event.
- The environment callback URL, either
  `https://webhook-event-receiver.preview.outshift.io/github` or
  `https://webhook-event-receiver.prod.outshift.io/github`.
- The same HMAC secret configured in that environment's Vault path.

`projects_v2_item` is organization-only and cannot be added to the
repository-hook installer. The gateway and CAIPE endpoint are shared with the
existing repository webhook path.

## Status mapping

TOME recognizes these Project V2 Status aliases:

- `Todo`, `Backlog`, `Open`, or `Not started` → Open
- `In progress`, `Doing`, `Active`, or `Started` → In progress
- `Done`, `Completed`, `Resolved`, or `Closed` → Resolved

The Project V2 status is stored as a cache override, while issue labels remain
the fallback when no Project V2 status has been received. The cache generation
is advanced after the update, so the existing SSE connection refreshes the
board without a manual page reload. A matching Feed event is also emitted.

The CAIPE deployment token (`TOME_GITHUB_TOKEN`, falling back to `GITHUB_TOKEN`)
must be able to read the issue and organization Project V2 data. If it is not
configured or lacks Projects permission, the durable event retries and is
reported by the event worker rather than being silently acknowledged.
