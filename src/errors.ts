export class ApiError extends Error {
  constructor(public code: string, message: string, public statusCode = 502, public retryable = false) {
    super(message); this.name = 'ApiError';
  }
}
export function upstreamError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
    return new ApiError('UPSTREAM_TIMEOUT', 'CIPA did not complete the request in time.', 504, true);
  }
  return new ApiError('UPSTREAM_UNAVAILABLE', 'The CIPA browser session could not complete the request.', 502, true);
}
