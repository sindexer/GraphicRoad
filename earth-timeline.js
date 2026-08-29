/* A local camera editor on the existing Map3DElement, not an Earth Studio embed. */
(() => {
  'use strict';
  const C = window.GraphicRoadTimelineCore;
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = (value, digits = 4) => Number(value.toFixed(digits)).toString();
  const fitRenderViewport = (availableWidth, availableHeight, outputWidth, outputHeight) => {
    const targetRatio = outputWidth / outputHeight;
    const availableRatio = availableWidth / availableHeight;
    const width = availableRatio > targetRatio ? availableHeight * targetRatio : availableWidth;
    const height = availableRatio > targetRatio ? availableHeight : availableWidth / targetRatio;
    return {
      left: (availableWidth - width) / 2,
      top: (availableHeight - height) / 2,
      width,
      height
    };
  };


  class Controller {
    constructor({ button, root, getProvider }) {
      this.button = button;
      this.root = root;
      this.getProvider = getProvider;
      this.available = false;
      this.opened = false;
      this.playing = false;
      this.time = 0;
      this.zoom = 1;
      this.viewStart = 0;
      this.channel = 'heading';
      this.selectedTime = null;
      this.selection = [];
      this.undoStack = [];
      this.redoStack = [];
      this.project = null;
      this.frame = null;
      this.cameraFrame = null;
      this.scrubFrame = null;
      this.scrubPose = null;
      this.appliedUntil = 0;
      this.acceptCameraUpdates = false;
      this.renderDestination = null;
      this.renderAbort = null;
      this.renderStream = null;
      this.folded = false;
      this.timelineHeight = null;
      this.build();
      root.tabIndex = 0;
      this.resizeObserver = new ResizeObserver(() => { if (this.opened) this.renderTracks(); });
      this.resizeObserver.observe(this.$('ET_TRACKS'));
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
        if (event.target.type === 'number') event.target.dataset.pendingEdit = 'true';
      });
      root.addEventListener('keydown', event => this.onKey(event));
      document.addEventListener('keydown', event => this.onGlobalKey(event));
      const resizeHandle = this.$('ET_RESIZE_HANDLE');
      resizeHandle.addEventListener('pointerdown', event => this.startResize(event));
      resizeHandle.addEventListener('keydown', event => this.resizeWithKeyboard(event));
      resizeHandle.addEventListener('dblclick', () => this.applyTimelineHeight(Math.min(294, window.innerHeight * .4)));
      document.addEventListener('pointermove', event => this.moveResize(event));
      document.addEventListener('pointerup', event => this.endResize(event));
      document.addEventListener('pointercancel', event => this.endResize(event));
      this.$('ET_TRACKS').addEventListener('wheel', event => {
        if (!this.project || (!event.shiftKey && !event.deltaX)) return;
        event.preventDefault();
        this.viewStart = C.clamp(this.viewStart + (event.deltaX || event.deltaY) / 500 * this.project.duration / this.zoom, 0, this.project.duration - this.project.duration / this.zoom);
        this.renderTracks();
      }, {passive:false});
      for (const svg of [this.$('ET_TRACKS'), this.$('ET_GRAPH')]) {
        svg.addEventListener('pointerdown', event => this.pointerDown(event, svg));
        document.addEventListener('pointermove', event => { if (this.drag?.svg === svg) this.pointerMove(event, svg); });
        const finish = () => { if (this.drag?.type === 'scrub') this.flushScrub(); this.drag = null; this.$('ET_MARQUEE')?.remove(); };
        svg.addEventListener('pointerup', finish);
        svg.addEventListener('pointercancel', finish);
        svg.addEventListener('lostpointercapture', finish);
        document.addEventListener('pointerup', event => { if (this.drag?.svg === svg && this.drag.pointerId === event.pointerId) finish(); });
        document.addEventListener('pointercancel', event => { if (this.drag?.svg === svg && this.drag.pointerId === event.pointerId) finish(); });
      }
      // Manual map navigation, switching tabs, hiding UI, or closing the panel
      // must never leave a background animation competing with the user.
      for (const event of ['pointerdown', 'wheel', 'keydown']) {
        document.getElementById('googleMap')?.addEventListener(event, () => this.pauseForNavigation(), { capture: true, passive: true });
      }
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
      window.addEventListener('blur', () => { this.drag = null; this.resizeDrag = null; this.root.classList.remove('et-resizing'); this.$('ET_MARQUEE')?.remove(); });
    }

    $(id) { return this.root.querySelector('#' + id); }
    activeChannels() { return C.channelsForMode(this.project.mode); }
    selected() { return this.selectedTime === null ? null : this.project?.tracks[this.channel].find(key => Math.abs(key.time - this.selectedTime) < 0.5 / this.project.fps); }
    selectedEntries() {
      const entries = this.selection?.length ? this.selection : this.selected() ? [{channel:this.channel,time:this.selectedTime}] : [];
      return entries.filter(s => this.project.tracks[s.channel]?.some(f => Math.abs(f.time-s.time) < .5/this.project.fps));
    }
    updateSelectionUI() {
      const count = this.selectedEntries().length;
      this.$('ET_SELECTION_COUNT').textContent = `${count}개 선택`;
      this.root.querySelectorAll('[data-ease]').forEach(button => { button.disabled = !count; });
      this.root.querySelectorAll('#ET_TRACKS [data-key]').forEach(node => node.setAttribute('aria-pressed', String(this.selectedEntries().some(s => s.channel === node.dataset.key && s.time === Number(node.dataset.time)))));
    }
    applyEase(kind) {
      const entries = this.selectedEntries();
      if (!entries.length || !['both','in','out'].includes(kind)) return;
      this.pause(); this.remember(); C.easeKeys(this.project, entries, kind);
      this.seek(this.time); this.renderTracks(); this.renderGraph(); this.historyButtons();
      this.setStatus(`${entries.length}개 키에 ${kind === 'both' ? 'Easy Ease' : kind === 'in' ? 'Ease In (도착 감속)' : 'Ease Out (출발 가속)'} 적용`);
    }
    pauseForNavigation() { this.pause(); this.appliedUntil = 0; this.acceptCameraUpdates = true; }
    setStatus(message) { this.$('ET_STATUS').textContent = message; }

    build() {
      this.root.innerHTML = `
        <div id="ET_RESIZE_HANDLE" class="et-resize-handle" role="separator" aria-label="타임라인 높이 조절" aria-orientation="horizontal" aria-valuemin="180" tabindex="0"><span aria-hidden="true"></span></div>
        <header class="et-header">
          <div class="et-header-left"><div class="et-title"><span class="et-orbit">▤</span><strong>타임라인 <span>· Earth Camera</span></strong></div><select id="ET_MODE" aria-label="카메라 좌표 기준"><option value="orbit">피벗 기준 회전</option><option value="camera">카메라 위치 이동</option></select></div>
          <div class="et-transport">
            <div class="et-ease-buttons"><span id="ET_SELECTION_COUNT" role="status">0개 선택</span><button type="button" data-action="capture" class="et-key-button">◆ 키프레임 추가</button><button type="button" data-ease="both"><svg class="et-ease-icon" viewBox="-8 -7 16 14" aria-hidden="true"><path d="${this.keyShape('both')}"/></svg>Easy Ease</button><button type="button" data-ease="in"><svg class="et-ease-icon" viewBox="-8 -7 16 14" aria-hidden="true"><path d="${this.keyShape('in')}"/></svg>Ease In</button><button type="button" data-ease="out"><svg class="et-ease-icon" viewBox="-8 -7 16 14" aria-hidden="true"><path d="${this.keyShape('out')}"/></svg>Ease Out</button></div>
            <button type="button" data-action="back" title="이전 프레임 (F)" aria-label="이전 프레임">‹</button>
            <button type="button" data-action="play" id="ET_PLAY" class="et-primary" aria-label="애니메이션 재생">▶ 재생</button>
            <button type="button" data-action="next" title="다음 프레임 (G)" aria-label="다음 프레임">›</button>
            <output id="ET_TIMECODE" aria-label="현재 타임코드">00:00:00</output>
            <label class="et-check"><input id="ET_LOOP" type="checkbox">반복</label>
          </div>
          <div class="et-actions">
            <div class="et-settings"><label>확대 <select id="ET_ZOOM" aria-label="타임라인 확대"><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select></label><label>길이 <input id="ET_DURATION" aria-label="타임라인 길이 초" type="number" min="1" max="600" step="1" value="10">초</label><select id="ET_FPS" aria-label="타임라인 FPS"><option>24</option><option>25</option><option selected>30</option><option>60</option></select><span>FPS</span></div>
            <button type="button" data-action="graph-toggle" id="ET_GRAPH_TOGGLE" aria-pressed="false">그래프 편집기</button>
            <button type="button" data-action="undo" id="ET_UNDO" aria-label="실행 취소" title="실행 취소 (Ctrl+Z)">↶ UNDO</button>
            <button type="button" data-action="redo" id="ET_REDO" aria-label="다시 실행" title="다시 실행 (Ctrl+Shift+Z 또는 Ctrl+Y)">↷ REDO</button>
            <button type="button" data-action="render-open">렌더</button>
            <button type="button" data-action="fold" id="ET_FOLD" class="et-fold" aria-label="타임라인 접기" aria-expanded="true" title="타임라인 접기">⌄</button>
          </div>
        </header>
        <div class="et-body">
          <section class="et-workspace" aria-label="카메라 속성과 키프레임">
            <div class="et-aligned-scroll">
              <div class="et-aligned-tracks">
                <section class="et-property-list" aria-label="카메라 속성"><div class="et-property-heading">카메라 속성 <span>값 · 키프레임</span></div><div id="ET_FIELDS"></div></section>
                <svg id="ET_TRACKS" viewBox="0 0 720 274" preserveAspectRatio="none" role="group" aria-label="카메라 키프레임 트랙"></svg>
              </div>
            </div>
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
        <footer class="et-footer"><span id="ET_STATUS" role="status" aria-live="polite">박스 선택 · Shift: 추가 선택 · F/G: 이전/다음 프레임 · Space: 재생/정지</span><span>CAMERA EDITOR · 로컬 프로젝트</span></footer>
        <dialog id="ET_CONFIRM" aria-labelledby="ET_CONFIRM_TITLE" aria-describedby="ET_CONFIRM_MESSAGE"><form method="dialog"><strong id="ET_CONFIRM_TITLE">타임라인 변경 확인</strong><p id="ET_CONFIRM_MESSAGE"></p><div><button type="submit" value="cancel" id="ET_CONFIRM_CANCEL">취소</button><button type="submit" value="confirm" class="et-primary">확인</button></div></form></dialog>
        <dialog id="ET_RENDER" class="et-render-dialog" aria-labelledby="ET_RENDER_TITLE">
          <form method="dialog">
            <header><div><strong id="ET_RENDER_TITLE">렌더링</strong><p>Earth Camera 타임라인 출력</p></div><button type="button" data-action="render-close" aria-label="렌더링 창 닫기">✕</button></header>
            <div class="et-render-scroll">
              <div class="et-render-top"><label>이름<input id="ET_RENDER_NAME" type="text" value="GraphicRoad" maxlength="80"></label><label>위치<span class="et-destination"><button type="button" data-action="render-location">📁 위치 선택</button><output id="ET_RENDER_LOCATION">선택 안 됨</output></span></label></div>
              <fieldset class="et-format"><legend>형식</legend><label><input type="radio" name="ET_RENDER_FORMAT" value="jpeg" checked><span>◉</span><strong>이미지 시퀀스 (JPEG)</strong><small>선택한 폴더에 프레임별 저장</small></label><label><input type="radio" name="ET_RENDER_FORMAT" value="mp4"><span>◉</span><strong>동영상 (MP4)</strong><small>브라우저 지원 시 H.264/MP4 저장</small></label></fieldset>
              <div class="et-render-grid"><label>프레임<span><input id="ET_RENDER_START" type="number" min="0" step="1" value="0"> ~ <input id="ET_RENDER_END" type="number" min="0" step="1" value="300"></span></label><label>크기<span><input id="ET_RENDER_WIDTH" type="number" min="320" max="7680" step="2" value="1920"> × <input id="ET_RENDER_HEIGHT" type="number" min="180" max="4320" step="2" value="1080"></span></label><label>저작자 표시 위치<select disabled><option>오른쪽 하단 (지도 원본 고정)</option></select></label><label>JPEG 품질<select id="ET_RENDER_QUALITY"><option value="0.8">보통</option><option value="0.92" selected>높음</option><option value="1">최고</option></select></label></div>
              <details class="et-render-advanced"><summary>고급</summary><div><label>3D 추적 데이터<select disabled><option>없음</option></select></label><label>좌표 공간<select disabled><option>전체</option></select></label><label>지도 스타일<select disabled><option>현재 지도 스타일</option></select></label><label>프레임 속도<output id="ET_RENDER_FPS">30 FPS</output></label></div></details>
              <p class="et-render-note">Google 지도 저작권 표시는 원본 위치에 포함됩니다. 브라우저 보안상 첫 렌더에서는 <strong>현재 탭</strong> 공유를 한 번 선택해야 하며, 공유가 유지되는 동안 다음 렌더부터는 바로 시작합니다.</p>
              <div id="ET_RENDER_PROGRESS_WRAP" class="et-render-progress" hidden><progress id="ET_RENDER_PROGRESS" max="1" value="0"></progress><output id="ET_RENDER_PROGRESS_TEXT">준비 중</output></div>
              <p id="ET_RENDER_ERROR" class="et-render-error" role="alert"></p>
            </div>
            <footer><button type="button" data-action="render-close">취소</button><button type="button" data-action="render-start" class="et-render-start">시작</button></footer>
          </form>
        </dialog>`;
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
      this.setFolded(this.folded);
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
      if (this.$('ET_RENDER')?.open) this.$('ET_RENDER').close();
      this.renderAbort?.abort();
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.cameraFrame !== null) cancelAnimationFrame(this.cameraFrame);
      this.cameraFrame = null;
      if (this.scrubFrame !== null) cancelAnimationFrame(this.scrubFrame);
      this.scrubFrame = null; this.scrubPose = null;
      this.drag = null;
      this.resizeDrag = null;
      this.root.classList?.remove('et-resizing');
      this.opened = false;
      this.root.hidden = true;
      this.button.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('earth-timeline-open', 'earth-timeline-folded');
      if (returnFocus && this.available) this.button.focus();
    }

    setFolded(folded) {
      this.folded = Boolean(folded);
      this.root.classList.toggle('et-folded', this.folded);
      document.body.classList.toggle('earth-timeline-folded', this.opened && this.folded);
      const button = this.$('ET_FOLD');
      if (button) {
        button.textContent = this.folded ? '⌃' : '⌄';
        button.setAttribute('aria-expanded', String(!this.folded));
        button.setAttribute('aria-label', this.folded ? '타임라인 펼치기' : '타임라인 접기');
        button.title = this.folded ? '타임라인 펼치기' : '타임라인 접기';
      }
      if (this.folded) this.pause();
      else if (this.opened) requestAnimationFrame(() => { this.renderTracks(); this.renderGraph(); });
    }

    applyTimelineHeight(height) {
      const maximum = Math.max(180, Math.floor(window.innerHeight * .7));
      this.timelineHeight = Math.max(180, Math.min(maximum, Math.round(height)));
      document.documentElement.style.setProperty('--earth-timeline-height', `${this.timelineHeight}px`);
      this.$('ET_RESIZE_HANDLE')?.setAttribute('aria-valuenow', String(this.timelineHeight));
    }

    startResize(event) {
      if (this.folded || event.button !== 0) return;
      event.preventDefault();
      this.resizeDrag = { pointerId: event.pointerId, startY: event.clientY, startHeight: this.root.getBoundingClientRect().height };
      this.root.classList.add('et-resizing');
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    moveResize(event) {
      if (!this.resizeDrag || event.pointerId !== this.resizeDrag.pointerId) return;
      event.preventDefault();
      this.applyTimelineHeight(this.resizeDrag.startHeight + this.resizeDrag.startY - event.clientY);
    }

    endResize(event) {
      if (!this.resizeDrag || event.pointerId !== this.resizeDrag.pointerId) return;
      this.resizeDrag = null;
      this.root.classList.remove('et-resizing');
      this.renderTracks();
    }

    resizeWithKeyboard(event) {
      if (this.folded || !['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault();
      const current = this.root.getBoundingClientRect().height;
      this.applyTimelineHeight(event.key === 'Home' ? Math.min(294, window.innerHeight * .4) : current + (event.key === 'ArrowUp' ? 20 : -20));
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
      this.selection = [];
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

    queueScrub(time) {
      this.time = C.snap(time, this.project.fps, this.project.duration);
      this.scrubPose = C.evaluate(this.project, this.time);
      this.updatePlayhead(); this.updateFields();
      if (this.scrubFrame !== null) return;
      this.scrubFrame = requestAnimationFrame(() => {
        this.scrubFrame = null;
        const pose = this.scrubPose; this.scrubPose = null;
        if (pose) this.apply(pose);
      });
    }

    flushScrub() {
      if (this.scrubFrame !== null) cancelAnimationFrame(this.scrubFrame);
      this.scrubFrame = null;
      if (this.scrubPose) this.apply(this.scrubPose);
      this.scrubPose = null;
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
      this.selection = channels.map(item => ({channel:item.key,time:this.time}));
      this.render();
      this.setStatus(`${number(this.time, 3)}초에 ${channels.length}개 채널의 키프레임을 저장했습니다.`);
    }

    deleteKey() {
      const entries = this.selectedEntries();
      if (!entries.length) return;
      this.pause();
      this.remember();
      for (const entry of entries) this.project.tracks[entry.channel] = this.project.tracks[entry.channel].filter(f => Math.abs(f.time-entry.time) >= .5/this.project.fps);
      this.selection = [];
      this.selectedTime = null;
      this.render();
      this.seek(this.time);
    }

    render() {
      const p = this.project;
      this.viewStart = C.clamp(this.viewStart, 0, p.duration - p.duration / this.zoom);

      this.root.dataset.mode = p.mode;
      this.$('ET_MODE').value = p.mode;
      this.$('ET_DURATION').value = p.duration;
      this.$('ET_FPS').value = p.fps;
      this.$('ET_UNDO').disabled = !this.undoStack.length;
      this.$('ET_REDO').disabled = !this.redoStack.length;
      this.$('ET_FIELDS').innerHTML = this.activeChannels().map(item => `<div class="et-field" data-property="${item.key}"><label for="ET_FIELD_${item.key}">${esc(item.label)}</label><input id="ET_FIELD_${item.key}" data-channel="${item.key}" type="number" min="${item.min}" max="${item.max}" step="${item.step}"><span>${item.unit}</span><button type="button" data-add="${item.key}" aria-label="${esc(item.label)} 키프레임 추가" title="현재 시간에 키프레임 추가">◆</button></div>`).join('');
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
      const x = this.trackX(this.time);
      this.$('ET_PLAYHEAD')?.setAttribute('transform', `translate(${x} 0)`);
      this.$('ET_PLAYHEAD')?.setAttribute('visibility', x < 12 || x > (this.trackWidth || 720) - 22 ? 'hidden' : 'visible');
    }

    trackX(time) { return 12 + (time - this.viewStart) / (this.project.duration / this.zoom) * ((this.trackWidth || 720) - 34); }
    trackTime(x) { return C.snap(this.viewStart + (x - 12) / ((this.trackWidth || 720) - 34) * (this.project.duration / this.zoom), this.project.fps, this.project.duration); }

    keyEaseKind(track,index) {
      const near=(a,b)=>Math.abs(a-b)<1e-6, key=track[index], previous=track[index-1];
      if (['linear','both','in','out'].includes(key?.easeKind)) return key.easeKind;
      const easeIn=!!previous&&near(previous.easing[2],.58)&&near(previous.easing[3],1);
      const easeOut=!!key&&near(key.easing[0],.42)&&near(key.easing[1],0);
      return easeIn&&easeOut?'both':easeIn?'in':easeOut?'out':'linear';
    }
    keyShape(kind) {
      if(kind==='both') return 'M-7,-6 C-2,-6 -2,-2 0,0 C2,-2 2,-6 7,-6 L7,6 C2,6 2,2 0,0 C-2,2 -2,6 -7,6 Z';
      if(kind==='in') return 'M-7,0 L0,-6 C0,-2 2,0 7,0 C2,0 0,2 0,6 Z';
      if(kind==='out') return 'M7,0 L0,-6 C0,-2 -2,0 -7,0 C-2,0 0,2 0,6 Z';
      return 'M0,-6 L6,0 L0,6 L-6,0 Z';
    }

    renderTracks() {
      const tracks = this.activeChannels();
      const width = this.trackWidth = this.$('ET_TRACKS').clientWidth || 720;
      this.$('ET_TRACKS').setAttribute('viewBox', `0 0 ${width} 274`);
      let svg = `<rect width="${width}" height="274" fill="#161820"/>`;
      for (let i = 0; i <= 5; i++) {
        const time = this.viewStart + this.project.duration / this.zoom * i / 5;
        const x = this.trackX(time);
        svg += `<line x1="${x}" y1="26" x2="${x}" y2="274" stroke="#30333f"/><text x="${x}" y="17" text-anchor="middle" class="et-svg-time">${number(time, 2)}s</text>`;
      }
      tracks.forEach((item, i) => {
        const y = 42.5 + i * 29;
        svg += `<rect x="0" y="${y - 14.5}" width="${width}" height="29" data-selected="${item.key === this.channel}" data-track="${item.key}"/>
          <line x1="12" y1="${y}" x2="${width - 22}" y2="${y}" stroke="#373442"/>`;
        this.project.tracks[item.key].forEach((key,index) => {
          if (this.trackX(key.time) < 12 || this.trackX(key.time) > width - 22) return;
          const selected = this.selectedEntries().some(s => s.channel === item.key && Math.abs(s.time-key.time) < .5/this.project.fps);
          const easeKind=this.keyEaseKind(this.project.tracks[item.key],index);
          svg += `<path d="${this.keyShape(easeKind)}" transform="translate(${this.trackX(key.time)} ${y})" aria-pressed="${selected}" data-ease-kind="${easeKind}" data-key="${item.key}" data-time="${key.time}" tabindex="0" role="button" aria-label="${esc(item.label)} ${number(key.time, 3)}초 ${easeKind==='both'?'Easy Ease':easeKind==='in'?'Ease In':easeKind==='out'?'Ease Out':'선형'} 키프레임"/>`;
        });
      });
      svg += '<g id="ET_PLAYHEAD" pointer-events="none"><line x1="0" y1="25" x2="0" y2="274" stroke="#60dfd4" stroke-width="1.5"/><path d="M-5,20 H5 V27 L0,32 L-5,27 Z" fill="#60dfd4"/></g>';
      this.$('ET_TRACKS').innerHTML = svg;
      this.root.querySelectorAll('[data-property]').forEach(row => row.dataset.selected = String(row.dataset.property === this.channel));
      this.updatePlayhead();
      this.updateSelectionUI();
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

    renderFormat() { return this.root.querySelector('input[name="ET_RENDER_FORMAT"]:checked')?.value || 'jpeg'; }
    renderMimeType() {
      if (!window.MediaRecorder) return '';
      return ['video/mp4;codecs=avc1.42E01E','video/mp4;codecs=avc1','video/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    }
    openRender() {
      this.pause();
      const lastFrame = Math.round(this.project.duration * this.project.fps);
      this.$('ET_RENDER_START').max = lastFrame;
      this.$('ET_RENDER_END').max = lastFrame;
      this.$('ET_RENDER_END').value = lastFrame;
      this.$('ET_RENDER_FPS').textContent = `${this.project.fps} FPS`;
      this.$('ET_RENDER_ERROR').textContent = '';
      this.$('ET_RENDER_PROGRESS_WRAP').hidden = true;
      this.$('ET_RENDER_LOCATION').textContent = this.renderDestination?.handle?.name || '선택 안 됨';
      this.$('ET_RENDER').showModal();
    }
    closeRender() {
      if (this.renderAbort) this.renderAbort.abort();
      else this.$('ET_RENDER').close();
    }
    safeRenderName() {
      return (this.$('ET_RENDER_NAME').value.trim() || 'GraphicRoad')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
    }
    async chooseRenderLocation() {
      const format = this.renderFormat();
      this.$('ET_RENDER_ERROR').textContent = '';
      try {
        if (format === 'jpeg') {
          if (!window.showDirectoryPicker) throw new Error('DIRECTORY_PICKER_UNSUPPORTED');
          this.renderDestination = {
            format,
            handle: await window.showDirectoryPicker({ mode: 'readwrite' })
          };
        } else {
          if (!this.renderMimeType()) throw new Error('MP4_UNSUPPORTED');
          this.renderDestination = window.showSaveFilePicker ? {
            format,
            handle: await window.showSaveFilePicker({
              suggestedName: `${this.safeRenderName()}.mp4`,
              types: [{ description: 'MP4 동영상', accept: { 'video/mp4': ['.mp4'] } }]
            })
          } : { format, handle: null };
        }
        this.$('ET_RENDER_LOCATION').textContent = this.renderDestination.handle?.name ||
          (format === 'mp4' ? '다운로드 폴더' : '선택됨');
      } catch (error) {
        if (error?.name === 'AbortError') return;
        const messages = {
          MP4_UNSUPPORTED: '이 브라우저는 MP4 녹화를 지원하지 않습니다. JPEG 시퀀스를 선택하세요.',
          DIRECTORY_PICKER_UNSUPPORTED: '이 브라우저는 폴더 저장을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용하세요.'
        };
        this.$('ET_RENDER_ERROR').textContent = messages[error?.message] || '저장 위치를 선택하지 못했습니다.';
      }
    }
    renderSettings() {
      const lastFrame = Math.round(this.project.duration * this.project.fps);
      const integer = id => Math.round(Number(this.$(id).value));
      const settings = {
        format: this.renderFormat(),
        name: this.safeRenderName(),
        start: integer('ET_RENDER_START'),
        end: integer('ET_RENDER_END'),
        width: integer('ET_RENDER_WIDTH'),
        height: integer('ET_RENDER_HEIGHT'),
        quality: Number(this.$('ET_RENDER_QUALITY').value),
        fps: this.project.fps
      };
      if (!Number.isFinite(settings.start) || !Number.isFinite(settings.end) ||
          settings.start < 0 || settings.end < settings.start || settings.end > lastFrame) {
        throw new Error(`프레임 범위는 0~${lastFrame} 사이여야 합니다.`);
      }
      if (!Number.isFinite(settings.width) || !Number.isFinite(settings.height) ||
          settings.width < 320 || settings.width > 7680 ||
          settings.height < 180 || settings.height > 4320) {
        throw new Error('출력 크기는 320×180 이상, 7680×4320 이하여야 합니다.');
      }
      if (settings.width % 2 || settings.height % 2) {
        throw new Error('출력 너비와 높이는 짝수여야 합니다.');
      }
      return settings;
    }
    async captureRenderStream() {
      const activeTrack = this.renderStream?.getVideoTracks()[0];
      if (activeTrack?.readyState === 'live') return this.renderStream;
      this.renderStream = null;
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('SCREEN_CAPTURE_UNSUPPORTED');

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', cursor: 'never' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
        systemAudio: 'exclude'
      });
      const track = stream.getVideoTracks()[0];
      const surface = track?.getSettings?.().displaySurface;
      if (surface && surface !== 'browser') {
        stream.getTracks().forEach(item => item.stop());
        throw new Error('CURRENT_TAB_REQUIRED');
      }
      track?.addEventListener('ended', () => {
        if (this.renderStream === stream) this.renderStream = null;
        this.renderAbort?.abort();
      }, { once: true });
      this.renderStream = stream;
      return stream;
    }
    async renderVideo(stream) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise((resolve, reject) => {
          video.addEventListener('loadeddata', resolve, { once: true });
          video.addEventListener('error', reject, { once: true });
        });
      }
      return video;
    }
    waitForRenderPointer(signal, timeout = 30000) {
      if (signal.aborted) return Promise.reject(new DOMException('중단됨', 'AbortError'));
      this.root.dataset.renderMessage = '마우스를 아래의 접힌 타임라인 바 위로 이동하면 렌더링을 시작합니다.';
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          document.removeEventListener('pointermove', onPointerMove, true);
          signal.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else {
            this.root.dataset.renderMessage = '렌더링 준비 중…';
            resolve();
          }
        };
        const onPointerMove = event => {
          const rect = document.getElementById('googleMap')?.getBoundingClientRect();
          if (!rect) return;
          const outside = event.clientX < rect.left || event.clientX >= rect.right ||
            event.clientY < rect.top || event.clientY >= rect.bottom;
          if (outside) finish();
        };
        const onAbort = () => finish(new DOMException('중단됨', 'AbortError'));
        const timer = setTimeout(() => finish(
          new Error('화면 공유 후 마우스를 아래의 접힌 타임라인 바 위로 이동해 주세요.')), timeout);
        document.addEventListener('pointermove', onPointerMove, true);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    configureRenderViewport(settings, reserveTimeline = false) {
      const foldedHeight = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--earth-timeline-folded-height')) || 52;
      const availableWidth = window.innerWidth;
      const availableHeight = Math.max(1, window.innerHeight - (reserveTimeline ? foldedHeight : 0));
      const viewport = fitRenderViewport(availableWidth, availableHeight, settings.width, settings.height);
      const style = document.documentElement.style;
      style.setProperty('--earth-render-left', `${viewport.left}px`);
      style.setProperty('--earth-render-top', `${viewport.top}px`);
      style.setProperty('--earth-render-width', `${viewport.width}px`);
      style.setProperty('--earth-render-height', `${viewport.height}px`);
    }
    clearRenderViewport() {
      const style = document.documentElement.style;
      for (const name of ['--earth-render-left', '--earth-render-top', '--earth-render-width', '--earth-render-height']) {
        style.removeProperty(name);
      }
    }
    renderCanvas(video, settings, canvas = document.createElement('canvas')) {
      const rect = document.getElementById('googleMap')?.getBoundingClientRect();
      const scale = video.videoWidth / window.innerWidth;
      if (!rect?.width || !rect?.height || !(scale > 0)) {
        throw new Error('지도 화면 크기를 계산하지 못했습니다.');
      }
      // Chrome adds a sharing notice above the captured page. Its pixels are
      // present in the video but not in window.innerHeight. Use the horizontal
      // scale (which is unaffected by that notice) and remove the top inset.
      const contentHeight = window.innerHeight * scale;
      const topInset = Math.max(0, video.videoHeight - contentHeight);
      const source = {
        x: rect.left * scale,
        y: topInset + rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale
      };

      canvas.width = settings.width;
      canvas.height = settings.height;
      const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
      if (!context) throw new Error('출력 이미지를 만들지 못했습니다.');
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);

      // Never stretch the globe. The render viewport already has the target
      // ratio; contain is a final safeguard for capture rounding differences.
      const outputScale = Math.min(canvas.width / source.width, canvas.height / source.height);
      const outputWidth = source.width * outputScale;
      const outputHeight = source.height * outputScale;
      context.drawImage(video, source.x, source.y, source.width, source.height,
        (canvas.width - outputWidth) / 2, (canvas.height - outputHeight) / 2,
        outputWidth, outputHeight);
      return canvas;
    }
    async settleRenderFrame(signal, delay = 70, paints = 2) {
      if (signal.aborted) throw new DOMException('중단됨', 'AbortError');
      for (let count = 0; count < paints; count++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (!delay) return;
      await new Promise((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('중단됨', 'AbortError'));
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    canvasBlob(canvas, type, quality) {
      return new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('이미지 인코딩에 실패했습니다.'));
      }, type, quality));
    }
    waitCapturedVideoFrame(video, signal, timeout = 350) {
      if (signal.aborted) return Promise.reject(new DOMException('중단됨', 'AbortError'));
      if (!video.requestVideoFrameCallback) return this.settleRenderFrame(signal, 0, 1);
      return new Promise((resolve, reject) => {
        let callbackId;
        let timer;
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          video.cancelVideoFrameCallback?.(callbackId);
          reject(new DOMException('중단됨', 'AbortError'));
        };
        callbackId = video.requestVideoFrameCallback(finish);
        // Chrome may stop emitting captured-video callbacks when consecutive
        // Earth frames are visually similar. Never let one frame stall a job.
        timer = setTimeout(() => {
          video.cancelVideoFrameCallback?.(callbackId);
          finish();
        }, timeout);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    async prepareRenderFrame(video, signal, settleTimeout = 2500) {
      const steady = await this.getProvider()?.waitEarthSteady?.(settleTimeout);
      await this.settleRenderFrame(signal, steady ? 50 : 200, 2);
      await this.waitCapturedVideoFrame(video, signal);
    }
    updateRenderProgress(done, total) {
      this.$('ET_RENDER_PROGRESS').value = done / total;
      this.$('ET_RENDER_PROGRESS_TEXT').textContent = `${done} / ${total} 프레임`;
    }
    async renderJpegSequence(video, settings, signal) {
      const total = settings.end - settings.start + 1;
      for (let frame = settings.start; frame <= settings.end; frame++) {
        if (signal.aborted) throw new DOMException('중단됨', 'AbortError');
        this.seek(frame / settings.fps, true);
        await this.prepareRenderFrame(video, signal);
        const canvas = this.renderCanvas(video, settings);
        const blob = await this.canvasBlob(canvas, 'image/jpeg', settings.quality);
        const filename = `${settings.name}_${String(frame).padStart(6, '0')}.jpg`;
        const file = await this.renderDestination.handle.getFileHandle(filename, { create: true });
        const writable = await file.createWritable();
        await writable.write(blob);
        await writable.close();
        this.updateRenderProgress(frame - settings.start + 1, total);
      }
    }
    async renderMp4(video, settings, signal) {
      const mimeType = this.renderMimeType();
      if (!mimeType) throw new Error('MP4_UNSUPPORTED');
      const canvas = document.createElement('canvas');
      canvas.width = settings.width;
      canvas.height = settings.height;
      const output = canvas.captureStream(settings.fps);
      const chunks = [];
      const recorder = new MediaRecorder(output, {
        mimeType,
        videoBitsPerSecond: Math.min(40000000,
          Math.max(4000000, settings.width * settings.height * settings.fps * .12))
      });
      recorder.addEventListener('dataavailable', event => {
        if (event.data.size) chunks.push(event.data);
      });
      const stopped = new Promise((resolve, reject) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.addEventListener('error', () => reject(
          recorder.error || new Error('MP4 인코딩에 실패했습니다.')), { once: true });
      });
      const total = settings.end - settings.start + 1;
      this.seek(settings.start / settings.fps, true);
      await this.prepareRenderFrame(video, signal);
      this.renderCanvas(video, settings, canvas);
      recorder.start(1000);
      this.updateRenderProgress(1, total);
      try {
        for (let frame = settings.start + 1; frame <= settings.end; frame++) {
          if (signal.aborted) throw new DOMException('중단됨', 'AbortError');
          this.seek(frame / settings.fps, true);
          await this.prepareRenderFrame(video, signal, 1200);
          this.renderCanvas(video, settings, canvas);
          output.getVideoTracks()[0]?.requestFrame?.();
          this.updateRenderProgress(frame - settings.start + 1, total);
        }
        await this.settleRenderFrame(signal, Math.ceil(1000 / settings.fps), 0);
      } finally {
        if (recorder.state !== 'inactive') recorder.stop();
      }
      await stopped;
      output.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: 'video/mp4' });
      if (!blob.size) throw new Error('MP4 파일이 비어 있습니다.');
      if (this.renderDestination.handle) {
        const writable = await this.renderDestination.handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${settings.name}.mp4`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
    async startRender() {
      let settings;
      try {
        settings = this.renderSettings();
      } catch (error) {
        this.$('ET_RENDER_ERROR').textContent = error.message;
        return;
      }
      if (!this.renderDestination || this.renderDestination.format !== settings.format) {
        this.$('ET_RENDER_ERROR').textContent = '먼저 현재 형식의 저장 위치를 선택하세요.';
        return;
      }

      this.pause();
      this.$('ET_RENDER_ERROR').textContent = '';
      this.$('ET_RENDER_PROGRESS_WRAP').hidden = false;
      this.updateRenderProgress(0, settings.end - settings.start + 1);
      this.renderAbort = new AbortController();
      const signal = this.renderAbort.signal;
      const provider = this.getProvider();
      const returnTime = this.time;
      const returnFolded = this.folded;
      let video = null;
      this.setFolded(true);
      this.$('ET_RENDER').close();

      try {
        const stream = await this.captureRenderStream();
        document.body.classList.add('earth-rendering');
        this.configureRenderViewport(settings, true);
        if (!provider?.setEarthRenderMode?.(true)) {
          throw new Error('Earth 렌더 모드를 시작하지 못했습니다.');
        }
        await this.waitForRenderPointer(signal);
        this.root.dataset.renderMessage = '렌더링 중…';
        document.body.classList.add('earth-capture-clean');
        this.configureRenderViewport(settings);
        await this.settleRenderFrame(signal, 500, 3);
        video = await this.renderVideo(stream);
        await this.waitCapturedVideoFrame(video, signal);
        if (settings.format === 'jpeg') await this.renderJpegSequence(video, settings, signal);
        else await this.renderMp4(video, settings, signal);
        this.setStatus(`${settings.name} 렌더링을 완료했습니다.`);
      } catch (error) {
        if (error?.name !== 'AbortError' && error?.name !== 'NotAllowedError') {
          const messages = {
            CURRENT_TAB_REQUIRED: '화면 공유에서 현재 탭을 선택하세요.',
            SCREEN_CAPTURE_UNSUPPORTED: '이 브라우저는 화면 캡처를 지원하지 않습니다.',
            MP4_UNSUPPORTED: '이 브라우저는 MP4 녹화를 지원하지 않습니다. JPEG 시퀀스를 사용하세요.'
          };
          const message = messages[error?.message] || error?.message || '렌더링에 실패했습니다.';
          this.setStatus(message);
          window.alert(message);
        }
      } finally {
        video?.pause();
        if (video) video.srcObject = null;
        provider?.setEarthRenderMode?.(false);
        document.body.classList.remove('earth-capture-clean');
        this.clearRenderViewport();
        document.body.classList.remove('earth-rendering');
        delete this.root.dataset.renderMessage;
        this.renderAbort = null;
        this.setFolded(returnFolded);
        this.seek(returnTime, true);
      }
    }

    onClick(event) {
      const property = event.target.closest('[data-property]');
      if (property && event.target.tagName === 'LABEL') {
        this.channel = property.dataset.property;
        this.selectedTime = null; this.selection = [];
        this.$('ET_CHANNEL').value = this.channel;
        this.renderTracks(); this.renderGraph();
      }
      const ease = event.target.closest('[data-ease]');
      if (ease) { this.applyEase(ease.dataset.ease); return; }
      const add = event.target.closest('[data-add]');
      if (add) { this.capture(add.dataset.add); return; }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'fold') this.setFolded(!this.folded);
      else if (action === 'play') this.play();
      else if (action === 'graph-toggle') {
        const shown = this.root.classList.toggle('et-show-graph');
        this.$('ET_GRAPH_TOGGLE').setAttribute('aria-pressed', String(shown));
      }
      else if (action === 'back' || action === 'next') this.seek(this.time + (action === 'back' ? -1 : 1) / this.project.fps);
      else if (action === 'capture') this.capture();
      else if (action === 'delete') this.deleteKey();
      else if (action === 'undo' || action === 'redo') this.restore(action === 'redo');
      else if (action === 'easing' || action === 'values') { this.graphMode = action; this.renderGraph(); }
      else if (action === 'render-open') this.openRender();
      else if (action === 'render-close') this.closeRender();
      else if (action === 'render-location') this.chooseRenderLocation();
      else if (action === 'render-start') this.startRender();
    }

    onChange(event) {
      const input = event.target;
      if (input.name === 'ET_RENDER_FORMAT') {
        this.renderDestination=null;this.$('ET_RENDER_LOCATION').textContent='선택 안 됨';this.$('ET_RENDER_ERROR').textContent='';this.$('ET_RENDER_QUALITY').disabled=input.value!=='jpeg';return;
      }
      if (input.id === 'ET_ZOOM') {
        this.zoom = Number(input.value);
        this.viewStart = C.clamp(this.time - this.project.duration / this.zoom / 2, 0, this.project.duration - this.project.duration / this.zoom);
        this.renderTracks(); return;
      }
      if (input.id === 'ET_CHANNEL') {
        this.selection = [];
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
        this.remember(); this.project = next; this.selectedTime = null; this.selection = [];
        this.render(); this.seek(this.time); return;
      }
      if (input.id === 'ET_PRESET') {
        if (C.PRESETS[input.value] && this.selected()) {
          this.pause(); this.remember();
          const key = this.selected();
          key.easing = [...C.PRESETS[input.value]];
          delete key.easeKind;
          this.seek(this.time); this.renderTracks(); this.renderGraph(); this.historyButtons();
        }
        return;
      }
      if (input.type !== 'number') return;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value)) { this.render(); return; }

      if (input.dataset.channel) {
        const key = input.dataset.channel;
        if (!this.activeChannels().some(item => item.key === key)) return;
        this.pause(); this.getProvider()?.stopEarthAnimation();
        const definition = C.channel(key);
        const next = C.clamp(value, definition.min, definition.max);
        const existing = this.project.tracks[key].find(frame => Math.abs(frame.time - this.time) < 0.5 / this.project.fps);
        if (existing) { this.remember(); existing.value = next; this.selectedTime = existing.time; }
        this.selection = existing ? [{channel:key,time:existing.time}] : [];
        if (!existing) this.selectedTime = null;
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
        this.pause(); this.remember();
        const key = this.selected();
        key.easing[Number(input.dataset.handle)] = C.clamp(value, 0, 1);
        delete key.easeKind;
        this.seek(this.time); this.renderTracks(); this.renderGraph(); this.historyButtons();
      } else if ((input.id === 'ET_KEY_TIME' || input.id === 'ET_KEY_VALUE') && this.selected()) {
        this.pause(); this.remember();
        const frame = C.moveKey(this.project, this.channel, this.selectedTime,
          input.id === 'ET_KEY_TIME' ? value : this.selectedTime, input.id === 'ET_KEY_VALUE' ? value : undefined);
        this.selectedTime = frame.time;
        this.selection = [{channel:this.channel,time:frame.time}];
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
      if (!await this.confirmAction('현재 타임라인을 새로 만듭니다. 기존 키프레임이 초기화됩니다. 계속할까요?')) { this.render(); return; }
      this.remember();
      this.project = C.createProject(this.getProvider()?.getEarthCamera() || this.pose, mode);
      this.pose = C.copy(this.project.base);
      this.activeChannels().forEach(item => C.upsert(this.project, item.key, 0, this.pose[item.key]));
      this.selection = [];
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
        const entry = {channel:this.channel,time:this.selectedTime};
        const entries = this.selection || [];
        const contains = entries.some(s => s.channel === entry.channel && s.time === entry.time);
        this.selection = event.shiftKey ? (contains ? entries.filter(s => s.channel !== entry.channel || s.time !== entry.time) : [...entries,entry]) : contains ? entries : [entry];
        if (!this.selection.length) this.selectedTime = null;
        if (this.selectedTime === null) { this.renderTracks(); this.renderGraph(); return; }
        this.seek(this.selectedTime);
        this.drag = { type: svg.id === 'ET_TRACKS' ? 'key' : 'selection', startX: event.clientX, remembered: false };
      } else if (target?.dataset.handle !== undefined && this.selected()) {
        this.drag = { type: 'handle', handle: Number(target.dataset.handle), remembered: false };
      } else if (svg.id === 'ET_TRACKS') {
        if (target?.dataset.track) this.channel = target.dataset.track;
        this.selectedTime = null;
        const point = this.point(event, svg);
        if (point.y <= 28) {
          this.seek(this.trackTime(point.x)); this.drag = { type:'scrub' };
        } else {
          const initial = event.shiftKey ? [...(this.selection || [])] : [];
          this.selection = initial;
          this.drag = {type:'box',start:point,initial};
        }
      } else return;
      event.preventDefault();
      this.root.focus?.({preventScroll:true});
      this.drag.svg = svg; this.drag.pointerId = event.pointerId;
      svg.setPointerCapture(event.pointerId);
      this.$('ET_CHANNEL').value = this.channel;
      // Do not remove the pointer-down target before capture becomes active.
      this.updateSelectionUI(); this.renderGraph();
    }

    pointerMove(event, svg) {
      if (!this.drag || (this.drag.pointerId !== undefined && this.drag.pointerId !== event.pointerId)) return;
      const point = this.point(event, svg);
      if (this.drag.type === 'box') {
        const x = Math.min(point.x,this.drag.start.x), y = Math.min(point.y,this.drag.start.y);
        const width = Math.abs(point.x-this.drag.start.x), height = Math.abs(point.y-this.drag.start.y);
        const found = [...this.drag.initial];
        this.activeChannels().forEach((item,i) => this.project.tracks[item.key].forEach(f => {
          const fx = this.trackX(f.time), fy = 42.5+i*29;
          if (fx >= 12 && fx <= (this.trackWidth || 720)-22 && fx >= x && fx <= x+width && fy >= y && fy <= y+height &&
            !found.some(s => s.channel === item.key && s.time === f.time)) found.push({channel:item.key,time:f.time});
        }));
        this.selection = found;
        this.selectedTime = found[0]?.time ?? null;
        if (found.length) this.channel = found[0].channel;
        this.$('ET_CHANNEL').value = this.channel;
        this.renderTracks(); this.renderGraph();
        const box = document.createElementNS('http://www.w3.org/2000/svg','rect');
        for (const [key,value] of Object.entries({id:'ET_MARQUEE',x,y,width,height,fill:'#58a6ff22',stroke:'#58a6ff','pointer-events':'none'})) box.setAttribute(key,value);
        svg.appendChild(box); return;
      }
      if (this.drag.type === 'scrub') { this.queueScrub(this.trackTime(point.x)); return; }
      if (this.drag.type === 'selection') return;
      if (this.drag.type === 'key' && Math.abs(event.clientX - this.drag.startX) < 3) return;
      if (!this.drag.remembered) { this.remember(); this.drag.remembered = true; }
      if (this.drag.type === 'key') {
        const delta = this.trackTime(point.x)-this.selectedTime;
        const moved = C.moveKeys(this.project,this.selectedEntries(),delta);
        if (!moved) return;
        this.selection = moved;
        this.selectedTime += delta;
        this.seek(this.selectedTime);
        this.renderTracks();
      } else {
        const key = this.selected();
        if (!key) return;
        delete key.easeKind;
        key.easing[this.drag.handle * 2] = C.clamp((point.x - 32) / 218, 0, 1);
        key.easing[this.drag.handle * 2 + 1] = C.clamp((116 - point.y) / 94, 0, 1);
        this.seek(this.time); this.renderTracks();
      }
      this.renderGraph(); this.historyButtons();
    }

    onKey(event) {
      if (this.$('ET_CONFIRM')?.open) return;
      if (this.$('ET_RENDER')?.open && event.key === 'Escape') { event.preventDefault(); this.closeRender(); return; }
      if (event.key === 'Enter' && event.target.type === 'number') {
        event.preventDefault(); event.target.blur(); return;
      }
      if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation?.();
        if (!event.repeat) this.play();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && ['f','g'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        this.seek(this.time+(event.key.toLowerCase()==='f'?-1:1)/this.project.fps);
        return;
      }
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
        if (event.key === 'Enter') {
          event.preventDefault(); this.seek(this.selectedTime); this.renderTracks(); this.renderGraph();
        } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault(); this.remember();
          const delta = (event.key === 'ArrowLeft' ? -1 : 1) / this.project.fps;
          const moved = C.moveKeys(this.project,this.selectedEntries(),delta);
          if (!moved) return;
          this.selection = moved; this.selectedTime = C.snap(this.selectedTime+delta,this.project.fps,this.project.duration);
          this.seek(this.selectedTime); this.renderTracks(); this.renderGraph(); this.historyButtons();
          this.$('ET_TRACKS').querySelector(`[data-key="${this.channel}"][data-time="${this.selectedTime}"]`)?.focus();
        }
      } else if (target?.dataset.handle !== undefined && /^Arrow/.test(event.key) && this.selected()) {
        event.preventDefault(); this.pause(); this.remember();
        const handle = Number(target.dataset.handle);
        const index = handle * 2 + (['ArrowUp', 'ArrowDown'].includes(event.key) ? 1 : 0);
        const sign = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
        const key = this.selected();
        key.easing[index] = C.clamp(key.easing[index] + sign * 0.01, 0, 1);
        delete key.easeKind;
        this.seek(this.time); this.renderTracks(); this.renderGraph(); this.historyButtons();
        this.$('ET_GRAPH').querySelector(`[data-handle="${handle}"]`)?.focus();
      }
    }

    onGlobalKey(event) {
      if (!this.opened || this.renderAbort || this.$('ET_CONFIRM')?.open || this.root.contains(event.target) || event.altKey) return;
      if (/INPUT|SELECT|TEXTAREA/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(key)) return;
      event.preventDefault();
      this.restore(key === 'y' || Boolean(event.shiftKey));
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
      this.pause(); this.remember(); this.project = project; this.selection = [];
      this.time = 0; this.channel = 'heading'; this.selectedTime = project.tracks.heading[0]?.time ?? null;
      this.render();
      if (this.opened && this.available) this.seek(0);
      this.setStatus('프로젝트를 불러왔습니다. 재생 버튼으로 카메라 움직임을 확인하세요.');
    }
  }

  window.GraphicRoadEarthTimeline = Object.freeze({ Controller, fitRenderViewport });
})();
