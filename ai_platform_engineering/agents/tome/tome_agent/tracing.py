"""Optional Langfuse tracing for Claude Agent SDK executions.

The instrumentation is deliberately process-level: once enabled, it covers
all SDK entry points used by chat, ingest, compaction, synthesis, evaluation,
model checks, and presentation generation. Missing tracing credentials never
prevent the agent from starting, which keeps local development and existing
deployments backward compatible until tracing is configured.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from opentelemetry import trace as trace_api

log = logging.getLogger("tome_agent.tracing")

_client: Any | None = None
_instrumented = False


def _base_url() -> str:
    """Return the current SDK base-url setting, supporting the legacy name."""
    return os.environ.get("LANGFUSE_BASE_URL", "").strip() or os.environ.get(
        "LANGFUSE_HOST", ""
    ).strip()


def _enabled_by_configuration() -> bool:
    """Check whether the deployment supplied enough settings to trace."""
    flag = os.environ.get("LANGFUSE_TRACING_ENABLED", "true").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    return bool(
        os.environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
        and os.environ.get("LANGFUSE_SECRET_KEY", "").strip()
        and _base_url()
    )


def initialize_tracing() -> None:
    """Install Claude Agent SDK instrumentation when Langfuse is configured.

    Tracing is best-effort. A telemetry package/configuration problem is
    logged and isolated so it cannot take the Tome API out of service.
    """
    global _client, _instrumented

    if _instrumented:
        return
    if not _enabled_by_configuration():
        log.info(
            "Langfuse tracing disabled; set LANGFUSE_PUBLIC_KEY, "
            "LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL to enable it"
        )
        return

    try:
        # Keep the legacy alias working for existing deployments while using
        # the current Langfuse SDK setting internally.
        os.environ.setdefault("LANGFUSE_BASE_URL", _base_url())

        from langfuse import get_client
        from openinference.instrumentation.claude_agent_sdk import (
            ClaudeAgentSDKInstrumentor,
        )

        _client = get_client()
        ClaudeAgentSDKInstrumentor().instrument()
        _instrumented = True
        log.info("Langfuse tracing enabled for Claude Agent SDK")
    except Exception:
        _client = None
        log.exception("Unable to initialize Langfuse tracing; continuing without it")


def flush_tracing() -> None:
    """Flush queued spans during graceful process shutdown."""
    if _client is None:
        return
    try:
        _client.flush()
    except Exception:
        log.exception("Unable to flush Langfuse spans during shutdown")


def rename_current_span(
    name: str,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict[str, str] | None = None,
    tags: list[str] | None = None,
) -> None:
    """Name the active span and apply trace identity to the SDK span."""
    span = trace_api.get_current_span()
    if not span.is_recording():
        return
    try:
        span.update_name(name)
        span.set_attribute("langfuse.trace.name", name)
        if user_id:
            span.set_attribute("user.id", user_id)
        if session_id:
            span.set_attribute("session.id", session_id)
        if tags:
            span.set_attribute("langfuse.trace.tags", tags)
        for key, value in (metadata or {}).items():
            if value:
                # Set both forms because the active span is also the trace
                # root for the OpenInference Claude SDK instrumentor.
                span.set_attribute(f"langfuse.trace.metadata.{key}", value[:200])
                span.set_attribute(f"langfuse.observation.metadata.{key}", value[:200])
    except Exception:
        log.exception("Unable to update current Langfuse span")


@contextmanager
def trace_context(
    *,
    snapshot: Any,
    actor_email: str | None = None,
    session_id: str | None = None,
    operation: str = "agent",
) -> Iterator[None]:
    """Attach Tome request identity and project context to SDK traces."""
    if not _instrumented:
        yield
        return

    from langfuse import propagate_attributes

    project_type = str(getattr(snapshot, "project_type", "project"))
    project_name = str(getattr(snapshot, "name", ""))
    trace_name = f"Tome - {project_name}" if project_name else "Tome Agent"
    trace_name = trace_name[:200]
    child_projects = getattr(snapshot, "child_projects", None) or []
    child_names = ", ".join(
        str(getattr(child, "name", ""))
        for child in child_projects
        if getattr(child, "name", "")
    )
    metadata: dict[str, str] = {
        "tome_project_id": str(getattr(snapshot, "project_id", "")),
        "tome_project_slug": str(getattr(snapshot, "slug", "")),
        "tome_project_name": project_name,
        "tome_project_type": project_type,
        "tome_bhag_or_area": project_name if project_type in {"bhag", "area"} else "",
        "tome_child_projects": child_names,
        "tome_actor_email": actor_email or "",
        "tome_operation": operation,
        "tome_sdk_operation": "ClaudeAgentSDK.ClaudeSDKClient.receive_response",
    }
    # Langfuse limits propagated metadata values to 200 characters.
    metadata = {key: value[:200] for key, value in metadata.items() if value}

    tags = ["tome", f"tome:{project_type}", f"tome:{operation}"]
    with propagate_attributes(
        user_id=actor_email,
        session_id=session_id,
        metadata=metadata,
        tags=tags,
        trace_name=trace_name,
    ):
        # Give the request a concrete Langfuse root. This makes the trace-level
        # identity and metadata reliable even when the Claude SDK creates its
        # instrumented span from another async context.
        with _client.start_as_current_observation(
            name=trace_name,
            as_type="agent",
            metadata=metadata,
        ):
            yield


def tracing_enabled() -> bool:
    """Expose the effective instrumentation state for health/tests."""
    return _instrumented
