# Draft issue for truefoundry/trueforge — NOT YET FILED

Ready to post at https://github.com/truefoundry/trueforge/issues/new — reviewed by a human first.
Everything below was reproduced locally; the root cause is pinned to a line, and the fix is one
line in TrueForge's own code (no upstream kysely change required).

---

**Title:** `npx @truefoundry/trueforge` fails to start on Windows — migration loader passes a raw
Win32 path to `import()`

---

### What happens

`npx @truefoundry/trueforge@latest` never starts on Windows. The banner prints, then:

```
17:45:29 warn Removing leftover Code Mode socket parent {"path":"C:\\Users\\...\\Temp\\tf_cms"}
17:45:29 warn Local sandbox fallback is unavailable {"reason":"LocalSandboxProvider supports macOS and Linux only (got win32)"}
Failed to start server: Only URLs with a scheme in: file, data, and node are supported by the
default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'
```

The process exits. No port is opened, no migration runs. (The sandbox warning above it is
expected/documented — the ESM error is the hard stop.)

### Environment

| | |
|---|---|
| TrueForge | 0.1.4 (standalone, via `npx`) |
| Node | v24.18.0 |
| npm | 11.17.0 |
| OS | Windows 11, 10.0.26200.9168 |

### Reproduce

On any Windows machine:

```
npx -y @truefoundry/trueforge@latest
```

### Root cause

Not in TrueForge's own bundle — `dist/main.js` contains no dynamic `import()` at all. It is
`kysely`'s `FileMigrationProvider`, which TrueForge uses to run the 14 startup migrations:

`node_modules/kysely/dist/migration/file-migration-provider.js:32-35`

```js
const filePath = this.#props.path.join(this.#props.migrationFolder, fileName);
const module = this.#props.import
    ? await this.#props.import(filePath)
    : await import(/* webpackIgnore: true */ filePath);
```

`path.join()` on Windows produces `C:\Users\...\20260730_000001_init.js`. Node's ESM loader
rejects a bare drive-letter path — it requires a `file://` URL — and reports the drive letter as
an unsupported protocol, hence `Received protocol 'c:'`.

This is why it only bites on Windows: on Linux/macOS `path.join()` yields `/...`, which the loader
accepts.

### Suggested fix

`FileMigrationProvider` already accepts a caller-supplied `import` function, so this can be fixed
in TrueForge without waiting on kysely:

```js
import { pathToFileURL } from 'node:url';

new FileMigrationProvider({
  fs,
  path,
  migrationFolder,
  // Windows: import() requires a file:// URL, not a bare C:\ path.
  import: (p) => import(pathToFileURL(p).href),
});
```

`pathToFileURL` is a no-op-shaped conversion on POSIX, so the same code is correct on all
platforms.

### Workaround for anyone hitting this now

Run the published package inside a Linux container — no source build, no compose, no
Postgres/Redis:

```bash
docker run -d --name tforge -p 4000:4000 -e PORT=4000 -e HOST=0.0.0.0 \
  node:22-bookworm-slim sh -lc "npx -y @truefoundry/trueforge@latest"
```

Boots clean: 14 migrations apply, SQLite at `/root/.local/share/trueforge/db/db.sqlite`,
`Agent server listening on http://0.0.0.0:4000`.

### Second, smaller note — enabling the local sandbox

Out of the box the container also reports:

```
warn Local sandbox fallback is unavailable
{"reason":"SRT host dependencies missing (linux: bwrap, socat, rg)"}
```

and then, once those are installed:

```
{"reason":"No usable Python 3 interpreter in sandbox (python3 or python via command -v)"}
```

Installing `bubblewrap socat ripgrep python3` and running the container `--privileged` (bubblewrap
needs user namespaces) flips both:

```
info Local sandbox fallback is available {"platform":"linux","shell":"/usr/bin/bash","python":"/usr/bin/python3.11"}
GET /api/v1/capabilities -> {"sandbox":{"enabled":true},"skill":{"enabled":true},"settings":{"enabled":true}}
```

Might be worth documenting in the quickstart, or shipping those four packages in an official
image — Skills are gated behind the sandbox (`"Skills run in a sandbox, which is not configured."`),
so a default `npx` run silently has Skills unavailable and the reason is two layers down in the logs.

Happy to open a PR for the `pathToFileURL` fix if useful.
