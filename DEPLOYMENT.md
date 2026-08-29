# Deployment

Production URL:

```text
https://seu-link.fit/makeup/
```

Build the static site with Node.js 22:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test:actions
pnpm build
```

Publish the complete contents of `dist/` into the Nginx directory serving
`/makeup/`. The Vite production base is `/makeup/`, so generated JavaScript,
CSS, action JSON, regions, models, and sequences all resolve under that
path.

The deployment must use HTTPS for browser camera access. Nginx should route
`/makeup/` to the static directory and preserve the trailing slash redirect.
Do not give stable runtime files under `actions/`, `regions/`, `models/`,
or `sequences/` an immutable cache policy.
