import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useChatStore } from "@/store/chat-store";
import type { Conversation } from "@/types/a2a";

import { AgenticAppAssistantOverlay } from "../AgenticAppAssistantOverlay";

const mockCreateConversation = jest.fn();
const mockDeleteConversation = jest.fn();
const mockLoadConversationsFromServer = jest.fn();
const mockLoadMessagesFromServer = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockChatStoreState: {
  activeConversationId: string | null;
  conversations: Conversation[];
  createConversation: typeof mockCreateConversation;
  deleteConversation: typeof mockDeleteConversation;
  loadConversationsFromServer: typeof mockLoadConversationsFromServer;
  loadMessagesFromServer: typeof mockLoadMessagesFromServer;
  setActiveConversation: typeof mockSetActiveConversation;
} = {
  activeConversationId: "previous-conversation",
  conversations: [],
  createConversation: mockCreateConversation,
  deleteConversation: mockDeleteConversation,
  loadConversationsFromServer: mockLoadConversationsFromServer,
  loadMessagesFromServer: mockLoadMessagesFromServer,
  setActiveConversation: mockSetActiveConversation,
};

jest.mock("@/store/chat-store", () => ({ useChatStore: jest.fn() }));

jest.mock("@/components/chat/DynamicAgentChatPanel", () => ({
  ChatPanel: ({
    conversationId,
    agentId,
  }: {
    conversationId?: string;
    agentId: string;
  }) => (
    <div
      data-testid="chat-panel"
      data-conversation-id={conversationId}
      data-agent-id={agentId}
    />
  ),
}));

describe("AgenticAppAssistantOverlay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockChatStoreState.activeConversationId = "previous-conversation";
    mockChatStoreState.conversations = [];
    mockCreateConversation.mockResolvedValue("assistant-conversation");
    mockDeleteConversation.mockResolvedValue(undefined);
    mockLoadConversationsFromServer.mockResolvedValue(undefined);
    mockLoadMessagesFromServer.mockResolvedValue(undefined);
    const mockUseChatStore = useChatStore as unknown as jest.Mock & {
      getState: () => typeof mockChatStoreState;
    };
    mockUseChatStore.mockImplementation(
      (selector: (state: typeof mockChatStoreState) => unknown) => selector(mockChatStoreState),
    );
    mockUseChatStore.getState = () => mockChatStoreState;
  });

  afterEach(() => jest.restoreAllMocks());

  it("creates an isolated assistant conversation before mounting chat", async () => {
    const { unmount } = render(
      <AgenticAppAssistantOverlay
        appId="weather"
        appName="Weather Lab"
        assistantLabel="Ask Weather"
        assistantAgentName="Weather Agent"
        activeContext={null}
        onClearContext={jest.fn()}
        assistantAgentId="agent-weather"
        open
        onOpenChange={jest.fn()}
      />,
    );

    expect(screen.getByText("Starting Ask Weather…")).toBeInTheDocument();
    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith("agent-weather", {
        title: "Weather Lab Assistant",
        metadata: {
          conversation_surface: "agentic-app",
          agentic_app_id: "weather",
          agentic_app_agent_id: "agent-weather",
        },
      });
    });

    const chat = await screen.findByTestId("chat-panel");
    expect(chat).toHaveAttribute("data-conversation-id", "assistant-conversation");
    expect(chat).toHaveAttribute("data-agent-id", "agent-weather");

    unmount();
    await waitFor(() => {
      expect(mockSetActiveConversation).toHaveBeenCalledWith("previous-conversation");
    });
  });

  it("restores the latest matching app conversation from chat history", async () => {
    mockChatStoreState.conversations = [
      makeConversation("older", "2026-01-01T00:00:00.000Z"),
      makeConversation("latest", "2026-02-01T00:00:00.000Z"),
    ];

    renderWeatherOverlay();

    const chat = await screen.findByTestId("chat-panel");
    expect(chat).toHaveAttribute("data-conversation-id", "latest");
    expect(mockCreateConversation).not.toHaveBeenCalled();
    expect(mockLoadMessagesFromServer).toHaveBeenCalledWith("latest");
  });

  it("starts a new chat while retaining the prior conversation in history", async () => {
    mockCreateConversation
      .mockResolvedValueOnce("assistant-conversation")
      .mockResolvedValueOnce("new-assistant-conversation");
    renderWeatherOverlay();
    await screen.findByTestId("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "Start new assistant chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "new-assistant-conversation",
      );
    });
    expect(mockDeleteConversation).not.toHaveBeenCalled();
  });

  it("moves a cleared chat to Trash before starting a replacement", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    mockCreateConversation
      .mockResolvedValueOnce("assistant-conversation")
      .mockResolvedValueOnce("replacement-conversation");
    renderWeatherOverlay();
    await screen.findByTestId("chat-panel");

    fireEvent.click(screen.getByRole("button", { name: "Clear assistant chat" }));

    await waitFor(() => {
      expect(mockDeleteConversation).toHaveBeenCalledWith("assistant-conversation");
      expect(screen.getByTestId("chat-panel")).toHaveAttribute(
        "data-conversation-id",
        "replacement-conversation",
      );
    });
  });
});

function renderWeatherOverlay() {
  return render(
    <AgenticAppAssistantOverlay
      appId="weather"
      appName="Weather Lab"
      assistantLabel="Ask Weather"
      assistantAgentName="Weather Agent"
      activeContext={null}
      onClearContext={jest.fn()}
      assistantAgentId="agent-weather"
      open
      onOpenChange={jest.fn()}
    />,
  );
}

function makeConversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: "Weather Lab Assistant",
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    messages: [],
    streamEvents: [],
    participants: [{ type: "agent", id: "agent-weather" }],
    metadata: {
      conversation_surface: "agentic-app",
      agentic_app_id: "weather",
      agentic_app_agent_id: "agent-weather",
    },
  };
}
