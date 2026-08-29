import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = await readFile(new URL('../google-maps.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const config = { apiKey: 'AIza' + 'x'.repeat(35), basicMapId: '1'.repeat(16), blueMapId: '2'.repeat(16) };

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.events = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.events[name] = listener; }
  removeEventListener(name, listener) { if (this.events[name] === listener) delete this.events[name]; }
  appendChild(child) {
    child.remove(); this.children.push(child); child.parent = child.parentNode = this; return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = this.parentNode = null;
  }
}

function environment({ fetchConfig = async () => ({ ok: true, json: async () => config }), places = [], geocoding = [], maxZoom = async () => ({ zoom: 15 }), earthLoad = 'ready' } = {}) {
  const constructed = [];
  const queries = [];
  const requests = [];
  const scripts = [];
  const notices = [];
  const coverageRequests = [];
  const libraries = [];
  const earthMaps = [];
  let context;
  class LatLng {
    constructor(position, lng) { this.position = typeof position === 'number' ? { lat: position, lng } : position; }
    lat() { return this.position.lat; }
    lng() { return this.position.lng; }
  }
  class Map {
    constructor(element, options) {
      this.element = element; this.options = options; this.events = {};
      this.setZoom(options.zoom);
      constructed.push(this);
    }
    addListener(name, callback) { this.events[name] = callback; }
    getCenter() { return new LatLng(this.options.center); }
    getZoom() { return this.options.zoom; }
    setCenter(center) { this.options.center = center; }
    setZoom(zoom) {
      this.options.zoom = Math.min(zoom, this.options.maxZoom ?? 22);
    }
    setOptions(options) { Object.assign(this.options, options); this.setZoom(this.options.zoom); }
    panTo(center) { this.options.center = center; }
    fitBounds(bounds, padding) { this.fittedBounds = { bounds, padding }; }
  }
  class OverlayView {
    static preventMapHitsAndGesturesFrom() {}
    setMap(map) {
      if (this.map === map) return;
      if (this.map) this.onRemove();
      this.map = map;
      if (map) { this.onAdd(); this.draw(); }
    }
    getPanes() { return { overlayMouseTarget: this.map.element }; }
    getProjection() { return { fromLatLngToDivPixel: () => ({ x: 10, y: 20 }) }; }
  }
  class InfoWindow {
    setContent(content) { this.content = content; }
    setPosition() {}
    open() { this.opened = true; }
    close() { this.opened = false; }
  }
  class MaxZoomService {
    getMaxZoomAtLatLng(position) { coverageRequests.push(position); return maxZoom(position); }
  }
  class Map3DElement extends Element {
    constructor(options) {
      super('gmp-map-3d'); Object.assign(this, options); earthMaps.push(this);
      this.cameraPosition = { lat: 38.1, lng: 129, altitude: 3500000 };
      queueMicrotask(() => {
        if (earthLoad === 'ready') this.events['gmp-steadychange']?.({ isSteady: true });
        if (earthLoad === 'error') this.events['gmp-error']?.({ message: 'private SDK request URL' });
      });
    }
    stopCameraAnimation() { this.stopped = true; }
  }
  class Marker3DInteractiveElement extends Element {
    constructor(options) { super('gmp-marker-3d-interactive'); Object.assign(this, options); }
  }
  class PinElement extends Element {
    constructor(options) { super('gmp-pin'); Object.assign(this, options); }
  }
  class PopoverElement extends Element {
    constructor(options) { super('gmp-popover'); Object.assign(this, options); }
  }
  const maps = {
    Map, LatLng, OverlayView, InfoWindow, ControlPosition: { RIGHT_BOTTOM: 9 },
    event: { trigger() {} },
    async importLibrary(name) {
      libraries.push(name);
      if (name === 'maps') return { Map, MaxZoomService, RenderingType: { VECTOR: 'VECTOR' } };
      if (name === 'maps3d') return { Map3DElement, Marker3DInteractiveElement, PopoverElement,
        MapMode: { SATELLITE: 'SATELLITE' }, GestureHandling: { GREEDY: 'GREEDY' },
        AltitudeMode: { CLAMP_TO_GROUND: 'CLAMP_TO_GROUND' } };
      if (name === 'marker') return { PinElement };
      if (name === 'places') return { Place: { searchByText: async request => {
        queries.push(request);
        return { places };
      } } };
      if (name === 'geocoding') return { Geocoder: class {
        async geocode(request) { queries.push(request); return { results: geocoding }; }
      } };
      throw new Error('Unexpected library');
    }
  };
  const document = { createElement: name => new Element(name), head: new Element('head') };
  document.head.appendChild = script => {
    scripts.push(script);
    queueMicrotask(() => {
      context.google = { maps };
      const callback = new URL(script.src).searchParams.get('callback');
      context[callback]();
    });
  };
  context = vm.createContext({
    document, URLSearchParams, AbortSignal, Event, console,
    setTimeout: (callback, delay) => setTimeout(callback, earthLoad === 'timeout' && delay === 45000 ? 0 : delay), clearTimeout,
    fetch: async (...args) => { requests.push(args); return fetchConfig(...args); },
    dispatchEvent: event => notices.push(event.type)
  });
  context.window = context;
  vm.runInContext(source, context);
  const container = new Element();
  const provider = new context.GraphicRoadGoogle.Provider(container);
  return { context, container, provider, constructed, requests, scripts, queries, notices, coverageRequests, LatLng, libraries, earthMaps };
}

test('all inline scripts and the provider parse; production sources contain no API keys', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, content] of scripts) new vm.Script(content);
  new vm.Script(source);
  assert.doesNotMatch(html + source, /AIza[\w-]{35}/);
});

test('configuration fails closed and never includes invalid credential values in errors', () => {
  const { context } = environment();
  const validate = context.GraphicRoadGoogle.validateConfig;
  assert.equal(validate(config).basicMapId, config.basicMapId);
  for (const invalid of [null, {}, { ...config, apiKey: 'sensitive-value' },
    { ...config, basicMapId: '<script>' }, { ...config, blueMapId: config.basicMapId }]) {
    assert.throws(() => validate(invalid), error => error.code === 'CONFIG' && !error.message.includes('sensitive-value'));
  }
});

test('Google loads lazily, uses the fixed Google origin, and reuses each of the four maps', async () => {
  const env = environment();
  const view = { center: { lat: 37.5, lng: 127 }, zoom: 15 };
  assert.equal(env.requests.length, 0);
  await env.provider.activate('GOOGLE_BASIC', view, () => true);
  await env.provider.activate('GOOGLE_BLUE', view, () => true);
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  await env.provider.activate('GOOGLE_DEFAULT', view, () => true);
  await env.provider.activate('GOOGLE_BASIC', { center: { lat: 35, lng: 135 }, zoom: 10 }, () => true);
  await env.provider.activate('GOOGLE_DEFAULT', { center: { lat: 35, lng: 135 }, zoom: 10 }, () => true);
  assert.equal(env.requests.length, 1);
  assert.equal(env.scripts.length, 1);
  const url = new URL(env.scripts[0].src);
  assert.equal(url.origin + url.pathname, 'https://maps.googleapis.com/maps/api/js');
  assert.equal(url.searchParams.get('auth_referrer_policy'), 'origin');
  assert.equal(env.constructed.length, 4);
  assert.equal(env.constructed[0].options.mapId, config.basicMapId);
  assert.equal(env.constructed[1].options.mapId, config.blueMapId);
  assert.equal(env.constructed[2].options.mapTypeId, 'satellite');
  assert.equal(env.constructed[2].options.mapId, undefined);
  assert.equal(env.constructed[3].options.mapTypeId, 'roadmap');
  assert.equal(env.constructed[3].options.mapId, undefined);
  assert.equal(env.constructed[3].options.styles, undefined);
  assert.equal(env.constructed[3].element.attributes['aria-label'], 'Google Map');
  assert.equal(env.provider.getView().zoom, 10);
  assert.equal(env.provider.getView().center.lng, 135);
  assert.equal(env.container.children.filter(element => !element.hidden).length, 1);
});

test('a canceled slow selection never creates or activates a stale map', async () => {
  let finish;
  const env = environment({ fetchConfig: () => new Promise(resolve => { finish = resolve; }) });
  let selected = 'GOOGLE_BASIC';
  const first = env.provider.activate('GOOGLE_BASIC', {}, () => selected === 'GOOGLE_BASIC');
  selected = 'GOOGLE_BLUE';
  const second = env.provider.activate('GOOGLE_BLUE', {}, () => selected === 'GOOGLE_BLUE');
  finish({ ok: true, json: async () => config });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(env.constructed.length, 1);
  assert.equal(env.constructed[0].options.mapId, config.blueMapId);
});

test('satellite preserves the current camera on its first selection and keeps the WebGL renderer', async () => {
  const env = environment();
  const firstView = { center: { lat: 37.5, lng: 127 }, zoom: 13 };
  await env.provider.activate('GOOGLE_SATELLITE', firstView, () => true);
  const map = env.constructed[0];
  assert.equal(map.getZoom(), firstView.zoom);
  assert.deepEqual({ ...map.options.center }, firstView.center);
  assert.equal(map.fittedBounds, undefined, 'do not replace the working view with an overview');
  assert.equal(map.options.renderingType, 'VECTOR');
  assert.equal(map.options.isFractionalZoomEnabled, false);
  assert.equal(map.options.tilt, 0);
  assert.equal(map.options.heading, 0);
  assert.equal(map.options.mapId, undefined);

  const laterView = { center: { lat: 35, lng: 135 }, zoom: 10 };
  await env.provider.activate('GOOGLE_BASIC', laterView, () => true);
  await env.provider.activate('GOOGLE_SATELLITE', laterView, () => true);
  assert.equal(env.provider.getView().zoom, 10, 'returning to satellite preserves the working camera');
  assert.deepEqual({ ...env.provider.getView().center }, laterView.center);
  assert.equal(env.constructed.length, 2, 'reuse the initialized satellite map');
});

test('satellite switching and search respect the SDK imagery limit', async () => {
  const env = environment();
  const view = { center: { lat: 37.5, lng: 127 }, zoom: 20 };
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  await new Promise(setImmediate);
  assert.equal(env.provider.getView().zoom, 15);
  env.provider.panTo({ lat: 37.56, lng: 126.97 });
  assert.equal(env.provider.getView().zoom, 15);
  assert.equal(env.provider.getView().center.lat, 37.56);
  await env.provider.activate('GOOGLE_BASIC', view, () => true);
  assert.equal(env.provider.getView().zoom, 20);
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  assert.equal(env.provider.getView().zoom, 15);
  await new Promise(setImmediate);
  const requests = env.coverageRequests.length;
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  assert.equal(env.coverageRequests.length, requests, 'zooming at the same center reuses its limit');
});

test('satellite coverage updates for new locations and ignores stale responses', async () => {
  const pending = [];
  const env = environment({ maxZoom: () => new Promise(resolve => pending.push(resolve)) });
  await env.provider.activate('GOOGLE_SATELLITE', { center: { lat: 37, lng: 127 }, zoom: 20 }, () => true);
  const record = env.provider.active;
  env.provider.panTo({ lat: 35, lng: 135 });
  const updated = env.provider.updateSatelliteLimit(record);
  pending[1]({ zoom: 19 });
  await updated;
  pending[0]({ zoom: 15 });
  await Promise.resolve();
  assert.equal(record.map.options.maxZoom, 15, 'metadata cannot override the verified imagery ceiling');
  assert.equal(record.element.attributes['data-imagery-reported-max-zoom'], '19');
  env.provider.panTo({ lat: 36, lng: 128 });
  const lowerCoverage = env.provider.updateSatelliteLimit(record);
  pending[2]({ zoom: 14 });
  await lowerCoverage;
  assert.equal(record.map.getZoom(), 14);
});

test('a low overview imagery limit does not clamp a later search or provider switch', async () => {
  const env = environment({ maxZoom: async position => ({ zoom: position.lng === 129 ? 11 : 20 }) });
  await env.provider.activate('GOOGLE_SATELLITE', { center: { lat: 38.1, lng: 129 }, zoom: 6 }, () => true);
  await new Promise(setImmediate);
  assert.equal(env.provider.active.map.options.maxZoom, 11);
  env.provider.panTo({ lat: 37.56, lng: 126.97 });
  assert.equal(env.provider.getView().zoom, 15);
  await env.provider.updateSatelliteLimit(env.provider.active);
  assert.equal(env.provider.active.map.options.maxZoom, 15);

  await env.provider.activate('GOOGLE_SATELLITE', { center: { lat: 38.1, lng: 129 }, zoom: 6 }, () => true);
  await new Promise(setImmediate);
  assert.equal(env.provider.active.map.options.maxZoom, 11);
  const cityView = { center: { lat: 37.56, lng: 126.97 }, zoom: 20 };
  await env.provider.activate('GOOGLE_BASIC', cityView, () => true);
  await env.provider.activate('GOOGLE_SATELLITE', cityView, () => true);
  assert.equal(env.provider.getView().zoom, 15);
});

test('configuration/network errors are retryable and auth failures notify the host', async () => {
  let fail = true;
  const env = environment({ fetchConfig: async () => {
    if (fail) throw new Error('A request URL with private query data');
    return { ok: true, json: async () => config };
  } });
  await assert.rejects(env.provider.activate('GOOGLE_BASIC', {}, () => true), error => error.code === 'CONFIG');
  assert.equal(env.scripts.length, 0);
  fail = false;
  await env.provider.activate('GOOGLE_BASIC', {}, () => true);
  env.context.gm_authFailure();
  assert.deepEqual(env.notices, ['graphic-road-google-auth-failure']);
  await assert.rejects(env.provider.activate('GOOGLE_BLUE', {}, () => true), error => error.code === 'AUTH');
});

test('pins survive Google style changes and visibility changes without duplication', async () => {
  const env = environment();
  await env.provider.activate('GOOGLE_BASIC', {}, () => true);
  const item = { lat: 37.5, lng: 127, title: '<unsafe title>' };
  assert.equal(env.provider.addMarker(item, '#123456'), true);
  assert.equal(env.provider.addMarker(item, '#123456'), false);
  const marker = [...env.provider.markers.values()][0].overlay;
  assert.equal(marker.element.title.includes('<unsafe title>'), true);
  assert.equal(marker.map, env.constructed[0]);
  env.provider.toggleMarkers();
  assert.equal(marker.map, null);
  await env.provider.activate('GOOGLE_BLUE', {}, () => true);
  assert.equal(marker.map, null);
  env.provider.toggleMarkers();
  assert.equal(marker.map, env.constructed[1]);
  env.provider.hide();
  assert.equal(marker.map, null);
  await env.provider.activate('GOOGLE_SATELLITE', {}, () => true);
  assert.equal(marker.map, env.constructed[2]);
  await env.provider.activate('GOOGLE_DEFAULT', {}, () => true);
  assert.equal(marker.map, env.constructed[3]);
  env.provider.removeMarker('37.500000,127.000000');
  assert.equal(env.provider.markerCount, 0);
});

test('keyword search requests only required fields and labels Google results', async () => {
  const env = environment({ places: [{ displayName: '서울역', formattedAddress: '서울',
    location: { lat: () => 37.55, lng: () => 126.97 }, attributions: [] }] });
  await env.provider.activate('GOOGLE_BASIC', {}, () => true);
  const results = await env.provider.search('서울역');
  assert.equal(results[0].provider, 'google');
  assert.equal(results[0].source, 'Google Maps');
  assert.equal(results[0].lat, 37.55);
  assert.deepEqual(Array.from(env.queries[0].fields), ['displayName', 'formattedAddress', 'location']);
  assert.equal(env.queries[0].textQuery, '서울역');
  assert.equal(env.queries.length, 1);
});

test('empty keyword results fall back to Google geocoding', async () => {
  const env = environment({ geocoding: [{ formatted_address: '서울',
    geometry: { location: { lat: () => 37.5, lng: () => 127 } } }] });
  await env.provider.activate('GOOGLE_BLUE', {}, () => true);
  const results = await env.provider.search('서울 주소');
  assert.equal(env.queries.length, 2);
  assert.equal(results[0].title, '서울');
});

test('Earth loads on demand without a new key or map ID and reuses its 3D viewer', async () => {
  const env = environment();
  await env.provider.activate('GOOGLE_BASIC', {}, () => true);
  assert.equal(env.libraries.includes('maps3d'), false);
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const earth = env.earthMaps[0];
  assert.equal(earth.mode, 'SATELLITE');
  assert.equal(earth.defaultUIHidden, false);
  assert.equal(earth.mapId, undefined);
  assert.deepEqual({ ...earth.center }, { lat: 38.1, lng: 129, altitude: 0 });
  assert.equal(earth.range, 3500000);
  assert.equal(env.provider.active.element.attributes['aria-label'], '어스_G');
  assert.equal(env.container.children.filter(element => !element.hidden).length, 1);
  const view = { center: { lat: 35, lng: 135 }, zoom: 13 };
  await env.provider.activate('GOOGLE_DEFAULT', view, () => true);
  await env.provider.activate('GOOGLE_EARTH', view, () => true);
  assert.equal(env.earthMaps.length, 1);
  assert.equal(env.scripts.length, 1);
  assert.equal(new URL(env.scripts[0].src).searchParams.get('v'), 'quarterly');
  assert.deepEqual({ ...env.provider.getView().center }, view.center);
  assert.equal(env.provider.getView().zoom, 13);
});

test('Earth uses its camera for keyword bias, search movement, and returning to 2D', async () => {
  const env = environment({ places: [{ displayName: '도쿄 타워', location: { lat: 35.6586, lng: 139.7454 } }] });
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const [result] = await env.provider.search('도쿄 타워');
  assert.deepEqual({ ...env.queries[0].locationBias }, { lat: 38.1, lng: 129 });
  env.provider.panTo(result);
  assert.equal(env.earthMaps[0].range, 3000);
  assert.equal(env.earthMaps[0].tilt, 60);
  const view = env.provider.getView();
  assert.equal(view.center.lat, 35.6586);
  assert.ok(view.zoom >= 14 && view.zoom <= 17);
  await env.provider.activate('GOOGLE_BLUE', view, () => true);
  assert.deepEqual({ ...env.provider.getView().center }, { ...view.center });
  assert.equal(env.provider.getView().zoom, view.zoom);
});

test('Earth pins retain their colors across renderers and can be hidden and deleted', async () => {
  const env = environment();
  await env.provider.activate('GOOGLE_BASIC', {}, () => true);
  const item = { lat: 35, lng: 135, title: '<unsafe title>' };
  env.provider.addMarker(item, '#123456');
  const entry = [...env.provider.markers.values()][0];
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const earth = env.earthMaps[0];
  assert.equal(entry.overlay.map, null, '2D OverlayView must never receive a 3D map');
  assert.equal(entry.earthMarker.parentNode, earth);
  assert.equal(entry.earthMarker.children[0].background, '#123456');
  assert.equal(env.provider.addMarker(item, '#654321'), false);
  env.provider.syncMarkers();
  assert.equal(earth.children.filter(child => child.tagName === 'gmp-marker-3d-interactive').length, 1);
  env.provider.toggleMarkers();
  assert.equal(entry.earthMarker.parentNode, null);
  env.provider.toggleMarkers();
  assert.equal(entry.earthMarker.parentNode, earth);
  await env.provider.activate('GOOGLE_SATELLITE', {}, () => true);
  assert.equal(entry.earthMarker.parentNode, null);
  assert.equal(entry.overlay.map, env.provider.active.map);
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  assert.equal(entry.earthMarker.gmpPopoverTargetElement, entry.earthPopover);
  // Google manages opening and positioning the bound native popover.
  entry.earthPopover.open = true;
  earth.events['gmp-click']?.({ position: item });
  assert.equal(entry.earthPopover.open, true);
  assert.equal(entry.earthPopover.children[0].children[0].textContent, '<unsafe title>');
  const popover = entry.earthPopover;
  popover.children[0].children[1].events.click();
  assert.equal(env.provider.markerCount, 0);
  assert.equal(popover.parentNode, null);
  assert.equal(entry.earthMarker.parentNode, null);
});

test('pins can first be created in Earth and remain available after hide/show', async () => {
  const env = environment();
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  assert.equal(env.provider.addMarker({ lat: 35, lng: 135 }, '#abcdef'), true);
  const entry = [...env.provider.markers.values()][0];
  env.provider.hide();
  assert.equal(entry.earthMarker.parentNode, null);
  await env.provider.activate('GOOGLE_DEFAULT', {}, () => true);
  assert.equal(entry.overlay.map, env.provider.active.map);
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  entry.earthMarker.events.keydown({ key: 'Delete', preventDefault() {}, stopPropagation() {} });
  assert.equal(env.provider.markerCount, 0);
});

test('Earth initialization errors and timeouts are sanitized, cleaned up, and retryable', async () => {
  for (const earthLoad of ['error', 'timeout']) {
    const env = environment({ earthLoad });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(env.provider.activate('GOOGLE_EARTH', {}, () => true), error => {
        assert.equal(error.code, 'EARTH');
        assert.equal(error.message.includes('private'), false);
        return true;
      });
      assert.equal(env.container.children.length, 0);
      assert.equal(env.provider.records.size, 0);
      assert.equal(env.provider.cancelEarthLoad, null);
    }
    await env.provider.activate('GOOGLE_DEFAULT', {}, () => true);
    assert.equal(env.provider.enabled, true);
  }
});

test('switching away cancels an unfinished Earth scene and ignores late events', async () => {
  for (const destination of ['naver', 'GOOGLE_BLUE']) {
    const env = environment({ earthLoad: 'pending' });
    let selected = 'GOOGLE_EARTH';
    const pending = env.provider.activate('GOOGLE_EARTH', {}, () => selected === 'GOOGLE_EARTH');
    await new Promise(setImmediate);
    const earth = env.earthMaps[0];
    const staleReady = earth.events['gmp-steadychange'];
    const staleError = earth.events['gmp-error'];
    selected = destination;
    if (destination === 'naver') env.provider.hide();
    else await env.provider.activate(destination, {}, () => true);
    assert.equal(await pending, false);
    staleReady({ isSteady: true }); staleError();
    assert.equal(env.provider.enabled, destination !== 'naver');
    assert.equal(env.provider.records.has('GOOGLE_EARTH'), false);
    assert.equal(env.container.children.some(element => element.children.includes(earth)), false);
  }
});

test('Earth camera adapter writes exactly one coordinate basis and keeps the same scene', async () => {
  const env = environment();
  assert.equal(env.provider.getEarthCamera(), null);
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const scene = env.earthMaps[0];
  const initial = env.provider.getEarthCamera();
  assert.equal(initial.pivotLat, 38.1);
  assert.equal(initial.cameraAlt, 3500000);
  const position = scene.cameraPosition;
  assert.equal(env.provider.setEarthCamera({ ...initial, pivotLat: 35, heading: 360, tilt: 60, roll: 10, fov: 45 }, 'orbit'), true);
  assert.equal(scene.center.lat, 35);
  assert.equal(scene.cameraPosition, position, 'orbit must not write cameraPosition');
  assert.equal(scene.heading, 360);
  assert.equal(scene.roll, 10);
  const center = scene.center;
  assert.equal(env.provider.setEarthCamera({ ...initial, cameraLat: 36, cameraAlt: 9000, range: 2000 }, 'camera'), true);
  assert.equal(scene.cameraPosition.lat, 36);
  assert.equal(scene.cameraPosition.altitude, 9000);
  assert.equal(scene.center, center, 'position mode must not write center');
  assert.equal(scene.range, 2000);
  for (let i = 0; i < 120; i++) env.provider.setEarthCamera({ ...initial, heading: i }, 'orbit');
  assert.equal(env.earthMaps.length, 1);
  assert.equal(env.requests.length, 1);
  assert.equal(env.scripts.length, 1);
});

test('Earth camera updates reject invalid input and unsubscribe safely', async () => {
  const env = environment();
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const scene = env.earthMaps[0];
  const initial = env.provider.getEarthCamera();
  assert.equal(env.provider.setEarthCamera({ ...initial, tilt: NaN }), false);
  assert.equal(env.provider.setEarthCamera(initial, 'invalid'), false);
  assert.equal(env.provider.setEarthCamera(null), false);
  assert.equal(scene.tilt, initial.tilt);
  env.provider.setEarthCamera({ ...initial, tilt: 300, range: -10, fov: 100 });
  assert.equal(scene.tilt, 90); assert.equal(scene.range, 1); assert.equal(scene.fov, 80);
  let updates = 0;
  const unsubscribe = env.provider.subscribeEarthCamera(camera => { updates++; assert.equal(camera.fov, 80); });
  scene.events['gmp-fovchange'](); assert.equal(updates, 1);
  unsubscribe(); assert.equal(scene.events['gmp-fovchange'], undefined);
  env.provider.hide(); assert.equal(scene.stopped, true);
  assert.equal(env.provider.setEarthCamera(initial), false);
  assert.equal(env.provider.getEarthCamera(), null);
});

test('Earth render mode hides exploration UI and waits for a completed scene', async () => {
  const env = environment();
  assert.equal(env.provider.setEarthRenderMode(true), false);
  await env.provider.activate('GOOGLE_EARTH', {}, () => true);
  const scene = env.earthMaps[0];
  assert.equal(scene.defaultUIHidden, false);
  assert.equal(env.provider.setEarthRenderMode(true), true);
  assert.equal(scene.defaultUIHidden, true);
  assert.equal(env.provider.renderMode, true);
  const initial=env.provider.getEarthCamera(), cameraPosition=scene.cameraPosition;
  env.provider.setEarthCamera({...initial,pivotLat:37.5},'orbit');
  const steady = env.provider.waitEarthSteady(1000);
  assert.equal(scene.cameraPosition,cameraPosition,'orbit rendering must not overwrite the derived camera position');
  scene.events['gmp-steadychange']({ isSteady: false });
  scene.events['gmp-steadychange']({ isSteady: true });
  assert.equal(await steady, true);
  assert.equal(scene.events['gmp-steadychange'], undefined);
  env.provider.setEarthRenderMode(false);
  assert.equal(scene.defaultUIHidden, false);
  assert.equal(env.provider.renderMode, false);
});

test('deployment injects configuration without logging it and publishes only allowed files', async () => {
  const root = new URL('../', import.meta.url);
  const env = { ...process.env, GOOGLE_MAPS_BROWSER_KEY: config.apiKey,
    GOOGLE_MAP_ID_BASIC: config.basicMapId, GOOGLE_MAP_ID_BLUE: config.blueMapId };
  const run = values => spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: fileURLToPath(root), env: values, encoding: 'utf8'
  });
  let built = run(env);
  assert.equal(built.status, 0, built.stderr);
  assert.equal((built.stdout + built.stderr).includes(config.apiKey), false);
  assert.match(await readFile(new URL('_site/index.html', root), 'utf8'), /src="google-maps\.js\?v=[a-f\d]{12}"/);
  const builtHtml = await readFile(new URL('_site/index.html', root), 'utf8');
  for (const file of ['earth-timeline-core.js', 'earth-timeline.js', 'earth-timeline.css']) {
    assert.match(builtHtml, new RegExp(file.replaceAll('.', '\\.') + '\\?v=[a-f\\d]{12}'));
  }
  assert.deepEqual(JSON.parse(await readFile(new URL('_site/google-maps-config.json', root), 'utf8')), config);
  await writeFile(new URL('_site/not-for-publishing.env', root), 'example private data');
  built = run(env);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual((await readdir(new URL('_site/', root))).sort(),
    ['.nojekyll', 'data', 'earth-timeline-core.js', 'earth-timeline.js', 'earth-timeline.css', 'google-maps-config.json', 'google-maps.js', 'index.html'].sort());
  const invalid = run({ ...env, GOOGLE_MAPS_BROWSER_KEY: '' });
  assert.equal(invalid.status, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(config.apiKey), false);
  // Failed configuration must leave the last valid deployment artifact untouched.
  assert.deepEqual(JSON.parse(await readFile(new URL('_site/google-maps-config.json', root), 'utf8')), config);
});

test('custom camera input is absent and native Google navigation is retained', () => {
      assert.doesNotMatch(html + source, /GraphicRoadEarthNavigation|earth-navigation\.js|WASD/);
      assert.match(source, /gestureHandling: library\.GestureHandling\.GREEDY/);
    });
