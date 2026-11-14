import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface MacroStep {
  /** Keystroke chunk exactly as the terminal delivered it. */
  data: string;
  /** Pause before this chunk (ms), capped at 3000 to skip dead time. */
  delayMs: number;
}

export interface Macro {
  id: string;
  name: string;
  steps: MacroStep[];
  createdAt: number;
}

interface MacroState {
  macros: Macro[];
  save: (name: string, steps: MacroStep[]) => Macro;
  remove: (id: string) => void;
}

export const MACRO_DELAY_CAP_MS = 3000;

export const useMacroStore = create<MacroState>()(
  persist(
    (set) => ({
      macros: [],

      save: (name, steps) => {
        const macro: Macro = {
          id: crypto.randomUUID(),
          name: name.trim() || 'Macro',
          steps,
          createdAt: Date.now()
        };
        set((state) => ({ macros: [...state.macros, macro] }));
        return macro;
      },

      remove: (id) => {
        set((state) => ({ macros: state.macros.filter((macro) => macro.id !== id) }));
      }
    }),
    { name: 'nexterm.macros.v1' }
  )
);

/** Transient recorder state (never persisted). */
interface RecorderState {
  recording: boolean;
  steps: MacroStep[];
  lastAt: number;
  start: () => void;
  record: (data: string) => void;
  /** Stops recording and returns the captured steps (may be empty). */
  stop: () => MacroStep[];
}

export const useMacroRecorderStore = create<RecorderState>((set, get) => ({
  recording: false,
  steps: [],
  lastAt: 0,

  start: () => set({ recording: true, steps: [], lastAt: 0 }),

  record: (data) => {
    const { recording, steps, lastAt } = get();
    if (!recording || !data) {
      return;
    }
    const now = Date.now();
    const delayMs = lastAt === 0 ? 0 : Math.min(now - lastAt, MACRO_DELAY_CAP_MS);
    set({ steps: [...steps, { data, delayMs }], lastAt: now });
  },

  stop: () => {
    const steps = get().steps;
    set({ recording: false, steps: [], lastAt: 0 });
    return steps;
  }
}));

/** Record one keystroke chunk when a recording is active (XtermCanvas hot path). */
export function recordKeystroke(data: string): void {
  const recorder = useMacroRecorderStore.getState();
  if (recorder.recording) {
    recorder.record(data);
  }
}
