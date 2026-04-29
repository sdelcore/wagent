import type { ErrorCategory, ErrorPayload } from '../types.js'

// Default retryability per category. Adapters use this so the
// (category, retryable) pair stops being a coincidence — flipping a
// bool in one adapter and not the other was the drift hole.
//
// `transport` is the one genuinely ambiguous category: a deliberate
// AbortError is transport-but-not-retryable, while a network blip is
// transport-and-retryable. Adapters override via the `retryable` arg
// to makeError when they know the difference.
export const CATEGORY_RETRYABLE: Record<ErrorCategory, boolean> = {
  rate_limit: true,
  auth: false,
  quota: false,
  upstream_5xx: true,
  transport: true,
  internal: false,
}

interface MakeErrorOpts {
  retryAfterMs?: number
  retryable?: boolean
}

export function makeError(
  category: ErrorCategory,
  message: string,
  opts: MakeErrorOpts = {},
): ErrorPayload {
  const out: ErrorPayload = {
    category,
    retryable: opts.retryable ?? CATEGORY_RETRYABLE[category],
    message,
  }
  if (opts.retryAfterMs !== undefined) out.retryAfterMs = opts.retryAfterMs
  return out
}
