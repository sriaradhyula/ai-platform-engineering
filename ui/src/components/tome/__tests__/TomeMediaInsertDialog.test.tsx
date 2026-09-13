import { fireEvent, render, screen } from "@testing-library/react";

import { TomeMediaInsertDialog } from "../TomeMediaInsertDialog";

const PLAYLIST_ID = "daa5d80c-9272-4587-989b-91d6c5f35b93";

describe("TomeMediaInsertDialog", () => {
  it("exposes and persists the Vidcast playlist expansion preference", () => {
    const onInsert = jest.fn();
    render(
      <TomeMediaInsertDialog
        open
        onOpenChange={jest.fn()}
        onInsert={onInsert}
      />,
    );

    fireEvent.change(screen.getByLabelText("Video or playlist URL"), {
      target: { value: `https://app.vidcast.io/playlists/${PLAYLIST_ID}` },
    });

    const toggle = screen.getByRole("switch", { name: "Show playlist videos" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(onInsert).toHaveBeenCalledWith(
      `\n\n\`\`\`vidcast\nurl: https://app.vidcast.io/playlists/${PLAYLIST_ID}?expand=0\n\`\`\`\n\n`,
    );
  });
});
