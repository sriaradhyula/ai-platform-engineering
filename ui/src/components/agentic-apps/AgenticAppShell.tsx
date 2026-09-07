"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgenticAppAssistantOverlay } from "@/components/agentic-apps/AgenticAppAssistantOverlay";
import { apiClient, type AgenticAppListItem } from "@/lib/api-client";
import { validateAssistantContextMessage } from "@/lib/agentic-apps/assistant-context";
import { buildAgenticAppPublicPath } from "@/lib/agentic-apps/runtime";
import {
  resolveUsableChatAgent,
  type ResolvedChatAgent,
} from "@/lib/chat-agent-selection";
import { createMicrofrontendInitializeMessage } from "@/packages/agentic-app-sdk";
import type {
  AgenticAppAssistantContextRecord,
  AgenticAppManifest,
} from "@/types/agentic-app";

type PreferenceValue = boolean | number | string;
type AppPreferences = Record<string, PreferenceValue>;
type AppPreferencesById = Record<string, AppPreferences>;

type ShellState =
  | { status: "loading" }
  | { status: "ready"; app: AgenticAppListItem }
  | { status: "error"; title: string; message: string };

export function AgenticAppShell({
  appId,
  path = [],
}: {
  appId: string;
  path?: string[];
}): React.ReactElement {
  const searchParams = useSearchParams();
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const [assistantContext, setAssistantContext] =
    useState<AgenticAppAssistantContextRecord | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantBinding, setAssistantBinding] = useState<{
    bindingKey: string;
    agent: ResolvedChatAgent;
  } | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>({});
  const [theme, setTheme] = useState<"dark" | "light" | "system">("system");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const requestedAgentId = state.status === "ready" ? state.app.assistantAgentId : undefined;
  const assistantBindingKey = `${appId}:${requestedAgentId ?? "default"}`;
  const assistantAgent =
    assistantBinding?.bindingKey === assistantBindingKey ? assistantBinding.agent : null;
  const assistantConfigured =
    state.status === "ready" && state.app.assistantEnabled !== false;
  const assistantEnabled = assistantConfigured && assistantAgent !== null;

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      apiClient.getAgenticApps(),
      apiClient.getSettings().catch(() => null),
    ])
      .then(([payload, settings]) => {
        if (cancelled) return;
        const app = payload.items.find((candidate) => candidate.appId === appId);
        if (!app) {
          setState({
            status: "error",
            title: "App not found",
            message: "This App is not installed or visible.",
          });
          return;
        }
        if (!app.canLaunch) {
          setState({
            status: "error",
            title: "Access required",
            message: `You do not have permission to open ${app.displayName}.`,
          });
          return;
        }

        const preferencesByApp = normalizePreferencesByApp(
          settings?.preferences.agentic_app_preferences,
        );
        setPreferences(resolvePreferences(app.ui?.preferences, preferencesByApp[appId]));
        setTheme(normalizeTheme(settings?.preferences.theme));
        setState({ status: "ready", app });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof Error && /\bHTTP 401\b|Unauthorized/i.test(error.message)) {
          window.location.assign(
            `/login?callbackUrl=${encodeURIComponent(
              window.location.pathname + window.location.search,
            )}`,
          );
          return;
        }
        setState({
          status: "error",
          title: "Could not open App",
          message: error instanceof Error ? error.message : "Unexpected error",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [appId]);

  useEffect(() => {
    let cancelled = false;
    if (!assistantConfigured) return () => undefined;

    resolveUsableChatAgent({
      requestedAgentId,
      requireAvailableAgent: true,
    })
      .then((agent) => {
        if (!cancelled) setAssistantBinding({ bindingKey: assistantBindingKey, agent });
      })
      .catch((error: unknown) => {
        console.warn(
          `[AgenticAppShell] Contextual assistant unavailable for ${appId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [appId, assistantBindingKey, assistantConfigured, requestedAgentId]);

  const publishHostContext = useCallback((): void => {
    const target = iframeRef.current?.contentWindow;
    if (!target || state.status !== "ready") return;
    target.postMessage(
      createMicrofrontendInitializeMessage(appId, {
        surface: "hosted",
        route: window.location.pathname,
        theme,
        locale: navigator.language || "en-US",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        preferences,
      }),
      window.location.origin,
    );
  }, [appId, preferences, state.status, theme]);

  useEffect(() => {
    publishHostContext();
  }, [publishHostContext]);

  useEffect(() => {
    if (!assistantConfigured) return;

    function onMessage(event: MessageEvent): void {
      const expectedSource = iframeRef.current?.contentWindow ?? null;
      if (event.origin !== window.location.origin || event.source !== expectedSource) return;

      if (isAssistantOpenMessage(event.data, appId)) {
        setAssistantOpen(true);
        return;
      }

      const result = validateAssistantContextMessage({
        message: event.data,
        appId,
        origin: event.origin,
        expectedOrigin: window.location.origin,
        source: event.source,
        expectedSource,
      });
      if (result.ok) setAssistantContext(result.record);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, assistantConfigured]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle
          className="h-6 w-6 animate-spin text-muted-foreground"
          aria-label="Loading App"
        />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border p-8 text-center">
          <h1 className="text-xl font-semibold">{state.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <Link
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary"
            href="/apps"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Apps
          </Link>
        </div>
      </div>
    );
  }

  const query = searchParams.toString();
  const runtimePath = `${buildAgenticAppPublicPath(appId, path)}${query ? `?${query}` : ""}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        ref={iframeRef}
        onLoad={publishHostContext}
        className="min-h-0 flex-1 border-0 bg-background"
        src={runtimePath}
        title={state.app.displayName}
        allow="clipboard-read; clipboard-write"
      />
      {assistantEnabled ? (
        <AgenticAppAssistantOverlay
          appId={state.app.appId}
          appName={state.app.displayName}
          assistantLabel={state.app.assistantLabel}
          assistantAgentName={state.app.assistantAgentName}
          activeContext={assistantContext}
          onClearContext={() => setAssistantContext(null)}
          assistantAgentId={assistantAgent.id}
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
        />
      ) : null}
    </div>
  );
}

function isAssistantOpenMessage(message: unknown, appId: string): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    "version" in message &&
    "appId" in message &&
    message.type === "caipe.agenticApp.assistant.open.v1" &&
    message.version === "1.0" &&
    message.appId === appId
  );
}

function resolvePreferences(
  schema: NonNullable<AgenticAppManifest["ui"]>["preferences"] | undefined,
  stored: AppPreferences | undefined,
): AppPreferences {
  if (!schema) return {};
  return Object.fromEntries(
    schema.fields.map((field) => {
      const value = stored?.[field.key];
      return [field.key, isPreferenceValueValid(field, value) ? value : field.default];
    }),
  );
}

function isPreferenceValueValid(
  field: NonNullable<NonNullable<AgenticAppManifest["ui"]>["preferences"]>["fields"][number],
  value: unknown,
): value is PreferenceValue {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.min === undefined || value >= field.min) &&
      (field.max === undefined || value <= field.max)
    );
  }
  if (field.type === "string") return typeof value === "string";
  return (
    typeof value === "string" &&
    Boolean(field.options?.some((option) => option.value === value))
  );
}

function normalizePreferencesByApp(value: unknown): AppPreferencesById {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as AppPreferencesById;
}

function normalizeTheme(value: unknown): "dark" | "light" | "system" {
  return value === "dark" || value === "light" ? value : "system";
}
