// A user-facing error: the CLI prints `message` to stderr (no stack trace) and exits with `code`.
export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function fail(message, code = 1) {
  throw new CliError(message, code);
}
