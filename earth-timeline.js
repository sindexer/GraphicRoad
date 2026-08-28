/* A local camera editor on the existing Map3DElement, not an Earth Studio embed. */
(() => {
  'use strict';
  const C = window.GraphicRoadTimelineCore;
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = (value, digits = 4) => Number(value.toFixed(digits)).toString();
  const groups = { pivot: '3D PIVOT · 회전 중심', camera: '3D POSITION · 카메라 위치', rotation: '3D ROTATION · 회전', lens: 'LENS · 거리와 화각' };

  class Controller {
    constructor({ button, root, getProvider }) {
      this.button = button;
      this.root = root;
      this.getProvider = getProvider;
      this.available = false;
      this.opened = false;
      this.playing = false;
      this.time = 0;
      this.channel = 'heading';
      this.selectedTime = null;
      this.undoStack = [];
      this.redoStack = [];
      this.project = null;
      this.frame = null;
      this.cameraFrame = null;
      this.appliedUntil = 0;
      this.acceptCameraUpdates = false;
      this.build();
      button.addEventListener('click', () => this.opened ? this.close() : this.open());
      root.addEventListener('click', event => this.onClick(event));
      root.addEventListener('change', event => {
        delete event.target.dataset?.pendingEdit;
        this.onChange(event);
      });
      root.addEventListener('focusout', event => {
        if (event.target.dataset?.pendingEdit) {
          delete event.target.dataset.pendingEdit;
          this.onChange(event);
        }
      });
      root.addEventListener('input', event => {
        if (event.target.id === 'ET_SCRUB') this.seek(Number(event.target.value));
        else if (event.target.type === 'number') event.target.dataset.pendingEdit = 'true';
      });
      root.addEventListener('keydown', event => this.onKey(event));
      for (const svg of [this.$('ET_TRACKS'), this.$('ET_GRAPH')]) {
        svg.addEventListener('pointerdown', event => this.pointerDown(event, svg));
        svg.addEventListener('pointermove', event => this.pointerMove(event, svg));
        const finish = () => { this.drag = null; };
        svg.addEventListener('pointerup', finish);
        svg.addEventListener('pointercancel', finish);
        svg.addEventListener('lostpointercapture', finish);
      }
      // Manual map navigation, switching tabs, hiding UI, or closing the panel
      // must never leave a background animation competing with the user.
      for (const event of ['pointerdown', 'wheel', 'keydown']) {
        document.getElementById('googleMap')?.addEventListener(event, () => this.pauseForNavigation(), { capture: true, passive: true });
      }
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    }

    $(id) { return this.root.querySelector('#' + id); }
    activeChannels() { return C.channelsForMode(this.project.mode); }
    selected() { return this.selectedTime === null ? null : this.project?.tracks[this.channel].find(key => Math.abs(key.time - this.selectedTime) < 0.5 / this.project.fps); }
    pauseForNavigation() { this.pause(); this.appliedUntil = 0; this.acceptCameraUpdates = true; }
    setStatus(message) { this.$('ET_STATUS').textContent = message; }

    build() {
      this.root.innerHTML = `
        <header class="et-header">
          <div class="et-title"><span class="et-orbit">◉</span><strong>EARTH <span>타임라인</span></strong></div>
          <div class="et-transport">
            <button type="button" data-action="back" title="이전 프레임" aria-label="이전 프레임">‹</button>
            <button type="button" data-action="play" id="ET_PLAY" class="et-primary" aria-label="애니메이션 재생">▶ 재생</button>
            <button type="button" data-action="next" title="다음 프레임" aria-label="다음 프레임">›</button>
            <output id="ET_TIMECODE" aria-label="현재 타임코드">00:00:00</output>
            <label class="et-check"><input id="ET_LOOP" type="checkbox">반복</label>
          </div>
          <div class="et-actions">
            <button type="button" data-action="capture" class="et-key-button">◆ 키프레임 추가</button>
            <button type="button" data-action="undo" id="ET_UNDO" aria-label="실행 취소" title="실행 취소 (Ctrl+Z)">↶</button>
            <button type="button" data-action="redo" id="ET_REDO" aria-label="다시 실행" title="다시 실행 (Ctrl+Shift+Z)">↷</button>
            <button type="button" data-action="save">저장</button>
            <button type="button" data-action="load">불러오기</button>
            <button type="button" data-action="new">새로 만들기</button>
            <button type="button" data-action="close" class="et-close" aria-label="타임라인 닫기">✕</button>
          </div>
          <input id="ET_FILE" type="file" accept=".json,application/json" hidden>
        </header>
        <div class="et-body">
          <section class="et-inspector" aria-label="카메라 속성">
            <label class="et-mode">카메라 제어 기준<select id="ET_MODE" aria-label="카메라 제어 기준"><option value="orbit">피벗 기준 회전</option><option value="camera">카메라 위치 이동</option></select></label>
            <p class="et-help">위치와 피벗은 연동됩니다. 회색 값은 자동 계산됩니다.</p>
            <div id="ET_FIELDS"></div>
          </section>
          <section class="et-sequencer" aria-label="키프레임 트랙">
            <div class="et-section-head"><strong>키프레임</strong><div class="et-settings">
              <label>길이 <input id="ET_DURATION" aria-label="타임라인 길이 초" type="number" min="1" max="600" step="1" value="10">초</label>
              <select id="ET_FPS" aria-label="타임라인 FPS"><option>24</option><option>25</option><option selected>30</option><option>60</option></select><span>FPS</span>
            </div></div>
            <svg id="ET_TRACKS" viewBox="0 0 720 274" preserveAspectRatio="none" role="group" aria-label="카메라 키프레임 트랙"></svg>
            <div class="et-scrubber"><label for="ET_SCRUB">시간</label><input id="ET_SCRUB" aria-label="재생 위치" type="range" min="0" max="10" step="0.033333" value="0"><input id="ET_TIME" aria-label="현재 시간 초" type="number" min="0" max="10" step="0.033333" value="0"><span>초</span></div>
            <p class="et-help">시간 이동 → 지도 또는 숫자로 카메라 조절 → ◆ 추가<br>키를 드래그해 이동 · 선택 후 Delete로 삭제</p>
          </section>
          <section class="et-curve" aria-label="애니메이션 그래프">
            <div class="et-section-head"><strong>그래프 편집</strong><select id="ET_CHANNEL" aria-label="그래프 채널"></select></div>
            <div class="et-graph-tabs"><button type="button" data-action="easing" id="ET_EASING_TAB" aria-pressed="true">보간 곡선</button><button type="button" data-action="values" id="ET_VALUES_TAB" aria-pressed="false">값 그래프</button></div>
            <svg id="ET_GRAPH" viewBox="0 0 280 146" role="group" aria-label="애니메이션 곡선 그래프"></svg>
            <div id="ET_CURVE_TOOLS"><select id="ET_PRESET" aria-label="보간 프리셋"><option value="custom">사용자 지정</option><option value="linear">선형</option><option value="smooth">부드럽게</option><option value="in">천천히 시작</option><option value="out">천천히 끝</option></select>
              <div class="et-handles">${['X1', 'Y1', 'X2', 'Y2'].map((label, i) => `<label>${label}<input type="number" data-handle="${i}" aria-label="베지어 ${label}" min="0" max="1" step="0.01"></label>`).join('')}</div>
            </div>
            <div class="et-key-detail"><label>키 시간<input id="ET_KEY_TIME" aria-label="선택한 키프레임 시간" type="number" min="0" step="0.033333"></label><label>값<input id="ET_KEY_VALUE" aria-label="선택한 키프레임 값" type="number" step="any"></label><button type="button" data-action="delete" id="ET_DELETE" aria-label="선택한 키프레임 삭제">삭제</button></div>
            <p id="ET_CURVE_HINT" class="et-help"></p>
          </section>
        </div>
        <footer class="et-footer"><span id="ET_STATUS" role="status" aria-live="polite">카메라만 애니메이션합니다. 프로젝트는 JSON으로 저장하세요.</span><span>CAMERA EDITOR · 로컬 프로젝트</span></footer>
        <dialog id="ET_CONFIRM" aria-labelledby="ET_CONFIRM_TITLE" aria-describedby="ET_CONFIRM_MESSAGE"><form method="dialog"><strong id="ET_CONFIRM_TITLE">타임라인 변경 확인</strong><p id="ET_CONFIRM_MESSAGE"></p><div><button type="submit" value="cancel" id="ET_CONFIRM_CANCEL">취소</button><button type="submit" value="confirm" class="et-primary">확인</button></div></form></dialog>`;
    }

    setAvailable(available) {
      this.available = available;
      this.button.hidden = !available;
      if (!available) this.close(false);
    }

    open() {
      if (!this.available) return;
      const camera = this.getProvider()?.getEarthCamera();
      if (!camera) {
        window.alert('3D 카메라가 아직 준비되지 않았습니다. 지도가 표시된 후 다시 눌러 주세요.');
        return;
      }
      this.getProvider().stopEarthAnimation();
      this.pose = C.normalizeCamera(camera);
      if (!this.project) {
        this.project = C.createProject(this.pose);
        this.activeChannels().forEach(item => C.upsert(this.project, item.key, 0, this.pose[item.key]));
        this.selectedTime = 0;
      }
      this.opened = true;
      this.root.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      document.body.classList.add('earth-timeline-open');
      this.unsubscribe = this.getProvider().subscribeEarthCamera(snapshot => {
        if (!snapshot || !this.opened) return;
        const derivedGroup = this.project.mode === 'orbit' ? 'camera' : 'pivot';
        for (const field of C.CHANNELS.filter(item => item.group === derivedGroup)) this.pose[field.key] = snapshot[field.key];
        if (this.acceptCameraUpdates && !this.playing && performance.now() >= this.appliedUntil) this.pose = C.normalizeCamera(snapshot);
        if (this.cameraFrame === null) this.cameraFrame = requestAnimationFrame(() => {
          this.cameraFrame = null;
          if (this.opened) this.updateFields();
        });
      });
      this.render();
      this.seek(this.time);
      this.$('ET_PLAY').focus();
    }

    close(returnFocus = true) {
      this.pause();
      this.cancelConfirmation?.();
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.cameraFrame !== null) cancelAnimationFrame(this.cameraFrame);
      this.cameraFrame = null;
      this.drag = null;
      this.opened = false;
      this.root.hidden = true;
      this.button.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('earth-timeline-open');
      if (returnFocus && this.available) this.button.focus();
    }

    remember() {
      this.undoStack.push(C.copy(this.project));
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
    }

    restore(redo) {
      this.pause();
      const source = redo ? this.redoStack : this.undoStack;
      if (!source.length) return;
      (redo ? this.undoStack : this.redoStack).push(C.copy(this.project));
      this.project = source.pop();
      this.time = Math.min(this.time, this.project.duration);
      if (!this.activeChannels().some(item => item.key === this.channel)) this.channel = 'heading';
      this.selectedTime = null;
      this.render();
      this.seek(this.time);
    }

    apply(camera) {
      this.pose = C.normalizeCamera(camera);
      this.acceptCameraUpdates = false;
      this.appliedUntil = performance.now() + 160;
      try {
        if (this.getProvider()?.setEarthCamera(this.pose, this.project.mode) === false) {
          this.pause();
          this.setStatus('3D 카메라에 연결할 수 없습니다. 어스_G를 다시 선택해 주세요.');
        }
      } catch {
        this.pause();
        this.setStatus('이 카메라 값을 적용할 수 없습니다. 위치와 고도를 확인해 주세요.');
      }
    }

    seek(time, playing = false) {
      if (!playing) { this.pause(); this.getProvider()?.stopEarthAnimation(); }
      this.time = C.snap(time, this.project.fps, this.project.duration);
      this.apply(C.evaluate(this.project, this.time));
      this.updatePlayhead();
      this.updateFields();
    }

    pause() {
      this.playing = false;
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      const button = this.$('ET_PLAY');
      button.textContent = '▶ 재생';
      button.setAttribute('aria-label', '애니메이션 재생');
    }

    play() {
      if (this.playing) { this.pause(); return; }
      if (!this.opened || !this.available) return;
      if (this.time >= this.project.duration) this.seek(0);
      this.getProvider()?.stopEarthAnimation();
      this.playing = true;
      this.$('ET_PLAY').textContent = 'Ⅱ 정지';
      this.$('ET_PLAY').setAttribute('aria-label', '애니메이션 일시정지');
      const start = performance.now() - this.time * 1000;
      let previous = -1;
      const tick = now => {
        this.frame = null;
        if (!this.playing || !this.opened || !this.available) return;
        let time = (now - start) / 1000;
        if (time >= this.project.duration) {
          if (this.$('ET_LOOP').checked) time %= this.project.duration;
          else { this.seek(this.project.duration, true); this.pause(); return; }
        }
        const frame = Math.floor(time * this.project.fps);
        if (frame !== previous) { previous = frame; this.seek(frame / this.project.fps, true); }
        if (this.playing) this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    capture(key) {
      this.pause();
      const channels = key ? [C.channel(key)] : this.activeChannels();
      // Build atomically: exceeding the key budget must not leave half a pose.
      const next = C.copy(this.project);
      try { channels.forEach(item => C.upsert(next, item.key, this.time, this.pose[item.key])); }
      catch (error) { this.setStatus(error.message); return; }
      this.remember();
      this.project = next;
      if (key) this.channel = key;
      this.selectedTime = this.time;
      this.render();
      this.setStatus(`${number(this.time, 3)}초에 ${channels.length}개 채널의 키프레임을 저장했습니다.`);
    }

    deleteKey() {
      if (!this.selected()) return;
      this.pause();
      this.remember();
      this.project.tracks[this.channel] = this.project.tracks[this.channel].filter(key => key !== this.selected());
      this.selectedTime = null;
      this.render();
      this.seek(this.time);
    }

    render() {
      const p = this.project;
      this.root.dataset.mode = p.mode;
      this.$('ET_MODE').value = p.mode;
      this.$('ET_DURATION').value = p.duration;
      this.$('ET_FPS').value = p.fps;
      this.$('ET_SCRUB').max = this.$('ET_TIME').max = p.duration;
      this.$('ET_SCRUB').step = this.$('ET_TIME').step = 1 / p.fps;
      this.$('ET_UNDO').disabled = !this.undoStack.length;
      this.$('ET_REDO').disabled = !this.redoStack.length;
      const active = new Set(this.activeChannels().map(item => item.key));
      this.$('ET_FIELDS').innerHTML = Object.entries(groups).map(([group, title]) => `<fieldset><legend>${title}</legend>${C.CHANNELS.filter(item => item.group === group).map(item => `<div class="et-field ${active.has(item.key) ? '' : 'et-derived'}"><label for="ET_FIELD_${item.key}">${esc(item.label)}</label><input id="ET_FIELD_${item.key}" data-channel="${item.key}" type="number" min="${item.min}" max="${item.max}" step="${item.step}" ${active.has(item.key) ? '' : 'readonly'}><span>${item.unit}</span>${active.has(item.key) ? `<button type="button" data-add="${item.key}" aria-label="${esc(item.label)} 키프레임 추가" title="이 채널 키프레임 추가">◆</button>` : '<span title="다른 카메라 값에서 자동 계산">↔</span>'}</div>`).join('')}</fieldset>`).join('');
      this.$('ET_CHANNEL').innerHTML = this.activeChannels().map(item => `<option value="${item.key}">${esc(item.label)}</option>`).join('');
      this.$('ET_CHANNEL').value = this.channel;
      this.renderTracks();
      this.renderGraph();
      this.updateFields();
      this.updatePlayhead();
    }

    updateFields() {
      if (!this.pose) return;
      for (const item of C.CHANNELS) {
        const input = this.$('ET_FIELD_' + item.key);
        if (input && document.activeElement !== input) input.value = number(this.pose[item.key], item.unit === 'm' ? 1 : 5);
      }
    }

    updatePlayhead() {
      const frames = Math.round(this.time * this.project.fps);
      this.$('ET_TIMECODE').textContent = [Math.floor(frames / this.project.fps / 60), Math.floor(frames / this.project.fps) % 60, frames % this.project.fps].map(n => String(n).padStart(2, '0')).join(':');
      this.$('ET_SCRUB').value = this.time;
      if (document.activeElement !== this.$('ET_TIME')) this.$('ET_TIME').value = number(this.time, 3);
      const x = this.trackX(this.time);
      this.$('ET_PLAYHEAD')?.setAttribute('transform', `translate(${x} 0)`);
    }

    trackX(time) { return 130 + time / this.project.duration * 568; }
    trackTime(x) { return C.snap((x - 130) / 568 * this.project.duration, this.project.fps, this.project.duration); }

    renderTracks() {
      const tracks = this.activeChannels();
      let svg = '<rect width="720" height="274" fill="#161820"/>';
      for (let i = 0; i <= 5; i++) {
        const x = this.trackX(this.project.duration * i / 5);
        svg += `<line x1="${x}" y1="26" x2="${x}" y2="274" stroke="#30333f"/><text x="${x}" y="17" text-anchor="middle" class="et-svg-time">${number(this.project.duration * i / 5, 2)}s</text>`;
      }
      tracks.forEach((item, i) => {
        const y = 43 + i * 29;
        svg += `<rect x="0" y="${y - 13}" width="720" height="27" fill="${item.key === this.channel ? '#28213e' : i % 2 ? '#1b1d26' : '#161820'}" data-track="${item.key}"/>
          <text x="10" y="${y + 4}" class="et-svg-label" data-track="${item.key}">${esc(item.label)}</text><line x1="130" y1="${y}" x2="698" y2="${y}" stroke="#373442"/>`;
        this.project.tracks[item.key].forEach(key => {
          const selected = item.key === this.channel && this.selectedTime !== null && Math.abs(key.time - this.selectedTime) < 0.5 / this.project.fps;
          svg += `<path d="M0,-6 L6,0 L0,6 L-6,0 Z" transform="translate(${this.trackX(key.time)} ${y})" fill="${selected ? '#e4c4ff' : '#a78bfa'}" stroke="${selected ? '#ffffff' : '#a78bfa'}" data-key="${item.key}" data-time="${key.time}" tabindex="0" role="button" aria-label="${esc(item.label)} ${number(key.time, 3)}초 키프레임"/>`;
        });
      });
      svg += '<g id="ET_PLAYHEAD" pointer-events="none"><line x1="0" y1="25" x2="0" y2="274" stroke="#60dfd4" stroke-width="1.5"/><path d="M-5,20 H5 V27 L0,32 L-5,27 Z" fill="#60dfd4"/></g>';
      this.$('ET_TRACKS').innerHTML = svg;
      this.updatePlayhead();
    }

    renderGraph() {
      const key = this.selected();
      const track = this.project.tracks[this.channel];
      const next = key && track[track.indexOf(key) + 1];
      const usable = !!next;
      const curve = key?.easing || C.PRESETS.smooth;
      const definition = C.channel(this.channel);
      const X = x => 32 + 218 * x, Y = y => 116 - 94 * y;
      let svg = '<rect width="280" height="146" fill="#161820"/>';
      for (let i = 0; i <= 4; i++) svg += `<path d="M${X(i / 4)},22 V116 M32,${Y(i / 4)} H250" fill="none" stroke="#30333f"/>`;
      if (this.graphMode === 'values') {
        const values = track.map(item => item.value);
        const min = values.length ? Math.min(...values) : this.project.base[this.channel];
        const max = values.length ? Math.max(...values) : min;
        const pad = Math.max((max - min) * 0.1, definition.unit === 'm' ? 1 : 0.01);
        const valueY = value => Y((value - min + pad) / (max - min + 2 * pad));
        let path = '';
        for (let i = 0; i <= 160; i++) {
          const value = C.evaluateTrack(track, i / 160 * this.project.duration, this.project.base[this.channel], this.channel);
          path += `${i ? 'L' : 'M'}${X(i / 160)},${C.clamp(valueY(value), 22, 116)} `;
        }
        svg += `<path d="${path}" stroke="#b79aff" stroke-width="2" fill="none"/>`;
        for (const frame of track) svg += `<circle cx="${X(frame.time / this.project.duration)}" cy="${valueY(frame.value)}" r="4" fill="${frame === key ? '#60dfd4' : '#dfcbff'}" data-key="${this.channel}" data-time="${frame.time}" role="button" tabindex="0" aria-label="${esc(definition.label)} ${number(frame.time, 3)}초 그래프 키프레임"/>`;
        svg += `<text x="32" y="13" class="et-svg-time">${number(max, 3)} ${definition.unit}</text><text x="32" y="135" class="et-svg-time">${number(min, 3)} ${definition.unit}</text><text x="250" y="135" text-anchor="end" class="et-svg-time">${this.project.duration}s</text>`;
      } else {
        svg += `<path d="M32,116 L${X(curve[0])},${Y(curve[1])} M250,22 L${X(curve[2])},${Y(curve[3])}" stroke="#716286" fill="none"/>
          <path d="M32,116 C${X(curve[0])},${Y(curve[1])} ${X(curve[2])},${Y(curve[3])} 250,22" fill="none" stroke="${usable ? '#bb9aff' : '#626270'}" stroke-width="2.5"/>
          <text x="32" y="135" class="et-svg-time">0</text><text x="250" y="135" text-anchor="end" class="et-svg-time">1 · 시간 →</text><text x="32" y="13" class="et-svg-time">변화량 ↑</text>`;
        if (usable) [0, 1].forEach(i => { svg += `<circle cx="${X(curve[i * 2])}" cy="${Y(curve[i * 2 + 1])}" r="6" fill="${i ? '#60dfd4' : '#cfabff'}" data-handle="${i}" role="button" tabindex="0" aria-label="베지어 핸들 ${i + 1}"/>`; });
      }
      this.$('ET_GRAPH').innerHTML = svg;
      this.$('ET_EASING_TAB').setAttribute('aria-pressed', String(this.graphMode !== 'values'));
      this.$('ET_VALUES_TAB').setAttribute('aria-pressed', String(this.graphMode === 'values'));
      this.root.querySelectorAll('input[data-handle]').forEach((input, i) => { input.value = number(curve[i], 3); input.disabled = !usable; });
      this.$('ET_PRESET').disabled = !usable;
      this.$('ET_PRESET').value = Object.keys(C.PRESETS).find(name => C.PRESETS[name].every((value, i) => Math.abs(value - curve[i]) < 0.001)) || 'custom';
      this.$('ET_KEY_TIME').disabled = this.$('ET_KEY_VALUE').disabled = this.$('ET_DELETE').disabled = !key;
      this.$('ET_KEY_TIME').value = key ? number(key.time, 3) : '';
      this.$('ET_KEY_TIME').max = this.project.duration;
      this.$('ET_KEY_TIME').step = 1 / this.project.fps;
      this.$('ET_KEY_VALUE').value = key ? number(key.value, 5) : '';
      this.$('ET_KEY_VALUE').min = definition.min;
      this.$('ET_KEY_VALUE').max = definition.max;
      this.$('ET_KEY_VALUE').step = definition.step;
      this.$('ET_CURVE_HINT').textContent = next ? `${number(key.time, 3)} → ${number(next.time, 3)}초 구간의 속도 곡선입니다. 핸들을 드래그하세요.` : '트랙에서 키를 선택하세요. 다음 키가 있어야 구간 곡선을 편집할 수 있습니다.';
    }

    onClick(event) {
      const add = event.target.closest('[data-add]');
      if (add) { this.capture(add.dataset.add); return; }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close') this.close();
      else if (action === 'play') this.play();
      else if (action === 'back' || action === 'next') this.seek(this.time + (action === 'back' ? -1 : 1) / this.project.fps);
      else if (action === 'capture') this.capture();
      else if (action === 'delete') this.deleteKey();
      else if (action === 'undo' || action === 'redo') this.restore(action === 'redo');
      else if (action === 'easing' || action === 'values') { this.graphMode = action; this.renderGraph(); }
      else if (action === 'save') this.save();
      else if (action === 'load') { this.pause(); this.$('ET_FILE').click(); }
      else if (action === 'new') this.newProject();
    }

    onChange(event) {
      const input = event.target;
      if (input.id === 'ET_FILE') { this.load(input.files?.[0]); input.value = ''; return; }
      if (input.id === 'ET_CHANNEL') {
        this.channel = input.value;
        this.selectedTime = this.project.tracks[this.channel].find(key => key.time >= this.time)?.time ?? this.project.tracks[this.channel].at(-1)?.time ?? null;
        this.renderTracks(); this.renderGraph(); return;
      }
      if (input.id === 'ET_MODE') { this.newProject(input.value); return; }
      if (input.id === 'ET_FPS') {
        this.pause();
        const next = C.copy(this.project);
        next.fps = Number(input.value);
        next.duration = C.snap(next.duration, next.fps, 600);
        Object.values(next.tracks).forEach(track => track.forEach(key => { key.time = C.snap(key.time, next.fps, next.duration); }));
        try { C.validateProject(next); }
        catch { input.value = this.project.fps; this.setStatus('프레임 간격이 겹칩니다. 가까운 키를 옮긴 후 FPS를 바꾸세요.'); return; }
        this.remember(); this.project = next; this.selectedTime = null;
        this.render(); this.seek(this.time); return;
      }
      if (input.id === 'ET_PRESET') {
        if (C.PRESETS[input.value] && this.selected()) {
          this.pause(); this.remember(); this.selected().easing = [...C.PRESETS[input.value]];
          this.seek(this.time); this.renderGraph(); this.historyButtons();
        }
        return;
      }
      if (input.type !== 'number') return;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value)) { this.render(); return; }
      if (input.id === 'ET_TIME') { this.seek(value); return; }
      if (input.dataset.channel) {
        const key = input.dataset.channel;
        if (!this.activeChannels().some(item => item.key === key)) return;
        this.pause(); this.getProvider()?.stopEarthAnimation();
        const definition = C.channel(key);
        const next = C.clamp(value, definition.min, definition.max);
        const existing = this.project.tracks[key].find(frame => Math.abs(frame.time - this.time) < 0.5 / this.project.fps);
        if (existing) { this.remember(); existing.value = next; this.selectedTime = existing.time; }
        this.channel = key;
        this.apply({ ...this.pose, [key]: next });
        this.render();
        this.setStatus(existing ? '현재 키프레임 값을 수정했습니다.' : '카메라 미리보기입니다. ◆ 키프레임 추가를 눌러 저장하세요.');
      } else if (input.id === 'ET_DURATION') {
        const duration = C.snap(C.clamp(value, 1, 600), this.project.fps, 600);
        if (Object.values(this.project.tracks).some(track => track.some(key => key.time > duration))) {
          this.setStatus('마지막 키프레임보다 짧게 줄일 수 없습니다. 뒤쪽 키를 먼저 이동하거나 삭제하세요.');
          input.value = this.project.duration; return;
        }
        this.pause(); this.remember(); this.project.duration = duration;
        this.render(); this.seek(Math.min(this.time, duration));
      } else if (input.dataset.handle !== undefined && this.selected()) {
        this.pause(); this.remember(); this.selected().easing[Number(input.dataset.handle)] = C.clamp(value, 0, 1);
        this.seek(this.time); this.renderGraph(); this.historyButtons();
      } else if ((input.id === 'ET_KEY_TIME' || input.id === 'ET_KEY_VALUE') && this.selected()) {
        this.pause(); this.remember();
        const frame = C.moveKey(this.project, this.channel, this.selectedTime,
          input.id === 'ET_KEY_TIME' ? value : this.selectedTime, input.id === 'ET_KEY_VALUE' ? value : undefined);
        this.selectedTime = frame.time;
        this.render(); this.seek(frame.time);
      }
    }

    historyButtons() {
      this.$('ET_UNDO').disabled = !this.undoStack.length;
      this.$('ET_REDO').disabled = !this.redoStack.length;
    }

    confirmAction(message) {
      if (this.cancelConfirmation) return Promise.resolve(false);
      const dialog = this.$('ET_CONFIRM');
      this.$('ET_CONFIRM_MESSAGE').textContent = message;
      dialog.returnValue = 'cancel';
      return new Promise(resolve => {
        this.cancelConfirmation = () => dialog.close('cancel');
        dialog.addEventListener('close', () => {
          this.cancelConfirmation = null;
          resolve(dialog.returnValue === 'confirm');
        }, { once: true });
        dialog.showModal();
        this.$('ET_CONFIRM_CANCEL').focus();
      });
    }

    async newProject(mode = this.project.mode) {
      this.pause();
      if (!await this.confirmAction('현재 타임라인을 새로 만듭니다. 필요한 프로젝트는 먼저 저장해 주세요. 계속할까요?')) { this.render(); return; }
      this.remember();
      this.project = C.createProject(this.getProvider()?.getEarthCamera() || this.pose, mode);
      this.pose = C.copy(this.project.base);
      this.activeChannels().forEach(item => C.upsert(this.project, item.key, 0, this.pose[item.key]));
      this.time = 0; this.selectedTime = 0; this.channel = 'heading';
      this.setStatus('현재 카메라를 시작 키프레임으로 만들었습니다.');
      this.render();
    }

    point(event, svg) {
      const matrix = svg.getScreenCTM();
      return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
    }

    pointerDown(event, svg) {
      if (event.button !== 0) return;
      const target = event.target.closest('[data-key],[data-track],[data-handle]');
      this.pause();
      if (target?.dataset.key) {
        this.channel = target.dataset.key;
        this.selectedTime = Number(target.dataset.time);
        this.seek(this.selectedTime);
        this.drag = { type: svg.id === 'ET_TRACKS' ? 'key' : 'selection', startX: event.clientX, remembered: false };
      } else if (target?.dataset.handle !== undefined && this.selected()) {
        this.drag = { type: 'handle', handle: Number(target.dataset.handle), remembered: false };
      } else if (svg.id === 'ET_TRACKS') {
        if (target?.dataset.track) this.channel = target.dataset.track;
        this.selectedTime = null;
        this.seek(this.trackTime(this.point(event, svg).x));
        this.drag = { type: 'scrub' };
      } else return;
      event.preventDefault();
      svg.setPointerCapture(event.pointerId);
      this.$('ET_CHANNEL').value = this.channel;
      this.renderTracks(); this.renderGraph();
    }

    pointerMove(event, svg) {
      if (!this.drag || !svg.hasPointerCapture(event.pointerId)) return;
      const point = this.point(event, svg);
      if (this.drag.type === 'scrub') { this.seek(this.trackTime(point.x)); return; }
      if (this.drag.type === 'selection') return;
      if (this.drag.type === 'key' && Math.abs(event.clientX - this.drag.startX) < 3) return;
      if (!this.drag.remembered) { this.remember(); this.drag.remembered = true; }
      if (this.drag.type === 'key') {
        const frame = C.moveKey(this.project, this.channel, this.selectedTime, this.trackTime(point.x));
        this.selectedTime = frame.time;
        this.seek(frame.time);
        this.renderTracks();
      } else {
        const key = this.selected();
        if (!key) return;
        key.easing[this.drag.handle * 2] = C.clamp((point.x - 32) / 218, 0, 1);
        key.easing[this.drag.handle * 2 + 1] = C.clamp((116 - point.y) / 94, 0, 1);
        this.seek(this.time);
      }
      this.renderGraph(); this.historyButtons();
    }

    onKey(event) {
      if (this.$('ET_CONFIRM')?.open) return;
      if (event.key === 'Enter' && event.target.type === 'number') {
        event.preventDefault(); event.target.blur(); return;
      }
      if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
      if (event.key === 'Escape') { this.close(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); this.restore(event.shiftKey); return;
      }
      const target = event.target.closest('[data-key],[data-handle]');
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (target?.dataset.key) { this.channel = target.dataset.key; this.selectedTime = Number(target.dataset.time); }
        event.preventDefault(); this.deleteKey(); return;
      }
      if (target?.dataset.key) {
        this.channel = target.dataset.key; this.selectedTime = Number(target.dataset.time);
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); this.seek(this.selectedTime); this.renderTracks(); this.renderGraph();
        } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); this.remember();
          const frame = C.moveKey(this.project, this.channel, this.selectedTime, this.selectedTime + (event.key === 'ArrowLeft' ? -1 : 1) / this.project.fps);
          this.selectedTime = frame.time; this.seek(frame.time); this.renderTracks(); this.renderGraph(); this.historyButtons();
          this.$('ET_TRACKS').querySelector(`[data-key="${this.channel}"][data-time="${frame.time}"]`)?.focus();
        }
      } else if (target?.dataset.handle !== undefined && /^Arrow/.test(event.key) && this.selected()) {
        event.preventDefault(); this.pause(); this.remember();
        const handle = Number(target.dataset.handle);
        const index = handle * 2 + (['ArrowUp', 'ArrowDown'].includes(event.key) ? 1 : 0);
        const sign = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
        this.selected().easing[index] = C.clamp(this.selected().easing[index] + sign * 0.01, 0, 1);
        this.seek(this.time); this.renderGraph(); this.historyButtons();
        this.$('ET_GRAPH').querySelector(`[data-handle="${handle}"]`)?.focus();
      } else if (event.key === ' ' && event.target.tagName !== 'BUTTON') { event.preventDefault(); this.play(); }
    }

    save() {
      const blob = new Blob([JSON.stringify(this.project, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'GraphicRoad-earth-timeline.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.setStatus('프로젝트 JSON을 저장했습니다. API 키나 인증 정보는 포함하지 않습니다.');
    }

    async load(file) {
      if (!file) return;
      if (file.size > 1024 * 1024) { this.setStatus('프로젝트 파일은 1MB 이하여야 합니다.'); return; }
      let project;
      try { project = C.validateProject(JSON.parse(await file.text())); }
      catch { this.setStatus('올바른 타임라인 JSON이 아닙니다. 기존 프로젝트는 유지됩니다.'); return; }
      if (!this.opened || !this.available) return;
      if (!await this.confirmAction('현재 타임라인을 불러온 프로젝트로 바꿀까요? 저장하지 않은 변경은 사라집니다.')) return;
      this.pause(); this.remember(); this.project = project;
      this.time = 0; this.channel = 'heading'; this.selectedTime = project.tracks.heading[0]?.time ?? null;
      this.render();
      if (this.opened && this.available) this.seek(0);
      this.setStatus('프로젝트를 불러왔습니다. 재생 버튼으로 카메라 움직임을 확인하세요.');
    }
  }

  window.GraphicRoadEarthTimeline = Object.freeze({ Controller });
})();
