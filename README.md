# the-goodies-typescript

TypeScript client implementation of The Goodies distributed MCP knowledge graph

## Overview

This is a complete TypeScript port of The Goodies client libraries, enabling TypeScript/Node.js applications to interact with FunkyGibbon servers.

## Packages

### inbetweenies
TypeScript protocol package based on the Python [inbetweenies](https://github.com/adrianco/the-goodies/tree/main/inbetweenies) protocol.

Provides:
- Entity and relationship models
- Type definitions for all entity types
- Serialization/deserialization
- Protocol types

### kittenkong
TypeScript client package based on Python [blowing-off](https://github.com/adrianco/the-goodies/tree/main/blowing-off) that depends on inbetweenies to communicate with the Python-based [funkygibbon](https://github.com/adrianco/the-goodies/tree/main/funkygibbon) server.

Provides:
- REST API client for FunkyGibbon
- In-memory local graph cache (see [Sync behaviour](#sync-behaviour))
- Sync engine (Inbetweenies v2, per-id acknowledgement)
- Authentication management
- MCP tool execution (12 tools, served over stdio)

## Installation

```bash
npm install @the-goodies/inbetweenies
npm install @the-goodies/kittenkong
```

## Quick Start

```typescript
import { KittenKongClient } from '@the-goodies/kittenkong';

// Connect to FunkyGibbon server
const client = new KittenKongClient({
  serverUrl: 'http://localhost:8000',
  authToken: 'your-token'
});

// Authenticate
await client.loginAdmin('password');

// Create an entity
const device = await client.createEntity({
  entityType: 'DEVICE',
  name: 'Smart Light',
  content: {
    manufacturer: 'Philips',
    model: 'Hue'
  }
});

// Search entities
const results = await client.searchEntities('smart light');

// Sync with server
await client.sync();
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Watch mode
npm run dev
```

## Testing

Unit tests need nothing but `npm test`.

Integration tests start **their own** FunkyGibbon server on a freshly allocated
ephemeral port, with a throwaway seeded database and a real admin login — they
never touch a running install and never bind port 8000. Point them at a Python
checkout:

```bash
FUNKYGIBBON_REPO=~/the-goodies npm test
```

Without `FUNKYGIBBON_REPO` (and no sibling checkout to discover) the
integration tests **skip with an explicit reason**. If the repo is found but
the server fails to start, the run **fails loudly** — a broken harness never
masquerades as a passing suite.

| Variable | Purpose |
|---|---|
| `FUNKYGIBBON_REPO` | Path to the Python repo (default: discovery) |
| `FUNKYGIBBON_PYTHON` | Interpreter (default: `<repo>/venv/bin/python`, else `python3`) |
| `FUNKYGIBBON_URL` | Target an already-running server instead |
| `FUNKYGIBBON_TOKEN` | Bearer token when using `FUNKYGIBBON_URL` |

To run the client against a real long-lived server instead:

```bash
cd ~/the-goodies && ./start_funkygibbon.sh   # http://localhost:8000
```

## Sync behaviour

Sync is server-authoritative. The client pushes local changes and clears a
pending mark **only** when the server acknowledges that change **by id**
(`applied` / `applied_relationships`, FunkyGibbon v0.3.0+). Anything the server
omits — because it lost conflict resolution or its endpoint was missing —
stays pending and retries on the next sync. Aggregate counts are never used for
this: a partially-applied batch would otherwise clear writes that never landed.

Pull runs before push, and **an entity carrying an unpushed local edit is never
overwritten by pull**. The local version is pushed with its original
`parentVersions` so the server adjudicates; the server's version arrives on a
later delta once the id is no longer pending.

### Known limitations

- **The local cache is in-memory only.** Nothing survives a process restart; the
  next sync repopulates from the server. Unsynced local edits made before a
  restart are lost. A persistent store is part of the design work below.
- **Conflict resolution is server-side only.** The client applies the winner and
  reports conflicts informationally; it never resolves locally.
- Tracked in [#3](https://github.com/rolandcanyon-cmd/the-goodies-typescript/issues/3).
  The redesign that addresses persistence — clients as full temporal replicas
  with as-of queries — is under review as ADRs in
  [adrianco/the-goodies#70](https://github.com/adrianco/the-goodies/pull/70).

## Related Projects

- [the-goodies](https://github.com/adrianco/the-goodies) - Python implementation (FunkyGibbon server, Blowing-Off client, Inbetweenies protocol)
- [the-goodies-swift](https://github.com/adrianco/the-goodies-swift) - Swift client implementation
- [c11s-house-ios](https://github.com/adrianco/c11s-house-ios) - iOS app using The Goodies
- [instar](https://github.com/JKHeadley/instar) - Autonomous agent infrastructure framework

## License

Apache 2.0
