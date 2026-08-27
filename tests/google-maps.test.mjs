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
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

function environment({ fetchConfig = async () => ({ ok: true, json: async () => config }), places = [], geocoding = [] } = {}) {
  const constructed = [];
  const queries = [];
  const requests = [];
  const scripts = [];
  const notices = [];
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
      // Model a location whose satellite coverage ends before roadmap zoom.
      const mapTypeMax = this.options.mapTypeId === 'satellite' ? 16 : 22;
      this.options.zoom = Math.min(zoom, this.options.maxZoom ?? mapTypeMax);
    }
    panTo(center) { this.options.center = center; }
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
  const maps = {
    Map, LatLng, OverlayView, InfoWindow, ControlPosition: { RIGHT_BOTTOM: 9 },
    event: { trigger() {} },
    async importLibrary(name) {
      if (name === 'maps') return { Map };
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
    setTimeout, clearTimeout,
    fetch: async (...args) => { requests.push(args); return fetchConfig(...args); },
    dispatchEvent: event => notices.push(event.type)
  });
  context.window = context;
  vm.runInContext(source, context);
  const container = new Element();
  const provider = new context.GraphicRoadGoogle.Provider(container);
  return { context, container, provider, constructed, requests, scripts, queries, notices, LatLng };
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

test('Google loads lazily, uses the fixed Google origin, and reuses each of the three maps', async () => {
  const env = environment();
  const view = { center: { lat: 37.5, lng: 127 }, zoom: 15 };
  assert.equal(env.requests.length, 0);
  await env.provider.activate('GOOGLE_BASIC', view, () => true);
  await env.provider.activate('GOOGLE_BLUE', view, () => true);
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  await env.provider.activate('GOOGLE_BASIC', { center: { lat: 35, lng: 135 }, zoom: 10 }, () => true);
  assert.equal(env.requests.length, 1);
  assert.equal(env.scripts.length, 1);
  const url = new URL(env.scripts[0].src);
  assert.equal(url.origin + url.pathname, 'https://maps.googleapis.com/maps/api/js');
  assert.equal(url.searchParams.get('auth_referrer_policy'), 'origin');
  assert.equal(env.constructed.length, 3);
  assert.equal(env.constructed[0].options.mapId, config.basicMapId);
  assert.equal(env.constructed[1].options.mapId, config.blueMapId);
  assert.equal(env.constructed[2].options.mapTypeId, 'satellite');
  assert.equal(env.constructed[2].options.mapId, undefined);
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

test('satellite switching and search respect the SDK imagery limit', async () => {
  const env = environment();
  const view = { center: { lat: 37.5, lng: 127 }, zoom: 20 };
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  assert.equal(env.provider.getView().zoom, 16);
  env.provider.panTo({ lat: 37.56, lng: 126.97 });
  assert.equal(env.provider.getView().zoom, 16);
  assert.equal(env.provider.getView().center.lat, 37.56);
  await env.provider.activate('GOOGLE_BASIC', view, () => true);
  assert.equal(env.provider.getView().zoom, 20);
  await env.provider.activate('GOOGLE_SATELLITE', view, () => true);
  assert.equal(env.provider.getView().zoom, 16);
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
  assert.deepEqual(JSON.parse(await readFile(new URL('_site/google-maps-config.json', root), 'utf8')), config);
  await writeFile(new URL('_site/not-for-publishing.env', root), 'example private data');
  built = run(env);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual((await readdir(new URL('_site/', root))).sort(),
    ['.nojekyll', 'Popup_Worldmap.png', 'data', 'google-maps-config.json', 'google-maps.js', 'index.html'].sort());
  const invalid = run({ ...env, GOOGLE_MAPS_BROWSER_KEY: '' });
  assert.equal(invalid.status, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(config.apiKey), false);
  // Failed configuration must leave the last valid deployment artifact untouched.
  assert.deepEqual(JSON.parse(await readFile(new URL('_site/google-maps-config.json', root), 'utf8')), config);
});
