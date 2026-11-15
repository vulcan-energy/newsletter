// Operator-safe errors with a stable code; anything else stays generic over HTTP.
export class NewsletterError extends Error {
  constructor(
    message: string,
    readonly code = "operation_failed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NewsletterError";
  }
}
