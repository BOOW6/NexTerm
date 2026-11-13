import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { getTerminalTheme } from '../../theme/terminalTheme';
import { NativeLigaturesAddon } from '../../theme/nativeLigaturesAddon';
import { useTheme } from '../../theme/useTheme';
import { tStatic } from '../../i18n';
import type { TerminalCursorStyle } from '../../stores/settingsStore';

interface TerminalPreviewProps {
  visible: boolean;
  fontFamily: string;
  fontLigatures: boolean;
  fontFeatureSettings: string;
  colorScheme: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  scrollback: number;
}

const SAFE_FONT = 'ui-monospace, monospace';

export default function TerminalPreview({
  visible,
  fontFamily,
  fontLigatures,
  fontFeatureSettings,
  colorScheme,
  fontSize,
  lineHeight,
  cursorStyle,
  cursorBlink,
  scrollback
}: TerminalPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ligaturesRef = useRef<NativeLigaturesAddon | null>(null);
  const fontReadyRef = useRef(false);
  const fontFamilyRef = useRef(fontFamily);
  const { themeId } = useTheme();

  useEffect(() => {
    fontFamilyRef.current = fontFamily;
  }, [fontFamily]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let initFrame: number | null = null;
    let resizeFrame: number | null = null;
    let applyTimer: number | null = null;

    const applyConfiguredFont = async () => {
      try {
        await document.fonts.load(`${fontSize}px ${fontFamilyRef.current}`);
      } catch {
        /* fall back to the safe font */
      }
      if (disposed || !terminal) {
        return;
      }
      terminal.options.fontFamily = fontFamilyRef.current;
      fontReadyRef.current = true;
      try {
        fitAddon?.fit();
      } catch {
        /* ignore transient resize errors */
      }
    };

    const initialize = () => {
      initFrame = null;
      if (disposed) {
        return;
      }

      fontReadyRef.current = false;

      const instance = new Terminal({
        allowProposedApi: true,
        cursorBlink,
        cursorStyle,
        fontFamily: SAFE_FONT,
        fontSize,
        lineHeight,
        scrollback,
        disableStdin: true,
        theme: getTerminalTheme(colorScheme)
      });
      terminal = instance;

      const fit = new FitAddon();
      instance.loadAddon(fit);
      fitAddon = fit;

      instance.open(container);

      if (fontLigatures) {
        try {
          const addon = new NativeLigaturesAddon({ featureSettings: fontFeatureSettings });
          instance.loadAddon(addon);
          ligaturesRef.current = addon;
        } catch {
          ligaturesRef.current = null;
        }
      }

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (webglAddon === webgl) {
            webglAddon = null;
          }
        });
        instance.loadAddon(webgl);
        webglAddon = webgl;
      } catch {
        webglAddon = null;
      }

      instance.write(
        `${tStatic('settings.terminal.previewTitle')}\r\n$ git status\r\nOn branch main\r\nnothing to commit, working tree clean\r\n$ echo "-> => != === >= <="\r\n-> => != === >= <=\r\n$ `
      );

      terminalRef.current = instance;
      fitRef.current = fit;

      try {
        fit.fit();
      } catch {
        /* ignore transient resize errors */
      }

      // Let the tab switch paint first. The actual font is preloaded by the
      // settings window, so applying it here is normally cheap.
      applyTimer = window.setTimeout(() => void applyConfiguredFont(), 250);
    };

    initFrame = requestAnimationFrame(initialize);

    const observer = new ResizeObserver(() => {
      if (disposed || resizeFrame !== null) {
        return;
      }
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (disposed || container.clientWidth === 0 || container.clientHeight === 0) {
          return;
        }
        try {
          fitAddon?.fit();
        } catch {
          /* ignore transient resize errors */
        }
      });
    });
    observer.observe(container);

    return () => {
      disposed = true;
      if (initFrame !== null) {
        cancelAnimationFrame(initFrame);
      }
      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
      }
      if (applyTimer !== null) {
        window.clearTimeout(applyTimer);
      }
      observer.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      fitAddon?.dispose();
      ligaturesRef.current?.dispose();
      ligaturesRef.current = null;
      webglAddon?.dispose();
      terminal?.dispose();
    };
    // The terminal is only mounted while the preview tab is visible; option
    // changes are applied by the effects below. Ligatures require a fresh
    // renderer, so toggling them remounts the preview terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fontLigatures]);

  // Feature settings only affect the ligatures addon: rebuilding it alone
  // keeps typing in the settings field from churning the terminal and its
  // WebGL context on every keystroke.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !visible) {
      return;
    }
    ligaturesRef.current?.dispose();
    ligaturesRef.current = null;
    if (fontLigatures) {
      try {
        const addon = new NativeLigaturesAddon({ featureSettings: fontFeatureSettings });
        terminal.loadAddon(addon);
        ligaturesRef.current = addon;
      } catch {
        /* fall back to the default shaping */
      }
    }
    // The terminal mount is managed by the effect above (which also runs on
    // fontLigatures changes); this one only tracks the feature settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontFeatureSettings]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.scrollback = scrollback;
    if (fontReadyRef.current) {
      terminal.options.fontFamily = fontFamily;
    }
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore transient resize errors */
    }
  }, [fontFamily, fontSize, lineHeight, cursorStyle, cursorBlink, scrollback]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme(colorScheme);
    }
  }, [colorScheme, themeId]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore transient resize errors */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      data-native-context-menu
      className="h-40 w-full overflow-hidden rounded-sm border border-border bg-[hsl(var(--terminal-background))] p-1"
    />
  );
}
