// Undo/Redo機能

// Undo 用の履歴
/** @type {boolean[][][]} */
let history = [];
let historyIndex = -1;

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
  renderPianoRoll();

  clearCellSelection();
  renderChordTrack();
}

function canUndo() {
  return historyIndex > 0 && history.length > 0;
}

function canRedo() {
  return historyIndex < history.length - 1;
}

