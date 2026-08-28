/* Google Maps is loaded only when a Google theme is selected.
 * Browser keys are public at runtime. Restrict the key in Google Cloud;
 * never commit it, persist it in browser storage, or log SDK request URLs.
 */
(() => {
  'use strict';

  // Match the requested East Asia overview on the first satellite selection.
  // fitBounds also keeps Korea and Japan visible on smaller browser windows.
  const SATELLITE_INITIAL_VIEW = Object.freeze({
    center: Object.freeze({ lat: 38.1, lng: 129 }),
    zoom: 6,
    bounds: Object.freeze({ north: 45.4, south: 30, west: 108, east: 150 })
  });
  const THEMES = Object.freeze({
    GOOGLE_DEFAULT: { label: 'Google Map', mapTypeId: 'roadmap' },
    GOOGLE_BASIC: { label: '기본_G', mapIdSetting: 'basicMapId' },
    GOOGLE_BLUE: { label: '블루_G', mapIdSetting: 'blueMapId' },
    // Live Korean satellite tiles are available through zoom 15 for this
    // deployment. Keep a conservative ceiling even if metadata reports more.
    GOOGLE_SATELLITE: {
      label: '위성_G', mapTypeId: 'satellite', maxZoom: 15,
      initialView: SATELLITE_INITIAL_VIEW
    }
  });
  const MESSAGES = Object.freeze({
    CONFIG: '구글 지도 배포 설정이 준비되지 않았습니다. 기존 지도를 이용해 주세요.',
    LOAD: '구글 지도를 불러오지 못했습니다. 네트워크 연결 후 다시 선택해 주세요.',
    AUTH: '구글 지도 인증에 실패했습니다. API 키의 웹사이트·API 제한과 결제 설정을 확인해 주세요.',
    SEARCH: '구글 검색을 사용할 수 없습니다. Geocoding API와 Places API (New) 설정을 확인해 주세요.'
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
      const definition = THEMES[theme];
      if (!definition) throw failure('CONFIG');
      const config = await loadConfig();
      if (!isCurrent()) return false;
      await loadSdk(config);
      const { Map: GoogleMap, MaxZoomService, RenderingType } = await google.maps.importLibrary('maps');
      if (!isCurrent()) return false;
      if (authenticationFailed) throw failure('AUTH');
      this.closeInfo();
      this.records.forEach(record => { record.element.hidden = true; });
      let record = this.records.get(theme);
      const initialView = !record ? definition.initialView : null;
      const camera = initialView || view;
      const center = validPosition(camera?.center) || { lat: 37.5666103, lng: 126.9783882 };
      const zoom = Math.max(2, Math.min(definition.maxZoom || 22, Number(camera?.zoom) || 15));
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
        if (initialView?.bounds) map.fitBounds(initialView.bounds, 0);
      } else {
        record.element.hidden = false;
        google.maps.event.trigger(record.map, 'resize');
        record.map.setCenter(center);
        record.map.setZoom(zoom);
      }
      this.active = record;
      this.enabled = true;
      this.updateSatelliteLimit(record);
      this.syncMarkers();
      return true;
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
      this.enabled = false;
      this.closeInfo();
      this.syncMarkers();
    }

    getView() {
      if (!this.active) return null;
      return { center: validPosition(this.active.map.getCenter()), zoom: this.active.map.getZoom() };
    }

    panTo(item) {
      const position = validPosition(item);
      if (!position || !this.active) return;
      this.closeInfo();
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
      this.markers.set(key, { overlay: new SearchPin(), color });
      this.markersVisible = true;
      this.syncMarkers();
      this.onMarkersChanged?.();
      return true;
    }

    removeMarker(key) {
      const entry = this.markers.get(key);
      if (!entry) return;
      entry.overlay.setMap(null);
      this.markers.delete(key);
      if (!this.markers.size) this.markersVisible = true;
      this.closeInfo();
      this.onMarkersChanged?.();
    }

    syncMarkers() {
      const map = this.enabled && this.markersVisible ? this.active?.map : null;
      this.markers.forEach(entry => entry.overlay.setMap(map || null));
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
          locationBias: this.active.map.getCenter(), language: 'ko', maxResultCount: 8
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
    }

    async lookupAddress(position) {
      this.closeInfo();
      const sequence = this.infoSequence;
      const record = this.active;
      if (!record) return;
      if (!this.infoWindow) this.infoWindow = new google.maps.InfoWindow();
      const content = document.createElement('div');
      content.className = 'google-address-info';
      content.textContent = '주소 확인 중...';
      this.infoWindow.setContent(content);
      this.infoWindow.setPosition(position);
      this.infoWindow.open({ map: record.map, shouldFocus: false });
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
