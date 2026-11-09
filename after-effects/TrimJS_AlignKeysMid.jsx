/*
 * Trim JS - "Align Mid" 버튼 (선택한 키프레임들을 중간 프레임으로 일직선 정렬)
 *
 * 동작
 *   1. 타임라인에서 여러 레이어/속성의 키프레임을 선택한다.
 *   2. 버튼을 누르면 선택된 키프레임 중 가장 이른 시간과 가장 늦은 시간의
 *      중간 시점을 계산해 컴프 프레임 단위로 스냅한다.
 *   3. 선택된 모든 키프레임을 그 프레임으로 이동한다.
 *      (값, 보간 타입, Temporal Ease, Spatial Tangent, Roving, 라벨 유지)
 *   예) Layer1 Position @1f, Layer2 Position @2f, Layer3 Position @3f
 *       → 세 키프레임 모두 2f 로 이동
 *
 * 한 속성 안에서 여러 키를 선택한 경우, 같은 시간에 키가 여러 개 있을 수 없으므로
 * 중간 시점에 가장 가까운 키의 값/보간을 가진 키 1개로 합쳐진다.
 *
 * ── 기존 Trim JS 패널에 붙이는 방법 ──────────────────────────────────────
 *   (a) 이 파일의 trimJS_alignSelectedKeysToMid 함수(및 helper 함수들)를
 *       Trim JS 스크립트 안에 그대로 복사한다.
 *   (b) 버튼 행에서 "Trim JS" StaticText 를 만드는 줄을 삭제한다. 예:
 *         row.add("statictext", undefined, "Trim JS");   // ← 삭제
 *   (c) Pre-Compose 버튼을 만드는 줄 "바로 앞"에 아래 두 줄을 넣는다.
 *       ScriptUI는 add() 순서대로 왼쪽→오른쪽 배치하므로 Pre-Compose 바로 왼쪽에 생긴다.
 *         var btnAlignMid = row.add("button", undefined, "Align Mid");
 *         btnAlignMid.helpTip = "선택한 키프레임들을 처음/끝 키의 중간 프레임으로 정렬";
 *         btnAlignMid.onClick = function () { trimJS_alignSelectedKeysToMid(); };
 *         var btnPrecomp = row.add("button", undefined, "Pre-Compose");  // 기존 줄
 *   ('row' 는 기존 스크립트에서 버튼들이 들어있는 group 변수명으로 바꿔준다.)
 *
 * 이 파일을 단독으로 실행(File > Scripts > Run Script File)하면 바로 정렬을 수행한다.
 */

function trimJS_alignSelectedKeysToMid() {
    var comp = app.project.activeItem;
    if (!(comp && comp instanceof CompItem)) {
        alert("컴포지션 타임라인을 활성화한 뒤 키프레임을 선택하세요.");
        return;
    }

    // 1) 선택된 키프레임 수집
    var props = comp.selectedProperties;
    var targets = [];          // { prop, indices[] }
    var minT = Infinity, maxT = -Infinity, total = 0;
    for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (p.propertyType !== PropertyType.PROPERTY) continue;
        if (!p.numKeys || !p.selectedKeys || p.selectedKeys.length === 0) continue;
        var idx = p.selectedKeys.slice(0);
        for (var j = 0; j < idx.length; j++) {
            var t = p.keyTime(idx[j]);
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
        }
        total += idx.length;
        targets.push({ prop: p, indices: idx });
    }

    if (total < 2) {
        alert("정렬할 키프레임을 2개 이상 선택하세요.");
        return;
    }

    // 2) 중간 시점 → 프레임 스냅
    var fd = comp.frameDuration;
    var midFrame = Math.round(((minT + maxT) / 2) / fd + 1e-6);
    var midT = midFrame * fd;

    // 3) 이동
    app.beginUndoGroup("Trim JS - Align Keys to Mid");
    try {
        for (var k = 0; k < targets.length; k++) {
            trimJS_moveKeysTo(targets[k].prop, targets[k].indices, midT);
        }
    } catch (err) {
        alert("Align Mid 오류: " + err.toString());
    } finally {
        app.endUndoGroup();
    }
}

// 한 속성의 선택 키들을 newTime 으로 이동 (여러 개면 중간에 가장 가까운 키 하나로 병합)
function trimJS_moveKeysTo(prop, indices, newTime) {
    // 중간 시점에 가장 가까운 키를 대표로 사용
    var best = indices[0], bestDist = Infinity;
    for (var i = 0; i < indices.length; i++) {
        var d = Math.abs(prop.keyTime(indices[i]) - newTime);
        if (d < bestDist) { bestDist = d; best = indices[i]; }
    }
    if (indices.length === 1 && bestDist < 1e-6) {
        prop.setSelectedAtKey(best, true);
        return; // 이미 제자리
    }

    var data = trimJS_captureKey(prop, best);

    // 인덱스가 밀리지 않도록 뒤에서부터 삭제
    var sorted = indices.slice(0).sort(function (a, b) { return b - a; });
    for (var s = 0; s < sorted.length; s++) prop.removeKey(sorted[s]);

    prop.setValueAtTime(newTime, data.value);
    var ni = prop.nearestKeyIndex(newTime);
    trimJS_applyKey(prop, ni, data);
    prop.setSelectedAtKey(ni, true);
}

function trimJS_captureKey(p, i) {
    var k = { value: p.keyValue(i) };
    k.inType = p.keyInInterpolationType(i);
    k.outType = p.keyOutInterpolationType(i);
    try { k.inEase = p.keyInTemporalEase(i); k.outEase = p.keyOutTemporalEase(i); } catch (e) {}
    try { k.tCont = p.keyTemporalContinuous(i); k.tAuto = p.keyTemporalAutoBezier(i); } catch (e) {}
    if (p.isSpatial) {
        try {
            k.inTan = p.keyInSpatialTangent(i); k.outTan = p.keyOutSpatialTangent(i);
            k.sCont = p.keySpatialContinuous(i); k.sAuto = p.keySpatialAutoBezier(i);
            k.roving = p.keyRoving(i);
        } catch (e) {}
    }
    try { k.label = p.keyLabel(i); } catch (e) {}
    return k;
}

function trimJS_applyKey(p, i, k) {
    if (k.inTan !== undefined) {
        try { p.setSpatialTangentsAtKey(i, k.inTan, k.outTan); } catch (e) {}
        try { p.setSpatialContinuousAtKey(i, k.sCont); p.setSpatialAutoBezierAtKey(i, k.sAuto); } catch (e) {}
    }
    if (k.inEase !== undefined) {
        try { p.setTemporalEaseAtKey(i, k.inEase, k.outEase); } catch (e) {}
    }
    if (k.tCont !== undefined) {
        try { p.setTemporalContinuousAtKey(i, k.tCont); p.setTemporalAutoBezierAtKey(i, k.tAuto); } catch (e) {}
    }
    try { p.setInterpolationTypeAtKey(i, k.inType, k.outType); } catch (e) {}
    if (k.roving) { try { p.setRovingAtKey(i, true); } catch (e) {} }
    if (k.label !== undefined) { try { p.setLabelAtKey(i, k.label); } catch (e) {} }
}

// 단독 실행 시 (Trim JS 패널에 포함되지 않은 경우) 바로 수행
if (typeof TRIMJS_PANEL_INCLUDED === "undefined") {
    trimJS_alignSelectedKeysToMid();
}
