import { act, render, screen, waitFor } from "@testing-library/react";

import { AgenticAppShell } from "../AgenticAppShell";

const mockGetAgenticApps = jest.fn();
const mockGetSettings = jest.fn();
const mockResolveUsableChatAgent = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    getAgenticApps: () => mockGetAgenticApps(),
    getSettings: () => mockGetSettings(),
  },
}));

jest.mock("@/lib/chat-agent-selection", () => ({
  resolveUsableChatAgent: (options: unknown) => mockResolveUsableChatAgent(options),
}));

jest.mock("../AgenticAppAssistantOverlay", () => ({
  AgenticAppAssistantOverlay: ({
    assistantLabel,
    activeContext,
    open,
  }: {
    assistantLabel?: string;
    activeContext: { title?: string } | null;
    open: boolean;
  }) => (
    <div
      data-testid="assistant-overlay"
      data-open={String(open)}
      data-context={activeContext?.title ?? ""}
    >
      {assistantLabel ?? "Ask CAIPE"}
    </div>
  ),
}));

function app(overrides: Record<string, unknown> = {}) {
  return {
    appId: "example-app",
    displayName: "Example App",
    description: "Example description",
    href: "/apps/example-app",
    canLaunch: true,
    surfaces: { showInHub: true },
    ...overrides,
  };
}

describe("AgenticAppShell", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAgenticApps.mockResolvedValue({
      items: [
        app({
          assistantEnabled: true,
          assistantAgentId: "agent-example",
          assistantAgentName: "Example Agent",
          assistantLabel: "Ask Example",
        }),
      ],
    });
    mockGetSettings.mockResolvedValue({
      preferences: {
        agentic_app_preferences: {},
        theme: "dark",
      },
    });
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-example",
      name: "Example Agent",
      source: "configured",
    });
  });

  it("renders the app and its configured assistant without a second breadcrumb row", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTitle("Example App")).toHaveAttribute(
      "src",
      "/apps/example-app",
    );
    expect(await screen.findByTestId("assistant-overlay")).toHaveTextContent("Ask Example");
    expect(screen.queryByRole("link", { name: "Apps" })).not.toBeInTheDocument();
    expect(mockResolveUsableChatAgent).toHaveBeenCalledWith({
      requestedAgentId: "agent-example",
      requireAvailableAgent: true,
    });
  });

  it("opens the assistant and accepts bounded context from its own iframe", async () => {
    render(<AgenticAppShell appId="example-app" path={[]} />);

    const iframe = (await screen.findByTitle("Example App")) as HTMLIFrameElement;
    const overlay = await screen.findByTestId("assistant-overlay");
    expect(overlay).toHaveAttribute("data-open", "false");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: {
            type: "caipe.agenticApp.context.v1",
            version: "1.0",
            appId: "example-app",
            context: {
              route: "/apps/example-app",
              title: "Selected dashboard context",
            },
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: {
            type: "caipe.agenticApp.assistant.open.v1",
            version: "1.0",
            appId: "example-app",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(overlay).toHaveAttribute("data-open", "true");
      expect(overlay).toHaveAttribute("data-context", "Selected dashboard context");
    });
  });

  it("uses an available default agent when an app does not specify one", async () => {
    mockGetAgenticApps.mockResolvedValue({ items: [app()] });
    mockResolveUsableChatAgent.mockResolvedValue({
      id: "agent-default",
      name: "Default Agent",
      source: "platform-default",
    });

    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTestId("assistant-overlay")).toHaveTextContent("Ask CAIPE");
    expect(mockResolveUsableChatAgent).toHaveBeenCalledWith({
      requestedAgentId: undefined,
      requireAvailableAgent: true,
    });
  });

  it("does not resolve or render an assistant when the app disables it", async () => {
    mockGetAgenticApps.mockResolvedValue({
      items: [app({ assistantEnabled: false })],
    });

    render(<AgenticAppShell appId="example-app" path={[]} />);

    expect(await screen.findByTitle("Example App")).toBeInTheDocument();
    await waitFor(() => expect(mockResolveUsableChatAgent).not.toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-overlay")).not.toBeInTheDocument();
  });
});
