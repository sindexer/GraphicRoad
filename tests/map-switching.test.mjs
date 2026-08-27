import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const hostSource = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('const STYLE_WHITE'));

function environment() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        id, value: '', hidden: false, disabled: false, textContent: '', attributes: {},
        classList: {
          add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle(value, force) { if (force ?? !classes.has(value)) classes.add(value); else classes.delete(value); }
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        replaceChildren() {}, addEventListener() {}, querySelectorAll: () => []
      });
    }
    return elements.get(id);
  }
  const document = {
    body: element('body'), getElementById: element,
    querySelector: selector => selector.startsWith('script[') ? null : element(selector),
    querySelectorAll: () => []
  };
  class LatLng {
    constructor(lat, lng) { this._lat = lat; this._lng = lng; }
    lat() { return this._lat; } lng() { return this._lng; }
  }
  const cameras = [];
  const googleStub = {
    enabled: false, markerCount: 2, markersVisible: true,
    view: { center: { lat: 35, lng: 135 }, zoom: 11 },
    async activate(theme, view, current) { if (!current()) return false; this.enabled = true; return true; },
    getView() { return this.view; }, hide() { this.enabled = false; }, closeInfo() {},
    search: async () => []
  };
  const naver = { maps: { LatLng, OverlayView: function() {}, MapTypeId: {
    NORMAL: 'normal', SATELLITE: 'satellite', TERRAIN: 'terrain', HYBRID: 'hybrid'
  } } };
  const context = vm.createContext({
    document, naver, googleStub, cameras, setTimeout, clearTimeout, console,
    URL, URLSearchParams, Map, Set,
    GraphicRoadGoogle: {
      isTheme: value => ['GOOGLE_BASIC', 'GOOGLE_BLUE', 'GOOGLE_SATELLITE'].includes(value),
      errorMessage: () => 'safe configuration error'
    }
  });
  context.window = context;
  vm.runInContext(hostSource, context);
  vm.runInContext(`
    map = { getCenter: () => new naver.maps.LatLng(37.5, 127), getZoom: () => 15 };
    googleProvider = googleStub;
    recreate = (options, theme) => { cameras.push(options); setActive(theme); };
  `, context);
  element('THEME_SELECT').value = 'NORMAL';
  const select = theme => {
    element('THEME_SELECT').value = theme;
    return context.selectMapTheme(theme);
  };
  return { context, document, element, googleStub, select, cameras };
}

test('all three Google themes hide boundary controls and close open popovers', async () => {
  const env = environment();
  for (const theme of ['GOOGLE_BASIC', 'GOOGLE_BLUE', 'GOOGLE_SATELLITE']) {
    env.element('LINE_WEIGHT_PANEL').classList.add('is-open');
    env.element('FILL_REGION_PANEL').classList.add('is-open');
    await env.select(theme);
    assert.equal(env.document.body.classList.contains('google-map-active'), true);
    assert.equal(env.element('.buttons').inert, true);
    assert.equal(env.element('.buttons').attributes['aria-hidden'], 'true');
    assert.equal(env.element('LINE_WEIGHT_PANEL').classList.contains('is-open'), false);
    assert.equal(env.element('FILL_REGION_PANEL').classList.contains('is-open'), false);
    assert.equal(env.element('googleMap').hidden, false);
    assert.equal(env.element('EXPORT_MAP').disabled, false);
  }
});

test('Naver restores controls, retained boundary choices and the latest Google camera', async () => {
  const env = environment();
  env.element('COLOR_LINES').value = '#123456';
  env.element('TOGGLE_SIDO').checked = true;
  await env.select('GOOGLE_BLUE');
  await env.select('WHITE');
  assert.equal(env.document.body.classList.contains('google-map-active'), false);
  assert.equal(env.element('.buttons').inert, false);
  assert.equal(env.element('googleMap').hidden, true);
  assert.equal(env.element('COLOR_LINES').value, '#123456');
  assert.equal(env.element('TOGGLE_SIDO').checked, true);
  assert.equal(env.cameras[0].center.lat(), 35);
  assert.equal(env.cameras[0].center.lng(), 135);
  assert.equal(env.cameras[0].zoom, 11);
  assert.equal(env.element('THEME_SELECT').value, 'WHITE');
});

test('failed Google load restores the previous Naver selection and usable buttons', async () => {
  const env = environment();
  await env.select('DARK');
  env.googleStub.activate = async () => { throw new Error('private URL or key'); };
  await env.select('GOOGLE_BASIC');
  assert.equal(env.element('THEME_SELECT').value, 'DARK');
  assert.equal(env.element('.buttons').inert, false);
  assert.equal(env.element('EXPORT_MAP').disabled, false);
  assert.equal(env.element('#addressSearch button[type="submit"]').disabled, false);
  assert.equal(env.element('MAP_PROVIDER_STATUS').textContent, 'safe configuration error');
});

test('returning to Naver cancels an in-flight Google selection', async () => {
  const env = environment();
  let finish;
  env.googleStub.activate = async (theme, view, current) => {
    await new Promise(resolve => { finish = resolve; });
    if (!current()) return false;
    env.googleStub.enabled = true;
    return true;
  };
  const pending = env.select('GOOGLE_BASIC');
  await env.select('BLUE');
  finish();
  await pending;
  assert.equal(env.element('THEME_SELECT').value, 'BLUE');
  assert.equal(env.element('.buttons').inert, false);
  assert.equal(env.googleStub.enabled, false);
});

test('an uninitialized Naver renderer does not block selecting Google', async () => {
  const env = environment();
  vm.runInContext(`map.getCenter = () => { throw new Error('Naver not initialized'); };`, env.context);
  await env.select('GOOGLE_SATELLITE');
  assert.equal(env.element('.buttons').inert, true);
  assert.equal(env.element('MAP_PROVIDER_STATUS').hidden, true);
});

test('search results from the previous provider are discarded after a switch', async () => {
  const env = environment();
  let finish;
  let rendered = false;
  env.googleStub.search = () => new Promise(resolve => { finish = resolve; });
  env.context.renderSearchResults = () => { rendered = true; };
  await env.select('GOOGLE_BASIC');
  const pending = env.context.moveToAddress('서울');
  await env.select('NORMAL');
  finish([{ lat: 37.5, lng: 127, title: 'Google result' }]);
  await pending;
  assert.equal(rendered, false);
});
