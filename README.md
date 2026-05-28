# single-flight

TypeScript single-flight implementation for deduplicating concurrent asynchronous operations by key.

`single-flight` prevents duplicate in-flight async operations. If multiple calls with the same key happen at the same time, only one underlying operation is executed and all callers receive the same Promise result.

## Features

- Deduplicates concurrent async operations by key
- Supports string keys and composite string-array keys
- Shares the same in-flight Promise between concurrent callers
- Supports error cooldown
- Supports custom error normalization
- Supports retry decision logic
- Supports success and error lifecycle hooks
- Written in TypeScript
- Ships with TypeScript declarations
- No runtime dependencies

## Installation

```bash
npm i @andrew-nazin/single-flight
```

## Usage

```typescript
import { SingleFlight } from "@andrew-nazin/single-flight";

const singleFlight = new SingleFlight();

const result = await singleFlight.exec("user:1", async () => { return "user-data"; });

console.log(result);

singleFlight.dispose();
```

## Deduplicating concurrent calls

```typescript
import { SingleFlight } from "@andrew-nazin/single-flight";

const singleFlight = new SingleFlight();
let calls = 0;

const operation = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return "result";
};

const promise1 = singleFlight.exec('my-key', operation);
const promise2 = singleFlight.exec('my-key', operation);
const promise3 = singleFlight.exec('my-key', operation);

const [first, second, third] = await Promise.all([promise1, promise2, promise3]);

console.log(first);  // "result"
console.log(second); // "result"
console.log(third);  // "result"
console.log(calls);  // 1 ← the operation was performed only once!

singleFlight.dispose();
```

Only one underlying operation is executed while all concurrent callers receive the same result.

## Error cooldown

```typescript
import { SingleFlight } from "@andrew-nazin/single-flight";

const singleFlight = new SingleFlight({ cooldownMs: 5000 });

try {
    await singleFlight.exec("resource", async () => { throw new Error("Temporary failure"); });
} catch (error) {
    console.error(error.message);
}

try {
    const result = await singleFlight.exec("resource", async () => { return "this will not run during cooldown"; });
    console.log(result);
} catch (error) {
    console.error(error.message);
}

singleFlight.dispose();
```

## API

### `SingleFlight<TValue, TError>`

Main class used to deduplicate concurrent async operations.

```typescript
const singleFlight = new SingleFlight<TValue, TError>(options);
```

### `exec(key, operation, options?)`

Executes an async operation with single-flight deduplication.

```typescript
exec( key: Key, operation: () => Promise , options?: SingleFlightOptions ): Promise
```

### `dispose()`

Stops the internal cleanup timer.

```typescript
singleFlight.dispose();
```

Call this method when the instance is no longer needed, especially in tests, CLI tools, or short-lived scripts.

## Types

```typescript
type Key = string | string[];

interface SingleFlightOptions<TValue, TError extends Error = Error> { 
    cooldownMs?: number; 
    normalizeError?: (error: unknown) => TError; 
    shouldRetry?: (error: TError) => boolean; 
    onSuccess?: (value: TValue) => void | Promise ; 
    onError?: (error: TError) => void | Promise; 
}

interface SingleFlightState<TValue, TError extends Error = Error> { 
    inFlight: Promise| null; 
    lastError: TError | null; 
    errorCacheExpiresAt: number; 
}
```

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:coverage
```

Build package:

```bash
npm run build
```

Check package contents before publishing:

```bash
npm run pack:check
```

## License

MIT