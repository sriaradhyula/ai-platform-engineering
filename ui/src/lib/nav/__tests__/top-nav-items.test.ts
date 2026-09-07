import {
  BUILT_IN_TOP_NAV_ITEMS,
  applyTopNavConfig,
} from "@/lib/nav/top-nav-items";

describe("top navigation ordering", () => {
  it("keeps new destinations in their default position with a stale saved order", () => {
    const items = [
      { key: "home" },
      { key: "dynamic-agents" },
      { key: "autonomous" },
      { key: "apps" },
      { key: "admin" },
      { key: "settings" },
    ];

    const result = applyTopNavConfig(items, {
      order: ["home", "dynamic-agents", "apps", "admin"],
      hidden: [],
    });

    expect(result.map((item) => item.key)).toEqual([
      "home",
      "dynamic-agents",
      "autonomous",
      "apps",
      "admin",
      "settings",
    ]);
  });

  it("still honors configured ordering and hidden destinations", () => {
    const items = [
      { key: "home" },
      { key: "chat" },
      { key: "autonomous" },
      { key: "apps" },
    ];

    const result = applyTopNavConfig(items, {
      order: ["apps", "chat", "home"],
      hidden: ["autonomous"],
    });

    expect(result.map((item) => item.key)).toEqual(["apps", "chat", "home"]);
  });

  it("includes Autonomous and Settings in the admin-editable catalog", () => {
    const keys = BUILT_IN_TOP_NAV_ITEMS.map((item) => item.key);

    expect(keys.indexOf("autonomous")).toBeGreaterThan(
      keys.indexOf("dynamic-agents"),
    );
    expect(keys.indexOf("autonomous")).toBeLessThan(keys.indexOf("apps"));
    expect(keys.at(-1)).toBe("settings");
  });
});
