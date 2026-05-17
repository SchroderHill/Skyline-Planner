# Sky line Planning Report by Schroder Hill Limited

A browser-only prototype for preliminary forestry skyline clearance screening. It uses a simple straight-line skyline clearance model for v1 and is not a final engineered cable harvesting design tool.

## Run Locally

```powershell
npm install
npm run dev
```

## Mapbox Token

The app uses Mapbox GL JS when a public token is available, but the token is not hard-coded. LINZ hillshade tiles can also be enabled with a LINZ Basemaps API key.

1. Copy `.env.example` to `.env`.
2. Add your public tokens:

```env
VITE_MAPBOX_TOKEN=your_mapbox_public_token_here
VITE_LINZ_API_KEY=your_linz_basemaps_api_key_here
```

Without a token, the app opens in a no-map fallback mode with demo geometry so the clearance engine and tests still work.

## Tests

```powershell
npm test
```

## Model Scope

The prototype uses a simple user-defined geometric deflection model for preliminary screening. It does not calculate true rope tension, safe working load, or cable mechanics.

## Disclaimer

Preliminary skyline clearance screening only. Not a final cable harvesting plan. Final setup must be confirmed by a competent cable harvesting operator or planner.
