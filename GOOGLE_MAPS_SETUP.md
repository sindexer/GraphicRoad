# Google Maps deployment

Naver themes are `Naver Map`, `기본_N`, `블루_N (지하철 X)`, `블루_N`,
`흰블_N`, and `위성_N`. Google themes are `Google Map`, `기본_G`, `블루_G`,
`위성_G`, and `어스_G`. `Google Map` uses the default roadmap with no custom style or
map ID. The two styled Google themes retain their existing Cloud map IDs.
Selecting a Google theme hides the entire boundary toolbar and its popovers.
Returning to Naver restores the saved boundary settings. Each provider keeps
its own search results and pins; Google data is not copied onto a Naver map.

The first selection of `위성_G` starts at an East Asia overview (zoom 6, centered
near 38.1 N / 129 E), then fits 108–150 E / 30–45.4 N to the available window.
Smaller windows may start farther out. Subsequent theme switches continue to
share the current camera instead of repeatedly resetting to the overview.
Satellite requests Google's WebGL/vector renderer to avoid gaps between HTML
raster tiles, with fractional zoom, tilt and rotation disabled. Google may fall
back to raster when WebGL is unavailable; seams on those devices may depend on
browser/display scaling. We do not alter Google's tile DOM or image pixels.

Satellite currently has a conservative zoom ceiling of 15: live Seoul imagery
was available at 15 but returned missing-image tiles at 16 and 17. The maximum
imagery service can further lower the limit for areas with less coverage.
Roadmap themes keep their normal zoom range. Raise this ceiling only after
checking actual satellite tiles with this deployment's key and region settings.

## Earth / 3D

`어스_G` uses the official Maps JavaScript `maps3d` library and `Map3DElement`
on the existing quarterly SDK channel. This is not an embedded Google Earth
website. The default photorealistic satellite globe needs no additional map ID
or API key. The 3D and marker libraries load only when this theme is selected;
one initialized viewer is reused for later switches.

The first view is an East Asia overview (38.1 N / 129 E, range 3,500 km,
tilt 35 degrees). Search moves to the result at range 3 km and tilt 60
degrees. The built-in controls allow rotation, tilt, and zoom. Camera position
and approximate zoom are shared when switching to/from 2D Google themes.
Pins retain their colors; click a 3D pin to open its delete button, or focus
it and press Delete/Backspace. Search results also provide an accessible
`삭제` button for an existing Earth pin, including pins obscured by buildings
or terrain. The line/fill toolbar stays hidden.

Initialization waits for the first rendered scene. A 3D initialization error
or 45-second timeout restores the previous Naver theme with a safe message.
Switching away cancels a pending load. Hardware acceleration/WebGL and network
access to Google's 3D imagery are required. Coverage varies by location;
Korean detailed 3D coverage is limited, so test supported cities such as Tokyo.

3D map loads use the separately billed **Immersive Maps** SKU. Check current
pricing and quotas before enabling this feature in another deployment. Existing
key restrictions, secret injection, and Google attribution remain unchanged.

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
Google's included copyright notices (including `©2026 Google`) must remain
visible on the map and in exports; they are not optional UI controls.

## References

- https://developers.google.com/maps/api-security-best-practices
- https://developers.google.com/maps/documentation/javascript/map-ids/get-map-id
- https://developers.google.com/maps/documentation/javascript/policies
- https://developers.google.com/maps/documentation/javascript/3d/overview
- https://developers.google.com/maps/documentation/javascript/reference/3.64/3d-map
- https://developers.google.com/maps/coverage
- https://developers.google.com/maps/billing-and-pricing/pricing
