const maximumCharacters = 1_048_576;
const maximumChunks = 500;

/** One view's bounded scrollback; execution results remain owned by the host. */
export function appendTranscript(
  previous: readonly string[],
  text: string,
): readonly string[] {
  const chunks = [...previous, text].slice(-maximumChunks);
  const retained: string[] = [];
  let remaining = maximumCharacters;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk.length === 0) continue;
    let start = Math.max(0, chunk.length - remaining);
    // The maintained string API identifies a cut through a surrogate pair.
    if (start > 0 && (chunk.codePointAt(start - 1) ?? 0) > 0xffff) start += 1;
    const tail = chunk.slice(start);
    retained.unshift(tail);
    remaining -= tail.length;
  }
  return retained;
}
