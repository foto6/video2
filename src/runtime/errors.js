export class RenderRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "RenderRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function runtimeError(code, message, details = null) {
  return new RenderRuntimeError(code, message, details);
}
