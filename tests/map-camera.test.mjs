import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const cameraSource = await readFile(new URL('../map-camera.js', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('../earth-timeline-core.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../earth-timeline.js', import.meta.url), 'utf8');
function fixture() {
  const handlers = new Map();
  let center = { lat: () => 37.5, lng: () => 127 }, zoom = 15;
  const options = { minZoom: 6, maxZoom: 20, draggable: true, scrollWheel: true, keyboardShortcuts: true };
  const emit = name => handlers.get(name)?.forEach(fn => fn());
  const map = {
    getCenter: () => center, getZoom: () => zoom, getOptions: key => options[key], get: key => options[key],
    setOptions(values) { Object.assign(options, values); if (values.center) { center = values.center; emit('center_changed'); } if (values.zoom !== undefined) { zoom = values.zoom; emit('zoom_changed'); } },
    moveCamera(values) { this.setOptions({ ...values, center: { lat: () => values.center.lat, lng: () => values.center.lng } }); },
    updateBy(center, zoom) { this.setOptions({center, zoom}); },
    addListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); return { remove: () => handlers.get(name).delete(fn) }; }
  };
  const env = vm.createContext({ setTimeout, clearTimeout, console }); env.window = env;
  env.naver = { maps: { LatLng: class { constructor(a,b) { this.lat=()=>a;this.lng=()=>b; } }, Event: { addListener: (m,n,f) => m.addListener(n,f), removeListener: h => h.remove() } } };
  vm.runInContext(coreSource, env); vm.runInContext(cameraSource, env); vm.runInContext(uiSource, env);
  let google = false;
  const provider = { active: { map, zoomCeiling: 15 } };
  const adapter = new env.GraphicRoadMapCamera.Adapter({ getMap: () => map, getGoogleProvider: () => provider, isGoogle: () => google });
  return { env, map, adapter, options, handlers, provider, google() { google=true; } };
}
test('flat projects animate only latitude, longitude and zoom, and old Earth JSON remains valid', () => {
  const { env } = fixture(), C = env.GraphicRoadTimelineCore;
  const p=C.createProject({ pivotLat: 37, pivotLng: 127, zoom: 10 },'flat');
  assert.deepEqual(Array.from(C.channelsForMode('flat'), c=>c.key), ['pivotLat','pivotLng','zoom']);
  C.upsert(p,'zoom',0,10,C.PRESETS.linear); C.upsert(p,'zoom',10,16);
  assert.ok(Math.abs(C.evaluate(p,5).zoom-13)<1e-6);
  assert.equal(C.validateProject(JSON.parse(JSON.stringify(p))).mode,'flat');
  const old=JSON.parse(JSON.stringify(C.createProject())); delete old.base.zoom; delete old.tracks.zoom;
  assert.equal(C.validateProject(old).base.zoom,15);
});
test('Naver camera applies an immediate view, clamps zoom and unsubscribes all manual navigation listeners', () => {
  const { adapter, map, handlers }=fixture(); const seen=[];
  const off=adapter.subscribeEarthCamera(pose=>seen.push(pose));
  assert.equal(adapter.setEarthCamera({ pivotLat: 35, pivotLng: 129, zoom: 30 },'flat'),true);
  assert.equal(map.getCenter().lat(),35); assert.equal(map.getZoom(),20); assert.ok(seen.length>0);
  off(); assert.ok([...handlers.values()].every(set=>set.size===0));
  assert.equal(adapter.setEarthCamera({ pivotLat: NaN, pivotLng: 1, zoom: 1 },'flat'),false);
  assert.equal(adapter.setEarthCamera({ pivotLat: 35, pivotLng: 129, zoom: 15 },'orbit'),false);
});
test('Google flat maps use moveCamera, honor satellite zoom ceiling, and keep Earth behind its own adapter', () => {
  const f=fixture(); f.google();
  f.adapter.setEarthCamera({ pivotLat: 34, pivotLng: 130, zoom: 19 },'flat');
  assert.equal(f.map.getZoom(),15); assert.equal(f.map.getCenter().lng(),130);
  f.provider.active.earth=true;
  f.provider.getEarthCamera=()=>({ heading: 123 });
  f.provider.setEarthCamera=(pose,mode)=>mode==='camera' && pose.heading===90;
  assert.equal(f.adapter.getEarthCamera().heading,123);
  assert.equal(f.adapter.setEarthCamera({heading:90},'camera'),true);
});
test('render cleanup restores SDK interaction settings and removes settlement listeners', async () => {
  const { adapter, options, handlers }=fixture();
  adapter.setEarthRenderMode(true); assert.equal(options.draggable,false);
  adapter.setEarthCamera({ pivotLat: 35, pivotLng: 129, zoom: 12 },'flat');
  handlers.get('tilesloaded').forEach(fn=>fn());
  await adapter.waitEarthSteady(); adapter.setEarthRenderMode(false);
  assert.equal(options.draggable,true); assert.equal(options.scrollWheel,true);
  assert.ok([...handlers.values()].every(set=>set.size===0));
});
test('switching map sessions preserves separate projects and undo history', () => {
  const { env }=fixture(); const e=Object.create(env.GraphicRoadEarthTimeline.Controller.prototype);
  Object.assign(e,{sessions:new Map(),getProvider:()=>({mode:'flat'})});
  e.activateMap('NORMAL'); const project={mode:'flat',id:'naver'};
  Object.assign(e,{project,time:3,undoStack:[1],redoStack:[],channel:'zoom',selectedTime:3,selection:[]});
  e.activateMap('GOOGLE_EARTH'); assert.equal(e.project,null); e.project={id:'earth'};
  e.activateMap('NORMAL'); assert.equal(e.project,project); assert.equal(e.time,3); assert.deepEqual(e.undoStack,[1]);
});
test('capturing a cropped map makes a 1920x1080 image without changing its geometry', () => {
  const { env }=fixture(); const rect={left:100,top:60,width:960,height:540}; let draw;
  env.document={getElementById:()=>({getBoundingClientRect:()=>rect})}; env.innerWidth=1280;env.innerHeight=720;
  const e=Object.create(env.GraphicRoadEarthTimeline.Controller.prototype); e.getProvider=()=>({});e.regionCaptured=true;
  const canvas={getContext:()=>({fillRect(){},drawImage(...args){draw=args;}})};
  const video={videoWidth:960,videoHeight:540};
  e.renderCanvas(video,{width:1920,height:1080},canvas);
  assert.equal(canvas.width,1920); assert.equal(canvas.height,1080);
  assert.deepEqual(draw.slice(1),[0,0,960,540,0,0,1920,1080]);
});
test('MP4 frame timestamps depend on FPS rather than map loading wall time', async () => {
  const { env }=fixture(); const encoded=[],writes=[];
  env.VideoEncoder=class {
    static isConfigSupported=async()=>({supported:true}); encodeQueueSize=0;
    constructor(callbacks){this.callbacks=callbacks;}configure(){} close(){} async flush(){}
    encode(frame){encoded.push([frame.timestamp,frame.duration,frame.closed]);}
  };
  env.VideoFrame=class { constructor(canvas,init){Object.assign(this,init);}close(){this.closed=true;} };
  env.Mp4Muxer={ArrayBufferTarget:class {buffer=new Uint8Array([1,2]);},Muxer:class{finalize(){}}};env.Blob=Blob;
  env.document={createElement:()=>({})};
  const e=Object.create(env.GraphicRoadEarthTimeline.Controller.prototype);
  Object.assign(e,{renderMimeType:()=>true,seek(){},prepareRenderFrame:async()=>{await new Promise(r=>setTimeout(r,1));},renderCanvas(){},updateRenderProgress(){},renderDestination:{handle:{createWritable:async()=>({write:async b=>writes.push(b),close:async()=>{}})}}});
  await e.renderMp4({}, {width:1920,height:1080,fps:30,start:10,end:39},new AbortController().signal);
  assert.equal(encoded.length,30); assert.equal(encoded[0][0],0);
  assert.equal(encoded.at(-1)[0]+encoded.at(-1)[1],1000000); assert.equal(writes[0].type,'video/mp4');
});
