/* Unreal-style viewport input. Google Earth's tilt remains limited to 0–90°. */
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const radians = Math.PI / 180;
  function translate(pose, forward, right, up) {
    const p = { ...pose }, h = p.heading * radians, t = p.tilt * radians;
    const north = forward * Math.sin(t) * Math.cos(h) - right * Math.sin(h);
    const east = forward * Math.sin(t) * Math.sin(h) + right * Math.cos(h);
    const radius = Math.max(6371000, 6371000 + p.cameraAlt);
    p.cameraLat = clamp(p.cameraLat + north / radius / radians, -85, 85);
    p.cameraLng = ((p.cameraLng + east / (radius * Math.max(.087, Math.cos(p.cameraLat * radians))) / radians + 180) % 360 + 360) % 360 - 180;
    p.cameraAlt = clamp(p.cameraAlt + up - forward * Math.cos(t), -1000, 63170000);
    return p;
  }
  class Controller {
    constructor(element, provider, isActive) {
      this.element = element; this.provider = provider; this.isActive = isActive;
      this.keys = new Set(); this.speed = 1; this.frame = null; this.drag = null;
      element.tabIndex = 0;
      element.setAttribute('aria-label', '3D 뷰포트: 우클릭+WASD 이동, Q/E 하강/상승, Alt+드래그 궤도 회전');
      const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, options);
      on(element, 'contextmenu', e => { if (isActive()) e.preventDefault(); });
      on(element, 'pointerdown', e => this.down(e), { capture: true });
      on(element, 'pointermove', e => this.move(e), { capture: true });
      on(element, 'pointerup', e => this.up(e), { capture: true });
      on(element, 'pointercancel', () => this.reset());
      on(element, 'lostpointercapture', () => this.reset());
      on(element, 'wheel', e => this.wheel(e), { capture: true, passive: false });
      on(element, 'keydown', e => this.key(e, true), { capture: true });
      on(element, 'keyup', e => this.key(e, false), { capture: true });
      on(window, 'blur', () => this.reset());
      on(element, 'focusout', e => { if (!element.contains(e.relatedTarget)) this.reset(); });
      on(document, 'visibilitychange', () => { if (document.hidden) this.reset(); });
    }
    consume(e) { e.preventDefault(); e.stopPropagation(); }
    reset() {
      const id = this.drag?.id;
      this.drag = null; this.keys.clear();
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      if (id !== undefined && this.element.hasPointerCapture(id)) this.element.releasePointerCapture(id);
    }
    down(e) {
      if (!this.isActive() || e.pointerType === 'touch' || e.button > 2) return;
      // Preserve clicks on markers, popovers, links and the SDK controls.
      if (e.composedPath().some(n => n.matches?.('button,a,input,select,textarea,[contenteditable="true"],gmp-marker-3d-interactive,gmp-popover'))) return;
      this.consume(e); this.provider.stopEarthAnimation(); this.element.focus({ preventScroll: true });
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, buttons: e.buttons, alt: e.altKey };
      this.element.setPointerCapture(e.pointerId);
      this.last = performance.now();
      if (this.frame === null) this.frame = requestAnimationFrame(now => this.tick(now));
    }
    up(e) {
      if (!this.drag) return;
      this.consume(e);
      if (e.buttons) this.drag.buttons = e.buttons; else this.reset();
    }
    move(e) {
      if (!this.drag || !this.isActive()) return;
      this.consume(e);
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      Object.assign(this.drag, { x: e.clientX, y: e.clientY, buttons: e.buttons, alt: e.altKey });
      let p = this.provider.getEarthCamera(); if (!p) return;
      const scale = Math.max(1, p.range) / Math.max(300, this.element.clientHeight);
      let mode = 'camera';
      if (e.altKey && (e.buttons & 1)) {
        mode = 'orbit'; p.heading -= dx * .2; p.tilt = clamp(p.tilt + dy * .2, 0, 90);
      } else if (e.altKey && (e.buttons & 2)) {
        mode = 'orbit'; p.range = clamp(p.range * Math.exp((dx + dy) * .005), 1, 63170000);
      } else if ((e.buttons & 4) || (e.buttons & 3) === 3) {
        p = translate(p, 0, -dx * scale, dy * scale);
      } else if (e.buttons & 2) {
        p.heading += dx * .2; p.tilt = clamp(p.tilt - dy * .2, 0, 90);
      } else if (e.buttons & 1) {
        p.heading += dx * .2; p = translate(p, -dy * scale, 0, 0);
      }
      this.provider.setEarthCamera(p, mode);
    }
    wheel(e) {
      if (!this.isActive() || e.ctrlKey) return;
      this.consume(e); this.provider.stopEarthAnimation();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1);
      if (this.drag?.buttons === 2 && !this.drag.alt) this.speed = clamp(this.speed * Math.exp(-delta * .002), .05, 20);
      else {
        const p = this.provider.getEarthCamera();
        if (p) this.provider.setEarthCamera(translate(p, -Math.sign(delta) * p.range * .1, 0, 0), 'camera');
      }
    }
    key(e, pressed) {
      if (!this.isActive() || !this.drag || !(this.drag.buttons & 2) || this.drag.alt || e.ctrlKey || e.metaKey) return;
      if (!['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown'].includes(e.code)) return;
      this.consume(e);
      if (pressed) this.keys.add(e.code); else this.keys.delete(e.code);
    }
    tick(now) {
      this.frame = null;
      if (!this.drag || !this.isActive()) { this.reset(); return; }
      const dt = clamp((now - this.last) / 1000, 0, .05); this.last = now;
      const has = (...codes) => codes.some(code => this.keys.has(code)) ? 1 : 0;
      if ((this.drag.buttons & 2) && !this.drag.alt && this.keys.size) {
        const p = this.provider.getEarthCamera();
        if (p) {
          const f = has('KeyW','ArrowUp') - has('KeyS','ArrowDown');
          const r = has('KeyD','ArrowRight') - has('KeyA','ArrowLeft');
          const u = has('KeyE','PageUp') - has('KeyQ','PageDown');
          const amount = Math.max(10, p.range * .5) * this.speed * dt / Math.max(1, Math.hypot(f, r, u));
          this.provider.setEarthCamera(translate(p, f * amount, r * amount, u * amount), 'camera');
        }
      }
      this.frame = requestAnimationFrame(time => this.tick(time));
    }
  }
  window.GraphicRoadEarthNavigation = Object.freeze({ Controller, translate });
})();
