/** Input owned by one light-shell view, before any command is submitted.
 * Cursor offsets use UTF-16, matching the browser's text selection offsets. */
export type LineState = Readonly<{ text: string; cursor: number }>;
export type LineEdit =
  | Readonly<{ type: "insert"; text: string }>
  | Readonly<{
      type: "left" | "backspace" | "right" | "delete" | "home" | "end";
    }>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Edit text only. Routing and execution remain separate public boundaries. */
export function editLine(state: LineState, edit: LineEdit): LineState {
  if (edit.type === "home") return { ...state, cursor: 0 };
  if (edit.type === "end") return { ...state, cursor: state.text.length };
  if (edit.type === "insert") {
    return {
      text:
        state.text.slice(0, state.cursor) +
        edit.text +
        state.text.slice(state.cursor),
      cursor: state.cursor + edit.text.length,
    };
  }
  if (edit.type === "right" || edit.type === "delete") {
    const next =
      [...graphemes.segment(state.text)].find(
        (part) => part.index > state.cursor,
      )?.index ?? state.text.length;
    if (edit.type === "right") return { ...state, cursor: next };
    return {
      text: state.text.slice(0, state.cursor) + state.text.slice(next),
      cursor: state.cursor,
    };
  }
  const previous =
    [...graphemes.segment(state.text)]
      .filter((part) => part.index < state.cursor)
      .at(-1)?.index ?? 0;
  if (edit.type === "left") return { ...state, cursor: previous };
  return {
    text: state.text.slice(0, previous) + state.text.slice(state.cursor),
    cursor: previous,
  };
}

/** Null leaves the event with Ghostty's ordinary input handling. */
export function editLineKey(
  state: LineState,
  event: KeyboardEvent,
): LineState | null {
  if (event.altKey || event.metaKey) return null;
  if (event.ctrlKey) {
    switch (event.key.toLowerCase()) {
      case "a":
        return editLine(state, { type: "home" });
      case "e":
        return editLine(state, { type: "end" });
      case "b":
        return editLine(state, { type: "left" });
      case "f":
        return editLine(state, { type: "right" });
      case "h":
        return editLine(state, { type: "backspace" });
      case "d":
        return editLine(state, { type: "delete" });
      default:
        return null;
    }
  }
  switch (event.key) {
    case "ArrowLeft":
      return editLine(state, { type: "left" });
    case "ArrowRight":
      return editLine(state, { type: "right" });
    case "Home":
      return editLine(state, { type: "home" });
    case "End":
      return editLine(state, { type: "end" });
    case "Backspace":
      return editLine(state, { type: "backspace" });
    case "Delete":
      return editLine(state, { type: "delete" });
    default:
      return null;
  }
}
