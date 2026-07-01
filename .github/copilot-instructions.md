# Skyline Planner Agent Instructions

- Never remove, blank, rename, or bypass `VITE_MAPBOX_TOKEN` handling unless the user explicitly requests it in the current conversation.
- Treat the Mapbox token as a required deployment dependency for the live map canvas. The app may fall back to no-map mode without it, but production should keep the token available through GitHub Actions secrets or environment variables.
- Do not hard-code Mapbox or LINZ token literals into source files. Preserve workflow-time injection via `.github/workflows/deploy-pages.yml` and repository secrets/variables.
- When changing deployment, Vite config, app startup, map initialization, or environment handling, verify that the deployed build receives `VITE_MAPBOX_TOKEN` without printing the token value.
- If the live site shows a blank/no-map state after deploy, first check the GitHub Pages workflow env and deployed bundle token presence before changing layout or map code.