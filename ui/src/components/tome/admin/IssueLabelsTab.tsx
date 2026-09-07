"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  DEFAULT_TOME_ISSUE_LABEL_SETTINGS,
  materializeTomeIssueLabels,
  TOME_ISSUE_LABEL_KEYS,
  type TomeIssueLabelKey,
  type TomeIssueLabelSettings,
} from "@/lib/tome/issue-filter-views";

interface IssueLabelSettingsResponse extends TomeIssueLabelSettings {
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const LABEL_DESCRIPTIONS: Record<TomeIssueLabelKey, string> = {
  critical: "High-priority items that should be visible to leadership.",
  "needs-attention": "Items that are blocked, at risk, or need follow-up.",
  decision: "Decision records and discussions that should remain discoverable.",
};

function copySettings(settings: TomeIssueLabelSettings): TomeIssueLabelSettings {
  return {
    use_prefix: settings.use_prefix,
    labels: Object.fromEntries(
      TOME_ISSUE_LABEL_KEYS.map((key) => [key, { ...settings.labels[key] }]),
    ) as TomeIssueLabelSettings["labels"],
  };
}

export function IssueLabelsTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<IssueLabelSettingsResponse | null>(null);
  const [draft, setDraft] = useState<TomeIssueLabelSettings>(
    copySettings(DEFAULT_TOME_ISSUE_LABEL_SETTINGS),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/tome/admin/issue-labels");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to load issue label settings");
      const next = body.data as IssueLabelSettingsResponse;
      setSettings(next);
      setDraft(copySettings(next));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load issue label settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = useMemo(() => materializeTomeIssueLabels(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings && copySettings(settings));

  const updateLabel = (key: TomeIssueLabelKey, field: "title" | "suffix", value: string) => {
    setDraft((current) => ({
      ...current,
      labels: {
        ...current.labels,
        [key]: { ...current.labels[key], [field]: value },
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tome/admin/issue-labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json();
      if (!response.ok) {
        const details = Array.isArray(body.errors)
          ? `: ${body.errors.map((item: { message?: string }) => item.message).join(" ")}`
          : "";
        throw new Error(`${body.error ?? "Failed to save issue label settings"}${details}`);
      }
      const next = body.data as IssueLabelSettingsResponse;
      setSettings(next);
      setDraft(copySettings(next));
      toast("TOME issue label settings updated", "success");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save issue label settings");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft(copySettings(DEFAULT_TOME_ISSUE_LABEL_SETTINGS));
    setError(null);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Issue labels</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure the GitHub labels TOME uses for its Critical, Needs Attention, and Decisions views.
          These settings apply across all TOME projects.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading issue label settings…
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-card p-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={draft.use_prefix}
                onChange={(event) => setDraft((current) => ({ ...current, use_prefix: event.target.checked }))}
                className="mt-1 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="block text-sm font-medium">Use the `tome:` prefix</span>
                <span className="block text-xs text-muted-foreground">
                  Recommended. A prefix prevents ordinary GitHub labels from being mistaken for TOME views.
                </span>
              </span>
            </label>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              Changing a label keeps the previous value recognized as a legacy alias, so existing GitHub
              issues remain visible while new issues use the updated value.
            </p>
          </div>

          <div className="space-y-3">
            {TOME_ISSUE_LABEL_KEYS.map((key, index) => {
              const label = draft.labels[key];
              const materialized = preview[index];
              return (
                <div key={key} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-3">
                    <h3 className="font-medium">{key === "needs-attention" ? "Needs Attention" : key === "decision" ? "Decisions" : "Critical"}</h3>
                    <p className="text-xs text-muted-foreground">{LABEL_DESCRIPTIONS[key]}</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Display name
                      <Input
                        value={label.title}
                        onChange={(event) => updateLabel(key, "title", event.target.value)}
                        className="mt-1"
                      />
                    </label>
                    <label className="text-xs font-medium text-muted-foreground">
                      GitHub label suffix
                      <Input
                        value={label.suffix}
                        onChange={(event) => updateLabel(key, "suffix", event.target.value)}
                        className="mt-1"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    GitHub label: <code className="font-mono">{materialized.label}</code>
                  </p>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={reset} disabled={!dirty || saving} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Reset draft
            </Button>
            <Button onClick={() => void save()} disabled={!dirty || saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save labels
            </Button>
          </div>
          {settings?.updated_by && (
            <p className="text-right text-xs text-muted-foreground">
              Last edited by {settings.updated_by}
            </p>
          )}
        </>
      )}
    </div>
  );
}
