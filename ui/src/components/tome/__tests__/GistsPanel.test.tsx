import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GistsPanel } from "../GistsPanel";

describe("GistsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { gists: [] } }),
    }) as jest.Mock;
  });

  it("lets project readers start a new gist without steward access", async () => {
    const onNewGist = jest.fn();
    render(
      <GistsPanel
        slug="example-project"
        canEdit={false}
        onOpenGist={jest.fn()}
        onNewGist={onNewGist}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New gist" }));
    expect(onNewGist).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });
});
