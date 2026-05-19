import { afterEach, describe, expect, it, vi } from "vitest";
import { SingleFlight } from "../src/index.js";

interface Disposable {
    dispose(): void;
}

const instances: Disposable[] = [];

function createSingleFlight<TValue, TError extends Error = Error>(
    options?: ConstructorParameters<typeof SingleFlight<TValue, TError>>[0]
): SingleFlight<TValue, TError> {
    const singleFlight = new SingleFlight<TValue, TError>(options);
    instances.push(singleFlight);
    return singleFlight;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

afterEach(() => {
    for (const instance of instances) {
        instance.dispose();
    }

    instances.length = 0;
    vi.restoreAllMocks();
});

describe("SingleFlight", () => {
    it("executes operation and returns its result", async () => {
        const singleFlight = createSingleFlight<string>();

        const result = await singleFlight.exec("key", async () => {
            return "value";
        });

        expect(result).toBe("value");
    });

    it("deduplicates concurrent calls with the same key", async () => {
        const singleFlight = createSingleFlight<string>();
        const operation = vi.fn(async () => {
            await delay(10);
            return "shared-result";
        });

        const [first, second, third] = await Promise.all([
            singleFlight.exec("same-key", operation),
            singleFlight.exec("same-key", operation),
            singleFlight.exec("same-key", operation)
        ]);

        expect(first).toBe("shared-result");
        expect(second).toBe("shared-result");
        expect(third).toBe("shared-result");
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not deduplicate calls with different keys", async () => {
        const singleFlight = createSingleFlight<string>();
        const operation = vi.fn(async (value: string) => {
            await delay(10);
            return value;
        });

        const [first, second] = await Promise.all([
            singleFlight.exec("first-key", () => operation("first")),
            singleFlight.exec("second-key", () => operation("second"))
        ]);

        expect(first).toBe("first");
        expect(second).toBe("second");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("supports composite array keys", async () => {
        const singleFlight = createSingleFlight<string>();
        const operation = vi.fn(async () => {
            await delay(10);
            return "composite-result";
        });

        const [first, second] = await Promise.all([
            singleFlight.exec(["user", "1"], operation),
            singleFlight.exec(["user", "1"], operation)
        ]);

        expect(first).toBe("composite-result");
        expect(second).toBe("composite-result");
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("runs operation again after a successful call because successful entries are removed", async () => {
        const singleFlight = createSingleFlight<string>();
        const operation = vi.fn(async () => {
            return "value";
        });

        await singleFlight.exec("key", operation);
        await singleFlight.exec("key", operation);

        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("normalizes thrown non-error values", async () => {
        const singleFlight = createSingleFlight<string>();

        await expect(
            singleFlight.exec("key", async () => {
                throw "failure";
            })
        ).rejects.toThrow("failure");
    });

    it("uses custom error normalization", async () => {
        class AppError extends Error {
            constructor(message: string, public readonly code: string) {
                super(message);
                this.name = "AppError";
            }
        }

        const singleFlight = createSingleFlight<string, AppError>({
            normalizeError: (error) => {
                return new AppError(String(error), "CUSTOM_ERROR");
            }
        });

        await expect(
            singleFlight.exec("key", async () => {
                throw "raw-error";
            })
        ).rejects.toMatchObject({
            name: "AppError",
            message: "raw-error",
            code: "CUSTOM_ERROR"
        });
    });

    it("caches error during cooldown and does not execute operation again", async () => {
        const singleFlight = createSingleFlight<string>({
            cooldownMs: 1000
        });

        const firstOperation = vi.fn(async () => {
            throw new Error("temporary failure");
        });

        const secondOperation = vi.fn(async () => {
            return "should-not-run";
        });

        await expect(singleFlight.exec("key", firstOperation)).rejects.toThrow("temporary failure");
        await expect(singleFlight.exec("key", secondOperation)).rejects.toThrow("temporary failure");

        expect(firstOperation).toHaveBeenCalledTimes(1);
        expect(secondOperation).not.toHaveBeenCalled();
    });

    it("retries during cooldown when shouldRetry returns true", async () => {
        const singleFlight = createSingleFlight<string>({
            cooldownMs: 1000,
            shouldRetry: () => true
        });

        const firstOperation = vi.fn(async () => {
            throw new Error("retryable failure");
        });

        const secondOperation = vi.fn(async () => {
            return "retried-value";
        });

        await expect(singleFlight.exec("key", firstOperation)).rejects.toThrow("retryable failure");

        const result = await singleFlight.exec("key", secondOperation);

        expect(result).toBe("retried-value");
        expect(firstOperation).toHaveBeenCalledTimes(1);
        expect(secondOperation).toHaveBeenCalledTimes(1);
    });

    it("runs onSuccess hook after successful operation", async () => {
        const onSuccess = vi.fn();
        const singleFlight = createSingleFlight<string>({
            onSuccess
        });

        const result = await singleFlight.exec("key", async () => {
            return "value";
        });

        expect(result).toBe("value");
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledWith("value");
    });

    it("runs onError hook after failed operation", async () => {
        const onError = vi.fn();
        const singleFlight = createSingleFlight<string>({
            onError
        });

        await expect(
            singleFlight.exec("key", async () => {
                throw new Error("failure");
            })
        ).rejects.toThrow("failure");

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
        expect(onError.mock.calls[0]?.[0]).toMatchObject({
            message: "failure"
        });
    });

    it("does not fail operation when onSuccess hook throws", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const singleFlight = createSingleFlight<string>({
            onSuccess: () => {
                throw new Error("hook failure");
            }
        });

        const result = await singleFlight.exec("key", async () => {
            return "value";
        });

        expect(result).toBe("value");
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("does not replace original error when onError hook throws", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const singleFlight = createSingleFlight<string>({
            onError: () => {
                throw new Error("hook failure");
            }
        });

        await expect(
            singleFlight.exec("key", async () => {
                throw new Error("original failure");
            })
        ).rejects.toThrow("original failure");

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("allows per-call options to override constructor options", async () => {
        const singleFlight = createSingleFlight<string>({
            cooldownMs: 1000,
            shouldRetry: () => false
        });

        const firstOperation = vi.fn(async () => {
            throw new Error("failure");
        });

        const secondOperation = vi.fn(async () => {
            return "value";
        });

        await expect(singleFlight.exec("key", firstOperation)).rejects.toThrow("failure");

        const result = await singleFlight.exec("key", secondOperation, {
            shouldRetry: () => true
        });

        expect(result).toBe("value");
        expect(firstOperation).toHaveBeenCalledTimes(1);
        expect(secondOperation).toHaveBeenCalledTimes(1);
    });

    it("dispose stops the internal cleanup timer", () => {
        const singleFlight = createSingleFlight<string>();

        expect(() => {
            singleFlight.dispose();
        }).not.toThrow();
    });
});