# @valentech/rust-fetch

[![npm version](https://img.shields.io/npm/v/@valentech/rust-fetch)](https://www.npmjs.com/package/@valentech/rust-fetch) [![License: ISC](https://img.shields.io/npm/l/@valentech/rust-fetch)](#license)

A Rust-powered HTTP fetch library for Node.js, built with Neon for high-performance native bindings.

## Prerequisites

- **Node.js** v14 or higher (CommonJS support)
- **Yarn** (or npm)
- **Rust toolchain** (Rust and Cargo, stable)
- **cross** (for cross-compilation, optional)
- **Neon CLI** (installed as a dev dependency)

## Installation

Install from npm with Yarn:

```bash
yarn add @valentech/rust-fetch
```

Or with npm:

```bash
npm install @valentech/rust-fetch
```

## Usage

Import and call the `fetch` function exported by the native addon:

```js
const { rustFetch } = require("@valentech/rust-fetch");

(async () => {
  try {
    const body = await rustFetch("https://api.example.com/data");
    console.log("Response body:", body);
  } catch (err) {
    console.error("Fetch error:", err);
  }
})();
```

## Building from source

Compile the Rust code and package the native addon using the provided scripts.

- **Standard build** (cargo + Neon packaging):

  ```bash
  yarn build
  # runs: yarn cargo-build --release && neon dist < cargo.log
  ```

- **Cross-compilation** (e.g., for ARM, musl):
  ```bash
  yarn cross
  # runs: yarn cross-build --release && neon dist -m /target < cross.log
  ```

You can also invoke the lower-level steps directly:

```bash
# Cargo build with JSON diagnostics
yarn cargo-build

# Cross build with JSON diagnostics
yarn cross-build
```

## Testing

Run the test suite with:

```bash
yarn test
```

This executes `node test.js`, which validates the functionality of the native binding.

## Benchmarking

Measure performance and memory usage:

```bash
yarn bench
```

This runs `node bench.js` under `/usr/bin/time` to report peak memory consumption.

## Contributing

1. Fork the repository
2. Install dependencies: `yarn`
3. Build: `yarn build`
4. Run tests: `yarn test`
5. Open a pull request with your changes

Please follow the [contribution guidelines](./CONTRIBUTING.md) and ensure all tests pass.

## License

This project is licensed under the ISC License. See the [LICENSE](./LICENSE) file for details.
