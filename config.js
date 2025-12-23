// シーケンサー設定
const STEPS_PER_BAR = 16; // 16分音符
const BARS = 4;
const TOTAL_STEPS = STEPS_PER_BAR * BARS; // 64
const OCTAVES = 2;
const NOTES_PER_OCTAVE = 12;
const TOTAL_PITCHES = OCTAVES * NOTES_PER_OCTAVE; // 24
const BASE_MIDI_NOTE = 60; // C4 を下のオクターブにするため、行0がC4+12になる

const MIN_CHORD_STEPS = 4; // 最小長さ（16分音符4つ = 1拍）くらいに制限

const PITCH_CLASS_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const DISPLAY_MODE_CHORD = "chord";
const DISPLAY_MODE_BERKLEE = "berklee";

const MAX_HISTORY = 100;

