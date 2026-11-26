# AGENTS.md — hsStore (Holly)

## Overview

Static e-commerce storefront built with **Astro 7** (Spanish UI, `<html lang="es">`) and deployed to **AWS S3 + CloudFront** using **Serverless Framework v4** and **GitHub Actions**.

## Tech Stack

- **Framework:** Astro `^7.4.13` (static output to `dist/`, no SSR adapter)
- **Language:** TypeScript (`astro/tsconfigs/strict`), ESM (`"type": "module"`)
- **Runtime & Package Manager:** Node.js `>=22.23.4`, `pnpm`
- **Styling:** Plain CSS with **CSS Modules** (`*.module.css`) and global CSS custom properties (`src/styles/global.css`) — no CSS framework (e.g., Tailwind)
- **Fonts:** Local `.ttf` fonts configured via `fontProviders.local()` in `astro.config.mjs` (`Boldonse`, `Galada`, `Varela Round`)
- **Interactive / Graphics:**
  - `three` (`^0.187.0`) — 3D viewer (`public/models/caja-salsas.glb`)
  - `matter-js` (`^0.20.0`) — 2D physics animations
- **Infrastructure & CI/CD:**
  - **Serverless Framework v4** (`serverless.yml`, service `holly-frontend`, region `us-east-1`): private S3 bucket, CloudFront Origin Access Control (OAC), CloudFront Function (`cloudfront-js-2.0`) for Astro directory route rewriting, CloudFront distribution, and S3 bucket policy.
  - **GitHub Actions** (`.github/workflows/deploy-frontend.yml`): builds with `pnpm`, deploys stack `holly-frontend-prod`, syncs `dist/` to S3 with split cache headers, and invalidates CloudFront.
  - **Planned Backend:** Future `.NET` AWS Lambda API will live in a separate `backend/` folder with its own `serverless.yml` and path-filtered workflow, routed via CloudFront `/api/*`.

## Project Structure

```text
hsStore/
├── .github/workflows/
│   └── deploy-frontend.yml     # CI/CD for frontend (path-filtered on push to main)
├── public/
│   ├── icons/                  # SVG icons
│   ├── media/                  # Product images, reviews, video
│   └── models/                 # 3D GLB models (caja-salsas.glb)
├── src/
│   ├── assets/fonts/           # Local .ttf fonts (Boldonse, Galada, Varela Round)
│   ├── components/             # Feature folders: <name>/<name>.astro + .module.css + optional .ts
│   │   ├── flavors/
│   │   ├── footer/
│   │   ├── hero/
│   │   ├── nav/
│   │   ├── package/            # Three.js 3D package viewer + fallback
│   │   ├── resellers/          # Matter.js effects + modal
│   │   └── showcase/
│   ├── layouts/
│   │   └── Layout.astro        # Base HTML shell, font preloads, global CSS, optional Footer
│   ├── pages/                  # File-based routes (index, products, cart, about, profile, legal)
│   └── styles/                 # global.css + page-level *.module.css
├── astro.config.mjs            # Astro & local font configuration
├── serverless.yml              # AWS S3 + CloudFront IaC (Serverless Framework v4)
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

## Project Rules & Conventions

- **Package manager:** Always use `pnpm` (`pnpm install`, `pnpm build`, `pnpm preview`). Do not mix `npm`/`yarn` lockfiles.
- **Language:** All user-facing copy, titles, labels, and alt text must be in **Spanish** (`lang="es"`).
- **Styling:**
  - Use CSS Modules (`*.module.css`) co-located inside `src/components/<name>/` for components and under `src/styles/` for pages.
  - Use the design tokens defined in `src/styles/global.css`:
    - Colors: `--color-primary` (`#F1E5BC`), `--color-text` (`#050503`), `--color-contrast` (`#DAC211`), `--color-action` (`#A61F48`).
    - Fonts: `--font-brand`, `--font-heading`, `--font-body`.
  - Note that `html { font-size: 62.5%; }` is set globally (`1rem = 10px`).
- **Component organization:** Keep each component self-contained in `src/components/<name>/` with `<name>.astro`, `<name>.module.css`, and separate `.ts` files for client-side interactivity.
- **Static routing & CloudFront:** Astro outputs directory-based static pages (`dist/<route>/index.html`). Extensionless routes (`/products`, `/cart`, etc.) rely on the `UrlRewriteFunction` in `serverless.yml` to append `/index.html`.
- **Serverless Framework v4 (`serverless.yml`):**
  - Keep S3 buckets private (`PublicAccessBlockConfiguration` all `true`) and serve exclusively via CloudFront OAC.
  - Prefer CloudFormation `!Join` over `!Sub '${...}'` so Serverless v4 does not misinterpret `${...}` as a Serverless variable.
  - Keep frontend path filters in `.github/workflows/deploy-frontend.yml` up to date if new root config files affect the frontend build.

## Development

When starting the dev server, use background mode:

```bash
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

Common commands:

- `pnpm build` — Build static site into `dist/`
- `pnpm preview` — Preview production build locally

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
