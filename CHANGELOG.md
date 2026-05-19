# Changelog

All notable changes to this project will be documented in this file.

## 1.0.0 - 2026-05-19

### Added

- Initial TypeScript implementation of `SingleFlight`
- Concurrent async operation deduplication by key
- Support for string keys
- Support for composite string-array keys
- Error cooldown support
- Custom error normalization
- Retry decision callback
- Success lifecycle hook
- Error lifecycle hook
- Automatic cleanup of expired error cache entries
- TypeScript declaration generation
- Unit tests with Vitest