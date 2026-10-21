import { useLayoutEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

export function useUiFont(): void {
  const fontFamily = useSettingsStore((state) => state.uiFontFamily);
  const ligatures = useSettingsStore((state) => state.uiFontLigatures);
  const featureSettings = useSettingsStore((state) => state.uiFontFeatureSettings);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--ui-font-family', fontFamily);
    root.style.setProperty('--ui-font-ligatures', ligatures ? 'normal' : 'none');
    root.style.setProperty(
      '--ui-font-feature-settings',
      ligatures ? featureSettings : '"liga" 0, "calt" 0'
    );
  }, [fontFamily, ligatures, featureSettings]);
}
