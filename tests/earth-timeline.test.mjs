import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../earth-timeline-core.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../earth-timeline.js', import.meta.url), 'utf8');
const context = vm.createContext({});
context.window = context;
vm.runInContext(source, context);
const C = context.GraphicRoadTimelineCore;
const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ~= ${expected}`);

test('editor parses without credentials, storage or Google/network loading', () => {
  new vm.Script(uiSource);
  assert.doesNotMatch(source + uiSource, /AIza[\w-]{35}|localStorage|sessionStorage|fetch\(|importLibrary|new\s+Map3DElement|eval\(/);
});

test('project has distinct camera/pivot bases with eight animated channels each', () => {
  const project = C.createProject({ heading: 25, tilt: NaN, fov: 300 });
  assert.equal(project.base.heading, 25);
  assert.equal(project.base.tilt, 35);
  assert.equal(project.base.fov, 80);
  assert.equal(C.channelsForMode('orbit').length, 8);
  assert.equal(C.channelsForMode('camera').length, 8);
  assert.ok(C.channelsForMode('orbit').every(channel => channel.group !== 'camera'));
  assert.ok(C.channelsForMode('camera').every(channel => channel.group !== 'pivot'));
});

test('Bezier timing solves x(t), respects endpoints and remains bounded', () => {
  for (let i = 0; i <= 10; i++) near(C.easingAt(i / 10, C.PRESETS.linear), i / 10);
  assert.equal(C.easingAt(-1), 0);
  assert.equal(C.easingAt(2), 1);
  near(C.easingAt(0.5), 0.5);
  assert.ok(C.easingAt(0.25, C.PRESETS.in) < 0.25);
  assert.ok(C.easingAt(0.25, C.PRESETS.out) > 0.25);
  for (const curve of Object.values(C.PRESETS)) {
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const value = C.easingAt(i / 100, curve);
      assert.ok(value >= previous && value <= 1);
      previous = value;
    }
  }
});

test('independent per-channel curves and explicit full rotations interpolate correctly', () => {
  const p = C.createProject();
  C.upsert(p, 'heading', 0, 0, C.PRESETS.linear);
  C.upsert(p, 'heading', 10, 720);
  C.upsert(p, 'roll', 0, 0, C.PRESETS.in);
  C.upsert(p, 'roll', 10, 360);
  near(C.evaluate(p, 5).heading, 360);
  assert.ok(C.evaluate(p, 5).roll < 180);
  assert.equal(C.evaluate(p, -1).heading, 0);
  assert.equal(C.evaluate(p, 12).heading, 720);
  assert.equal(C.evaluate(p, 5).pivotLat, p.base.pivotLat);
});

test('longitude interpolates across the date line by the short route', () => {
  const p = C.createProject();
  C.upsert(p, 'pivotLng', 0, 179, C.PRESETS.linear);
  C.upsert(p, 'pivotLng', 10, -179);
  near(Math.abs(C.evaluate(p, 5).pivotLng), 180);
  assert.ok(Math.abs(C.evaluate(p, 2).pivotLng) > 178);
});

test('keys snap to frames, update in place and reject invalid values', () => {
  const p = C.createProject();
  C.upsert(p, 'tilt', 1.01, 50);
  C.upsert(p, 'tilt', 1, 70);
  assert.equal(p.tracks.tilt.length, 1);
  assert.equal(p.tracks.tilt[0].time, 1);
  assert.equal(p.tracks.tilt[0].value, 70);
  C.upsert(p, 'tilt', 2, 100);
  assert.equal(p.tracks.tilt[1].value, 90);
  assert.throws(() => C.upsert(p, 'tilt', NaN, 20));
  assert.throws(() => C.upsert(p, 'tilt', 3, Infinity));
  assert.throws(() => C.upsert(p, 'unknown', 3, 10));
  assert.throws(() => C.upsert(p, 'tilt', 3, 10, [0, -1, 1, 1]));
});

test('moving a key cannot overwrite its neighbor and reorders the track', () => {
  const p = C.createProject();
  C.upsert(p, 'heading', 0, 10);
  C.upsert(p, 'heading', 5, 20);
  C.upsert(p, 'heading', 10, 30);
  const frame = C.moveKey(p, 'heading', 5, 0, 99);
  assert.equal(frame.time, 5);
  assert.equal(frame.value, 20);
  C.moveKey(p, 'heading', 5, 2.01, 42);
  assert.deepEqual(plain(p.tracks.heading.map(key => key.time)), [0, 2, 10]);
  assert.equal(frame.value, 42);
  assert.equal(C.moveKey(p, 'heading', 2, NaN), null);
});

test('JSON validation round trips data without accepting unknown runtime fields', () => {
  const p = C.createProject({}, 'camera');
  C.upsert(p, 'cameraAlt', 0, 6000);
  C.upsert(p, 'cameraAlt', 10, 12000);
  const restored = C.validateProject({ ...plain(p), apiKey: 'not-part-of-project', script: 'do not run' });
  assert.deepEqual(plain(restored), plain(p));
  assert.equal(restored.apiKey, undefined);
  restored.tracks.cameraAlt[0].value = 4000;
  assert.equal(p.tracks.cameraAlt[0].value, 6000);
});

test('JSON rejects malformed, excessive, duplicate, out-of-range and non-finite input', () => {
  const original = C.createProject();
  C.upsert(original, 'heading', 0, 0);
  const mutations = [
    p => { p.version = 2; }, p => { p.mode = 'script'; }, p => { p.duration = 601; },
    p => { p.fps = 120; }, p => { p.base.cameraAlt = Infinity; },
    p => { p.base.pivotLat = 90; }, p => { p.tracks = []; },
    p => { p.tracks.execute = []; }, p => { delete p.tracks.tilt; },
    p => { p.tracks.heading[0].time = 20; }, p => { p.tracks.heading[0].value = NaN; },
    p => { p.tracks.heading[0].easing = [0, 0, 1, 2]; },
    p => { p.tracks.heading.push({ ...p.tracks.heading[0], time: 0.001 }); },
    p => { p.tracks.heading = Array.from({ length: 2001 }, (_, i) => ({ time: i / 30, value: 1, easing: [0, 0, 1, 1] })); }
  ];
  for (const mutate of mutations) { const p = plain(original); mutate(p); assert.throws(() => C.validateProject(p)); }
  for (const p of [null, [], {}, 'text']) assert.throws(() => C.validateProject(p));
});

// Controller logic uses the real implementation and a minimal renderer stub.
// Interactive pointer/keyboard/DOM layout is additionally checked in the local fixture.
function editor() {
  const callbacks = new Map();
  const controls = new Map();
  let id = 0;
  const classes = new Set();
  const env = vm.createContext({
    performance: { now: () => 0 }, setTimeout, clearTimeout, Blob, URL,
    requestAnimationFrame(callback) { callbacks.set(++id, callback); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    document: { activeElement: null, body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } },
    confirm: () => true
  });
  env.window = env;
  vm.runInContext(source, env); vm.runInContext(uiSource, env);
  const e = Object.create(env.GraphicRoadEarthTimeline.Controller.prototype);
  Object.assign(e, { project: env.GraphicRoadTimelineCore.createProject(), time: 0, zoom: 1, viewStart: 0, channel: 'heading', selectedTime: null,
    pose: env.GraphicRoadTimelineCore.normalizeCamera({}), undoStack: [], redoStack: [], available: true, opened: true, frame: null, cameraFrame: null,
    scrubFrame: null, scrubPose: null });
  const calls = [];
  const provider = { getEarthCamera: () => e.pose, setEarthCamera: (pose, mode) => { calls.push({ ...pose, mode }); return true; }, stopEarthAnimation() {} };
  e.getProvider = () => provider;
  e.confirmAction = async () => true;
  e.$ = id => {
    if (!controls.has(id)) controls.set(id, { value: '', checked: false, setAttribute() {}, focus() {} });
    return controls.get(id);
  };
  e.button = { setAttribute() {}, focus() {} }; e.root = { hidden: false };
  e.render = () => {}; e.renderTracks = () => {}; e.renderGraph = () => {};
  e.updatePlayhead = () => {}; e.updateFields = () => {};
  return { e, calls, callbacks, controls, provider, tick(time) {
    const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time));
  } };
}

test('zoomed time coordinates round trip and clamp at composition bounds', () => {
  const { e } = editor();
  e.zoom = 4; e.viewStart = 5; e.trackWidth = 1000;
  near(e.trackX(5), 12); near(e.trackX(7.5), 978);
  near(e.trackTime(e.trackX(6)), 6);
  assert.equal(e.trackTime(-100000), 0); assert.equal(e.trackTime(100000), 10);
});

test('mouse scrubbing coalesces camera writes to one update per paint', () => {
  const { e, calls, tick } = editor();
  C.upsert(e.project, 'heading', 0, 0); C.upsert(e.project, 'heading', 10, 100);
  e.queueScrub(1); e.queueScrub(2); e.queueScrub(3);
  assert.equal(calls.length, 0); assert.equal(e.time, 3);
  tick(16); assert.equal(calls.length, 1); near(calls[0].heading, 30);
  e.flushScrub(); assert.equal(calls.length, 1);
});

test('camera channels use After Effects axis names and new keys default to linear diamonds', () => {
  const labels = Object.fromEntries(C.CHANNELS.map(channel => [channel.key, channel.label]));
  assert.equal(labels.pivotLng, 'Position X'); assert.equal(labels.pivotLat, 'Position Y');
  assert.equal(labels.pivotAlt, 'Position Z'); assert.equal(labels.tilt, 'Rotation X');
  assert.equal(labels.heading, 'Rotation Y'); assert.equal(labels.roll, 'Rotation Z');
  assert.equal(labels.range, 'Focus Distance'); assert.equal(labels.fov, 'Zoom (FOV)');
  const project = C.createProject();
  assert.deepEqual(plain(C.upsert(project, 'heading', 1, 20).easing), plain(C.PRESETS.linear));
});

test('selecting a track label preserves playhead time', () => {
  const { e } = editor(); e.time = 5;
  e.onClick({ target: { tagName: 'LABEL', closest: selector => selector === '[data-property]' ? { dataset: { property: 'tilt' } } : null } });
  assert.equal(e.time, 5); assert.equal(e.channel, 'tilt');
});

test('right-hand lanes contain keys but no duplicated property labels', () => {
  const { e } = editor();
  e.capture();
  e.root.querySelectorAll = () => [];
  Object.getPrototypeOf(e).renderTracks.call(e);
  const svg = e.$('ET_TRACKS').innerHTML;
  assert.doesNotMatch(svg, /et-svg-label/);
  assert.equal((svg.match(/data-track=/g) || []).length, 8);
  assert.equal((svg.match(/data-key=/g) || []).length, 8);
  assert.match(svg, /translate\(12 42\.5\)/);
  assert.match(uiSource, /et-aligned-scroll/);
});

test('capture, delete, undo and redo preserve all channel data', () => {
  const { e } = editor();
  assert.equal(e.selected(), null);
  e.capture();
  assert.equal(Object.values(e.project.tracks).flat().length, 8);
  e.time = 5; e.pose.heading = 360; e.capture('heading');
  assert.equal(e.selected().value, 360);
  e.deleteKey(); assert.equal(e.project.tracks.heading.length, 1);
  e.restore(false); assert.equal(e.project.tracks.heading.length, 2);
  e.restore(true); assert.equal(e.project.tracks.heading.length, 1);
});

test('Space toggles playback from buttons and keys; repeats and text editing do not toggle', () => {
  const {e} = editor();
  let toggles = 0; e.play = () => toggles++;
  const event = {key:' ',code:'Space',preventDefault(){},target:{tagName:'BUTTON'}};
  e.onKey(event); e.onKey(event); assert.equal(toggles,2);
  e.onKey({...event,repeat:true}); assert.equal(toggles,2);
  e.onKey({...event,target:{tagName:'INPUT'}}); assert.equal(toggles,2);
});

test('F and G step exactly one frame without intercepting text fields or browser modifiers', () => {
  const {e}=editor(); e.time=5;
  const event={key:'f',preventDefault(){this.prevented=true;},target:{tagName:'BUTTON',closest(){return null;}}};
  e.onKey(event); near(e.time,5-1/e.project.fps); assert.equal(event.prevented,true);
  e.onKey({...event,key:'G',prevented:false}); near(e.time,5);
  e.onKey({...event,key:'f',target:{tagName:'INPUT'}}); near(e.time,5);
  e.onKey({...event,key:'f',ctrlKey:true}); near(e.time,5);
});

test('timeline keys use directional After Effects-style shapes for easing', () => {
  const {e}=editor(), track=e.project.tracks.heading;
  C.upsert(e.project,'heading',0,0,C.PRESETS.linear);
  C.upsert(e.project,'heading',5,90,C.PRESETS.linear);
  C.upsert(e.project,'heading',10,180,C.PRESETS.linear);
  assert.equal(e.keyEaseKind([track[0]],0),'linear');
  assert.equal(e.keyEaseKind(track,1),'linear');
  C.easeKeys(e.project,[{channel:'heading',time:5}],'in');
  assert.equal(e.keyEaseKind(track,1),'in');
  C.easeKeys(e.project,[{channel:'heading',time:5}],'out');
  assert.equal(e.keyEaseKind(track,1),'both');
  assert.notEqual(e.keyShape('linear'),e.keyShape('both'));
  e.root.querySelectorAll=()=>[]; Object.getPrototypeOf(e).renderTracks.call(e);
  assert.match(e.$('ET_TRACKS').innerHTML,/data-ease-kind="both"/);
});

test('batch easing affects incoming/outgoing handles of each selected key', () => {
  const p = C.createProject();
  for (const key of ['heading','tilt']) for (const time of [0,5,10]) C.upsert(p,key,time,time,C.PRESETS.linear);
  const selection = [{channel:'heading',time:5},{channel:'tilt',time:5}];
  C.easeKeys(p,selection,'in');
  assert.deepEqual(plain(p.tracks.heading[0].easing),[0,0,.58,1]);
  assert.deepEqual(plain(p.tracks.heading[1].easing),[0,0,1,1]);
  C.easeKeys(p,selection,'out');
  assert.deepEqual(plain(p.tracks.heading[1].easing),[.42,0,1,1]);
  assert.deepEqual(plain(p.tracks.tilt[1].easing),[.42,0,1,1]);
});

test('group movement is atomic, keeps offsets and refuses collisions and bounds', () => {
  const p = C.createProject();
  C.upsert(p,'heading',0,0); C.upsert(p,'heading',5,90); C.upsert(p,'tilt',0,30);
  let selected = [{channel:'heading',time:0},{channel:'tilt',time:0}];
  assert.equal(C.moveKeys(p,selected,-1),null);
  assert.equal(C.moveKeys(p,selected,5),null);
  assert.equal(p.tracks.tilt[0].time,0);
  selected = C.moveKeys(p,selected,2);
  assert.equal(p.tracks.heading[0].time,2); assert.equal(p.tracks.tilt[0].time,2);
  assert.equal(selected.length,2);
});

test('batch ease and delete each have a single undo step', () => {
  const {e} = editor(); e.capture();
  const before = JSON.stringify(e.project);
  e.applyEase('both'); assert.equal(e.undoStack.length,2);
  e.deleteKey(); assert.equal(Object.values(e.project.tracks).flat().length,0);
  e.restore(false); assert.equal(Object.values(e.project.tracks).flat().length,8);
  e.restore(false); assert.equal(JSON.stringify(e.project),before);
});

test('toolbar has one capture action, a render dialog and no obsolete project controls', () => {
  assert.equal((uiSource.match(/data-action="capture"/g)||[]).length,1);
  assert.doesNotMatch(uiSource,/id="ET_(PAN|TIME|SCRUB)"|data-action="(?:save|load|new)"/);
  assert.match(uiSource,/data-action="render-open"/);
  assert.match(uiSource,/id="ET_RENDER"/);
  assert.match(uiSource,/value="jpeg"/);
  assert.match(uiSource,/value="mp4"/);
  assert.match(uiSource,/showDirectoryPicker/);
  assert.match(uiSource,/MediaRecorder\.isTypeSupported/);
  assert.match(uiSource,/setEarthRenderMode\?\.\(true\)/);
  assert.match(uiSource,/waitEarthSteady/);
  assert.match(uiSource,/requestVideoFrameCallback/);
  assert.match(uiSource,/topInset=Math\.max\(0,video\.videoHeight-contentHeight\)/);
  assert.doesNotMatch(uiSource,/video\.videoHeight\/window\.innerHeight/);
  assert.doesNotMatch(uiSource,/data-action="render-(?:frame|preview)"/);
  assert.match(uiSource,/et-ease-buttons[^\n]*data-action="capture"[^\n]*data-ease="both"/);
  assert.match(uiSource,/F\/G: 이전\/다음 프레임/);
  assert.match(uiSource,/id="ET_RESIZE_HANDLE"[^>]*role="separator"/);
  assert.match(uiSource,/data-action="fold"[^>]*id="ET_FOLD"/);
  assert.doesNotMatch(uiSource,/data-action="close" class="et-close"/);
  assert.match(uiSource,/setFolded\(true\).*captureRenderStream/s);
  assert.match(uiSource,/beginEarthRender\(this\.pose,this\.project\.mode\)/);
  assert.match(uiSource,/waitForRenderPointer\(this\.renderAbort\.signal\).*beginEarthRender/s);
});

test('playback updates the existing provider at selected FPS and stops at its end', () => {
  const { e, calls, tick, callbacks } = editor();
  C.upsert(e.project, 'heading', 0, 0, C.PRESETS.linear);
  C.upsert(e.project, 'heading', 10, 360);
  e.play(); tick(1000); near(calls.at(-1).heading, 36);
  const count = calls.length; tick(1001); assert.equal(calls.length, count);
  tick(5000); near(calls.at(-1).heading, 180);
  tick(10000); assert.equal(calls.at(-1).heading, 360);
  assert.equal(e.playing, false); assert.equal(callbacks.size, 0);
});

test('closing, switching modes and manual navigation cancel queued animation', () => {
  const { e, tick, callbacks, calls } = editor();
  e.play(); assert.equal(callbacks.size, 1);
  e.setAvailable(false); assert.equal(callbacks.size, 0);
  assert.equal(e.opened, false); assert.equal(e.root.hidden, true);
  const count = calls.length; tick(2000); assert.equal(calls.length, count);
  e.available = true; e.opened = true; e.play(); e.pauseForNavigation();
  assert.equal(e.playing, false); assert.equal(e.acceptCameraUpdates, true);
  assert.equal(callbacks.size, 0);
});

test('invalid or oversized imports preserve the existing timeline', async () => {
  const { e } = editor();
  e.capture(); const before = JSON.stringify(e.project);
  await e.load({ size: 2000000, text: () => { throw new Error('should not read'); } });
  assert.equal(JSON.stringify(e.project), before);
  await e.load({ size: 10, text: async () => '{broken json' });
  assert.equal(JSON.stringify(e.project), before);
  assert.match(e.$('ET_STATUS').textContent, /기존 프로젝트는 유지/);
});

test('valid project import restores the selected camera mode and data', async () => {
  const { e } = editor();
  const p = C.createProject({ cameraAlt: 5000 }, 'camera');
  C.upsert(p, 'cameraAlt', 0, 5000); C.upsert(p, 'cameraAlt', 10, 9000);
  await e.load({ size: 1000, text: async () => JSON.stringify(p) });
  assert.equal(e.project.mode, 'camera'); assert.equal(e.pose.cameraAlt, 5000);
  assert.deepEqual(plain(e.project.tracks), plain(p.tracks));
});

test('graph handle dragging updates the outgoing curve and groups undo history', () => {
  const { e } = editor();
  C.upsert(e.project, 'heading', 0, 0); C.upsert(e.project, 'heading', 10, 360);
  e.selectedTime = 0;
  e.drag = { type: 'handle', handle: 0, remembered: false };
  e.point = () => ({ x: 141, y: 69 });
  const svg = { hasPointerCapture: () => true };
  e.pointerMove({ pointerId: 1 }, svg);
  near(e.selected().easing[0], 0.5); near(e.selected().easing[1], 0.5);
  assert.equal(e.undoStack.length, 1);
  e.point = () => ({ x: 250, y: 22 });
  e.pointerMove({ pointerId: 1 }, svg);
  near(e.selected().easing[0], 1); near(e.selected().easing[1], 1);
  assert.equal(e.undoStack.length, 1);
  assert.deepEqual(plain(e.project.tracks.heading[1].easing), plain(C.PRESETS.linear));
});

test('key drag moves the selected key, updates camera time, and never merges neighbors', () => {
  const { e } = editor();
  C.upsert(e.project, 'heading', 0, 0); C.upsert(e.project, 'heading', 10, 360);
  e.selectedTime = 0;
  e.drag = { type: 'key', startX: 0, remembered: false };
  e.point = () => ({ x: e.trackX(5), y: 50 });
  const svg = { hasPointerCapture: () => true };
  e.pointerMove({ pointerId: 1, clientX: 100 }, svg);
  assert.equal(e.selectedTime, 5); assert.equal(e.time, 5);
  e.point = () => ({ x: 698, y: 50 });
  e.pointerMove({ pointerId: 1, clientX: 120 }, svg);
  assert.equal(e.selectedTime, 5); assert.equal(e.project.tracks.heading.length, 2);
});

test('changing FPS refuses collisions and duration cannot cut off keys', () => {
  const { e } = editor();
  e.project.fps = 60;
  C.upsert(e.project, 'heading', 2 / 60, 5); C.upsert(e.project, 'heading', 3 / 60, 10);
  const fps = { id: 'ET_FPS', value: '24', dataset: {} };
  e.onChange({ target: fps });
  assert.equal(e.project.fps, 60);
  assert.match(e.$('ET_STATUS').textContent, /겹칩니다/);
  C.upsert(e.project, 'heading', 10, 20);
  e.onChange({ target: { id: 'ET_DURATION', type: 'number', valueAsNumber: 4, dataset: {} } });
  assert.equal(e.project.duration, 10);
});

test('changing the camera basis requires confirmation and creates matching starting keys', async () => {
  const { e } = editor();
  e.capture(); const original = JSON.stringify(e.project);
  e.confirmAction = async () => false;
  await e.newProject('camera');
  assert.equal(JSON.stringify(e.project), original);
  e.confirmAction = async () => true;
  await e.newProject('camera');
  assert.equal(e.project.mode, 'camera');
  assert.equal(e.project.tracks.cameraAlt.length, 1);
  assert.equal(e.project.tracks.pivotAlt.length, 0);
  e.restore(false);
  assert.equal(e.project.mode, 'orbit');
  assert.equal(JSON.stringify(e.project), original);
});
