import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const camera=await readFile(new URL('../map-camera.js',import.meta.url),'utf8');
const source=await readFile(new URL('../google-boundaries.js',import.meta.url),'utf8');
test('closing the timeline releases Naver inline dimensions before measurement and remains fluid',()=>{
 const sizes=[];const element={style:{width:'1024px',height:'576px'},getBoundingClientRect(){return this.style.width==='100%'?{width:1920,height:1080}:{width:1024,height:576};}};
 const context=vm.createContext({document:{body:{classList:{contains:()=>false}},getElementById:()=>element},naver:{maps:{Size:class{constructor(width,height){Object.assign(this,{width,height});}}}}});context.window=context;
 vm.runInContext(camera,context);const map={setSize(size){sizes.push(size);element.style.width=size.width+'px';element.style.height=size.height+'px';}};
 const adapter=new context.GraphicRoadMapCamera.Adapter({getMap:()=>map,isGoogle:()=>false});adapter.resize();
 assert.deepEqual([sizes[0].width,sizes[0].height],[1920,1080]);assert.equal(element.style.width,'100%');assert.equal(element.style.height,'100%');
});
test('Google boundary canvases use container coordinates, preserve fill/line style and clean up',()=>{
 const nodes=[],removed=[],calls=[];let observed=false;
 const element={clientWidth:800,clientHeight:450,append(...els){els.forEach(el=>{el.isConnected=true;nodes.push(el);});}};
 const context=vm.createContext({document:{createElement(){return{style:{},setAttribute(){},remove(){removed.push(this);}}; }},ResizeObserver:class{observe(){observed=true;}disconnect(){observed=false;}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},google:{maps:{LatLng:class{constructor(lat,lng){this.lat=()=>lat;this.lng=()=>lng;}},OverlayView:class{
  setMap(map){this.map=map;if(map)this.onAdd();else this.onRemove();}getMap(){return this.map;}getProjection(){return{fromLatLngToContainerPixel(coord){return{x:coord.lng()*2,y:coord.lat()*3};}};}
 }}}});context.window=context;context.devicePixelRatio=2;vm.runInContext(source,context);
 const map={addListener(){return{remove(){calls.push('remove');}};}};
 const overlay=context.GraphicRoadGoogleBoundaries.create({map,element,prepare:(canvas,w,h,dpr)=>({canvas,w,h,dpr}),blendStyle:()=>'multiply',drawFill:(ctx,p)=>calls.push({fill:ctx,point:p.fromCoordToOffset({lat:()=>37,lng:()=>127})}),drawLines:(ctx)=>calls.push({line:ctx})});
 overlay.draw();assert.equal(nodes.length,2);assert.equal(observed,true);assert.equal(nodes[0].style.mixBlendMode,'multiply');assert.equal(calls[0].point.x,254);assert.equal(calls[0].point.y,111);assert.equal(calls[0].fill.dpr,2);assert.equal(calls[1].line.w,800);
 overlay.setMap(null);assert.equal(removed.length,2);assert.equal(observed,false);assert.equal(calls.filter(x=>x==='remove').length,3);
});
