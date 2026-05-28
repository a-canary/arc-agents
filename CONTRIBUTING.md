# Contributing to cli-proxy

## Dev Setup

```bash
git clone https://github.com/a-canary/cli-proxy.git
cd cli-proxy
npm install
```

Requires Node.js >=22.

## Run

```bash
npm start  # starts the server on port 7890
```

## Tests

```bash
npm test        # all tests
node --test --experimental-strip-types tests/one.test.ts  # single file
```

## Code Quality

```bash
npm run check  # typecheck all .ts files
```

## File an Issue

Open at https://github.com/a-canary/cli-proxy/issues. PRs welcome — expect thoughtful review. Solo dev, triage may be slow.