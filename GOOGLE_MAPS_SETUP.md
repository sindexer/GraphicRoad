# Google Maps deployment

Naver themes are `Naver Map`, `기본_N`, `블루_N (지하철 X)`, `블루_N`,
`흰블_N`, and `위성_N`. Google themes are `Google Map`, `기본_G`, `블루_G`,
and `위성_G`. `Google Map` uses the default roadmap with no custom style or
map ID. The two styled Google themes retain their existing Cloud map IDs.
Selecting a Google theme hides the entire boundary toolbar and its popovers.
Returning to Naver restores the saved boundary settings. Each provider keeps
its own search results and pins; Google data is not copied onto a Naver map.

Satellite currently has a conservative zoom ceiling of 15: live Seoul imagery
was available at 15 but returned missing-image tiles at 16 and 17. The maximum
imagery service can further lower the limit for areas with less coverage.
Roadmap themes keep their normal zoom range. Raise this ceiling only after
checking actual satellite tiles with this deployment's key and region settings.

## Security

- Never commit the API key or `google-maps-config.json`.
- Set the repository Actions secret `GOOGLE_MAPS_BROWSER_KEY`.
- Set repository variables `GOOGLE_MAP_ID_BASIC` and `GOOGLE_MAP_ID_BLUE` to
  **JavaScript map IDs**, each linked to the corresponding published style.
  Style IDs are not interchangeable with map IDs. Map IDs are public configuration.
- Restrict the browser key to `https://sindexer.github.io/*` in Google Cloud.
  The SDK uses `auth_referrer_policy=origin`; do not restrict to a full page path.
- Restrict APIs to Maps JavaScript API, Geocoding API, and Places API (New).
  Geocoding supports addresses/right-click lookup; Places supports keyword search.
- A browser key remains visible in downloaded site configuration and Google
  requests. Actions secrets keep it out of source history, not out of the browser.
  Do not obfuscate it or claim that the generated config is private.
- No key is written to browser storage or included in app error logs.
- Use a dedicated key. Check usage, set appropriate API quotas and billing alerts,
  and rotate the key if it is misused. Budget alerts do not cap spending.

## Hosting

GitHub Pages must use **GitHub Actions** as its source. The deployment workflow
tests the code, builds a small allowlisted artifact, and injects the browser
configuration from the secret/variables. Missing configuration fails the build
without replacing the last successful deployment. The secret is not available
to pull requests and is passed only to the build step of the main-branch workflow.

```sh
node --test tests/*.test.mjs
node scripts/build.mjs
node scripts/serve.mjs _site 4173
```

Supply the three environment variables to the build process privately. Local
live API tests require a separate development key restricted to the exact
localhost origin; do not relax the production key for local tests.

## Export

Naver retains its direct PNG export. Google Export uses the browser's current-tab
screen-share picker; select the GraphicRoad tab. Only the map area is saved, with
Google's logo and provider attribution left intact. Capture permission is per
user action and all capture tracks are stopped afterward. Browsers without
`getDisplayMedia` show an explanation rather than saving an empty map.

## References

- https://developers.google.com/maps/api-security-best-practices
- https://developers.google.com/maps/documentation/javascript/map-ids/get-map-id
- https://developers.google.com/maps/documentation/javascript/policies
