# Google Maps deployment

Naver themes are `Naver Map`, `기본_N`, `블루_N (지하철 X)`, `블루_N`,
`흰블_N`, and `위성_N`. Google themes are `Google Map`, `기본_G`, `블루_G`,
`위성_G`, and `어스_G`. `Google Map` uses the default roadmap with no custom style or
map ID. The two styled Google themes retain their existing Cloud map IDs.
Selecting a Google theme hides the entire boundary toolbar and its popovers.
Returning to Naver restores the saved boundary settings. Each provider keeps
its own search results and pins; Google data is not copied onto a Naver map.

The first selection of `위성_G`, like later theme switches, preserves the current
map center and zoom within the available imagery limit. There is no forced
East Asia overview or initial fit-to-bounds. If no current view is available,
the default is Seoul at zoom 15.
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

## Earth camera timeline

Select **어스_G**, wait for its 3D scene, then press the purple **타임라인**
button immediately left of **구글Map**. The panel resizes the map above it;
Google's logo and attribution remain visible. The button is hidden in other
themes. Closing the panel, hiding the UI, exporting a PNG, switching themes,
manual map navigation, or hiding the browser tab stops playback.

The editor captures the current camera into eight starting keys at time zero.
Move the playhead, navigate the map or edit camera numbers, then press
**◆ 키프레임 추가** to capture the pose. A channel's diamond captures only
that channel. Editing a numeric field at an existing key updates that key;
otherwise the change is a preview until captured. Commit numbers with Enter
or by leaving the field. Drag keys horizontally (snapped to FPS), or select
one and edit its time/value. Delete and undo/redo are available.

- **피벗 기준 회전**: animate center latitude/longitude/altitude, heading,
  tilt, roll, range, and FOV. Camera position is derived by Google.
- **카메라 위치 이동**: animate cameraPosition latitude/longitude/altitude,
  heading, tilt, roll, range, and FOV. The pivot is derived by Google.
- Changing the coordinate basis starts a new project after confirmation;
  it never reinterprets existing position keys as pivot keys.
- Positions use geographic degrees and altitude in meters, not Cartesian XYZ.
  Heading and roll are unwrapped: 0 to 360 makes a full turn. Longitude uses
  the shorter path across the date line. SDK terrain/collision constraints
  can still limit the rendered camera.
- Choose a key with a following key to edit that segment's cubic Bezier
  timing curve using handles, numeric control points, or presets. The value
  graph displays the resulting selected-channel animation.
- Duration: 1–600 seconds; 24/25/30/60 FPS; maximum 2,000 channel keys. Real
  rendering speed depends on the device and network. There is no video or
  image-sequence renderer; the existing Export button still saves one PNG.

**저장** downloads a camera-only JSON project; **불러오기** validates a local
file before replacing the current project. The editor keeps projects in memory,
not in browser storage or on a server. Save before reloading or closing the tab.
JSON includes no browser key, SDK configuration, or authentication information.
Invalid, oversized (>1 MB), non-finite, and duplicate-frame imports are rejected.

Playback updates the already-open Map3DElement via requestAnimationFrame; it
does not initialize new maps or reload the SDK for each frame. This is a custom
camera editor, not the Google Earth Studio application. Normal Google 3D usage
and billing still apply; this editor does not implement a monthly usage cap.

For UI-only development without Google requests, serve the repository and open
`/tests/fixtures/earth-timeline-preview.html`. This explicitly labeled mock is
excluded from the published artifact; it does not verify real 3D rendering.

## References

- https://developers.google.com/maps/api-security-best-practices
- https://developers.google.com/maps/documentation/javascript/map-ids/get-map-id
- https://developers.google.com/maps/documentation/javascript/policies
- https://developers.google.com/maps/documentation/javascript/3d/overview
- https://developers.google.com/maps/documentation/javascript/reference/3.64/3d-map
- https://developers.google.com/maps/coverage
- https://developers.google.com/maps/billing-and-pricing/pricing
