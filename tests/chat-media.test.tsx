import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../src/client/ChatTranscript";

describe("inline images", () => {
  it("renders /api/media images and refuses external ones", () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        calls={[]}
        messages={
          [
            { id: "1", role: "assistant", content: "![arch](/api/media/a.png) and ![x](https://evil.example/t.png)" },
          ] as never
        }
      />,
    );
    expect(html).toContain("class=\"chat-media\"");
    expect(html).toContain("src=\"/api/media/a.png\"");
    expect(html).not.toContain("evil.example");
  });
});
