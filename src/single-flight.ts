/**
 * Represents the internal state of a single-flight operation for a specific key.
 *
 * @template TValue - The type of the resolved value from the operation.
 * @template TError - The type of error that can be thrown (must extend Error).
 */
export interface SingleFlightState<TValue, TError extends Error = Error> {
  /**
   * The current in-flight Promise for this key, or null if no operation is pending.
   * Used to deduplicate concurrent requests with the same key.
   */
  inFlight: Promise<TValue> | null;

  /**
   * The last error thrown by an operation for this key, or null if the last execution succeeded.
   * Used for error caching and retry logic.
   */
  lastError: TError | null;

  /**
   * Unix timestamp (ms) when the cached error should expire.
   * While current time < this value, later calls will rethrow the cached error
   * unless shouldRetry returns true.
   */
  errorCacheExpiresAt: number;
}

/**
 * Configuration options for the SingleFlight.
 *
 * @template TValue - The type of the resolved value from the operation.
 * @template TError - The type of error that can be thrown (must extend Error).
 */
export interface SingleFlightOptions<TValue, TError extends Error = Error> {
  /**
   * Cooldown period in milliseconds after an error occurs.
   * During this window, later calls with the same key will immediately
   * rethrow the cached error instead of retrying. Default: 0 (no cooldown).
   */
  cooldownMs?: number;

  /**
   * Custom error normalizer function. Converts any thrown value into a typed Error.
   * Useful for standardizing errors from external APIs or libraries.
   * @param error - The caught error value (unknown type).
   * @returns A normalized error of type TError.
   */
  normalizeError?: (error: unknown) => TError;

  /**
   * Predicate to determine whether a failed operation should be retried immediately
   * despite having a cached error.
   * @param error - The normalized error from the last execution.
   * @returns true to bypass error cache and retry; false to respect cooldown.
   */
  shouldRetry?: (error: TError) => boolean;

  /**
   * Optional success hook called after a successful operation resolves.
   * Can be synchronous or asynchronous. Errors in this hook are caught and logged.
   * @param value - The resolved value from the operation.
   */
  onSuccess?: (value: TValue) => void | Promise<void>;

  /**
   * Optional error hook called after an operation rejects.
   * Can be synchronous or asynchronous. Errors in this hook are caught and logged.
   * @param error - The normalized error that was thrown.
   */
  onError?: (error: TError) => void | Promise<void>;
}

/**
 * Type alias for cache keys. Supports both string keys and composite keys as string arrays.
 * Arrays are joined with ':' delimiter for internal Map storage.
 */
export type Key = string | string[];

/**
 * SingleFlight — Request coalescing utility that prevents duplicate in-flight operations.
 *
 * This class implements the "single-flight" (or "request deduplication") pattern:
 * - Multiple concurrent calls with the same key share a single underlying Promise.
 * - Errors can be cached with a configurable cooldown period to avoid thundering herd.
 * - Supports lifecycle hooks (onSuccess/onError) for side effects.
 * - Automatically cleans up expired error cache entries to prevent memory leaks.
 *
 * @template TValue - The type of value returned by the wrapped operation.
 * @template TError - The type of error that can be thrown (must extend Error).
 *
 * @example
 * ```ts
 * const api = new SingleFlight<UserData, ApiError>({
 *   cooldownMs: 5000,
 *   normalizeError: (error) => error instanceof AppError ? error : new AppError(e.message),
 *   shouldRetry: (error) => error.isRetryable,
 * });
 *
 * const user = await api.exec(['user', '123'], () => fetchUser('123'));
 * ```
 */
export class SingleFlight<TValue, TError extends Error = Error> {
  /**
   * Internal cache mapping normalized keys to their SingleFlightState.
   * Stores in-flight Promises and error cache metadata.
   * @private
   */
  private readonly cache = new Map<string, SingleFlightState<TValue, TError>>();

  /**
   * Merged configuration: default options combined with constructor overrides.
   * @private
   */
  private readonly options: SingleFlightOptions<TValue, TError>;

  /**
   * Interval (ms) for automatic cleanup of expired error cache entries.
   * Default: 30 seconds. Helps prevent unbounded memory growth.
   * @private
   */
  private readonly autoCleanupToErrorMs = 1000 * 30;

  /**
   * Timer handle for the periodic cleanup interval.
   * Unref'd in Node.js environments to avoid preventing process exit.
   * @private
   */
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  /**
   * Creates a new SingleFlight instance.
   *
   * @param options - Optional configuration overrides. See SingleFlightOptions.
   */
  constructor(options: SingleFlightOptions<TValue, TError> = {}) {
    this.options = options;

    // Start periodic cleanup of expired error cache entries
    this.cleanupTimer = setInterval(() => this.cleanupExpiredError(), this.autoCleanupToErrorMs);

    // In Node.js, unref the timer so it doesn't keep the process alive
    if (
        typeof this.cleanupTimer === "object" &&
        this.cleanupTimer !== null &&
        "unref" in this.cleanupTimer &&
        typeof this.cleanupTimer.unref === "function"
    ) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Executes an operation with single-flight deduplication for the given key.
   *
   * Behavior:
   * 1. If a cached error exists and hasn't expired (and shouldRetry is false), rethrows immediately.
   * 2. If an operation is already in-flight for this key, returns the existing Promise.
   * 3. Otherwise, executes the operation, caches result/error, and triggers hooks.
   *
   * @param key - Identifier for the operation (string or string array for composite keys).
   * @param operation - Async function that performs the actual work.
   * @param options - Optional per-call overrides for SingleFlightOptions.
   * @returns Promise resolving to TValue, or rejecting with TError.
   *
   * @throws TError - If the operation fails and error cache is active or retry is disabled.
   */
  exec(key: Key, operation: () => Promise<TValue>, options?: SingleFlightOptions<TValue, TError>): Promise<TValue> {
    const {
      cooldownMs = 0,
      normalizeError = (error: unknown) => (error instanceof Error ? error : new Error(String(error))) as TError,
      shouldRetry = () => false,
      onSuccess,
      onError,
    } = { ...this.options, ...options };

    const cachedEntry = this.getCachedEntry(key);

    if (cachedEntry.lastError && Date.now() < cachedEntry.errorCacheExpiresAt && !shouldRetry(cachedEntry.lastError)) {
      return Promise.reject(cachedEntry.lastError);
    }

    if (cachedEntry.inFlight) {
      return cachedEntry.inFlight;
    }

    cachedEntry.lastError = null;
    cachedEntry.errorCacheExpiresAt = 0;

    const operationPromise = (async () => {
      try {
        const value = await operation();

        try {
          await onSuccess?.(value);
        } catch (hookError) {
          console.error("onSuccess hook error: ", hookError);
        }

        return value;
      } catch (error) {
        const errorObj = normalizeError(error);
        cachedEntry.lastError = errorObj;
        cachedEntry.errorCacheExpiresAt = Date.now() + cooldownMs;

        try {
          await onError?.(errorObj);
        } catch (hookError) {
          console.error("onError hook error: ", hookError);
        }

        throw errorObj;
      } finally {
        cachedEntry.inFlight = null;

        if (cachedEntry.lastError === null) {
          this.deleteCachedEntry(key);
        }
      }
    })();

    cachedEntry.inFlight = operationPromise;

    return operationPromise;
  }

  /**
   * Stops the internal cleanup timer.
   *
   * Call this method when the SingleFlight instance is no longer needed,
   * especially in tests, CLI tools, or short-lived scripts.
   */
  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  /**
   * Normalizes a Key (string | string[]) into a unique string for Map storage.
   * Arrays are joined with ':' delimiter.
   *
   * @param key - The input key to normalize.
   * @returns A string representation suitable for use as a Map key.
   * @private
   */
  private normalizeKey(key: Key): string {
    return Array.isArray(key) ? key.join(":") : key;
  }

  /**
   * Retrieves or creates a cache entry for the given key.
   *
   * @param key - The operation key.
   * @returns The SingleFlightState for this key.
   * @private
   */
  private getCachedEntry(key: Key) {
    const normalizedKey = this.normalizeKey(key);

    let entry = this.cache.get(normalizedKey);
    if (!entry) {
      entry = { inFlight: null, lastError: null, errorCacheExpiresAt: 0 };
      this.cache.set(normalizedKey, entry);
    }

    return entry;
  }

  /**
   * Removes a cache entry for the given key.
   * Called after successful operations to free memory.
   *
   * @param key - The operation key to remove.
   * @private
   */
  private deleteCachedEntry(key: Key) {
    const normalizedKey = this.normalizeKey(key);
    this.cache.delete(normalizedKey);
  }

  /**
   * Cleans up cache entries where:
   * - No operation is in-flight
   * - An error is cached
   * - The error cache expiration time has passed
   *
   * @returns Number of entries removed.
   * @private
   */
  private cleanupExpiredError() {
    let removed = 0;
    const nowMs = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (!entry.inFlight && entry.lastError && nowMs >= entry.errorCacheExpiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
