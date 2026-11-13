import { useState } from 'react';
import { useI18n } from '../../i18n';
import { formatShortcutFromEvent } from '../../lib/shortcuts';
import { Input } from '../ui/input';

interface ShortcutInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function ShortcutInput({ value, onChange }: ShortcutInputProps) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);

  return (
    <Input
      readOnly
      value={recording ? '' : value}
      placeholder={recording ? t('settings.shortcuts.recordPlaceholder') : ''}
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
      size="compact"
      width={160}
      aria-label={t('settings.shortcuts.inputAria')}
    />
  );
}
