// パターン管理

/** @type {{ startStep: number; length: number }[][]} [pitch][noteIndex] */
let pattern = [];

// MIDIノート番号をラベルに変換
function midiToLabel(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const name = names[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

// パターン初期化
function initPattern() {
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    pattern[p] = [];
  }
}

// ノートが指定されたステップに存在するかチェックするヘルパー関数
function hasNoteAtStep(pitch, step) {
  if (!pattern[pitch]) return false;
  return pattern[pitch].some(note => step >= note.startStep && step < note.startStep + note.length);
}

// ノートを取得するヘルパー関数
function getNoteAtStep(pitch, step) {
  if (!pattern[pitch]) return null;
  return pattern[pitch].find(note => step >= note.startStep && step < note.startStep + note.length) || null;
}

// ノートを追加するヘルパー関数
function addNote(pitch, startStep, length = 1) {
  if (!pattern[pitch]) pattern[pitch] = [];
  // 既存のノートと重複しないようにチェック
  const overlaps = pattern[pitch].some(note => {
    return !(startStep + length <= note.startStep || startStep >= note.startStep + note.length);
  });
  if (!overlaps) {
    pattern[pitch].push({ startStep, length });
    // startStep でソート
    pattern[pitch].sort((a, b) => a.startStep - b.startStep);
  }
}

// ノートを削除するヘルパー関数
function removeNoteAtStep(pitch, step) {
  if (!pattern[pitch]) return;
  const index = pattern[pitch].findIndex(note => step >= note.startStep && step < note.startStep + note.length);
  if (index !== -1) {
    pattern[pitch].splice(index, 1);
  }
}

// ノートの長さを変更するヘルパー関数
function resizeNote(pitch, step, newLength) {
  if (!pattern[pitch]) return;
  const note = getNoteAtStep(pitch, step);
  if (note && newLength > 0) {
    // 新しい長さが他のノートと重複しないかチェック
    const endStep = note.startStep + newLength;
    const overlaps = pattern[pitch].some(n => {
      return n !== note && !(endStep <= n.startStep || note.startStep >= n.startStep + n.length);
    });
    if (!overlaps && endStep <= TOTAL_STEPS) {
      note.length = newLength;
    }
  }
}

// パターンをクローンする関数
function clonePattern(src) {
  const result = [];
  for (let p = 0; p < TOTAL_PITCHES; p++) {
    result[p] = [];
    if (src[p]) {
      for (let i = 0; i < src[p].length; i++) {
        result[p].push({ startStep: src[p][i].startStep, length: src[p][i].length });
      }
    }
  }
  return result;
}

// 最初のノートラベルを取得（ファイル名用）
function getFirstNoteLabel() {
  // 最初の8音（ユニークなピッチクラス）までを含めて返す。なければ空文字。
  /** @type {Set<string>} */
  const pitchClassNames = new Set();
  const MAX_NOTES = 8;
  
  // ステップ0から順に走査して、新しいピッチクラスが見つかったら追加（最大8個まで）
  for (let s = 0; s < TOTAL_STEPS && pitchClassNames.size < MAX_NOTES; s++) {
    for (let p = 0; p < TOTAL_PITCHES && pitchClassNames.size < MAX_NOTES; p++) {
      if (hasNoteAtStep(p, s)) {
        const midi = BASE_MIDI_NOTE - 12 + p;
        const label = midiToLabel(midi);
        // オクターブ番号を除いてピッチクラス名だけを取得（例: "C4" → "C", "C#4" → "C#"）
        const pitchClass = label.replace(/\d+$/, "");
        if (!pitchClassNames.has(pitchClass)) {
          pitchClassNames.add(pitchClass);
          // 8個集まったら終了
          if (pitchClassNames.size >= MAX_NOTES) {
            break;
          }
        }
      }
    }
  }
  
  if (pitchClassNames.size === 0) {
    return "";
  }
  
  // ピッチクラス名をソート（C, C#, D, D#, E, F, F#, G, G#, A, A#, B の順）
  const sorted = Array.from(pitchClassNames).sort((a, b) => {
    const order = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const idxA = order.indexOf(a);
    const idxB = order.indexOf(b);
    return idxA - idxB;
  });
  
  // ハイフンで結合（例: "C-E-G"）
  return sorted.join("-");
}

