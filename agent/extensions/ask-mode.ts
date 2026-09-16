/**
 * Ask Mode Extension
 *
 * Read-only Q&A / brainstorm mode. When enabled, write-capable tools are
 * disabled while read-only tools stay available so the agent can still
 * look at your code to answer questions.
 *
 * - /ask to toggle (or --ask to start in ask mode)
 * - Ctrl+Alt+A to toggle
 * - Footer status shows when ask mode is active
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

// Built-in tools that can write or execute arbitrary commands.
const ASK_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "bash", "powershell"]);

interface AskModeState {
	enabled: boolean;
	toolsBeforeAskMode?: string[];
}

export default function askModeExtension(pi: ExtensionAPI): void {
	let askModeEnabled = false;
	let toolsBeforeAskMode: string[] | undefined;

	pi.registerFlag("ask", {
		description: "Start in ask mode (read-only Q&A, no write tools)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (askModeEnabled) {
			ctx.ui.setStatus("ask-mode", ctx.ui.theme.fg("warning", "💬 ask"));
		} else {
			ctx.ui.setStatus("ask-mode", undefined);
		}
	}

	function enableAskModeTools(): void {
		if (toolsBeforeAskMode === undefined) {
			toolsBeforeAskMode = pi.getActiveTools();
		}
		pi.setActiveTools(toolsBeforeAskMode.filter((name) => !ASK_MODE_DISABLED_TOOLS.has(name)));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforeAskMode ?? pi.getActiveTools());
		toolsBeforeAskMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("ask-mode", {
			enabled: askModeEnabled,
			toolsBeforeAskMode,
		} satisfies AskModeState);
	}

	function toggleAskMode(ctx: ExtensionContext): void {
		askModeEnabled = !askModeEnabled;

		if (askModeEnabled) {
			enableAskModeTools();
			ctx.ui.notify("Ask mode enabled. Write tools disabled (edit, write, bash).", "info");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Ask mode disabled. Full access restored.", "info");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("ask", {
		description: "Toggle ask mode (read-only Q&A, no write tools)",
		handler: (_args, ctx) => {
			toggleAskMode(ctx);
			return Promise.resolve();
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Toggle ask mode",
		handler: (ctx) => {
			toggleAskMode(ctx);
			return Promise.resolve();
		},
	});

	// Belt-and-suspenders: block write tools even if re-enabled mid-turn
	// while ask mode is on (e.g. via dynamic tool loading).
	pi.on("tool_call", (event) => {
		if (!askModeEnabled) return;
		if (!ASK_MODE_DISABLED_TOOLS.has(event.toolName)) return;

		return {
			block: true,
			reason: `Ask mode: ${event.toolName} is disabled. Use /ask to disable ask mode first.`,
		};
	});

	// Tell the model it is in read-only Q&A mode.
	pi.on("before_agent_start", () => {
		if (!askModeEnabled) return;

		return {
			message: {
				customType: "ask-mode-context",
				content: `[ASK MODE ACTIVE]
You are in ask mode - a read-only Q&A / brainstorm mode.

Restrictions:
- edit, write, bash, and powershell tools are disabled
- Read-only tools (read, grep, find, ls) remain available - use them to look at code when answering
- Other currently active extension tools remain available

Answer questions and brainstorm. Do NOT attempt to make changes - just describe what you would do.`,
				display: false,
			},
		};
	});

	// Restore state on session start/resume, honor --ask flag.
	pi.on("session_start", (event, ctx) => {
		if (pi.getFlag("ask") === true && event.reason === "startup") {
			askModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const askModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "ask-mode")
			.pop() as { data?: AskModeState } | undefined;

		if (askModeEntry?.data) {
			askModeEnabled = askModeEntry.data.enabled ?? askModeEnabled;
			toolsBeforeAskMode = askModeEntry.data.toolsBeforeAskMode ?? toolsBeforeAskMode;
		}

		if (askModeEnabled) {
			enableAskModeTools();
		}
		updateStatus(ctx);
	});
}
