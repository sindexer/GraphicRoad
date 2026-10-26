/* The timeline talks to one camera interface; each SDK owns its map pixels. */
(() => {
  'use strict';
  class Adapter {
    constructor({ getMap, getGoogleProvider, isGoogle }) {
      Object.assign(this, { getMap, getGoogleProvider, isGoogle });
    }
    get earth() { return this.isGoogle() && this.getGoogleProvider()?.active?.earth; }
    get map() { return this.isGoogle() ? this.getGoogleProvider()?.active?.map : this.getMap(); }
    get mode() { return this.earth ? 'orbit' : 'flat'; }
    get element() { return document.getElementById(this.isGoogle() ? 'googleMap' : 'map'); }
    getEarthCamera() {
      if (this.earth) return this.getGoogleProvider().getEarthCamera();
      const map = this.map;
      const center = map?.getCenter();
      const zoom = map?.getZoom();
      if (!center || !Number.isFinite(zoom)) return null;
      return { pivotLat: center.lat(), pivotLng: center.lng(), zoom };
    }
    setEarthCamera(camera, mode) {
      if (this.earth) return this.getGoogleProvider().setEarthCamera(camera, mode);
      if (mode !== 'flat' || !this.map || !['pivotLat', 'pivotLng', 'zoom'].every(key => Number.isFinite(camera[key]))) return false;
      const center = { lat: Math.max(-85, Math.min(85, camera.pivotLat)), lng: camera.pivotLng };
      const map = this.map;
      const min = this.isGoogle() ? 2 : map.getOptions('minZoom') ?? 6;
      const max = this.isGoogle() ? this.getGoogleProvider().active.zoomCeiling ?? 22 : map.getOptions('maxZoom') ?? 20;
      const zoom = Math.max(min, Math.min(max, camera.zoom));
      const before = this.getEarthCamera();
      const changed = Math.abs(before.pivotLat - center.lat) > 1e-10 ||
        Math.abs(before.pivotLng - center.lng) > 1e-10 || Math.abs(before.zoom - zoom) > 1e-10;
      if (this.rendering && changed) this.armSteady();
      if (this.isGoogle()) map.moveCamera({ center, zoom, heading: 0, tilt: 0 });
      else {
        map.updateBy(new naver.maps.LatLng(center.lat, center.lng), zoom);
      }
      return true;
    }
    listen(name, callback) {
      const map = this.map;
      if (this.isGoogle()) {
        const listener = map.addListener(name, callback);
        return () => listener.remove();
      }
      const listener = naver.maps.Event.addListener(map, name, callback);
      return () => naver.maps.Event.removeListener(listener);
    }
    subscribeEarthCamera(callback) {
      if (this.earth) return this.getGoogleProvider().subscribeEarthCamera(callback);
      const events = this.isGoogle() ? ['center_changed', 'zoom_changed'] : ['center_changed', 'zoom_changed', 'zoom', 'zoomend'];
      const removers = events.map(event => this.listen(event, () => callback(this.getEarthCamera())));
      return () => removers.forEach(remove => remove());
    }
    stopEarthAnimation() { if (this.earth) this.getGoogleProvider().stopEarthAnimation(); }
    resize() {
      if (!this.map) return;
      if (this.isGoogle()) {
        if (!this.earth) google.maps.event.trigger(this.map, 'resize');
      } else {
        const element = this.element;
        const fullSize = !document.body.classList.contains('earth-timeline-open');
        // setSize writes pixel dimensions inline. Release those dimensions
        // before measuring the normal fluid layout, not after measuring it.
        if (fullSize) { element.style.width = '100%'; element.style.height = '100%'; }
        const rect = element.getBoundingClientRect();
        this.map.setSize(new naver.maps.Size(rect.width, rect.height));
        if (fullSize) { element.style.width = '100%'; element.style.height = '100%'; }
      }
    }
    armSteady() {
      this.finishSteady?.();
      // Wait for visible tiles, not merely the camera's idle event. An idle
      // camera can still be showing unloaded tiles. Unchanged poses skip this.
      this.steady = new Promise(resolve => {
        const removers = [];
        const finish = (ready = false) => {
          clearTimeout(deadline);
          removers.forEach(remove => remove());
          this.finishSteady = null;
          resolve(ready);
        };
        const deadline = setTimeout(() => finish(false), 10000);
        this.finishSteady = finish;
        removers.push(this.listen('tilesloaded', () => finish(true)));
      });
    }
    setEarthRenderMode(enabled) {
      if (this.earth) return this.getGoogleProvider().setEarthRenderMode(enabled);
      const map = this.map;
      if (!map) return false;
      this.rendering = enabled;
      if (enabled) {
        this.savedInteraction = this.isGoogle()
          ? { gestureHandling: map.get('gestureHandling'), keyboardShortcuts: map.get('keyboardShortcuts') }
          : { draggable: map.getOptions('draggable'), scrollWheel: map.getOptions('scrollWheel'), keyboardShortcuts: map.getOptions('keyboardShortcuts') };
        map.setOptions(this.isGoogle() ? { gestureHandling: 'none', keyboardShortcuts: false } : { draggable: false, scrollWheel: false, keyboardShortcuts: false });
      } else {
        this.finishSteady?.();
        if (this.savedInteraction) map.setOptions(this.savedInteraction);
        this.savedInteraction = null;
      }
      return true;
    }
    waitEarthSteady(timeout) {
      return this.earth ? this.getGoogleProvider().waitEarthSteady(timeout) : this.steady || Promise.resolve(true);
    }
  }
  window.GraphicRoadMapCamera = Object.freeze({ Adapter });
})();
