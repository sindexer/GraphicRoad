import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../earth-navigation.js', import.meta.url), 'utf8');
function setup() {
  const events = {}, frames = new Map(); let id = 0, captured = false;
  const context = { window: { addEventListener() {} }, document: { addEventListener() {} }, performance: { now: () => 0 },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id) };
  vm.runInNewContext(source, context);
  let pose = { cameraLat: 0, cameraLng: 0, cameraAlt: 1000, pivotLat: 0, pivotLng: 0, pivotAlt: 0, heading: 0, tilt: 90, roll: 0, range: 1000, fov: 35 };
  let mode, active = true;
  const element = { clientHeight: 600, addEventListener: (n, fn) => events[n] = fn, setAttribute() {}, focus() {},
    setPointerCapture() { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture() { captured = false; }, contains: () => false };
  const provider = { getEarthCamera: () => ({ ...pose }), setEarthCamera: (p, m) => { pose = p; mode = m; }, stopEarthAnimation() {} };
  const c = new context.window.GraphicRoadEarthNavigation.Controller(element, provider, () => active);
  const event = extra => ({ button: 2, buttons: 2, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, composedPath: () => [], preventDefault() {}, stopPropagation() {}, ...extra });
  return { c, event, frames, api: context.window.GraphicRoadEarthNavigation, pose: () => pose, mode: () => mode, deactivate: () => active = false };
}
test('translation follows heading and altitude, wraps longitude, stays finite at poles', () => {
  const { api, pose } = setup();
  assert.ok(api.translate(pose(), 100, 0, 0).cameraLat > 0);
  assert.ok(api.translate({ ...pose(), heading: 90 }, 100, 0, 0).cameraLng > 0);
  assert.ok(api.translate({ ...pose(), tilt: 0 }, 100, 0, 0).cameraAlt < 1000);
  const p = api.translate({ ...pose(), cameraLat: 85, cameraLng: 179.99 }, 0, 100000, 20);
  assert.ok(p.cameraLng >= -180 && p.cameraLng <= 180); assert.equal(p.cameraAlt, 1020);
});
test('RMB rotates in place; Alt LMB rotates around pivot; Alt RMB dollies', () => {
  const { c, event, pose, mode } = setup();
  c.down(event()); c.move(event({ clientX: 20, clientY: 20 }));
  assert.equal(pose().heading, 4); assert.equal(pose().cameraLat, 0); assert.equal(mode(), 'camera');
  c.move(event({ buttons: 1, altKey: true, clientX: 40, clientY: 30 }));
  assert.equal(mode(), 'orbit'); assert.equal(pose().heading, 0);
  c.move(event({ buttons: 2, altKey: true, clientX: 60, clientY: 40 }));
  assert.ok(pose().range > 1000); c.reset();
});
test('flight requires RMB, uses physical key codes and stops on release/inactive viewport', () => {
  const { c, event, pose, frames, deactivate } = setup();
  c.key(event({ code: 'KeyW' }), true); assert.equal(c.keys.size, 0);
  c.down(event()); c.key(event({ code: 'KeyW', key: 'ㅈ' }), true); c.tick(50);
  assert.ok(pose().cameraLat > 0);
  c.up(event({ buttons: 0 })); assert.equal(c.keys.size, 0); assert.equal(c.drag, null);
  c.down(event()); deactivate(); c.tick(100); assert.equal(c.drag, null);
});
test('wheel changes fly speed only during RMB and interactive controls are excluded', () => {
  const { c, event, pose } = setup();
  c.down(event({ composedPath: () => [{ matches: () => true }] })); assert.equal(c.drag, null);
  c.wheel(event({ deltaY: -100 })); assert.ok(pose().cameraLat > 0);
  const lat = pose().cameraLat;
  c.down(event()); c.wheel(event({ deltaY: -100 })); assert.ok(c.speed > 1); assert.equal(pose().cameraLat, lat);
  c.reset();
});
