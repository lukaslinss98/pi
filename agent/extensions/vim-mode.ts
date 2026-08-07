import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchesKey, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const SETTINGS_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");

type PiSettings = Record<string, unknown> & { vimMode?: boolean };

async function loadEnabledSetting(): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as PiSettings;
    return settings.vimMode !== false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function saveEnabledSetting(enabled: boolean): Promise<void> {
  const settings = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as PiSettings;
  settings.vimMode = enabled;
  const temporaryPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, SETTINGS_PATH);
}

type Mode = "normal" | "insert";
type Operator = "change" | "delete" | "yank";
type FindKind = "f" | "F" | "t" | "T";

/** Strip SGR color sequences (border lines arrive pre-colored by the theme). */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * A rule line is made of border glyphs only: ─, spaces, and pi's scroll
 * indicator text ("↑ 3 more"). Content lines virtually never match this —
 * the ─ character cannot be typed from a keyboard.
 */
function isRuleLine(line: string): boolean {
  const plain = stripSgr(line);
  return plain.includes("─") && /^[─ ↑↓0-9more]*$/.test(plain);
}

/**
 * A modal editor for Pi's prompt.
 *
 * Normal-mode support: counts; h/j/k/l, w/b/e, 0/^/$, gg/G, f/F/t/T;
 * i/a/I/A/o/O; x/X/D/C/s/S/r; d/c/y with common motions; p/P; and u.
 * Insert mode delegates all input to Pi's normal editor, retaining completion,
 * history, paste handling, and application shortcuts.
 */
class VimEditor extends CustomEditor {
  private mode: Mode = "normal";
  private count = "";
  private operator?: Operator;
  private findKind?: FindKind;
  private register = "";
  private getUiTheme: () => Theme;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, getUiTheme: () => Theme) {
    // paddingX 1 keeps one space between the side borders and the text.
    super(tui, theme, keybindings, { paddingX: 1 });
    this.getUiTheme = getUiTheme;
  }

  handleInput(data: string): void {
    if (this.handleEscape(data)) return;
    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }
    if (this.handlePendingFind(data) || this.handleCount(data) || this.handleOperator(data)) return;

    const count = this.consumeCount();
    switch (data) {
      case "h": return this.repeat("\x1b[D", count);
      case "j": return this.repeat("\x1b[B", count);
      case "k": return this.repeat("\x1b[A", count);
      case "l": return this.repeat("\x1b[C", count);
      case "w": return this.repeat("\x1b[1;3C", count);
      case "b": return this.repeat("\x1b[1;3D", count);
      case "e": return this.moveToWordEnd(count);
      case "0": return this.repeat("\x01", 1);
      case "^": return this.moveToFirstNonBlank();
      case "$": return this.repeat("\x05", 1);
      case "g": return this.handleGo(count);
      case "G": return this.moveToDocumentEnd();
      case "f": case "F": case "t": case "T":
        this.findKind = data;
        return this.requestRender();
      case "i": return this.enterInsert();
      case "a": return this.append(count);
      case "I": this.repeat("\x01", 1); return this.enterInsert();
      case "A": this.repeat("\x05", 1); return this.enterInsert();
      case "o": return this.openLineBelow();
      case "O": return this.openLineAbove();
      case "x": return this.repeat("\x1b[3~", count);
      case "X": return this.repeat("\x7f", count);
      case "D": return this.deleteToEnd();
      case "C": this.deleteToEnd(); return this.enterInsert();
      case "s": this.repeat("\x1b[3~", count); return this.enterInsert();
      case "S": this.deleteLine(); return this.enterInsert();
      case "r": this.findKind = "f"; return this.replaceCharacter();
      case "d": case "c": case "y":
        this.operator = data === "d" ? "delete" : data === "c" ? "change" : "yank";
        return this.requestRender();
      case "p": return this.put(false, count);
      case "P": return this.put(true, count);
      case "u": return this.repeat("\x1f", count);
      case "/": return this.enterInsertWithCharacter("/");
      case "?": return this.enterInsertWithCharacter("?");
      default:
        // Preserve Pi application bindings (Ctrl+C, Ctrl+D, model selection, etc.).
        if (data.length !== 1 || data.charCodeAt(0) < 32) super.handleInput(data);
    }
  }

  render(width: number): string[] {
    // Too narrow for a framed box: fall back to pi's default chrome.
    if (width < 12) return super.render(width);

    // Render the editor two columns narrower, then wrap it in a box:
    // ╭──────────────────────╮
    // │ prompt text          │
    // ╰─────────── NORMAL ──╯
    const inner = super.render(width - 2);
    if (inner.length < 3) return inner;

    // The editor renders [top rule, ...content, bottom rule, ...autocomplete].
    // The bottom rule is the first line after the top rule made purely of
    // border glyphs; autocomplete rows follow it and stay outside the box.
    let bottomIndex = -1;
    for (let index = 1; index < inner.length; index++) {
      if (isRuleLine(inner[index]!)) {
        bottomIndex = index;
        break;
      }
    }
    if (bottomIndex === -1) return super.render(width);

    const border = (text: string) => this.borderColor(text);
    const lines: string[] = [this.buildBorder(width, "top", inner[0]!)];
    for (let index = 1; index < bottomIndex; index++) {
      lines.push(border("│") + inner[index]! + border("│"));
    }
    lines.push(this.buildBorder(width, "bottom", inner[bottomIndex]!));
    // Autocomplete rows stay below the box, aligned with its interior.
    for (let index = bottomIndex + 1; index < inner.length; index++) {
      lines.push(` ${inner[index]!} `);
    }
    return lines;
  }

  /**
   * Telescope-style rule with rounded corners. The mode title sits in the
   * bottom-right cutout (╰──── NORMAL ──╯); pi's scroll indicator is kept
   * right-aligned on the top border and left-aligned on the bottom border.
   */
  private buildBorder(width: number, position: "top" | "bottom", original: string): string {
    const border = (text: string) => this.borderColor(text);
    const [cornerLeft, cornerRight] = position === "top" ? ["╭", "╮"] : ["╰", "╯"];

    // Preserve pi's scroll indicator ("↑ 3 more" / "↓ 2 more") if present.
    const scroll = stripSgr(original).match(/[↑↓] \d+ more/)?.[0] ?? "";
    const scrollSegment = scroll ? border(` ${scroll} `) : "";
    const scrollWidth = scroll ? scroll.length + 2 : 0;

    const title = position === "bottom" ? this.modeTitle() : "";
    const titleSegment = title ? ` ${title} ` : "";

    // Two dashes anchor a segment to its corner.
    const edgeDashes = 2;
    const fill =
      width - 2 - scrollWidth - visibleWidth(titleSegment) - (scroll ? edgeDashes : 0) - (title ? edgeDashes : 0);
    if (fill < 2) {
      return border(cornerLeft) + border("─".repeat(Math.max(0, width - 2))) + border(cornerRight);
    }

    if (position === "top") {
      // ╭──────────────── ↑ 3 more ──╮
      return (
        border(cornerLeft) +
        border("─".repeat(fill)) +
        scrollSegment +
        (scroll ? border("─".repeat(edgeDashes)) : "") +
        border(cornerRight)
      );
    }

    // ╰── ↓ 2 more ──────── NORMAL ──╯
    return (
      border(cornerLeft) +
      (scroll ? border("─".repeat(edgeDashes)) + scrollSegment : "") +
      border("─".repeat(fill)) +
      titleSegment +
      (title ? border("─".repeat(edgeDashes)) : "") +
      border(cornerRight)
    );
  }

  /** The border title: current mode plus any pending count/operator. */
  private modeTitle(): string {
    const parts = [this.mode.toUpperCase()];
    if (this.count) parts.push(this.count);
    if (this.operator) parts.push(this.operator.toUpperCase());
    else if (this.findKind) parts.push("FIND");

    const theme = this.getUiTheme();
    const color = this.operator || this.findKind ? "warning" : this.mode === "insert" ? "success" : "accent";
    return theme.bold(theme.fg(color, parts.join(" ")));
  }

  private handleEscape(data: string): boolean {
    if (!matchesKey(data, "escape")) return false;
    if (this.mode === "insert") {
      if (this.isShowingAutocomplete()) {
        super.handleInput(data);
      } else {
        this.mode = "normal";
        this.resetPending();
        this.requestRender();
      }
      return true;
    }
    if (this.operator || this.findKind || this.count) {
      this.resetPending();
      this.requestRender();
      return true;
    }
    super.handleInput(data);
    return true;
  }

  private handleCount(data: string): boolean {
    if (!/^[0-9]$/.test(data)) return false;
    // 0 is a line-start motion unless a count has already begun.
    if (data === "0" && this.count.length === 0) return false;
    this.count += data;
    this.requestRender();
    return true;
  }

  private handleOperator(data: string): boolean {
    if (!this.operator) return false;
    const operator = this.operator;
    const count = this.consumeCount();
    this.operator = undefined;

    if (data === operator[0]) {
      if (operator === "yank") this.yankLine();
      else this.deleteLine();
      if (operator === "change") this.enterInsert(); else this.requestRender();
      return true;
    }

    if (operator === "yank") {
      this.yankMotion(data, count);
      this.requestRender();
      return true;
    }

    const insertAfter = operator === "change";
    switch (data) {
      case "w": case "e": this.repeat("\x1b[1;3C", count); this.deleteWordBackward(); break;
      case "b": this.repeat("\x1b[1;3D", count); this.deleteNextWord(); break;
      case "$": this.deleteToEnd(); break;
      case "0": case "^": this.deleteToStart(); break;
      case "h": this.repeat("\x7f", count); break;
      case "l": this.repeat("\x1b[3~", count); break;
      case "j": this.deleteLines(count + 1); break;
      case "k": this.deleteLines(count + 1); break;
      default: this.requestRender(); return true;
    }
    if (insertAfter) this.enterInsert(); else this.requestRender();
    return true;
  }

  private handlePendingFind(data: string): boolean {
    if (!this.findKind) return false;
    const kind = this.findKind;
    this.findKind = undefined;
    if (data.length !== 1 || data.charCodeAt(0) < 32) {
      this.requestRender();
      return true;
    }

    if (kind === "f" || kind === "t") {
      super.handleInput("\x1d"); // Pi's configured forward character jump
    } else {
      super.handleInput("\x1b\x1d"); // Pi's configured backward character jump
    }
    super.handleInput(data);
    if (kind === "t") super.handleInput("\x1b[D");
    if (kind === "T") super.handleInput("\x1b[C");
    this.requestRender();
    return true;
  }

  private consumeCount(): number {
    const value = Number.parseInt(this.count, 10);
    this.count = "";
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  private repeat(key: string, count: number): void {
    for (let index = 0; index < count; index++) super.handleInput(key);
  }

  private enterInsert(): void {
    this.mode = "insert";
    this.resetPending();
    this.requestRender();
  }

  private append(count: number): void {
    this.repeat("\x1b[C", count);
    this.enterInsert();
  }

  private enterInsertWithCharacter(character: string): void {
    this.mode = "insert";
    super.handleInput(character);
    this.requestRender();
  }

  private openLineBelow(): void {
    super.handleInput("\x05");
    super.handleInput("\n");
    this.enterInsert();
  }

  private openLineAbove(): void {
    super.handleInput("\x01");
    super.handleInput("\n");
    super.handleInput("\x1b[A");
    this.enterInsert();
  }

  private deleteToEnd(): void { super.handleInput("\x0b"); }
  private deleteToStart(): void { super.handleInput("\x15"); }
  private deleteNextWord(): void { super.handleInput("\x1b[3;3~"); }
  private deleteWordBackward(): void { super.handleInput("\x17"); }

  private deleteLine(): void {
    super.handleInput("\x01");
    this.deleteToEnd();
    super.handleInput("\x1b[3~");
  }

  private deleteLines(count: number): void {
    for (let index = 0; index < count; index++) this.deleteLine();
  }

  private moveToFirstNonBlank(): void {
    super.handleInput("\x01");
    const line = this.getLines()[this.getCursor().line] ?? "";
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    this.repeat("\x1b[C", indentation);
  }

  private moveToWordEnd(count: number): void {
    for (let index = 0; index < count; index++) {
      this.repeat("\x1b[1;3C", 1);
      const { line, col } = this.getCursor();
      const text = this.getLines()[line] ?? "";
      const end = text.slice(col).search(/\s|$/);
      this.repeat("\x1b[C", Math.max(0, end));
    }
  }

  private handleGo(_count: number): void {
    // Vim's gg is deliberately handled as a two-key command.
    this.findKind = undefined;
    this.operator = undefined;
    this.count = "";
    this.mode = "normal";
    this.moveToDocumentStart();
  }

  private moveToDocumentStart(): void {
    const line = this.getCursor().line;
    this.repeat("\x1b[A", line);
    super.handleInput("\x01");
  }

  private moveToDocumentEnd(): void {
    const lines = this.getLines();
    const line = this.getCursor().line;
    this.repeat("\x1b[B", lines.length - line - 1);
    super.handleInput("\x05");
  }

  private replaceCharacter(): void {
    // Reuse pending-find state only to receive the next printable character.
    const original = this.findKind;
    this.findKind = undefined;
    const receiveReplacement = (data: string) => {
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        super.handleInput("\x1b[3~");
        super.handleInput(data);
      }
      this.handleInput = VimEditor.prototype.handleInput;
      this.requestRender();
    };
    this.handleInput = receiveReplacement;
    void original;
  }

  private yankLine(): void {
    const { line } = this.getCursor();
    this.register = (this.getLines()[line] ?? "") + "\n";
  }

  private yankMotion(motion: string, _count: number): void {
    const { line, col } = this.getCursor();
    const text = this.getLines()[line] ?? "";
    if (motion === "$" || motion === "l") this.register = text.slice(col);
    else if (motion === "0" || motion === "h") this.register = text.slice(0, col);
    else if (motion === "w" || motion === "e") this.register = text.slice(col).match(/^\S+\s*/)?.[0] ?? "";
    else if (motion === "b") this.register = text.slice(0, col).match(/\S+\s*$/)?.[0] ?? "";
  }

  private put(before: boolean, count: number): void {
    if (!this.register) return;
    if (!before) super.handleInput("\x1b[C");
    for (let index = 0; index < count; index++) this.insertTextAtCursor(this.register);
  }

  private resetPending(): void {
    this.count = "";
    this.operator = undefined;
    this.findKind = undefined;
  }

  /** Request a redraw after input changes without shadowing Component.render(width). */
  private requestRender(): void { this.tui.requestRender(); }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;

  const apply = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      enabled
        ? (tui, theme, keybindings) => new VimEditor(tui, theme, keybindings, () => ctx.ui.theme)
        : undefined,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      enabled = await loadEnabledSetting();
      apply(ctx);
    } catch (error) {
      ctx.ui.notify(`Could not read vimMode setting: ${(error as Error).message}`, "error");
    }
  });

  pi.registerCommand("vim", {
    description: "Toggle Vim prompt editing, persistently: /vim [on|off]",
    handler: async (args, ctx) => {
      const option = args.trim().toLowerCase();
      const next = option === "on" ? true : option === "off" ? false : option === "" ? !enabled : undefined;
      if (next === undefined) {
        ctx.ui.notify("Usage: /vim, /vim on, or /vim off", "warning");
        return;
      }

      try {
        await saveEnabledSetting(next);
        enabled = next;
        apply(ctx);
        ctx.ui.notify(`Vim prompt editor ${enabled ? "enabled" : "disabled"}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save vimMode setting: ${(error as Error).message}`, "error");
      }
    },
  });
}
