<p align="center">
  <img src="docs/assets/logo.png" alt="mcp-persistence: the cyan panda keeping durable data archives" width="180" />
  <img src="docs/assets/mcp-broker-family.png" alt="MCP Broker Family" width="64" height="64" />
</p>

# mcp-persistence

Durable JSON documents, immutable revisions and streamed binary artifacts for the CyanMycelium MCP family. SQLite keeps revisions, references and idempotency; an internal file directory keeps artifact bytes. The broker decides access.

**Status: early release 0.2.0.** Node.js 22.13 or later is required; its built-in `node:sqlite` API is experimental on Node 22. This is a local single-writer backend, with integration tests, not a distributed storage service.

```text
Explorer / Mission Control / MCP client
                  |
              mcp-broker
                  |
       slot persistence, PersistenceBehavior
                  | broker decisions per resource
          IPersistenceStore
                  |
     SQLite revisions + internal artifact files

Binary upload/download -> loopback HTTP endpoint
                  | forwards caller bearer to a fresh broker MCP check
                  +-> bounded file stream, never base64 over MCP
```

Applications own document schemas, migrations and scene restoration. Persistence stores the states they provide and never restarts their operations.

## MCP contract for client development

Start with the [wire contract and examples](docs/mcp-contract.md), the [machine-readable JSON schemas](contracts/persistence.v1.json), and the [TypeScript store interface](src/contract/persistence.store.ts). These describe `persistence.v1`, revision 1, independently of SQLite. Import `@cyanmycelium/mcp-persistence/protocol` for backend-independent tool schemas or load `@cyanmycelium/mcp-persistence/contracts/persistence.v1.json`. The behavior publishes the same tool definitions used to generate the manifest. Tests validate live MCP inputs and outputs against these schemas.

```sh
npm run contracts
```

Regenerate the manifest after intentional protocol changes. Client teams can use its descriptors and fixtures while backend work continues.

## Develop locally

```sh
npm install
npm run build
npm test
npm run dev
```

For an npm installation, install `@cyanmycelium/mcp-broker` as well to use the optional `--dev` embedded broker. In a checkout it is already a development dependency.

`npm run dev` starts its own broker on `127.0.0.1:3000`, the provider and the transfer endpoint on `127.0.0.1:3001`. It explicitly selects `openGuard()`, so no token or policy is needed. The startup banner identifies this mode. Stop any broker already using port 3000, or choose another port with `MCP_PERSISTENCE_BROKER_URL`. Storage defaults to `./data-dev`.

On Windows, Node cannot synchronize directory entries. Choose the weaker file-sync durability explicitly before launch:

```powershell
$env:MCP_PERSISTENCE_ALLOW_FILE_SYNC_ONLY = '1'
npm run dev
```

This setting preserves SQLite transactions and synchronizes artifact file contents, but does not guarantee artifact directory entries against power loss. Without the opt-in, Windows startup is refused. On systems supporting directory fsync, leave the option unset for file-and-directory synchronization. Storage must be a canonical local directory, under operator control, with no symlinks or competing writer.

## Move to production

Read the broker's [HOWTO: development, policy tests and production](https://github.com/pandaGaume/mcp-broker/blob/main/HOWTO.md). It is supplied with the accompanying broker changes and may need that commit before the GitHub link resolves. It explains `openGuard()`, `auth.dev`, provider identities, OAuth and the access verification matrix.

Production uses an independently managed broker. The normal entry point uses `BrokerAccessGuard` and fails startup if its provider credential or accepted declaration is missing. It never falls back to `openGuard()`.

```powershell
$env:MCP_PERSISTENCE_BROKER_URL = 'https://mcp.example.com'
$env:MCP_PERSISTENCE_RESOURCE_ROOT = '/site1/persistence'
$env:MCP_PERSISTENCE_DATA = 'C:\ServiceData\mcp-persistence'
# Inject MCP_PERSISTENCE_PROVIDER_SECRET through the service environment.
# It must match the provider secretEnv entry in the broker security file.
npm start
```

On Windows the explicit file-sync opt-in above is also required. Serve the transfer endpoint behind an HTTPS reverse proxy; it always binds loopback. Preserve Authorization and streaming. Every transfer forwards the caller's bearer to the configured broker slot for a new access decision before opening bytes. A known upload id, artifact id or URL grants no permission. A stream already opened is not automatically interrupted by later revocation.

Do not carry `--dev` into the service command. `auth.dev` belongs to the broker and keeps the policy active; use normal `npm start` with that broker when testing policy locally. The transfer server has no standalone open-mode CLI switch.

## Configuration

| variable | default / meaning |
|---|---|
| `MCP_PERSISTENCE_BROKER_URL` | `http://127.0.0.1:3000`, broker origin |
| `MCP_PERSISTENCE_RESOURCE_ROOT` | `/local/persistence`, must match broker policy |
| `MCP_PERSISTENCE_PROVIDER_SECRET` | required outside `--dev`, own provider identity |
| `MCP_PERSISTENCE_DATA` | `./data-dev` in dev, `./data` otherwise |
| `MCP_PERSISTENCE_TRANSFER_PORT` | `3001`, loopback HTTP listener |
| `MCP_PERSISTENCE_LOCALE` | `en`, or `fr` for mcp-core grammar |
| `MCP_PERSISTENCE_ALLOW_FILE_SYNC_ONLY` | `1` explicitly permits weaker Windows file durability |

The library's `ISqlitePersistenceOptions` configures size limits and minimum retention. Purge is disabled by infinite retention unless a finite `retentionMs` is explicitly configured in the application assembly. There is no automatic retention job.

## Use from TypeScript

See [examples/explorer.mjs](examples/explorer.mjs) for a checkpoint saved through a real MCP client. `PersistenceSlotStore` implements the same `IPersistenceStore` as the local `SqlitePersistenceStore`.

```ts
const store = new SqlitePersistenceStore({ directory: '/srv/persistence' });
const context = { subject: 'trusted-internal-application' };
const saved = await store.putAsync({
    namespace: 'explorer', id: 'checkpoint-1', kind: 'checkpoint',
    schemaVersion: '1', expectedRevision: 0,
    payload: { sessionId: 'session-1', camera: { position: [0, 0, 10] } },
    references: [], idempotencyKey: crypto.randomUUID()
}, context);
await store.closeAsync();
```

The direct store is an internal trusted API. A remote store ignores `context.subject`; it never sends that value as caller identity. The broker authenticates the connected MCP client. Reuse a mutation's idempotency key after a lost response, along with the identical request.

## Tools and resources

| tools | broker capability |
|---|---|
| `persistence.capabilities` | public protocol and effective limits |
| `persistence.get`, `list`, `listRevisions` | `persistence.read`, per document; list entries are filtered |
| `persistence.put` | `persistence.write`; referenced targets additionally require read |
| `persistence.delete` | `persistence.delete`, logical tombstone |
| `persistence.beginArtifact` | `persistence.write` on the namespace artifact creation target `_new` |
| `persistence.uploadAccess`, `commitArtifact`, `abortArtifact` | `persistence.write` on the generated artifact target |
| `persistence.getArtifact` | `persistence.read` on the artifact |
| `persistence.purge` | `persistence.admin`, plus retention/reference checks |

Each name above has the `persistence.` prefix. Documents and artifacts occupy `<root>/namespaces/<namespace>/documents/<id>` and `<root>/namespaces/<namespace>/artifacts/<id>`. Namespace and id are single validated segments, at most 128 ASCII letters, digits, dots, underscores or hyphens, beginning with a letter, digit or underscore. Business UNS identifiers remain application data.

Templates on the provider's own slot:

- `persistence://documents/{namespace}/{id}`
- `persistence://documents/{namespace}/{id}/revisions/{revision}`
- `persistence://artifacts/{namespace}/{id}`

`persistence://capabilities` is public protocol metadata. EN and FR grammars use mcp-core. `_all` exposes opted-in tools and prompts, not resources.

## Guarantees and limits

- `expectedRevision: 0` creates only. Updates and tombstones must match the current revision. Historical revisions stay immutable until authorized purge.
- Document writes, reference checks, namespace quota accounting and idempotency results commit in one SQLite transaction, with WAL and synchronous=FULL.
- Keys are retained at least seven days. Direct stores scope them to subject and namespace. MCP scopes them to namespace because broker caller references are request-scoped. Use UUID keys across applications sharing a namespace. Reuse with different content conflicts; rights are checked before a replay. Actor ownership of an upload follows resource rights, not a claimed user id.
- Incomplete or wrong-hash uploads never become artifacts. Files are verified, synchronized and renamed before metadata publication. Restart reconciles staged/final files and verifies committed content before serving. Unlink pending after a purge remains quota-accounted until collection.
- Lists use encrypted authenticated cursors, bound to filters, namespace and the store context, expiring after fifteen minutes. Limits apply before authorization filtering, so a filtered page may be empty with a next cursor. Keep following nextCursor. Lists spanning requests are not snapshots.
- Default limits: 1 MiB document request, 256 references, 50 entries per page (maximum 200), 10 GiB artifact and 100 GiB logical namespace quota. Four uploads per store subject are active at once, therefore four across the MCP slot. Idempotency has 100,000 entries per namespace. Quota accounting includes retained revisions, reserved upload bytes, artifact metadata, idempotency and pending file deletion; filesystem and SQLite page overhead are additional.
- Uploads expire after 24 hours. An interrupted stream restarts from byte zero. Completion and abort are replayable. No public bearer download links or file paths are returned.

The configured 10 GiB maximum is a limit, not a throughput claim. Tests transfer 512 KiB in bounded chunks. Full hash verification on commit, download and startup is synchronous and can block Node on large archives. Load testing and asynchronous verification are still needed before a high-volume deployment. One process owns one data root; use a single provider instance per root.

## Backup and restore

Stop the provider cleanly and wait for transfers and SQLite checkpointing to finish. Copy the entire data directory to a protected backup destination, including the database, artifact files and cursor key. Do not copy only a live SQLite main file while omitting its WAL. Do not copy the provider environment or credentials into an application export.

Restore into a new canonical data root while the service is stopped. Verify backup file hashes from your backup system, set `MCP_PERSISTENCE_DATA` to that root and start the provider. Startup checks schema compatibility and committed artifact hashes; a missing or corrupt committed file refuses startup. Read a known document and pinned artifact before returning traffic. An offline restore must be exercised with the actual filesystem and backup tool used in production. Application operations are never restarted by restoration.

## Layout and tests

`src/contract/` holds the shared types; `src/sqlite/` implements documents and files; `src/server/` provides behavior, client and broker declaration; `src/provider/` assembles the executable and byte-transfer endpoint. `/conformance` exports a Vitest suite reusable on direct backends and through the slot.

```sh
npm run typecheck
npm run build
npm test
```

Tests cover restart, competing updates, idempotence, quotas, incomplete and corrupt transfers, rename-before-commit recovery, evidence references, pagination, real broker decisions, HTTP transfer authorization and explicit dev versus normal startup.

The initial [architecture proposal](docs/brief_persistence_slot.md) records the design. Runtime deviations and current guarantees are specified here, particularly namespace-scoped MCP idempotence and authenticated streaming without reusable tickets.

## MCP family

| project | responsibility |
|---|---|
| [mcp-core](https://github.com/pandaGaume/mcp-core) | behaviors, adapters, schemas, resources and grammars |
| [mcp-broker](https://github.com/pandaGaume/mcp-broker) | transport, identity, policy decisions and audit |
| [mcp-uns](https://github.com/pandaGaume/mcp-uns) | UNS conventions and shared access guard |
| [mcp-vault](https://github.com/pandaGaume/mcp-vault) | sealed secrets and configuration |
| [mcp-cache](https://github.com/pandaGaume/mcp-cache) | values with a time to live |
| [mcp-history](https://github.com/pandaGaume/mcp-history) | time series |
| mcp-persistence | durable documents, pinned revisions and artifacts |

The family emblem identifies the ecosystem; it is not a certification.

## Automated npm releases

[.github/workflows/release.yml](.github/workflows/release.yml) publishes stable releases when a `v*` tag is pushed. The tag must match package.json exactly, for example `v0.1.1` for version `0.1.1`. Type checking, tests, contract generation and package inspection must pass before publication. Version 0.1.0 was published manually; use a new version for the next release.

Configure the npm trusted publisher with GitHub owner `pandaGaume`, repository `mcp-persistence`, workflow filename `release.yml`, no environment, and permission to run `npm publish`. The workflow uses GitHub OIDC with `id-token: write`; no NPM_TOKEN secret is required. Commit and push the workflow before using it for a release.

## License

Apache-2.0. See [LICENSE](LICENSE).
