import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input, Label } from '../components/ui/input';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';

export interface PromptPayload {
  title: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel: string;
}

export default function PromptWindow() {
  const [payload, setPayload] = useState<PromptPayload | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getModalPayload<PromptPayload>().then((data) => {
      if (!cancelled && data) {
        setPayload(data);
        setValue(data.initialValue);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    try {
      await submitModal(trimmed);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 px-5 py-4">
        <Label htmlFor="prompt-input">{payload?.label ?? '名称'}</Label>
        <Input
          id="prompt-input"
          autoFocus
          value={value}
          placeholder={payload?.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" onClick={() => void cancelModal()}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
        >
          {payload?.confirmLabel ?? '确定'}
        </Button>
      </div>
    </div>
  );
}
