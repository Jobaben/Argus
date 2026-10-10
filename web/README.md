# Argus web workspace

The React dashboard for Argus. For installation and normal use, start with the [documentation index](../docs/README.md). This page is for contributors working on the web workspace.

## Develop from the repository root

Requires Node.js 22 or newer. Install all workspaces together:

```sh
npm ci
npm run dev
```

Open **http://localhost:5757**. Vite proxies `/api` and `/ws` to the server on port 7777 by default. Run `npm run dev:web` only when a compatible development API is already running; it does not start the server. See [Vite configuration](vite.config.ts) and [operations](../docs/reference/operations.md) for custom ports and binds.

## Validate

From the root:

```sh
npm -w web run typecheck
npm -w web run lint
npm -w web run test
npm -w web run build
```

`npm run build` also builds the server for single-port production use. A build pass does not prove runtime credentials or live workflows work.

## Code map

| Location                                   | Responsibility                                   |
| ------------------------------------------ | ------------------------------------------------ |
| [src/App.tsx](src/App.tsx)                 | Route metadata, lazy views and application shell |
| [src/legacyRoutes.ts](src/legacyRoutes.ts) | Redirects for removed/moved destinations         |
| [src/views/](src/views/)                   | Feature pages and panels                         |
| [src/live/](src/live/)                     | Shared socket and live-resource reads            |
| [src/cmd/](src/cmd/)                       | Palette, keyboard bindings and shortcut help     |
| [src/ds/](src/ds/)                         | Shared UI primitives, presence, motion and clock |
| [src/notify/](src/notify/)                 | Browser notifications and alerts                 |
| [../contracts/](../contracts/)             | Shared HTTP/WebSocket types                      |

Read [Architecture](../docs/ARCHITECTURE.md#8-client-architecture), [the motion system](../docs/MOTION-SYSTEM.md), and [design sources](../design/README.md) before changing shared behavior. Update the corresponding [feature guide](../docs/guides/README.md) when controls, routes or defaults change.
