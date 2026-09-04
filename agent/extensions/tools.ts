import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tools", {
    description: "Show available tools",
    handler: async (_, ctx) => {
      // Wait for the agent to be idle before showing the tool list
      await ctx.waitForIdle();

      const options = ctx.getSystemPromptOptions();
      const selected = options?.selectedTools ?? [];
      const snippets = options?.toolSnippets ?? {};

      if (selected.length === 0) {
        ctx.ui.notify("No tools currently available.", "warning");
        return;
      }

      // Format as multi-line notification with short descriptions (truncated to 40 chars)
      const lines = selected.map((name, i) => {
        const snippet = snippets[name] || "(no description)";
        const shortSnippet = snippet.length > 40 ? 
          snippet.substring(0, 37) + "..." : snippet;
        return `${i + 1}. ${name} — ${shortSnippet}`;
      });
      
      ctx.ui.notify(
        `Available tools (${selected.length})\n\n${lines.join("\n")}`,
        "info"
      );
    },
  });
}