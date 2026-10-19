/**
 * Demo fixture for the inline diff review acceptance run.
 * The agent edits this file in a later turn; the review tab should show the
 * full source with whole-line added backgrounds and inline deleted blocks.
 */

export interface RetryPolicy {
  attempts: number
  baseDelayMs: number
  /** Optional random jitter added to each backoff delay. */
  jitterMs?: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 400,
  jitterMs: 120,
  maxDelayMs: 6000,
}

export function delayFor(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const exponential = policy.baseDelayMs * Math.max(1, attempt)
  const jitter = Math.random() * (policy.jitterMs ?? 0)
  return Math.min(exponential + jitter, policy.maxDelayMs)
}

export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === policy.attempts) break
      await new Promise((resolve) => setTimeout(resolve, delayFor(attempt, policy)))
    }
  }
  throw lastError
}