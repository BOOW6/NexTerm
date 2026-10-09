import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  createPtySession,
  listenPtyOutput,
  resizePty,
  writePty
} from '../../hooks/useTauriPty';

interface XtermCanvasProps {
  sessionId: string;
}

export default function XtermCanvas({ sessionId }: XtermCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#09090b'
      }
    });

    const fitAddon = new FitAddon();
    const webglAddon = new WebglAddon();

    terminal.loadAddon(fitAddon);

    try {
      terminal.loadAddon(webglAddon);
    } catch {
      webglAddon.dispose();
    }

    terminal.open(containerRef.current);
    fitAddon.fit();

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let ptyId = '';

    const run = async () => {
      ptyId = await createPtySession(terminal.cols, terminal.rows);
      if (disposed) {
        return;
      }

      unlisten = await listenPtyOutput(ptyId, ({ data }) => {
        terminal.write(data);
      });

      terminal.onData((data) => {
        void writePty(ptyId, data);
      });

      terminal.onResize(({ cols, rows }) => {
        void resizePty(ptyId, cols, rows);
      });
    };

    void run();

    const onWindowResize = () => {
      fitAddon.fit();
      if (ptyId) {
        void resizePty(ptyId, terminal.cols, terminal.rows);
      }
    };

    window.addEventListener('resize', onWindowResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      unlisten?.();
      terminal.dispose();
    };
  }, [sessionId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
