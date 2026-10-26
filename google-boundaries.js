/* Shared boundary state, rendered with Google Maps' actual map projection. */
(() => {
  'use strict';
  function create({ map, element, drawFill, drawLines, prepare, blendStyle }) {
    class Boundaries extends google.maps.OverlayView {
      constructor() {
        super();
        this.fill = document.createElement('canvas');
        this.lines = document.createElement('canvas');
        this.fill.className = 'fill-blend-canvas';
        this.lines.className = 'line-overlay-canvas';
        for (const canvas of [this.fill, this.lines]) {
          canvas.setAttribute('aria-hidden', 'true');
          Object.assign(canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
        }
        this.setMap(map);
      }
      onAdd() {
        element.append(this.fill, this.lines);
        this.observer = new ResizeObserver(() => this.requestDraw());
        this.observer.observe(element);
        this.listeners = ['bounds_changed', 'idle', 'zoom_changed'].map(name => map.addListener(name, () => this.requestDraw()));
      }
      draw() {
        if (!this.getMap() || !this.fill.isConnected) return;
        const projection = this.getProjection();
        if (!projection) return;
        const width = element.clientWidth, height = element.clientHeight;
        if (!width || !height) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const sharedProjection = { fromCoordToOffset(coord) {
          return projection.fromLatLngToContainerPixel(new google.maps.LatLng(coord.lat(), coord.lng()));
        } };
        this.fill.style.mixBlendMode = blendStyle();
        drawFill(prepare(this.fill, width, height, ratio), sharedProjection);
        drawLines(prepare(this.lines, width, height, ratio), sharedProjection);
      }
      requestDraw() {
        if (this.frame != null) return;
        this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
      }
      onRemove() {
        this.observer?.disconnect();
        this.listeners?.forEach(listener => listener.remove());
        if (this.frame != null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.fill.remove(); this.lines.remove();
      }
    }
    return new Boundaries();
  }
  window.GraphicRoadGoogleBoundaries = Object.freeze({ create });
})();
