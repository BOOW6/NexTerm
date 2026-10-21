import { create } from 'zustand';
import { listSystemFonts, type SystemFontFamily } from '../lib/systemFonts';

interface FontCatalogState {
  families: SystemFontFamily[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useFontCatalogStore = create<FontCatalogState>((set, get) => ({
  families: [],
  loading: false,
  loaded: false,
  error: null,
  load: async () => {
    if (get().loaded) {
      return;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      set({ loading: true, error: null });
      try {
        const families = await listSystemFonts();
        set({ families, loaded: true });
      } catch (error) {
        set({ error: String(error) });
      } finally {
        set({ loading: false });
        inFlight = null;
      }
    })();

    return inFlight;
  },
  refresh: async () => {
    set({ loaded: false, error: null });
    await get().load();
  }
}));
