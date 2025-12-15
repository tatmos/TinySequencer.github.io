// シーケンサー設定
const STEPS_PER_BAR = 16; // 16分音符
const BARS = 4;
const TOTAL_STEPS = STEPS_PER_BAR * BARS; // 64
const OCTAVES = 2;
const NOTES_PER_OCTAVE = 12;
const TOTAL_PITCHES = OCTAVES * NOTES_PER_OCTAVE; // 24
const BASE_MIDI_NOTE = 60; // C4 を下のオクターブにするため、行0がC4+12になる

/** @type {boolean[][]} [pitch][step] */
let pattern = [];

let audioCtx = null;
let isPlaying = false;
let currentStep = 0;
let lastTouchedStep = 0;
let lastScheduleTime = 0;
let schedulerId = null;

const bpmInput = document.getElementById("bpm-input");
const loopCountInput = document.getElementById("loop-count");
const playBtn = document.getElementById("play-btn");
const stopBtn = document.getElementById("stop-btn");
const exportBtn = document.getElementById("export-btn");
const serializeBtn = document.getElementById("serialize-btn");
const deserializeBtn = document.getElementById("deserialize-btn");
const patternTextArea = document.getElementById("pattern-text");
const pianorollEl = document.getElementById("pianoroll");
const playheadEl = document.getElementById("playhead");
const chordTrackEl = document.getElementById("chord-track");
const displayModeSelect = document.getElementById("display-mode");
const flipVertBtn = document.getElementById("flip-vert-btn");
const flipHorizBtn = document.getElementById("flip-horiz-btn");
const randVertBtn = document.getElementById("rand-vert-btn");
const randHorizBtn = document.getElementById("rand-horiz-btn");
const smoothBtn = document.getElementById("smooth-btn");
const undoBtn = document.getElementById("undo-btn");

// 矩形選択・ドラッグ用の状態
let isSelecting = false;
let selectionStartPitch = null;
let selectionStartStep = null;
let isDraggingSelection = false;
let dragOriginPitch = null;
let dragOriginStep = null;
let dragCurrentPitch = null;
let dragCurrentStep = null;
/** @type {{ p: number; s: number }[]} */
let dragSelection = [];

// Undo 用の履歴
/** @type {boolean[][][]} */
let history = [];
let historyIndex = -1;
const MAX_HISTORY = 100;

// コードネーム用のデータ（ステップ数で長さを管理・合計でTOTAL_STEPSになる）
/** @type {{ lengthSteps: number }[]} */
let chords = [
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
];

const MIN_CHORD_STEPS = 4; // 最小長さ（16分音符4つ = 1拍）くらいに制限

const PITCH_CLASS_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DISPLAY_MODE_CHORD = "chord";
const DISPLAY_MODE_BERKLEE = "berklee";
/** @type {"chord" | "berklee"} */
let displayMode = DISPLAY_MODE_CHORD;

function getChordStepRange(index) {
  let start = 0;
  for (let i = 0; i < index; i++) {
    start += chords[i].lengthSteps;
  }
  const end = start + chords[index].lengthSteps;
  return { start, end };
}

function clonePattern(src) {
  const result = [];
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    result[p] = [];
    for (let s = 0; s < TOTAL_STEPS; s++) {
      result[p][s] = src[p][s];
    }
  }
  return result;
}

function pushHistory() {
  if (!pattern.length) return;
  const snapshot = clonePattern(pattern);
  // 現在位置以降のやり直し分を破棄してから追加
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  history.push(snapshot);
  if (history.length > MAX_HISTORY) {
    history.shift();
  } else {
    historyIndex++;
  }
}

function restoreFromHistory(index) {
  if (index < 0 || index >= history.length) return;
  pattern = clonePattern(history[index]);

  // UI を反映
  const cells = pianorollEl.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const p = Number(cell.dataset.pitch);
    const s = Number(cell.dataset.step);
    const on = !!(pattern[p] && pattern[p][s]);
    cell.classList.toggle("active", on);
  });

  clearCellSelection();
  renderChordTrack();
}

function getPitchClassesForRange(startStep, endStep) {
  /** @type {Set<number>} */
  const pitchClasses = new Set();

  for (let p = 0; p < TOTAL_PITCHES; p++) {
    for (let s = startStep; s < endStep; s++) {
      if (pattern[p][s]) {
        const midi = BASE_MIDI_NOTE - 12 + p;
        pitchClasses.add(midi % 12);
      }
    }
  }
  return pitchClasses;
}

function detectChordCore(pitchClasses) {
  if (pitchClasses.size === 0) {
    return { name: "", rootPc: null, basePitchClasses: new Set() };
  }

  const templates = [
    // 4和音（優先的にマッチさせたいものを上に）
    { name: "maj7", intervals: [0, 4, 7, 11] }, // CMaj7
    { name: "mMaj7", intervals: [0, 3, 7, 11] }, // Cm(maj7)
    { name: "7", intervals: [0, 4, 7, 10] }, // C7
    { name: "m7b5", intervals: [0, 3, 6, 10] }, // Cm7(b5)
    { name: "m7", intervals: [0, 3, 7, 10] }, // Cm7

    // 3和音
    { name: "maj", intervals: [0, 4, 7] }, // C
    { name: "m", intervals: [0, 3, 7] }, // Cm
    { name: "dim", intervals: [0, 3, 6] }, // Cdim
    { name: "sus2", intervals: [0, 2, 7] }, // Csus2
    { name: "sus4", intervals: [0, 5, 7] }, // Csus4
  ];

  let best = null;

  for (let rootPc = 0; rootPc < 12; rootPc++) {
    for (const tmpl of templates) {
      const ok = tmpl.intervals.every((iv) => pitchClasses.has((rootPc + iv) % 12));
      if (ok) {
        const score = tmpl.intervals.length;
        if (!best || score > best.score) {
          best = { rootPc, tmpl, score };
        }
      }
    }
  }

  if (best) {
    const rootPc = best.rootPc;
    const baseIntervals = new Set(best.tmpl.intervals.map((iv) => ((rootPc + iv) % 12)));

    /** @type {string[]} */
    const tensions = [];

    pitchClasses.forEach((pc) => {
      if (baseIntervals.has(pc)) return;
      const rel = (pc - rootPc + 12) % 12;
      switch (rel) {
        case 1:
          tensions.push("b2");
          break;
        case 2:
          tensions.push("9");
          break;
        case 3:
          tensions.push("#9");
          break;
        case 5:
          tensions.push("11");
          break;
        case 6:
          tensions.push("b5");
          break;
        case 8:
          tensions.push("#5");
          break;
        // それ以外の度数はテンション表記しない
      }
    });

    const baseName = PITCH_CLASS_NAMES[rootPc] + best.tmpl.name;
    if (tensions.length === 0) {
      return { name: baseName, rootPc, basePitchClasses: baseIntervals };
    }
    // 重複を除き、簡単にソートして表記
    const uniqTensions = Array.from(new Set(tensions));
    return {
      name: `${baseName}(${uniqTensions.join(",")})`,
      rootPc,
      basePitchClasses: baseIntervals,
    };
  }

  // うまく判定できない場合は、とりあえず一番低い音のルートだけ表示
  const pcs = Array.from(pitchClasses).sort((a, b) => a - b);
  const rootPc = pcs[0];
  return {
    name: PITCH_CLASS_NAMES[rootPc],
    rootPc,
    basePitchClasses: new Set([rootPc]),
  };
}

function detectChordNameForRange(startStep, endStep) {
  const pcs = getPitchClassesForRange(startStep, endStep);
  const analysis = detectChordCore(pcs);
  return analysis.name;
}

function detectChordNameForIndex(index) {
  const { start, end } = getChordStepRange(index);
  return detectChordNameForRange(start, end);
}

if (displayModeSelect) {
  displayModeSelect.addEventListener("change", () => {
    const value = displayModeSelect.value === DISPLAY_MODE_BERKLEE ? DISPLAY_MODE_BERKLEE : DISPLAY_MODE_CHORD;
    displayMode = value;
    updateNoteDegrees();
  });
}

// --- 上下反転 / 左右反転 / ランダム / なめらか ---
if (flipVertBtn) {
  flipVertBtn.addEventListener("click", () => {
    const selected = getSelectedNotePositions();
    if (!selected.length) {
      alert("まず矩形選択でノートを選んでください。");
      return;
    }
    const minPitch = Math.min(...selected.map((n) => n.p));
    const maxPitch = Math.max(...selected.map((n) => n.p));
    applyTransformToSelection(({ p, s }) => ({
      p: maxPitch - (p - minPitch),
      s,
    }));
  });
}

if (flipHorizBtn) {
  flipHorizBtn.addEventListener("click", () => {
    const selected = getSelectedNotePositions();
    if (!selected.length) {
      alert("まず矩形選択でノートを選んでください。");
      return;
    }
    const minStep = Math.min(...selected.map((n) => n.s));
    const maxStep = Math.max(...selected.map((n) => n.s));
    applyTransformToSelection(({ p, s }) => ({
      p,
      s: maxStep - (s - minStep),
    }));
  });
}

if (randVertBtn) {
  randVertBtn.addEventListener("click", () => {
    const selected = getSelectedNotePositions();
    if (!selected.length) {
      alert("まず矩形選択でノートを選んでください。");
      return;
    }
    const minPitch = Math.min(...selected.map((n) => n.p));
    const maxPitch = Math.max(...selected.map((n) => n.p));
    applyTransformToSelection(({ p, s }) => ({
      p: minPitch + Math.floor(Math.random() * (maxPitch - minPitch + 1)),
      s,
    }));
  });
}

if (randHorizBtn) {
  randHorizBtn.addEventListener("click", () => {
    const selected = getSelectedNotePositions();
    if (!selected.length) {
      alert("まず矩形選択でノートを選んでください。");
      return;
    }
    const minStep = Math.min(...selected.map((n) => n.s));
    const maxStep = Math.max(...selected.map((n) => n.s));
    applyTransformToSelection(({ p, s }) => ({
      p,
      s: minStep + Math.floor(Math.random() * (maxStep - minStep + 1)),
    }));
  });
}

if (smoothBtn) {
  smoothBtn.addEventListener("click", () => {
    const selected = getSelectedNotePositions();
    if (!selected.length) {
      alert("まず矩形選択でノートを選んでください。");
      return;
    }
    const steps = Array.from(new Set(selected.map((n) => n.s))).sort((a, b) => a - b);
    if (steps.length < 2) {
      alert("なめらかにするには、時間方向に2ステップ以上のノートが必要です。");
      return;
    }

    // 各ステップの平均ピッチを求める
    const stepToAvgPitch = new Map();
    steps.forEach((s) => {
      const ps = selected.filter((n) => n.s === s).map((n) => n.p);
      const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
      stepToAvgPitch.set(s, avg);
    });

    const firstStep = steps[0];
    const lastStep = steps[steps.length - 1];
    const firstPitch = stepToAvgPitch.get(firstStep);
    const lastPitch = stepToAvgPitch.get(lastStep);
    if (firstPitch == null || lastPitch == null) return;

    // 各ステップに対して、始点と終点を結ぶ直線上のピッチを割り当て
    const stepToSmoothPitch = new Map();
    steps.forEach((s, index) => {
      const t = steps.length === 1 ? 0 : index / (steps.length - 1);
      const p = Math.round(firstPitch + (lastPitch - firstPitch) * t);
      stepToSmoothPitch.set(s, Math.max(0, Math.min(TOTAL_PITCHES - 1, p)));
    });

    applyTransformToSelection(({ p, s }) => {
      const smoothP = stepToSmoothPitch.get(s);
      if (smoothP == null) return { p, s };
      return { p: smoothP, s };
    });
  });
}

if (undoBtn) {
  undoBtn.addEventListener("click", () => {
    if (historyIndex <= 0 || history.length === 0) {
      return;
    }
    historyIndex -= 1;
    restoreFromHistory(historyIndex);
  });
}

function updateNoteDegrees() {
  if (!pianorollEl) return;

  // ステップごとに、そのステップを担当するコードのルートと構成音集合を紐づける
  const stepRoot = new Array(TOTAL_STEPS).fill(null);
  const stepBaseSet = new Array(TOTAL_STEPS).fill(null);

  for (let i = 0; i < chords.length; i++) {
    const { start, end } = getChordStepRange(i);
    const pcs = getPitchClassesForRange(start, end);
    const analysis = detectChordCore(pcs);
    if (analysis.rootPc === null) continue;
    for (let s = start; s < end && s < TOTAL_STEPS; s++) {
      stepRoot[s] = analysis.rootPc;
      stepBaseSet[s] = analysis.basePitchClasses;
    }
  }

  const degreeClasses = [
    "degree-1",
    "degree-b2",
    "degree-b3",
    "degree-3",
    "degree-5",
    "degree-b5",
    "degree-#5",
    "degree-b7",
    "degree-7",
    "degree-9",
    "degree-11",
    "degree-13",
  ];

  const cells = pianorollEl.querySelectorAll(".cell");
  cells.forEach((cell) => {
    // 既存の度数ラベルをリセット
    const existing = cell.querySelector(".note-degree");
    if (existing) {
      existing.remove();
    }
    degreeClasses.forEach((cls) => cell.classList.remove(cls));

    if (!cell.classList.contains("active")) return;

    const step = Number(cell.dataset.step);
    const pitchIndex = Number(cell.dataset.pitch);
    const rootPc = stepRoot[step];
    const baseSet = stepBaseSet[step];
    if (rootPc == null || !baseSet) return;

    const midi = BASE_MIDI_NOTE - 12 + pitchIndex;
    const pc = midi % 12;
    const rel = (pc - rootPc + 12) % 12;

    /** @type {string | null} */
    let label = null;
    /** @type {string | null} */
    let cls = null;

    if (displayMode === DISPLAY_MODE_CHORD) {
      // コードの度数表示モード（1, b2, b3, 3, 5, b5, #5, b7, 7, 9, 11, 13）
      switch (rel) {
        case 0:
          label = "1";
          cls = "degree-1";
          break;
        case 1:
          label = "b2";
          cls = "degree-b2";
          break;
        case 3:
          label = "b3";
          cls = "degree-b3";
          break;
        case 4:
          label = "3";
          cls = "degree-3";
          break;
        case 7:
          label = "5";
          cls = "degree-5";
          break;
        case 6:
          label = "b5";
          cls = "degree-b5";
          break;
        case 8:
          label = "#5";
          cls = "degree-#5";
          break;
        case 10:
          label = "b7";
          cls = "degree-b7";
          break;
        case 11:
          label = "7";
          cls = "degree-7";
          break;
        case 2:
          label = "9";
          cls = "degree-9";
          break;
        case 5:
          label = "11";
          cls = "degree-11";
          break;
        case 9:
          label = "13";
          cls = "degree-13";
          break;
        default:
          // その他の度数はラベルなし
          break;
      }
    } else if (displayMode === DISPLAY_MODE_BERKLEE) {
      // バークリー音階表示モード（do di re me mi fa fi so si la te ti）
      switch (rel) {
        case 0:
          label = "do";
          cls = "degree-1";
          break;
        case 1:
          label = "di";
          cls = "degree-b2";
          break;
        case 2:
          label = "re";
          cls = "degree-9"; // 2度 ≒ 9度
          break;
        case 3:
          label = "me";
          cls = "degree-b3";
          break;
        case 4:
          label = "mi";
          cls = "degree-3";
          break;
        case 5:
          label = "fa";
          cls = "degree-11"; // 4度 ≒ 11度
          break;
        case 6:
          label = "fi";
          cls = "degree-b5";
          break;
        case 7:
          label = "so";
          cls = "degree-5";
          break;
        case 8:
          label = "si";
          cls = "degree-#5";
          break;
        case 9:
          label = "la";
          cls = "degree-13"; // 6度 ≒ 13度
          break;
        case 10:
          label = "te";
          cls = "degree-b7";
          break;
        case 11:
          label = "ti";
          cls = "degree-7";
          break;
        default:
          break;
      }
    }

    if (!label || !cls) return;

    const span = document.createElement("span");
    span.className = "note-degree";
    span.textContent = label;
    cell.appendChild(span);
    cell.classList.add(cls);
  });
}

function clearCellSelection() {
  if (!pianorollEl) return;
  pianorollEl.querySelectorAll(".cell.selected").forEach((c) => c.classList.remove("selected"));
}

function updateRectSelection(pitchA, stepA, pitchB, stepB) {
  if (!pianorollEl) return;
  clearCellSelection();
  const minPitch = Math.min(pitchA, pitchB);
  const maxPitch = Math.max(pitchA, pitchB);
  const minStep = Math.min(stepA, stepB);
  const maxStep = Math.max(stepA, stepB);

  const cells = pianorollEl.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const p = Number(cell.dataset.pitch);
    const s = Number(cell.dataset.step);
    if (p >= minPitch && p <= maxPitch && s >= minStep && s <= maxStep) {
      cell.classList.add("selected");
    }
  });
}

function getSelectedNotePositions() {
  /** @type {{ p: number; s: number }[]} */
  const result = [];
  if (!pianorollEl) return result;
  const cells = pianorollEl.querySelectorAll(".cell.selected");
  cells.forEach((cell) => {
    const p = Number(cell.dataset.pitch);
    const s = Number(cell.dataset.step);
    if (pattern[p] && pattern[p][s]) {
      result.push({ p, s });
    }
  });
  return result;
}

/**
 * 選択されているノートに対して変換関数を適用し、pattern と UI を更新するヘルパー
 * @param {(note: { p: number; s: number }) => { p: number; s: number } | null} transformFn
 */
function applyTransformToSelection(transformFn) {
  const selected = getSelectedNotePositions();
  if (!selected.length) {
    alert("まず矩形選択でノートを選んでください。");
    return;
  }

  pushHistory();

  const newPattern = [];
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    newPattern[p] = [];
    for (let s = 0; s < TOTAL_STEPS; s++) {
      newPattern[p][s] = pattern[p][s];
    }
  }

  /** @type {{ p: number; s: number }[]} */
  const newPositions = [];

  selected.forEach(({ p, s }) => {
    const mapped = transformFn({ p, s });
    if (!mapped) return;
    const np = mapped.p;
    const ns = mapped.s;
    if (np < 0 || np >= TOTAL_PITCHES || ns < 0 || ns >= TOTAL_STEPS) {
      return;
    }
    newPattern[p][s] = false;
    newPattern[np][ns] = true;
    newPositions.push({ p: np, s: ns });
  });

  pattern = newPattern;

  // UI を反映
  const cells = pianorollEl.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const p = Number(cell.dataset.pitch);
    const s = Number(cell.dataset.step);
    const on = !!(pattern[p] && pattern[p][s]);
    cell.classList.toggle("active", on);
  });

  // 選択状態を更新
  clearCellSelection();
  newPositions.forEach(({ p, s }) => {
    const el = pianorollEl.querySelector(`.cell[data-pitch="${p}"][data-step="${s}"]`);
    if (el) el.classList.add("selected");
  });

  // コードと度数ラベルを更新
  renderChordTrack();
}

function renderChordTrack() {
  if (!chordTrackEl) return;
  chordTrackEl.innerHTML = "";

  chords.forEach((chord, index) => {
    const segment = document.createElement("div");
    segment.className = "chord-segment";
    segment.style.flexGrow = String(chord.lengthSteps);

    const input = document.createElement("input");
    input.className = "chord-input";
    input.type = "text";
    input.readOnly = true;
    input.placeholder = "検出なし";
    input.value = detectChordNameForIndex(index);

    segment.appendChild(input);

    // 右端の境界をドラッグして長さ調整
    if (index < chords.length - 1) {
      // 中間〜先頭側：左右の既存セグメント間で長さをやりくり
      const handle = document.createElement("div");
      handle.className = "chord-handle";

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const trackRect = chordTrackEl.getBoundingClientRect();
        const startX = e.clientX;
        const startLeftLen = chords[index].lengthSteps;
        const startRightLen = chords[index + 1].lengthSteps;
        const pixelsPerStep = trackRect.width / TOTAL_STEPS;

        function onMouseMove(ev) {
          const deltaPx = ev.clientX - startX;
          const rawSteps = deltaPx / pixelsPerStep;
          const deltaSteps = Math.round(rawSteps);

          let newLeft = startLeftLen + deltaSteps;
          let newRight = startRightLen - deltaSteps;

          // 最小長さを下回らないように制限
          if (newLeft < MIN_CHORD_STEPS) {
            const diff = MIN_CHORD_STEPS - newLeft;
            newLeft += diff;
            newRight -= diff;
          }
          if (newRight < MIN_CHORD_STEPS) {
            const diff = MIN_CHORD_STEPS - newRight;
            newRight += diff;
            newLeft -= diff;
          }

          // 合計ステップ数が変わらないようにしつつ、極端なドラッグは無視
          if (newLeft < MIN_CHORD_STEPS || newRight < MIN_CHORD_STEPS) {
            return;
          }

          chords[index].lengthSteps = newLeft;
          chords[index + 1].lengthSteps = newRight;
          renderChordTrack();
        }

        function onMouseUp() {
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);
        }

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      });

      segment.appendChild(handle);
    } else {
      // 一番右端のセグメント：左へドラッグしたときに右側へ新しい要素を追加する
      const handle = document.createElement("div");
      handle.className = "chord-handle";

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const trackRect = chordTrackEl.getBoundingClientRect();
        const startX = e.clientX;
        const startLen = chords[index].lengthSteps;
        const pixelsPerStep = trackRect.width / TOTAL_STEPS;
        let lastDeltaSteps = 0;

        function onMouseMove(ev) {
          const deltaPx = ev.clientX - startX;
          const rawSteps = deltaPx / pixelsPerStep;
          lastDeltaSteps = Math.round(rawSteps);
        }

        function onMouseUp() {
          window.removeEventListener("mousemove", onMouseMove);
          window.removeEventListener("mouseup", onMouseUp);

          // 左方向に十分ドラッグされた場合のみ分割する
          if (lastDeltaSteps >= -1) {
            return;
          }

          let newLeft = startLen + lastDeltaSteps;
          // 右に新しく作るぶん
          let newRight = startLen - newLeft;

          // それぞれ最小長さを確保
          if (newLeft < MIN_CHORD_STEPS) {
            newLeft = MIN_CHORD_STEPS;
            newRight = startLen - newLeft;
          }
          if (newRight < MIN_CHORD_STEPS) {
            newRight = MIN_CHORD_STEPS;
            newLeft = startLen - newRight;
          }

          // まだ足りない場合やおかしなドラッグは無視
          if (newLeft < MIN_CHORD_STEPS || newRight < MIN_CHORD_STEPS) {
            return;
          }

          chords[index].lengthSteps = newLeft;
          chords.splice(index + 1, 0, { lengthSteps: newRight });
          renderChordTrack();
        }

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      });

      segment.appendChild(handle);
    }

    chordTrackEl.appendChild(segment);
  });

  // コード分析に基づいてノート上の度数ラベル＆色を更新
  updateNoteDegrees();
}

// --- パターン初期化 ---
for (let p = 0; p < TOTAL_PITCHES; p++) {
  pattern[p] = [];
  for (let s = 0; s < TOTAL_STEPS; s++) {
    pattern[p][s] = false;
  }
}

// --- ピアノロール生成 ---
function midiToLabel(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const name = names[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

function isBlackKey(midi) {
  // C#, D#, F#, G#, A# が黒鍵
  const blackKeyIndices = [1, 3, 6, 8, 10];
  return blackKeyIndices.includes(midi % 12);
}

function createPianoRoll() {
  pianorollEl.innerHTML = "";

  for (let row = 0; row < TOTAL_PITCHES; row++) {
    const pitchIndex = TOTAL_PITCHES - 1 - row; // 上が高い音
    const midi = BASE_MIDI_NOTE - 12 + pitchIndex; // C3〜B4くらい

    // ラベル列
    const label = document.createElement("div");
    label.className = "pitch-label";
     // 黒鍵行には専用クラスを付与
    if (isBlackKey(midi)) {
      label.classList.add("black-key");
    }
    label.textContent = midiToLabel(midi);
    pianorollEl.appendChild(label);

    // ステップ
    for (let step = 0; step < TOTAL_STEPS; step++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      // 黒鍵行のセルにもクラスを付与
      if (isBlackKey(midi)) {
        cell.classList.add("black-key-row");
      }
      // 各拍の頭に少し強いグリッド
      if (step % 4 === 0) {
        cell.classList.add("beat-strong");
      }
      const barIndex = Math.floor(step / STEPS_PER_BAR);
      cell.classList.add(barIndex % 2 === 0 ? "bar-even" : "bar-odd");
      cell.dataset.pitch = String(pitchIndex);
      cell.dataset.step = String(step);

      cell.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const p = Number(cell.dataset.pitch);
        const s = Number(cell.dataset.step);

        const hasNote = !!(pattern[p] && pattern[p][s]);

        // ノートがあるところからドラッグ開始した場合
        if (hasNote) {
          const currentSelected = getSelectedNotePositions();
          const isInSelection =
            cell.classList.contains("selected") &&
            currentSelected.some((pos) => pos.p === p && pos.s === s);

          isDraggingSelection = true;
          dragOriginPitch = p;
          dragOriginStep = s;
          dragCurrentPitch = p;
          dragCurrentStep = s;

          if (isInSelection && currentSelected.length > 1) {
            // 既存の複数選択をそのままドラッグ
            dragSelection = currentSelected;
          } else {
            // このノートだけをドラッグ対象にする
            dragSelection = [{ p, s }];
            clearCellSelection();
            cell.classList.add("selected");
          }
        } else {
          // ノートの無いところからは矩形選択開始
          isSelecting = true;
          selectionStartPitch = p;
          selectionStartStep = s;
          dragCurrentPitch = p;
          dragCurrentStep = s;
          clearCellSelection();
          updateRectSelection(selectionStartPitch, selectionStartStep, p, s);
        }
      });

      cell.addEventListener("click", () => {
        const p = Number(cell.dataset.pitch);
        const s = Number(cell.dataset.step);
        pushHistory();
        pattern[p][s] = !pattern[p][s];
        lastTouchedStep = s;
        cell.classList.toggle("active", pattern[p][s]);

        // クリック時に即時プレビュー音を鳴らす（ONにしたときのみ）
        if (pattern[p][s]) {
          ensureAudioContext();
          if (audioCtx) {
            playNoteAtTime(p, audioCtx.currentTime + 0.001);
          }
        }

        // ノート変更時にコードネームも更新
        renderChordTrack();
      });

      // マウスオーバーで「入力されているノートのみ」試聴
      cell.addEventListener("mouseenter", () => {
        const p = Number(cell.dataset.pitch);
        const s = Number(cell.dataset.step);
        if (!pattern[p][s]) return; // ノートが無いセルでは鳴らさない
        ensureAudioContext();
        if (audioCtx) {
          playNoteAtTime(p, audioCtx.currentTime + 0.001);
        }
      });

      pianorollEl.appendChild(cell);
    }
  }

  // ピアノロール生成後にコードトラックも描画
  renderChordTrack();

  // グローバルなドラッグ処理
  window.addEventListener("mousemove", (ev) => {
    if (!isSelecting && !isDraggingSelection) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!el || !(el instanceof HTMLElement) || !el.classList.contains("cell")) return;
    const p = Number(el.dataset.pitch);
    const s = Number(el.dataset.step);
    dragCurrentPitch = p;
    dragCurrentStep = s;

    if (isSelecting && selectionStartPitch != null && selectionStartStep != null) {
      updateRectSelection(selectionStartPitch, selectionStartStep, p, s);
    } else if (isDraggingSelection && dragOriginPitch != null && dragOriginStep != null && dragSelection.length) {
      // ドラッグ中のプレビュー（選択枠を移動先に表示）
      const deltaPitch = dragCurrentPitch - dragOriginPitch;
      const deltaStep = dragCurrentStep - dragOriginStep;

      clearCellSelection();
      dragSelection.forEach(({ p: op, s: os }) => {
        const np = op + deltaPitch;
        const ns = os + deltaStep;
        if (np < 0 || np >= TOTAL_PITCHES || ns < 0 || ns >= TOTAL_STEPS) return;
        const target = pianorollEl.querySelector(`.cell[data-pitch="${np}"][data-step="${ns}"]`);
        if (target) {
          target.classList.add("selected");
        }
      });
    }
  });

  window.addEventListener("mouseup", () => {
    // 矩形選択終了
    if (isSelecting) {
      isSelecting = false;
      selectionStartPitch = null;
      selectionStartStep = null;
    }

    // 選択ノートのドラッグ移動
    if (isDraggingSelection) {
      isDraggingSelection = false;
      if (
        dragOriginPitch == null ||
        dragOriginStep == null ||
        dragCurrentPitch == null ||
        dragCurrentStep == null ||
        !dragSelection.length
      ) {
        dragOriginPitch = dragOriginStep = dragCurrentPitch = dragCurrentStep = null;
        dragSelection = [];
        return;
      }

      const deltaPitch = dragCurrentPitch - dragOriginPitch;
      const deltaStep = dragCurrentStep - dragOriginStep;

      if (deltaPitch === 0 && deltaStep === 0) {
        dragOriginPitch = dragOriginStep = dragCurrentPitch = dragCurrentStep = null;
        dragSelection = [];
        return;
      }

      // 移動後に範囲外に出てしまうノートがある場合は何もしない
      const outOfRange = dragSelection.some(({ p, s }) => {
        const np = p + deltaPitch;
        const ns = s + deltaStep;
        return np < 0 || np >= TOTAL_PITCHES || ns < 0 || ns >= TOTAL_STEPS;
      });
      if (outOfRange) {
        dragOriginPitch = dragOriginStep = dragCurrentPitch = dragCurrentStep = null;
        dragSelection = [];
        return;
      }

      // パターンを更新
      const newPattern = [];
      for (let p = 0; p < TOTAL_PITCHES; p++) {
        newPattern[p] = [];
        for (let s = 0; s < TOTAL_STEPS; s++) {
          newPattern[p][s] = pattern[p][s];
        }
      }

      dragSelection.forEach(({ p, s }) => {
        const np = p + deltaPitch;
        const ns = s + deltaStep;
        newPattern[p][s] = false;
        newPattern[np][ns] = true;
      });

      pattern = newPattern;

      // UI を反映
      const cells = pianorollEl.querySelectorAll(".cell");
      cells.forEach((cell) => {
        const p = Number(cell.dataset.pitch);
        const s = Number(cell.dataset.step);
        const on = !!(pattern[p] && pattern[p][s]);
        cell.classList.toggle("active", on);
      });

      // 選択枠も移動後の位置に更新
      clearCellSelection();
      dragSelection.forEach(({ p, s }) => {
        const np = p + deltaPitch;
        const ns = s + deltaStep;
        const el = pianorollEl.querySelector(`.cell[data-pitch="${np}"][data-step="${ns}"]`);
        if (el) {
          el.classList.add("selected");
        }
      });

      // コードと度数ラベルを更新
      renderChordTrack();

      dragOriginPitch = dragOriginStep = dragCurrentPitch = dragCurrentStep = null;
      dragSelection = [];
    }
  });
}

createPianoRoll();
// 初期状態を履歴に追加
pushHistory();

// --- オーディオ関連 ---
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function stepDurationSec(bpm) {
  // 4/4で1拍=四分音符、16分音符は1/4拍
  const beatSec = 60 / bpm;
  return beatSec / 4;
}

function playNoteAtTime(pitchIndex, when) {
  if (!audioCtx) return;
  const midi = BASE_MIDI_NOTE - 12 + pitchIndex;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);

  // 一部ブラウザでは currentTime より過去の時間を指定するとエラーになるためクランプ
  const t = Math.max(audioCtx.currentTime + 0.001, when);

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = freq;

  const nowGain = 0.001;
  const maxGain = 0.18;

  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(maxGain, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(nowGain, t + 0.25);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.35);
}

function scheduleStep(step, baseTime, bpm) {
  const t = baseTime + step * stepDurationSec(bpm);

  // ノート再生
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    if (pattern[p][step]) {
      playNoteAtTime(p, t);
    }
  }

  // 再生中インジケータのためDOM更新タイミングを記録
  lastScheduleTime = t;
}

function startPlayback(fromStep) {
  ensureAudioContext();
  if (!audioCtx) return;

  const bpm = Number(bpmInput.value) || 120;
  const startStep = Math.max(0, Math.min(TOTAL_STEPS - 1, fromStep ?? 0));

  isPlaying = true;
  playBtn.disabled = true;
  stopBtn.disabled = false;
  playheadEl.style.opacity = "1";

  // ループ再生（音と表示）をタイマーで進めるシンプル方式
  const stepMs = stepDurationSec(bpm) * 1000;
  const startWallClock = performance.now();
  currentStep = startStep;

  // 再生開始時点のステップを即座に鳴らす
  const firstWhen = audioCtx.currentTime + 0.02;
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    if (pattern[p][startStep]) {
      playNoteAtTime(p, firstWhen);
    }
  }
  updatePlayhead(startStep);
  highlightPlaying(startStep);

  function tick() {
    if (!isPlaying) return;
    const elapsed = performance.now() - startWallClock;
    const approxStep = Math.floor(elapsed / stepMs);
    const stepInLoop = (startStep + approxStep) % TOTAL_STEPS;

    // 新しいステップに進んだタイミングでだけ音を鳴らす
    if (stepInLoop !== currentStep) {
      currentStep = stepInLoop;
      const when = audioCtx.currentTime + 0.02;
      for (let p = 0; p < TOTAL_PITCHES; p++) {
        if (pattern[p][stepInLoop]) {
          playNoteAtTime(p, when);
        }
      }
    }

    updatePlayhead(stepInLoop);
    highlightPlaying(stepInLoop);

    schedulerId = requestAnimationFrame(tick);
  }
  tick();
}

function stopPlayback() {
  isPlaying = false;
  playBtn.disabled = false;
  stopBtn.disabled = true;
  playheadEl.style.opacity = "0";
  if (schedulerId !== null) {
    cancelAnimationFrame(schedulerId);
    schedulerId = null;
  }
  clearPlayingHighlight();
}

// --- 再生位置UI ---
function updatePlayhead(step) {
  const cells = pianorollEl.querySelectorAll(".cell");
  if (!cells.length) return;
  // 1行あたり TOTAL_STEPS 個のセル＋左ラベル1
  const firstRowCells = Array.from(cells).slice(0, TOTAL_STEPS);
  const targetCell = firstRowCells[step];
  if (!targetCell) return;

  const rect = targetCell.getBoundingClientRect();
  const parentRect = pianorollEl.getBoundingClientRect();
  const left = rect.left - parentRect.left;
  playheadEl.style.transform = `translateX(${left}px)`;
}

function clearPlayingHighlight() {
  pianorollEl.querySelectorAll(".cell.playing").forEach((c) => {
    c.classList.remove("playing");
  });
}

function highlightPlaying(step) {
  clearPlayingHighlight();
  const cells = pianorollEl.querySelectorAll(`.cell[data-step="${step}"]`);
  cells.forEach((c) => c.classList.add("playing"));
}

// --- ボタン制御 ---
playBtn.addEventListener("click", () => {
  if (isPlaying) return;
  // 先頭（ステップ0）から再生
  startPlayback(0);
});

stopBtn.addEventListener("click", () => {
  stopPlayback();
});

// --- WAV エクスポート ---
async function renderToWav() {
  ensureAudioContext();

  const bpm = Number(bpmInput.value) || 120;
  const stepSec = stepDurationSec(bpm);
  const loopCountRaw = loopCountInput ? Number(loopCountInput.value) : 1;
  const loopCount = Math.max(1, Math.min(16, Number.isFinite(loopCountRaw) ? loopCountRaw : 1));
  const totalStepsAll = TOTAL_STEPS * loopCount;
  const totalDuration = stepSec * totalStepsAll + 1.0; // 余裕を1秒

  // OfflineAudioContext でオフラインレンダリング
  const sampleRate = audioCtx.sampleRate || 44100;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(totalDuration * sampleRate), sampleRate);

  function renderNote(pitchIndex, startTime) {
    const midi = BASE_MIDI_NOTE - 12 + pitchIndex;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);

    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();

    osc.type = "sine";
    osc.frequency.value = freq;

    const maxGain = 0.2;
    const nowGain = 0.001;

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(maxGain, startTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(nowGain, startTime + 0.25);

    osc.connect(gain).connect(offlineCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.35);
  }

  for (let loop = 0; loop < loopCount; loop++) {
    const loopOffset = loop * TOTAL_STEPS * stepSec;
    for (let step = 0; step < TOTAL_STEPS; step++) {
      const t = loopOffset + step * stepSec;
      for (let p = 0; p < TOTAL_PITCHES; p++) {
        if (pattern[p][step]) {
          renderNote(p, t);
        }
      }
    }
  }

  const rendered = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(rendered);

  const url = URL.createObjectURL(wavBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tiny-sequence.wav";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function audioBufferToWavBlob(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + buffer.length * numOfChan * 2, true);
  writeString(view, 8, "WAVE");

  // FMT sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // SubChunk1Size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numOfChan * 2, true);
  view.setUint16(32, numOfChan * 2, true);
  view.setUint16(34, 16, true); // bits per sample

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, buffer.length * numOfChan * 2, true);

  // interleaved data
  let offset = 44;
  const channels = [];
  for (let i = 0; i < numOfChan; i++) {
    channels.push(buffer.getChannelData(i));
  }

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numOfChan; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const s = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }

  return new Blob([bufferArray], { type: "audio/wav" });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

exportBtn.addEventListener("click", () => {
  renderToWav().catch((e) => {
    console.error(e);
    alert("WAVの書き出し中にエラーが発生しました");
  });
});

// --- パターンのシリアライズ（テキスト出力） ---
function serializePattern() {
  // シンプルに JSON 文字列として出力（将来のロードも想定し、メタ情報も含める）
  const data = {
    version: 1,
    stepsPerBar: STEPS_PER_BAR,
    bars: BARS,
    totalSteps: TOTAL_STEPS,
    octaves: OCTAVES,
    notesPerOctave: NOTES_PER_OCTAVE,
    baseMidiNote: BASE_MIDI_NOTE,
    bpm: Number(bpmInput.value) || 120,
    pattern,
  };
  return JSON.stringify(data, null, 2);
}

if (serializeBtn && patternTextArea) {
  serializeBtn.addEventListener("click", () => {
    patternTextArea.value = serializePattern();
    patternTextArea.focus();
    patternTextArea.select();
  });
}

// --- テキストからパターンを復元 ---
function applyPatternFromData(newPattern) {
  if (!Array.isArray(newPattern)) return;
  // 形だけざっくり検証
  if (newPattern.length !== TOTAL_PITCHES) return;

  // 内部データを更新
  pushHistory();
  pattern = [];
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    pattern[p] = [];
    for (let s = 0; s < TOTAL_STEPS; s++) {
      pattern[p][s] = !!(newPattern[p] && newPattern[p][s]);
    }
  }

  // UI を反映
  const cells = pianorollEl.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const p = Number(cell.dataset.pitch);
    const s = Number(cell.dataset.step);
    const on = !!(pattern[p] && pattern[p][s]);
    cell.classList.toggle("active", on);
  });
}

if (deserializeBtn && patternTextArea) {
  deserializeBtn.addEventListener("click", () => {
    try {
      const text = patternTextArea.value.trim();
      if (!text) {
        alert("テキストエリアにシリアライズされたJSONを貼り付けてください。");
        return;
      }
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.pattern)) {
        alert("pattern フィールドを持つJSONではありません。");
        return;
      }
      applyPatternFromData(data.pattern);
      if (data.bpm) {
        bpmInput.value = String(data.bpm);
      }
    } catch (e) {
      console.error(e);
      alert("JSONのパースに失敗しました。フォーマットを確認してください。");
    }
  });
}


