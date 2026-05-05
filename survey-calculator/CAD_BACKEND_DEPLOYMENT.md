# CAD Backend Deployment

This app should be deployed in two parts:

- Frontend on Vercel.
- CAD backend on a separate host that supports native binaries and child processes.

## Why Separate It

Native DWG conversion depends on a server-side converter process. That does not belong in a static Vercel frontend deployment, and it should never depend on software installed on a user machine.

## Recommended Production Architecture

1. Deploy the current frontend to Vercel.
2. Deploy the CAD backend from this repo using `Dockerfile.cad-api`.
3. Use the Docker image as-is on Railway or another container host; it already installs LibreDWG (`dwg2dxf`) for DWG to DXF conversion.
4. Set `VITE_CAD_API_BASE_URL` in Vercel to your hosted backend URL.

## Backend Hosting Options

- VM or VPS: easiest path if you need full control over native converters.
- Container host: good if you can bundle or mount the converter in the runtime.
- Managed app platform: only if it supports the required native process model and filesystem behavior.

## Backend Environment

Use `.env.cad-api.example` as the baseline.

Required in production:

- `CAD_ALLOWED_ORIGINS`

Optional overrides:

- `DWG2DXF_PATH`
- `DWG_CONVERTER_COMMAND`

## Vercel Environment

Use `.env.vercel.example` as the baseline.

Required in production:

- `VITE_CAD_API_BASE_URL=https://cad-api.yourdomain.com/api/cad`

## Docker Example

Build:

```bash
docker build -f Dockerfile.cad-api -t survey-cad-api .
```

Run:

```bash
docker run --rm -p 4000:4000 --env-file .env.cad-api survey-cad-api
```

The current Docker image already bakes LibreDWG into the runtime for Railway-style deployment. Only set `DWG2DXF_PATH` or `DWG_CONVERTER_COMMAND` if you are overriding the default converter strategy.

## Next Product Step

Once the hosted CAD API boundary is stable, the next implementation should expand the backend to return full CAD entities so the frontend can render lines, polylines, and point extraction workflows.
