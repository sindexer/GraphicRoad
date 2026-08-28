/* Pure animation data/math. No Google requests, credentials, or browser storage. */
(() => {
  'use strict';
  const CHANNELS = Object.freeze([
    { key: 'pivotLat', label: '피벗 위도', group: 'pivot', unit: '°', min: -85, max: 85, step: 0.0001 },
    { key: 'pivotLng', label: '피벗 경도', group: 'pivot', unit: '°', min: -180, max: 180, step: 0.0001 },
    { key: 'pivotAlt', label: '피벗 고도', group: 'pivot', unit: 'm', min: -1000, max: 63170000, step: 10 },
    { key: 'cameraLat', label: '카메라 위도', group: 'camera', unit: '°', min: -85, max: 85, step: 0.0001 },
    { key: 'cameraLng', label: '카메라 경도', group: 'camera', unit: '°', min: -180, max: 180, step: 0.0001 },
    { key: 'cameraAlt', label: '카메라 고도', group: 'camera', unit: 'm', min: -1000, max: 63170000, step: 10 },
    { key: 'heading', label: '방위 · Heading', group: 'rotation', unit: '°', min: -36000, max: 36000, step: 1 },
    { key: 'tilt', label: '기울기 · Tilt', group: 'rotation', unit: '°', min: 0, max: 90, step: 1 },
    { key: 'roll', label: '롤 · Roll', group: 'rotation', unit: '°', min: -36000, max: 36000, step: 1 },
    { key: 'range', label: '피벗 거리', group: 'lens', unit: 'm', min: 1, max: 63170000, step: 100 },
    { key: 'fov', label: '화각 · FOV', group: 'lens', unit: '°', min: 5, max: 80, step: 1 }
  ]);
  const PRESETS = Object.freeze({ linear: [0, 0, 1, 1], smooth: [0.42, 0, 0.58, 1], in: [0.42, 0, 1, 1], out: [0, 0, 0.58, 1] });
  const defaults = { pivotLat: 38.1, pivotLng: 129, pivotAlt: 0, cameraLat: 38.1, cameraLng: 129, cameraAlt: 3500000, heading: 0, tilt: 35, roll: 0, range: 3500000, fov: 35 };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const copy = value => JSON.parse(JSON.stringify(value));
  const channel = key => CHANNELS.find(item => item.key === key);
  const channelsForMode = mode => CHANNELS.filter(item => item.group !== (mode === 'camera' ? 'pivot' : 'camera'));
  const snap = (time, fps, duration) => clamp(Math.round(time * fps) / fps, 0, duration);
  const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;

  function normalizeCamera(camera = {}) {
    return Object.fromEntries(CHANNELS.map(item => [item.key,
      clamp(Number.isFinite(camera[item.key]) ? camera[item.key] : defaults[item.key], item.min, item.max)]));
  }

  function createProject(camera, mode = 'orbit') {
    return { version: 1, mode, duration: 10, fps: 30, base: normalizeCamera(camera),
      tracks: Object.fromEntries(CHANNELS.map(item => [item.key, []])) };
  }

  function cubic(t, a, b) { return 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3; }
  function easingAt(progress, curve = PRESETS.smooth) {
    if (progress <= 0 || progress >= 1) return clamp(progress, 0, 1);
    let low = 0, high = 1;
    // Solve x(t)=progress; using progress directly as t changes timing.
    for (let i = 0; i < 30; i++) {
      const middle = (low + high) / 2;
      if (cubic(middle, curve[0], curve[2]) < progress) low = middle; else high = middle;
    }
    return cubic((low + high) / 2, curve[1], curve[3]);
  }

  function evaluateTrack(track, time, fallback, key) {
    if (!track.length) return fallback;
    if (time <= track[0].time) return track[0].value;
    if (time >= track.at(-1).time) return track.at(-1).value;
    const index = track.findIndex(frame => frame.time > time);
    const a = track[index - 1], b = track[index];
    const progress = easingAt((time - a.time) / (b.time - a.time), a.easing);
    // Longitudes cross the date line by the short route. Heading and roll
    // deliberately remain unwrapped so 0 -> 360 makes one complete turn.
    const longitude = key.endsWith('Lng');
    const value = a.value + (longitude ? wrap(b.value - a.value) : b.value - a.value) * progress;
    const definition = channel(key);
    return longitude ? wrap(value) : clamp(value, definition.min, definition.max);
  }

  function evaluate(project, time) {
    return Object.fromEntries(CHANNELS.map(item => [item.key,
      evaluateTrack(project.tracks[item.key], time, project.base[item.key], item.key)]));
  }

  function upsert(project, key, time, value, easing) {
    const definition = channel(key);
    if (!definition || !Number.isFinite(time) || !Number.isFinite(value) || (easing &&
        (!Array.isArray(easing) || easing.length !== 4 || easing.some(n => !Number.isFinite(n) || n < 0 || n > 1)))) {
      throw new Error('잘못된 키프레임 값입니다.');
    }
    const at = snap(time, project.fps, project.duration);
    const track = project.tracks[key];
    const existing = track.find(frame => Math.abs(frame.time - at) < 0.5 / project.fps);
    if (!existing && Object.values(project.tracks).reduce((sum, frames) => sum + frames.length, 0) >= 2000) {
      throw new Error('프로젝트당 키프레임은 최대 2,000개입니다.');
    }
    const frame = existing || { time: at, value, easing: [...PRESETS.smooth] };
    frame.value = clamp(value, definition.min, definition.max);
    if (easing) frame.easing = [...easing];
    if (!existing) track.push(frame);
    track.sort((a, b) => a.time - b.time);
    return frame;
  }

  function moveKey(project, key, from, to, value) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const track = project.tracks[key];
    const frame = track?.find(item => Math.abs(item.time - from) < 0.5 / project.fps);
    if (!frame) return null;
    const at = snap(to, project.fps, project.duration);
    // Do not destroy a neighboring key while dragging across it.
    if (track.some(item => item !== frame && Math.abs(item.time - at) < 0.5 / project.fps)) return frame;
    frame.time = at;
    if (Number.isFinite(value)) {
      const definition = channel(key);
      frame.value = clamp(value, definition.min, definition.max);
    }
    track.sort((a, b) => a.time - b.time);
    return frame;
  }

  function validateProject(input) {
    const invalid = () => { throw new Error('지원하지 않거나 손상된 타임라인 파일입니다.'); };
    if (!input || input.version !== 1 || !['orbit', 'camera'].includes(input.mode) ||
        ![24, 25, 30, 60].includes(input.fps) || !Number.isFinite(input.duration) || input.duration < 1 || input.duration > 600 ||
        !input.base || !input.tracks || Array.isArray(input.tracks)) return invalid();
    const project = createProject(input.base, input.mode);
    project.fps = input.fps;
    project.duration = snap(input.duration, input.fps, 600);
    for (const definition of CHANNELS) {
      const value = input.base[definition.key];
      if (!Number.isFinite(value) || value < definition.min || value > definition.max) return invalid();
    }
    if (Object.keys(input.tracks).some(key => !channel(key))) return invalid();
    let total = 0;
    for (const definition of CHANNELS) {
      const track = input.tracks[definition.key];
      if (!Array.isArray(track) || (total += track.length) > 2000) return invalid();
      for (const frame of track) {
        if (!frame || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > project.duration ||
            !Number.isFinite(frame.value) || frame.value < definition.min || frame.value > definition.max ||
            !Array.isArray(frame.easing) || frame.easing.length !== 4 ||
            frame.easing.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return invalid();
        const before = project.tracks[definition.key].length;
        upsert(project, definition.key, frame.time, frame.value, frame.easing);
        if (project.tracks[definition.key].length === before) return invalid();
      }
    }
    return project;
  }

  window.GraphicRoadTimelineCore = Object.freeze({ CHANNELS, PRESETS, clamp, copy, channel, channelsForMode,
    snap, normalizeCamera, createProject, cubic, easingAt, evaluateTrack, evaluate, upsert, moveKey, validateProject });
})();
