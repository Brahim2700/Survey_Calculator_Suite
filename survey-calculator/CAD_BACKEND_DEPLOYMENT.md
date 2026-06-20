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

Recommended:

- `CAD_API_PORT=4000`
- `CAD_MAX_UPLOAD_MB=100`
- `DWG_CONVERTER_TIMEOUT_MS=120000`

Optional overrides:

- `DWG2DXF_PATH`
- `DWG_CONVERTER_COMMAND`

## Vercel Environment

Use `.env.vercel.example` as the baseline.

Required in production:

- `VITE_CAD_API_BASE_URL=https://cad-api.yourdomain.com/api/cad`

Production note:

- Keep `VITE_CAD_BACKEND_PROXY_TARGET` unset in Vercel.

## Cloud Wiring Checklist

1. Deploy Railway service with `railway.json` using `Dockerfile.cad-api`.
2. Set Railway env `CAD_ALLOWED_ORIGINS` to your Vercel URLs.
3. Open `https://<railway-domain>/api/cad/health` and verify HTTP 200.
4. In Vercel project settings, set `VITE_CAD_API_BASE_URL=https://<railway-domain>/api/cad`.
5. Trigger a Vercel redeploy after setting environment variables.
6. Upload one `.dxf` and one binary `.dwg` in production to verify both paths.

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
