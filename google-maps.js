/* Google Maps is loaded only when a Google theme is selected.
 * Browser keys are public at runtime. Restrict the key in Google Cloud;
 * never commit it, persist it in browser storage, or log SDK request URLs.
 */
(() => {
  'use strict';

  const THEMES = Object.freeze({
    GOOGLE_DEFAULT: { label: 'Google Map', mapTypeId: 'roadmap' },
    GOOGLE_BASIC: { label: '기본_G', mapIdSetting: 'basicMapId' },
    GOOGLE_BLUE: { label: '블루_G', mapIdSetting: 'blueMapId' },
    // Live Korean satellite tiles are available through zoom 15 for this
    // deployment. Keep a conservative ceiling even if metadata reports more.
    GOOGLE_SATELLITE: { label: '위성_G', mapTypeId: 'satellite', maxZoom: 15 },
    GOOGLE_EARTH: { label: '어스_G', earth: true }
  });
  const MESSAGES = Object.freeze({
    CONFIG: '구글 지도 배포 설정이 준비되지 않았습니다. 기존 지도를 이용해 주세요.',
    LOAD: '구글 지도를 불러오지 못했습니다. 네트워크 연결 후 다시 선택해 주세요.',
    AUTH: '구글 지도 인증에 실패했습니다. API 키의 웹사이트·API 제한과 결제 설정을 확인해 주세요.',
    SEARCH: '구글 검색을 사용할 수 없습니다. Geocoding API와 Places API (New) 설정을 확인해 주세요.',
    EARTH: '3D 지도를 불러오지 못했습니다. 최신 브라우저의 하드웨어 가속·네트워크·Maps JavaScript API 설정을 확인해 주세요.'
  });
  let configPromise;
  let sdkPromise;
  let authenticationFailed = false;

  function failure(code) {
    const error = new Error(MESSAGES[code] || MESSAGES.LOAD);
    error.code = code;
    return error;
  }

  function validateConfig(config) {
    if (!config || !/^AIza[\w-]{35}$/.test(config.apiKey || '') ||
        !/^[a-f\d]{16,32}$/i.test(config.basicMapId || '') ||
        !/^[a-f\d]{16,32}$/i.test(config.blueMapId || '') ||
        config.basicMapId === config.blueMapId) throw failure('CONFIG');
    return Object.freeze({
      apiKey: config.apiKey,
      basicMapId: config.basicMapId,
      blueMapId: config.blueMapId
    });
  }

  async function loadConfig() {
    if (!configPromise) {
      configPromise = (async () => {
        try {
          const response = await fetch('./google-maps-config.json', {
            credentials: 'same-origin', cache: 'no-store',
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) throw failure('CONFIG');
          return validateConfig(await response.json());
        } catch {
          throw failure('CONFIG');
        }
      })().catch(error => { configPromise = null; throw error; });
    }
    return configPromise;
  }

  async function loadSdk(config) {
    if (authenticationFailed) throw failure('AUTH');
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(window.google.maps);
      };
      const timer = setTimeout(() => finish(failure('LOAD')), 20000);
      window.__graphicRoadGoogleReady = () => finish();
      window.gm_authFailure = () => {
        authenticationFailed = true;
        finish(failure('AUTH'));
        window.dispatchEvent(new Event('graphic-road-google-auth-failure'));
      };
      const parameters = new URLSearchParams({
        key: config.apiKey, v: 'quarterly', loading: 'async',
        callback: '__graphicRoadGoogleReady', language: 'ko', region: 'KR',
        auth_referrer_policy: 'origin'
      });
      script.src = 'https://maps.googleapis.com/maps/api/js?' + parameters;
      script.async = true;
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.onerror = () => finish(failure('LOAD'));
      document.head.appendChild(script);
    }).catch(error => { sdkPromise = null; throw error; });
    return sdkPromise;
  }

  function validPosition(position) {
    const lat = Number(typeof position?.lat === 'function' ? position.lat() : position?.lat);
    const lng = Number(typeof position?.lng === 'function' ? position.lng() : position?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: Math.max(-85, Math.min(85, lat)), lng: ((lng + 180) % 360 + 360) % 360 - 180 };
  }

  function markerKey(item) {
    return [Number(item.lat).toFixed(6), Number(item.lng).toFixed(6)].join(',');
  }

  class Provider {
    constructor(container, onMarkersChanged) {
      this.container = container;
      this.records = new Map();
      this.active = null;
      this.markers = new Map();
      this.markersVisible = true;
      this.infoWindow = null;
      this.infoSequence = 0;
      this.onMarkersChanged = onMarkersChanged;
      this.enabled = false;
    }

    async activate(theme, view, isCurrent) {
      this.cancelEarthLoad?.();
      const definition = THEMES[theme];
      if (!definition) throw failure('CONFIG');
      const config = await loadConfig();
      if (!isCurrent()) return false;
      await loadSdk(config);
      const { Map: GoogleMap, MaxZoomService, RenderingType } = await google.maps.importLibrary('maps');
      if (!isCurrent()) return false;
      if (authenticationFailed) throw failure('AUTH');
      if (definition.earth) return this.activateEarth(theme, definition, view, isCurrent);
      this.closeInfo();
      this.records.forEach(record => { record.element.hidden = true; });
      let record = this.records.get(theme);
      const center = validPosition(view?.center) || { lat: 37.5666103, lng: 126.9783882 };
      const zoom = Math.max(2, Math.min(definition.maxZoom || 22, Number(view?.zoom) || 15));
      if (!record) {
        const element = document.createElement('div');
        element.className = 'google-map-surface';
        element.setAttribute('aria-label', definition.label);
        this.container.appendChild(element);
        const options = {
          // Never force a higher zoom than the available imagery supports.
          center, zoom, minZoom: 2,
          tilt: 0, heading: 0, disableDefaultUI: true,
          zoomControl: true, scaleControl: true, clickableIcons: false,
          gestureHandling: 'greedy', keyboardShortcuts: true,
          tiltInteractionEnabled: false, headingInteractionEnabled: false,
          zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
          mapTypeId: definition.mapTypeId || 'roadmap'
        };
        if (definition.maxZoom) options.maxZoom = definition.maxZoom;
        if (definition.mapIdSetting) options.mapId = config[definition.mapIdSetting];
        if (definition.mapTypeId === 'satellite') {
          // Avoid seams between separately composited HTML raster tiles.
          // Google falls back to raster on devices without WebGL support.
          options.renderingType = RenderingType.VECTOR;
          options.isFractionalZoomEnabled = false;
        }
        const map = new GoogleMap(element, options);
        record = { map, element, satellite: definition.mapTypeId === 'satellite', zoomCeiling: definition.maxZoom || 22, coverageSequence: 0 };
        this.records.set(theme, record);
        if (record.satellite) {
          this.maxZoomService ||= new MaxZoomService();
          map.addListener('idle', () => this.updateSatelliteLimit(record));
        }
        map.addListener('click', () => this.closeInfo());
        map.addListener('rightclick', event => {
          if (this.enabled && this.active === record && event.latLng) {
            this.lookupAddress(event.latLng);
          }
        });
      } else {
        record.element.hidden = false;
        google.maps.event.trigger(record.map, 'resize');
        this.resetSatelliteLimitForPosition(record, center);
        record.map.setCenter(center);
        record.map.setZoom(zoom);
      }
      this.active = record;
      this.enabled = true;
      this.updateSatelliteLimit(record);
      this.syncMarkers();
      return true;
    }

    async activateEarth(theme, definition, view, isCurrent) {
      let library;
      try {
        const [maps3d, marker] = await Promise.all([
          google.maps.importLibrary('maps3d'), google.maps.importLibrary('marker')
        ]);
        library = { ...maps3d, PinElement: marker.PinElement };
      } catch { throw failure('EARTH'); }
      if (!isCurrent()) return false;
      if (authenticationFailed) throw failure('AUTH');
      this.earthLibrary = library;
      this.closeInfo();
      this.enabled = false;
      this.syncMarkers();
      this.records.forEach(record => { record.element.hidden = true; });
      let record = this.records.get(theme);
      if (!record) {
        const element = document.createElement('div');
        element.className = 'google-map-surface google-earth-surface';
        element.setAttribute('aria-label', definition.label);
        let map;
        try {
          // No Cloud map ID is needed for the default photorealistic globe.
          map = new library.Map3DElement({
            center: { lat: 38.1, lng: 129, altitude: 0 },
            range: 3500000, tilt: 35, heading: 0,
            mode: library.MapMode.SATELLITE,
            gestureHandling: library.GestureHandling.GREEDY,
            defaultUIHidden: false,
            description: '어스_G 3D 지도. 지도 기본 컨트롤로 확대, 회전, 기울이기를 조절하세요.'
          });
        } catch { throw failure('EARTH'); }
        record = { map, element, earth: true };
        // PopoverElement handles outside-click dismissal itself;
        // a map click handler can close a marker's freshly opened popover.
        // Rendering can fail after the SDK loads (for example, WebGL is
        // unavailable). Wait for the first completed scene, not just import.
        const ready = new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, canceled = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            map.removeEventListener('gmp-steadychange', onSteady);
            map.removeEventListener('gmp-error', onError);
            if (this.cancelEarthLoad === cancel) this.cancelEarthLoad = null;
            if (error || canceled) element.remove();
            if (error) reject(error); else resolve(!canceled);
          };
          const onSteady = event => { if (event.isSteady) finish(null, !isCurrent()); };
          const onError = () => finish(failure('EARTH'));
          const cancel = () => finish(null, true);
          const timer = setTimeout(() => finish(failure('EARTH')), 45000);
          this.cancelEarthLoad = cancel;
          map.addEventListener('gmp-steadychange', onSteady);
          map.addEventListener('gmp-error', onError);
        });
        element.appendChild(map);
        this.container.appendChild(element);
        if (!await ready || !isCurrent()) { element.remove(); return false; }
        this.records.set(theme, record);
      } else {
        const center = validPosition(view?.center);
        if (center) {
          record.map.center = { ...center, altitude: 0 };
          record.map.range = this.earthRangeForView(view);
        }
        record.element.hidden = false;
      }
      this.active = record;
      this.enabled = true;
      this.syncMarkers();
      return true;
    }

    earthRangeForView(view) {
      const lat = validPosition(view?.center)?.lat || 0;
      const zoom = Math.max(2, Math.min(22, Number(view?.zoom) || 6));
      // Approximate a top-down Web Mercator view using the 3D vertical FOV.
      // Perspective/terrain mean a tilted view cannot match 2D bounds exactly.
      const metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
      return Math.max(800, Math.min(63170000,
        metersPerPixel * (this.container.clientHeight || 700) / (2 * Math.tan(35 * Math.PI / 360))));
    }

    resetSatelliteLimitForPosition(record, position) {
      // A low imagery limit at the old location must not clamp a new search
      // before the new location's metadata arrives. Keep the deployment cap.
      if (record.satellite && record.coverageKey !== markerKey(position)) {
        record.map.setOptions({ maxZoom: record.zoomCeiling });
      }
    }

    async updateSatelliteLimit(record) {
      if (!record.satellite || !this.enabled || this.active !== record) return;
      const center = validPosition(record.map.getCenter());
      if (!center) return;
      const key = markerKey(center);
      if (record.coverageKey === key) return;
      record.coverageKey = key;
      const sequence = ++record.coverageSequence;
      try {
        const result = await this.maxZoomService.getMaxZoomAtLatLng(center);
        if (sequence !== record.coverageSequence) return;
        const currentCenter = validPosition(record.map.getCenter());
        if (!this.enabled || this.active !== record || !currentCenter || markerKey(currentCenter) !== key) {
          record.coverageKey = null;
          return;
        }
        if (!Number.isFinite(result.zoom)) throw new Error('Invalid imagery limit');
        record.element.setAttribute('data-imagery-reported-max-zoom', String(result.zoom));
        const maxZoom = Math.max(2, Math.min(record.zoomCeiling, result.zoom));
        record.map.setOptions({ maxZoom });
        if (record.map.getZoom() > maxZoom) record.map.setZoom(maxZoom);
      } catch {
        // Keep the last usable limit; retry on the next map interaction.
        if (sequence === record.coverageSequence) record.coverageKey = null;
      }
    }

    hide() {
      this.stopEarthAnimation();
      this.cancelEarthLoad?.();
      this.enabled = false;
      this.closeInfo();
      this.syncMarkers();
    }

    getEarthCamera() {
      if (!this.enabled || !this.active?.earth) return null;
      const map = this.active.map;
      const pivot = validPosition(map.center);
      const position = validPosition(map.cameraPosition);
      if (!pivot || !position) return null;
      const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
      return {
        pivotLat: pivot.lat, pivotLng: pivot.lng, pivotAlt: finite(map.center.altitude, 0),
        cameraLat: position.lat, cameraLng: position.lng, cameraAlt: finite(map.cameraPosition.altitude, 0),
        heading: finite(map.heading, 0), tilt: finite(map.tilt, 0), roll: finite(map.roll, 0),
        range: finite(map.range, 1000), fov: finite(map.fov, 35)
      };
    }

    setEarthCamera(camera, mode = 'orbit') {
      if (!this.enabled || !this.active?.earth || !['orbit', 'camera'].includes(mode)) return false;
      const basis = mode === 'camera' ? 'camera' : 'pivot';
      const limits = { [`${basis}Lat`]: [-85, 85], [`${basis}Lng`]: [-180, 180],
        [`${basis}Alt`]: [-1000, 63170000], heading: [-36000, 36000], tilt: [0, 90],
        roll: [-36000, 36000], range: [1, 63170000], fov: [5, 80] };
      if (!camera || Object.keys(limits).some(key => !Number.isFinite(camera[key]))) return false;
      const values = Object.fromEntries(Object.entries(limits).map(([key, [min, max]]) =>
        [key, Math.max(min, Math.min(max, camera[key]))]));
      const map = this.active.map;
      if (this.renderMode) this.armEarthSteady(map);
      // The SDK derives center from cameraPosition (or vice versa). Writing
      // both in one frame would silently override the pivot animation.
      map.heading = values.heading;
      map.tilt = values.tilt;
      map.roll = values.roll;
      map.range = values.range;
      map.fov = values.fov;
      map[mode === 'camera' ? 'cameraPosition' : 'center'] = {
        lat: values[`${basis}Lat`], lng: values[`${basis}Lng`], altitude: values[`${basis}Alt`]
      };
      if (this.renderMode && mode === 'orbit') {
        // Let the SDK derive cameraPosition from the new center first. Moving
        // to that equivalent basis on the next paint suppresses the transient
        // blue target tether without reusing the previous frame's position.
        (globalThis.cancelAnimationFrame || clearTimeout)(this.renderCameraFrame || 0);
        this.renderCameraFrame = (globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0)))(() => {
          this.renderCameraFrame = 0;
          if (!this.renderMode || map !== this.active?.map) return;
          const position = validPosition(map.cameraPosition);
          if (position) map.cameraPosition = {
            ...position, altitude: Number(map.cameraPosition.altitude) || 0
          };
        });
      }
      return true;
    }

    armEarthSteady(map, timeout = 180) {
      this.cancelEarthSteady?.();
      let finish;
      this.earthSteadyPromise = new Promise(resolve => {
        let settled = false;
        const done = value => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          map.removeEventListener('gmp-steadychange', onSteady);
          if (this.cancelEarthSteady === cancel) this.cancelEarthSteady = null;
          resolve(value);
        };
        const onSteady = event => { if (event.isSteady) done(true); };
        const cancel = () => done(false);
        const timer = setTimeout(() => done(false), timeout);
        finish = cancel; this.cancelEarthSteady = cancel;
        map.addEventListener('gmp-steadychange', onSteady);
      });
      return this.earthSteadyPromise.finally(() => { if (this.cancelEarthSteady === finish) this.cancelEarthSteady = null; });
    }

    stopEarthAnimation() {
      if (this.active?.earth) this.active.map.stopCameraAnimation?.();
    }

    setEarthRenderMode(enabled) {
      if (!this.active?.earth) return false;
      // Hide exploration controls only. Google attribution remains rendered by
      // the SDK and must be present in exported imagery.
      this.renderMode = Boolean(enabled);
      if (!this.renderMode) {
        this.cancelEarthSteady?.(); this.earthSteadyPromise = null;
        (globalThis.cancelAnimationFrame || clearTimeout)(this.renderCameraFrame || 0); this.renderCameraFrame = 0;
      }
      this.active.map.defaultUIHidden = this.renderMode;
      if (this.renderMode) {
        this.closeInfo();
        // The 3D renderer shows its blue camera-target tether while the map is
        // focused/hovered. Rendering is programmatic, so release that state.
        this.active.map.blur?.();
        document.activeElement?.blur?.();
      }
      this.syncMarkers();
      return true;
    }

    waitEarthSteady(timeout = 2500) {
      if (!this.enabled || !this.active?.earth) return Promise.resolve(false);
      if (this.renderMode && this.earthSteadyPromise) return this.earthSteadyPromise;
      const map = this.active.map;
      return new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          map.removeEventListener('gmp-steadychange', onSteady);
          resolve(value);
        };
        const onSteady = event => { if (event.isSteady) finish(true); };
        const timer = setTimeout(() => finish(false), Math.max(100, timeout));
        map.addEventListener('gmp-steadychange', onSteady);
      });
    }

    subscribeEarthCamera(callback) {
      if (!this.enabled || !this.active?.earth) return () => {};
      const record = this.active;
      const events = ['gmp-camerapositionchange', 'gmp-centerchange', 'gmp-headingchange',
        'gmp-tiltchange', 'gmp-rollchange', 'gmp-rangechange', 'gmp-fovchange', 'gmp-steadychange'];
      const update = () => {
        if (this.enabled && this.active === record) callback(this.getEarthCamera());
      };
      events.forEach(name => record.map.addEventListener(name, update));
      return () => events.forEach(name => record.map.removeEventListener(name, update));
    }

    getView() {
      if (!this.active) return null;
      if (this.active.earth) {
        const map = this.active.map;
        const center = validPosition(map.center);
        if (!center) return null;
        const metersPerPixel = Math.max(1, map.range) * 2 * Math.tan((map.fov || 35) * Math.PI / 360)
          / (this.container.clientHeight || 700);
        const zoom = Math.log2(156543.03392 * Math.cos(center.lat * Math.PI / 180) / metersPerPixel);
        return { center, zoom: Math.max(2, Math.min(22, Math.round(zoom))) };
      }
      return { center: validPosition(this.active.map.getCenter()), zoom: this.active.map.getZoom() };
    }

    panTo(item) {
      const position = validPosition(item);
      if (!position || !this.active) return;
      this.closeInfo();
      if (this.active.earth) {
        // Direct camera updates also respect reduced-motion preferences.
        this.active.map.center = { ...position, altitude: 0 };
        this.active.map.range = 3000;
        this.active.map.tilt = 60;
        return;
      }
      this.resetSatelliteLimitForPosition(this.active, position);
      this.active.map.panTo(position);
      this.active.map.setZoom(17);
    }

    get markerCount() { return this.markers.size; }
    hasMarker(item) { return this.markers.has(markerKey(item)); }

    addMarker(item, color) {
      const key = markerKey(item);
      const position = validPosition(item);
      if (!position || this.markers.has(key) || !this.active) return false;
      const provider = this;
      class SearchPin extends google.maps.OverlayView {
        onAdd() {
          this.element = document.createElement('span');
          this.element.className = 'search-map-pin google-search-pin';
          this.element.style.setProperty('--pin-color', color);
          this.element.title = String(item.title || '검색 위치') + ' — 우클릭 또는 Delete 키로 삭제';
          this.element.tabIndex = 0;
          this.element.setAttribute('role', 'button');
          this.element.setAttribute('aria-label', this.element.title);
          this.element.addEventListener('contextmenu', event => {
            event.preventDefault(); event.stopPropagation(); provider.removeMarker(key);
          });
          this.element.addEventListener('keydown', event => {
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault(); event.stopPropagation(); provider.removeMarker(key);
            }
          });
          google.maps.OverlayView.preventMapHitsAndGesturesFrom(this.element);
          this.getPanes().overlayMouseTarget.appendChild(this.element);
        }
        draw() {
          const point = this.getProjection()?.fromLatLngToDivPixel(new google.maps.LatLng(position));
          if (!point || !this.element) return;
          this.element.style.left = point.x + 'px';
          this.element.style.top = point.y + 'px';
        }
        onRemove() { this.element?.remove(); }
      }
      this.markers.set(key, { overlay: new SearchPin(), color, position, title: String(item.title || '검색 위치') });
      this.markersVisible = true;
      this.syncMarkers();
      this.onMarkersChanged?.();
      return true;
    }

    removeMarker(key) {
      const entry = this.markers.get(key);
      if (!entry) return;
      entry.overlay.setMap(null);
      entry.earthMarker?.remove();
      entry.earthPopover?.remove();
      this.markers.delete(key);
      if (!this.markers.size) this.markersVisible = true;
      this.closeInfo();
      this.onMarkersChanged?.();
    }

    syncMarkers() {
      const record = this.enabled && this.markersVisible && !this.renderMode ? this.active : null;
      this.markers.forEach((entry, key) => {
        entry.overlay.setMap(record && !record.earth ? record.map : null);
        if (record?.earth) {
          if (!entry.earthMarker) {
            const { Marker3DInteractiveElement, PinElement, AltitudeMode, PopoverElement } = this.earthLibrary;
            const content = document.createElement('div');
            content.className = 'google-address-info';
            const title = document.createElement('p');
            title.textContent = entry.title;
            const remove = document.createElement('button');
            remove.type = 'button'; remove.textContent = '핀 삭제';
            remove.addEventListener('click', () => this.removeMarker(key));
            content.append(title, remove);
            const popover = new PopoverElement({ open: false });
            popover.appendChild(content);
            const marker = new Marker3DInteractiveElement({
              position: entry.position, altitudeMode: AltitudeMode.CLAMP_TO_GROUND,
              title: entry.title + ' — 클릭하여 핀 삭제', drawsWhenOccluded: true,
              gmpPopoverTargetElement: popover
            });
            marker.appendChild(new PinElement({ background: entry.color, borderColor: '#ffffff', glyphColor: '#ffffff' }));
            marker.addEventListener('keydown', event => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault(); event.stopPropagation(); this.removeMarker(key);
              }
            });
            entry.earthMarker = marker;
            entry.earthPopover = popover;
          }
          if (entry.earthMarker.parentNode !== record.map) record.map.appendChild(entry.earthMarker);
          if (entry.earthPopover.parentNode !== record.map) record.map.appendChild(entry.earthPopover);
        } else {
          entry.earthMarker?.remove();
          entry.earthPopover?.remove();
        }
      });
    }

    toggleMarkers() {
      this.markersVisible = !this.markersVisible;
      this.syncMarkers();
      if (!this.markersVisible) this.closeInfo();
      this.onMarkersChanged?.();
    }

    async search(query) {
      if (!this.active || authenticationFailed) throw failure('SEARCH');
      try {
        const { Place } = await google.maps.importLibrary('places');
        const { places } = await Place.searchByText({
          textQuery: query, fields: ['displayName', 'formattedAddress', 'location'],
          locationBias: this.getView()?.center, language: 'ko', maxResultCount: 8
        });
        if (places?.length) return places.filter(place => place.location).map(place => ({
          title: place.displayName || query, address: place.formattedAddress || '',
          ...validPosition(place.location), source: 'Google Maps', provider: 'google',
          attributions: (place.attributions || []).map(entry => ({
            provider: entry.provider || '', providerURI: entry.providerURI || ''
          }))
        }));
      } catch {
        // Address search can still work if only Geocoding is enabled.
      }
      try {
        const { Geocoder } = await google.maps.importLibrary('geocoding');
        const { results } = await new Geocoder().geocode({ address: query, language: 'ko' });
        return (results || []).map(result => ({
          title: result.formatted_address, address: result.formatted_address,
          ...validPosition(result.geometry.location), source: 'Google Maps', provider: 'google'
        }));
      } catch (error) {
        if (error?.code === 'ZERO_RESULTS') return [];
        throw failure('SEARCH');
      }
    }

    closeInfo() {
      this.infoSequence += 1;
      this.infoWindow?.close();
      this.earthInfo?.remove();
      this.earthInfo = null;
      this.markers.forEach(entry => { if (entry.earthPopover) entry.earthPopover.open = false; });
    }

    showEarthInfo(position, content) {
      this.closeInfo();
      if (!this.enabled || !this.active?.earth) return;
      const { PopoverElement } = this.earthLibrary;
      this.earthInfo = new PopoverElement({ positionAnchor: position, open: true });
      this.earthInfo.appendChild(content);
      this.active.map.appendChild(this.earthInfo);
    }

    async lookupAddress(position) {
      this.closeInfo();
      const record = this.active;
      if (!record) return;
      const content = document.createElement('div');
      content.className = 'google-address-info';
      content.textContent = '주소 확인 중...';
      if (record.earth) this.showEarthInfo(position, content);
      else {
        if (!this.infoWindow) this.infoWindow = new google.maps.InfoWindow();
        this.infoWindow.setContent(content);
        this.infoWindow.setPosition(position);
        this.infoWindow.open({ map: record.map, shouldFocus: false });
      }
      const sequence = this.infoSequence;
      try {
        const { Geocoder } = await google.maps.importLibrary('geocoding');
        const { results } = await new Geocoder().geocode({ location: position, language: 'ko' });
        if (sequence !== this.infoSequence || !this.enabled) return;
        content.textContent = results?.[0]?.formatted_address || '주소를 찾지 못했습니다.';
      } catch {
        if (sequence !== this.infoSequence || !this.enabled) return;
        content.textContent = '주소를 찾지 못했습니다. Geocoding API 설정을 확인해 주세요.';
      }
    }
  }

  window.GraphicRoadGoogle = Object.freeze({
    THEMES, Provider, validateConfig, validPosition,
    isTheme: theme => Object.hasOwn(THEMES, theme),
    errorMessage: error => MESSAGES[error?.code] || MESSAGES.LOAD
  });
})();
