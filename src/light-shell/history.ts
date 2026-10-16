/** One open light prompt's in-memory command history. */
export class CommandHistory {
  #entries: string[] = [];
  #position: number | null = null;
  #draft = "";

  /** Record one accepted command, retaining at most 500 entries. */
  record(command: string): void {
    this.#entries.push(command);
    if (this.#entries.length > 500) this.#entries.shift();
    this.#position = null;
    this.#draft = "";
  }

  previous(draft: string): string | null {
    if (this.#entries.length === 0) return null;
    if (this.#position === null) {
      this.#draft = draft;
      this.#position = this.#entries.length - 1;
    } else {
      this.#position = Math.max(0, this.#position - 1);
    }
    return this.#entries[this.#position] ?? null;
  }

  next(): string | null {
    if (this.#position === null) return null;
    if (this.#position === this.#entries.length - 1) {
      this.#position = null;
      return this.#draft;
    }
    this.#position += 1;
    return this.#entries[this.#position] ?? null;
  }

  suggest(prefix: string): string | null {
    if (prefix.length === 0) return null;
    const command = [...this.#entries]
      .reverse()
      .find((entry) => entry.startsWith(prefix));
    if (command === undefined || command.length === prefix.length) return null;
    return command.slice(prefix.length);
  }

  search(query: string, draft: string): string | null {
    for (
      let position = (this.#position ?? this.#entries.length) - 1;
      position >= 0;
      position -= 1
    ) {
      const command = this.#entries[position];
      if (!command.includes(query)) continue;
      if (this.#position === null) this.#draft = draft;
      this.#position = position;
      return command;
    }
    return null;
  }
}
