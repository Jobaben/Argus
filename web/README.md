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

## Home Screen branding

The shared [document head](index.html) supplies the install metadata on every hash route, including the sign-in screen. Argus is dark-only: the initial document, application background, and manifest colors use `#0a0f16`. The Apple status bar uses `black` to keep content below the system bar on older iOS versions; the existing viewport does not opt into drawing under screen cutouts.

[favicon.svg](public/favicon.svg) is the source artwork, a static adaptation of the existing `IrisMark` with the cyan `#36e3e8` rings, eye, and status blips. The three PNGs are rasterized from this SVG at 180, 192, and 512 pixels with an opaque navy background and internal padding. Regenerate all three when changing the artwork; leave the outer corners square for iOS to shape.

The deployment base is `/` (Vite's default and the production server's mount). Head asset links use Vite's `%BASE_URL%`; manifest launch, scope, and icon URLs resolve relative to the manifest. The new stable manifest ID is `/`. A future move to a subdirectory must coordinate the server, API paths, and manifest identity as well as Vite's base. Production serves the branding files publicly through exact routes; application API/session protection still applies.

After deploying a fresh `npm run build` (or using `argus --rebuild` with your usual launch options), check on an iPhone:

1. Open the deployed Argus URL in Safari, then choose **Share → Add to Home Screen**. Repeat from a deep link such as `/#/pipelines`.
2. Keep **Open as Web App** enabled when shown. Check the proposed iris icon and **Argus** name before adding it.
3. Launch the new icon. Check standalone presentation, the dark initial background, sign-in/dashboard appearance, and that controls stay clear of the status bar and screen cutouts.
4. If an existing installation retains old branding, remove its Home Screen icon and add a fresh one after deployment.
5. Compare with the normal/default Home Screen icon appearance first: iOS tinted, dark, or clear appearance settings can change the supplied icon's colors.

Real iPhone validation remains manual. Manifest colors do not guarantee a custom iOS splash screen or exact system status-bar colors. The status-bar compatibility choice follows [Apple's metadata reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html); current installation steps are described in [Apple's iPhone guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

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
