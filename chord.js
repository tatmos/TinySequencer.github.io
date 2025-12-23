// コードトラックとコード検出

// コードネーム用のデータ（ステップ数で長さを管理・合計でTOTAL_STEPSになる）
/** @type {{ lengthSteps: number }[]} */
let chords = [
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
  { lengthSteps: STEPS_PER_BAR },
];

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

function getPitchClassesForRange(startStep, endStep) {
  /** @type {Set<number>} */
  const pitchClasses = new Set();

  for (let p = 0; p < TOTAL_PITCHES; p++) {
    for (let s = startStep; s < endStep; s++) {
      if (hasNoteAtStep(p, s)) {
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

