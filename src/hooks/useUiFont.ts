import { useLayoutEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

export function useUiFont(): void {
  const fontFamily = useSettingsStore((state) => state.uiFontFamily);
  const ligatures = useSettingsStore((state) => state.uiFontLigatures);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--ui-font-family', fontFamily);
    root.style.setProperty('--ui-font-ligatures', ligatures ? 'normal' : 'none');
    root.style.setProperty(
      '--ui-font-feature-settings',
      ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0'
    );
  }, [fontFamily, ligatures]);
}
