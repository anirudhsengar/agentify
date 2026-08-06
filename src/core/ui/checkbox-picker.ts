// Custom checkbox-list picker.
//
// Why not clack.multiselect / clack.groupMultiselect?
//
// `clack.multiselect` renders the full list on every keypress and
// tracks the previous frame's line count via wrap-ansi(width). When
// the per-frame line count shifts between renders, clack's diff
// renderer positions `restoreCursor` at the wrong row and `m.down()`
// fails to erase the previous frame, leaving multiple frames stacked
// vertically on the screen.
//
// Why a custom viewport?
//
// The picker has 51 choices — too many to dump flat on a 24-row
// terminal. If we render all 51 choices + header + footer (54 rows),
// the bottom 30 rows spill off the visible area, the terminal
// scrolls, and each redraw pushes the previous frame into the
// scroll buffer. The user sees "stacked" frames even though we're
// only rendering one.
//
// This picker renders EXACTLY `output.rows` lines (the visible
// area) and scrolls a viewport window through the choices. The
// frame height never exceeds the terminal height, so redraws never
// push content into the scroll buffer.
//
// Mechanics:
//   * `viewportStart` = index of the first choice shown in the
//     visible window.
//   * When the cursor moves past the bottom edge of the viewport,
//     `viewportStart` shifts down by 1; the new frame overwrites
//     the previous one IN PLACE (MOVE_UP to the top of the frame,
//     rewrite every line).
//   * The picker chrome (message, blank, choices, blank, nav hint)
//     is always 4 rows + viewport rows. `viewportHeight` is bounded
//     by `output.rows - 4`.

import { stdin as input, stdout as output } from "node:process";

// ANSI helpers — minimal, hand-rolled, no dependency on sisteransi.
const ESC = "\x1B";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[K`;
const MOVE_UP = (rows: number): string => `${ESC}[${rows}A`;

interface CheckboxChoice {
  label: string;
  value: string;
  hint?: string;
}

interface CheckboxOptions {
  initialValues?: ReadonlyArray<string>;
  cursorAt?: string;
  selectionMode?: "single" | "multiple";
}

/**
 * Truncate `s` to at most `max` characters, appending `…` if any
 * characters were dropped. Used to keep checkbox rows within the
 * terminal width so wrap-ansi (and our own line counting) stays
 * stable across renders.
 */
function truncate(s: string, max: number): string {
  if (!Number.isFinite(max) || max <= 1) return s.slice(0, Math.max(0, max));
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

const CURSOR_WIDTH = 2; // "▸ " or "  "
const CHECKBOX_WIDTH = 3; // "[x]" or "[ ]"
const INNER_PADDING = 2; // space before hint
const MIN_LABEL_WIDTH = 24;
const DEFAULT_TERMINAL_WIDTH = 100;
const DEFAULT_TERMINAL_HEIGHT = 24;
const MAX_VIEWPORT_ROWS = 30;

// Picker chrome: message + selected-summary + blank + nav = 4 fixed rows.
const PICKER_CHROME_ROWS = 4;

/** A single rendered row (no trailing newline). */
interface FrameRow {
  text: string;
}

/**
 * Build the rendered frame as an array of rows. Renders exactly
 * `frameHeight` rows. If `viewportEnd - viewportStart < viewportHeight`,
 * the remaining rows are blank (so the visible area is fully
 * overwritten on every redraw).
 */
function buildFrame(
  message: string,
  choices: ReadonlyArray<CheckboxChoice>,
  cursorIndex: number,
  selected: Set<string>,
  terminalWidth: number,
  viewportStart: number,
  viewportHeight: number,
  frameHeight: number,
  selectionMode: "single" | "multiple",
): FrameRow[] {
  const safeWidth =
    Number.isFinite(terminalWidth) && terminalWidth > 40
      ? terminalWidth
      : DEFAULT_TERMINAL_WIDTH;
  const fixedChars = CURSOR_WIDTH + CHECKBOX_WIDTH + 1 + INNER_PADDING;
  const labelWidth = Math.max(
    MIN_LABEL_WIDTH,
    Math.min(40, Math.floor(safeWidth * 0.4)),
  );
  const hintBudget = Math.max(0, safeWidth - fixedChars - labelWidth);

  const rows: FrameRow[] = [];
  rows.push({ text: message });
  const selectedLabels = choices
    .filter((choice) => selected.has(choice.value))
    .map((choice) => choice.label);
  const selectedPreview = selectedLabels.length <= 3
    ? selectedLabels.join(", ")
    : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2} more`;
  rows.push({
    text: truncate(
      `Selected (${selectedLabels.length}): ${selectedPreview || "none"}`,
      safeWidth,
    ),
  });

  const totalChoices = choices.length;
  // Show `viewportHeight` choices starting at `viewportStart`. If the
  // list is shorter than the viewport, fill the rest with blank rows
  // so the frame always occupies exactly `frameHeight` terminal rows.
  for (let i = 0; i < viewportHeight; i += 1) {
    const idx = viewportStart + i;
    if (idx >= totalChoices) {
      rows.push({ text: "" });
      continue;
    }
    const choice = choices[idx];
    const isCursor = idx === cursorIndex;
    const isSelected = selected.has(choice.value);
    const cursorMark = isCursor ? "▸ " : "  ";
    const checkMark = isSelected ? "[x]" : "[ ]";
    const label = truncate(choice.label, labelWidth);
    const hint = choice.hint
      ? `  ${truncate(choice.hint, Math.max(0, hintBudget - 2))}`
      : "";
    rows.push({ text: `${cursorMark}${checkMark} ${label}${hint}` });
  }

  rows.push({ text: "" });
  // Footer: navigation instructions plus an explicit cue that scrolling
  // reveals additional choices beyond the 30-row viewport.
  const visibleEnd = Math.min(viewportStart + viewportHeight, totalChoices);
  const navigation = selectionMode === "multiple"
    ? "↑↓ navigate · Space toggle · Enter confirm"
    : "↑↓ navigate · Enter confirm";
  const hiddenChoices = totalChoices - visibleEnd;
  const moreCue = hiddenChoices > 0
    ? ` · ↓ ${hiddenChoices} more below`
    : viewportStart > 0
      ? ` · ↑ ${viewportStart} above`
      : "";
  const footer = totalChoices <= viewportHeight
    ? `${navigation} (Ctrl-C to cancel)`
    : `${navigation}   (${viewportStart + 1}-${visibleEnd} of ${totalChoices})${moreCue}`;
  rows.push({ text: footer });

  // Pad to exactly frameHeight rows so the rendered byte sequence is
  // constant width across renders. (Trailing blank rows get
  // CLEAR_LINE-ed anyway, but the explicit padding makes the
  // invariant obvious.)
  while (rows.length < frameHeight) {
    rows.push({ text: "" });
  }
  return rows;
}

/**
 * Rewrite the frame in place. The cursor is currently somewhere on
 * the LAST row of the previously rendered frame; we move up by
 * `moveUpBy` rows to its top, then overwrite every line with
 * `\x1b[K` padding.
 *
 * Pass `moveUpBy = 0` for the initial render so the picker doesn't
 * climb past content printed above it (e.g., the agentify ASCII
 * banner). On subsequent renders, pass `frameHeight - 1` so the
 * cursor lands at the top of the existing frame.
 */
function redraw(rows: ReadonlyArray<FrameRow>, moveUpBy: number): void {
  if (moveUpBy > 0) output.write(MOVE_UP(moveUpBy));
  output.write("\r");
  for (let i = 0; i < rows.length; i += 1) {
    output.write(rows[i].text);
    output.write(CLEAR_LINE);
    if (i < rows.length - 1) output.write("\r\n");
  }
  // Cursor is now at column 0 of the last row.
}

/** Replace the interactive frame with one compact, answered prompt line. */
function collapseFrame(
  message: string,
  choices: ReadonlyArray<CheckboxChoice>,
  selected: ReadonlySet<string>,
  frameHeight: number,
): void {
  const labels = choices
    .filter((choice) => selected.has(choice.value))
    .map((choice) => choice.label);
  const answer = labels.length === 0
    ? "none"
    : labels.length === 1
      ? labels[0]
      : `${labels[0]} +${labels.length - 1} more`;

  output.write(MOVE_UP(frameHeight - 1));
  output.write("\r");
  for (let i = 0; i < frameHeight; i += 1) {
    output.write(CLEAR_LINE);
    if (i < frameHeight - 1) output.write("\r\n");
  }
  output.write(MOVE_UP(frameHeight - 1));
  output.write(`\r${message} ${answer}\n`);
}

/** Read a single raw keypress and return the resolved action. */
type KeyAction =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "toggle" }
  | { kind: "submit" }
  | { kind: "cancel" }
  | { kind: "noop" };

function readKey(): Promise<KeyAction> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      input.off("data", onData);
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      resolve(parseKey(s));
    };
    input.on("data", onData);
  });
}

function parseKey(s: string): KeyAction {
  // Arrow keys arrive as ESC [ A/B/C/D.
  if (s === "\x1B[A" || s === "k") return { kind: "up" };
  if (s === "\x1B[B" || s === "j") return { kind: "down" };
  if (s === " ") return { kind: "toggle" };
  if (s === "\r" || s === "\n") return { kind: "submit" };
  if (s === "\x03") return { kind: "cancel" }; // Ctrl-C
  return { kind: "noop" };
}

/**
 * Adjust `viewportStart` so `cursorIndex` is visible. The viewport
 * scrolls in 1-row increments when the cursor crosses the top or
 * bottom edge.
 */
function adjustViewport(
  cursorIndex: number,
  viewportStart: number,
  viewportHeight: number,
): number {
  if (cursorIndex < viewportStart) return cursorIndex;
  if (cursorIndex >= viewportStart + viewportHeight) {
    return cursorIndex - viewportHeight + 1;
  }
  return viewportStart;
}

/**
 * Run the checkbox picker. Returns the selected values in
 * `choices` order. Throws `Error("Interrupted.")` on Ctrl-C.
 */
export async function runCheckboxPicker(
  message: string,
  choices: ReadonlyArray<CheckboxChoice>,
  options?: CheckboxOptions,
): Promise<ReadonlyArray<string>> {
  if (choices.length === 0) return [];

  let cursorIndex = 0;
  if (options?.cursorAt !== undefined) {
    const found = choices.findIndex((c) => c.value === options.cursorAt);
    if (found >= 0) cursorIndex = found;
  }

  const selectionMode = options?.selectionMode ?? "multiple";
  const selected = new Set<string>(options?.initialValues ?? []);
  if (selectionMode === "single") {
    selected.clear();
    selected.add(choices[cursorIndex].value);
  }

  // Show at most 30 choices at once, while respecting shorter terminals
  // so redraws never push the picker into the scroll buffer.
  const terminalWidth = output.columns ?? DEFAULT_TERMINAL_WIDTH;
  const terminalHeight = output.rows ?? DEFAULT_TERMINAL_HEIGHT;
  const viewportHeight = Math.max(
    3,
    Math.min(choices.length, MAX_VIEWPORT_ROWS, terminalHeight - PICKER_CHROME_ROWS),
  );
  const frameHeight = PICKER_CHROME_ROWS + viewportHeight;

  // Initial viewport: anchor at cursorIndex.
  let viewportStart = Math.max(
    0,
    Math.min(
      cursorIndex - Math.floor(viewportHeight / 2),
      choices.length - viewportHeight,
    ),
  );

  // Enter raw mode for the duration of the picker.
  const wasRaw = input.isTTY ? input.isRaw : false;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  output.write(HIDE_CURSOR);

  // Initial render — start at the current cursor position so any
  // content printed above the picker (the agentify banner) stays
  // visible. Subsequent renders MOVE_UP to overwrite the picker in
  // place.
  redraw(
    buildFrame(
      message,
      choices,
      cursorIndex,
      selected,
      terminalWidth,
      viewportStart,
      viewportHeight,
      frameHeight,
      selectionMode,
    ),
    0,
  );

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const action = await readKey();
      if (action.kind === "up") {
        // Stay at the top when the user keeps pressing ↑.
        if (cursorIndex > 0) cursorIndex -= 1;
      } else if (action.kind === "down") {
        // Stay at the bottom when the user keeps pressing ↓.
        if (cursorIndex < choices.length - 1) cursorIndex += 1;
      } else if (action.kind === "toggle") {
        if (selectionMode === "multiple") {
          const value = choices[cursorIndex].value;
          if (selected.has(value)) selected.delete(value);
          else selected.add(value);
        }
      } else if (action.kind === "submit") {
        break;
      } else if (action.kind === "cancel") {
        // cancel — Ctrl-C
        throw new Error("Interrupted.");
      }
      if (selectionMode === "single") {
        selected.clear();
        selected.add(choices[cursorIndex].value);
      }
      viewportStart = adjustViewport(
        cursorIndex,
        viewportStart,
        viewportHeight,
      );
      redraw(
        buildFrame(
          message,
          choices,
          cursorIndex,
          selected,
          terminalWidth,
          viewportStart,
        viewportHeight,
        frameHeight,
        selectionMode,
        ),
        frameHeight - 1,
      );
    }
  } finally {
    output.write(SHOW_CURSOR);
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
  }

  collapseFrame(message, choices, selected, frameHeight);

  // Return selected values in `choices` order (stable).
  return choices.map((c) => c.value).filter((v) => selected.has(v));
}

/** Run the same stable list UI for a single-choice question. */
export async function runSelectPicker(
  message: string,
  choices: ReadonlyArray<CheckboxChoice>,
): Promise<string> {
  const selected = await runCheckboxPicker(message, choices, { selectionMode: "single" });
  const value = selected[0];
  if (value === undefined) throw new Error("No option selected.");
  return value;
}
