import { create } from 'zustand';
import { loadCustomThemes, type CustomThemeDefinition, type ThemeScanError } from './customThemes';

interface CustomThemesState {
  themes: CustomThemeDefinition[];
  errors: ThemeScanError[];
  loading: boolean;
  /** True once the first scan attempt finished (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
}

// Shared across windows' concurrent mounts (ThemeProvider + settings window
// both trigger a load on mount); a single in-flight scan covers them all.
let inflight: Promise<void> | null = null;

export const useCustomThemesStore = create<CustomThemesState>()((set) => ({
  themes: [],
  errors: [],
  loading: false,
  loaded: false,
  load: () => {
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      set({ loading: true });
      try {
        const scan = await loadCustomThemes();
        set({ themes: scan.themes, errors: scan.errors, loading: false, loaded: true });
      } catch {
        // Keep whatever data is present; the scan is retried on the next
        // `themes-changed` event or explicit refresh.
        set({ loading: false, loaded: true });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }
}));
