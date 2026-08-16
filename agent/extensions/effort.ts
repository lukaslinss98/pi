import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/** Thinking levels supported by the current model. */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: Array<{ value: ThinkingLevel; label: string; description: string }> = [
  { value: "off",     label: "Off",        description: "No thinking/reasoning" },
  { value: "minimal", label: "Minimal",    description: "Minimal reasoning" },
  { value: "low",     label: "Low",        description: "Low reasoning effort" },
  { value: "medium",  label: "Medium",     description: "Moderate reasoning effort" },
  { value: "high",    label: "High",       description: "High reasoning effort" },
  { value: "xhigh",   label: "Extra High", description: "Very high reasoning effort" },
  { value: "max",     label: "Maximum",    description: "Maximum reasoning effort" },
];

/**
 * Get the thinking levels the current model supports, mirroring pi's own
 * `getSupportedThinkingLevels` from `@earendil-works/pi-ai`.
 */
function getSupportedLevels(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
} | undefined): ThinkingLevel[] {
  if (!model || !model.reasoning) return ["off"];
  return ALL_LEVELS.map((l) => l.value).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    // null marks a level as explicitly unsupported
    if (mapped === null) return false;
    // xhigh/max require an explicit mapping; they don't fall back to defaults
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("thinking", {
    description: "Set the thinking/reasoning level for the current model",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/thinking requires a TUI session", "error");
        return;
      }

      const current = pi.getThinkingLevel();
      const available = getSupportedLevels(ctx.model);
      const levels = ALL_LEVELS.filter((l) => available.includes(l.value));

      // Build items; mark current level and note unsupported ones
      const items: SelectItem[] = levels.map((l) => ({
        value: l.value,
        label: l.value === current ? `${l.label} ✓` : l.label,
        description: l.description,
      }));

      const modelName = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown";

      const result = await ctx.ui.custom<ThinkingLevel | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();

          // Top border
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          // Title with model name and current level
          const currentLabel = ALL_LEVELS.find((l) => l.value === current)?.label ?? current;
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold(`Thinking Effort`)) +
                theme.fg("dim", `  (${currentLabel})`),
              1,
              0,
            ),
          );
          container.addChild(new Text(theme.fg("muted", modelName), 1, 0));

          // SelectList
          const maxVisible = Math.min(items.length, 10);
          const selectList = new SelectList(items, maxVisible, {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          selectList.onSelect = (item) => done(item.value as ThinkingLevel);
          selectList.onCancel = () => done(null);
          container.addChild(selectList);

          // Help text
          container.addChild(
            new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0),
          );

          // Bottom border
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true },
      );

      if (result && result !== current) {
        pi.setThinkingLevel(result);
        const label = ALL_LEVELS.find((l) => l.value === result)?.label ?? result;
        ctx.ui.notify(`Thinking effort set to ${label}`, "info");
      }
    },
  });
}