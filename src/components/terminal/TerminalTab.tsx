import { useMemo } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import XtermCanvas from './XtermCanvas';

export default function TerminalTab(props: IDockviewPanelProps) {
  const sessionId = useMemo(() => props.api.id, [props.api.id]);

  return (
    <div className="h-full w-full bg-zinc-950">
      <XtermCanvas sessionId={sessionId} />
    </div>
  );
}
