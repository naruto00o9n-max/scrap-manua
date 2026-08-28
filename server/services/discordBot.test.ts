import { describe, expect, it } from "vitest";
import { buildJobComponents, getRegisteredDiscordCommands } from "./discordBot";

describe("Discord public chapter experience", () => {
  it("registers only public chapter/help commands and no status command", () => {
    const names = getRegisteredDiscordCommands().map(command => command.name);
    expect(names).toEqual(["فصل", "chapter", "مساعدة", "help"]);
    expect(names).not.toContain("حالة");
  });

  it("builds a Components V2 container with a black neutral progress state", () => {
    const [container] = buildJobComponents({ status: "uploading", title: "طلب فصل", description: "جارٍ الرفع", pageCount: 25, uploadedPages: 4 });
    expect(container.type).toBe(17);
    expect((container as { accent_color?: number }).accent_color).toBe(0x000000);
  });

  it("uses color only for terminal success/failure states", () => {
    const [success] = buildJobComponents({ status: "completed", title: "طلب فصل", description: "اكتمل", driveUrl: "https://drive.google.com/drive/folders/test" });
    const [failure] = buildJobComponents({ status: "failed", title: "طلب فصل", description: "فشل" });
    expect((success as { accent_color?: number }).accent_color).toBe(0x57f287);
    expect((failure as { accent_color?: number }).accent_color).toBe(0xed4245);
  });
});
