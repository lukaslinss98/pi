/**
 * Startup Header Extension
 *
 * Replaces the built-in header with a boxed startup screen (v0.80-era style):
 *
 *   ── Pi vX.Y.Z ─────────────────────────────────────────────┐
 *   │                                              │          │
 *   │                 [blocky pi logo]             │  Current context
 *   │                                              │  ~/Workspace/mypi
 *   │        Let's build something great           │  New session
 *   │     provider/model · high effort             │  0 / 128k tokens
 *   │               ~/Workspace/mypi               │
 *   └──────────────────────────────────────────────┘
 *
 * All colors come from the active theme (accent / muted / dim / text), so it
 * adapts automatically when the theme changes.
 *
 * /builtin-header restores the default header.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

// --- Blocky pi logo (accent-colored) ---
// Solid "P"-like block with a square hole, plus a small block at lower right.
const LOGO = [
  "██████  ",
  "██  ██  ",
  "████  ██",
  "██    ██",
];

/** Visible-width-aware right padding. */
function padEnd(line: string, width: number): string {
  const w = visibleWidth(line);
  return w >= width ? line : line + " ".repeat(width - w);
}

/** Center a line within width (visible-width-aware). */
function center(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return line;
  const left = Math.floor((width - w) / 2);
  return " ".repeat(left) + line + " ".repeat(width - w - left);
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function buildHeaderLines(theme: Theme, ctx: ExtensionContext, pi: ExtensionAPI, width: number): string[] {
  const accent = (s: string) => theme.fg("accent", s);
  const muted = (s: string) => theme.fg("muted", s);
  const dim = (s: string) => theme.fg("dim", s);
  const text = (s: string) => theme.fg("text", s);
  const bold = (s: string) => theme.bold(s);

  // Inner span between the box's side borders.
  const innerWidth = Math.max(width - 6, 20);

  // --- Left column: logo + tagline + model + cwd ---
  const model = ctx.model;
  const modelLine = model
    ? `${model.provider}/${model.id} · ${ctx.thinkingLevel} effort`
    : "no model selected";
  const leftContent: string[] = [
    "",
    ...LOGO.map((l) => accent(l)),
    "",
    bold(text("Let's build something great")),
    muted(modelLine),
    dim(shortenCwd(ctx.cwd)),
    "",
  ];

  // --- Right column: active project and session context ---
  const usage = ctx.getContextUsage();
  const contextWindow = model?.contextWindow;
  const contextLine = usage?.tokens !== null && usage?.tokens !== undefined && contextWindow
    ? `${formatTokens(usage.tokens)} / ${formatTokens(contextWindow)} tokens`
    : contextWindow
      ? `0 / ${formatTokens(contextWindow)} tokens`
      : "context usage unavailable";
  const sessionName = pi.getSessionName() ?? "New session";

  // Narrow terminals: skip the right panel.
  const showRightPanel = width >= 90;
  // Row layout: " " + left + "  " + "│" + "  " + right  (= innerWidth chars)
  const rightWidth = 34;
  const leftWidth = showRightPanel ? innerWidth - 6 - rightWidth : innerWidth - 2;

  const rightContent: string[] = [
    "",
    "",
    bold(accent("Current context")),
    muted(shortenCwd(ctx.cwd)),
    "",
    dim("─".repeat(rightWidth - 1)),
    "",
    muted(sessionName),
    dim(contextLine),
  ];

  // Vertically center the shorter column; 1 blank row of top/bottom padding.
  const contentHeight = Math.max(leftContent.length, rightContent.length);
  const leftPad = Math.floor((contentHeight - leftContent.length) / 2);
  const rightPad = Math.floor((contentHeight - rightContent.length) / 2);
  const leftLines = [...Array<string>(leftPad).fill(""), ...leftContent];
  const rightLines = [...Array<string>(rightPad).fill(""), ...rightContent];

  const height = contentHeight + 2; // top + bottom padding rows
  const rows: string[] = [];
  for (let i = 0; i < height; i++) {
    const left = center(leftLines[i - 1] ?? "", leftWidth);
    if (showRightPanel) {
      const right = padEnd(rightLines[i - 1] ?? "", rightWidth);
      rows.push(` ${left}  ${accent("│")}  ${right}`);
    } else {
      rows.push(` ${left} `);
    }
  }

  // --- Assemble box ---
  const title = accent(bold(` Pi v${VERSION} `));
  // ┌─ + title + ─…─┐  (total visible width: innerWidth + 2)
  const fillWidth = Math.max(innerWidth - visibleWidth(title) - 1, 0);
  const top = accent("┌─") + title + accent(`${"─".repeat(fillWidth)}┐`);
  const bottom = accent(`└${"─".repeat(innerWidth)}┘`);

  const lines = [top, ...rows.map((r) => `${accent("│")}${r}${accent("│")}`), bottom, ""];
  return lines;
}

export default function (pi: ExtensionAPI) {
  const applyHeader = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme): Component => {
      return {
        render(width: number): string[] {
          return buildHeaderLines(theme, ctx, pi, width);
        },
        invalidate() { },
      };
    });
  };

  pi.on("session_start", (_event, ctx) => applyHeader(ctx));

  // Refresh the header when the model or thinking level changes.
  pi.on("model_select", (_event, ctx) => applyHeader(ctx));
  pi.on("thinking_level_select", (_event, ctx) => applyHeader(ctx));
  pi.on("session_info_changed", (_event, ctx) => applyHeader(ctx));

  pi.registerCommand("builtin-header", {
    description: "Restore the built-in header",
    // eslint-disable-next-line @typescript-eslint/require-await -- signature requires Promise
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
