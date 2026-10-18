import { useState } from 'react';
import { formatShortcutFromEvent } from '../../lib/shortcuts';
import { Input } from '../ui/input';

interface ShortcutInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function ShortcutInput({ value, onChange }: ShortcutInputProps) {
  const [recording, setRecording] = useState(false);

  return (
    <Input
      readOnly
      value={recording ? '' : value}
      placeholder={recording ? '按下快捷键…' : ''}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
          setRecording(false);
          event.currentTarget.blur();
          return;
        }

        if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
          return;
        }

        const formatted = formatShortcutFromEvent(event.nativeEvent);
        if (formatted) {
          onChange(formatted);
          setRecording(false);
          event.currentTarget.blur();
        }
      }}
      className="h-7 w-40 text-[11px]"
      aria-label="快捷键"
    />
  );
}
