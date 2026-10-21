import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';
import type { HostKeyMismatchPayload, HostKeyPromptPayload } from '../hooks/useTauriSsh';

type HostKeyPayload =
  | { mode: 'prompt'; prompt: HostKeyPromptPayload }
  | { mode: 'mismatch'; mismatch: HostKeyMismatchPayload };

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <span className="selectable min-w-0 break-all font-mono text-foreground">{value}</span>
    </div>
  );
}

export default function HostKeyWindow() {
  const [payload, setPayload] = useState<HostKeyPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getModalPayload<HostKeyPayload>().then((data) => {
      if (!cancelled) {
        setPayload(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!payload) {
    return <div className="h-full bg-background" />;
  }

  if (payload.mode === 'mismatch') {
    return (
      <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2 rounded-sm border border-error/40 bg-error/10 px-2.5 py-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-error" />
            <span className="text-[11px] text-error">
              该主机当前密钥与已保存记录不一致，连接已中止。请勿在未确认服务器变更的情况下继续连接。
            </span>
          </div>
          <Field label="主机" value={payload.mismatch.host} />
          <div className="rounded-sm border border-border bg-background-alt p-2">
            <p className="mb-1 text-[10px] text-muted">已保存指纹</p>
            <p className="selectable break-all font-mono text-[11px] text-foreground">
              {payload.mismatch.expected}
            </p>
          </div>
          <div className="rounded-sm border border-border bg-background-alt p-2">
            <p className="mb-1 text-[10px] text-muted">服务器当前指纹</p>
            <p className="selectable break-all font-mono text-[11px] text-foreground">
              {payload.mismatch.actual}
            </p>
          </div>
          <p className="text-[10px] text-muted-foreground">
            如确认服务器已重装或更换密钥，请在「设置 → 安全」中删除该记录后重新连接。
          </p>
        </div>
        <div className="app-dialog-footer flex justify-end border-t border-border bg-background-alt px-5 py-3">
          <Button variant="secondary" onClick={() => void cancelModal()}>
            关闭
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-2 rounded-sm border border-border bg-background-alt px-2.5 py-2">
          <ShieldQuestion className="h-4 w-4 shrink-0 text-warning" />
          <span className="text-[11px] text-muted">请与服务器管理员核对以下指纹</span>
        </div>
        <Field label="主机" value={`${payload.prompt.host}:${payload.prompt.port}`} />
        <Field label="算法" value={payload.prompt.algorithm} />
        <div className="rounded-sm border border-border bg-background-alt p-2">
          <p className="mb-1 text-[10px] text-muted">SHA256 指纹</p>
          <p className="selectable break-all font-mono text-[11px] text-foreground">
            {payload.prompt.fingerprint}
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground">
          信任后会写入 known_hosts，后续连接将自动校验。
        </p>
      </div>
      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" onClick={() => void submitModal(false)}>
          取消连接
        </Button>
        <Button variant="primary" onClick={() => void submitModal(true)}>
          信任并连接
        </Button>
      </div>
    </div>
  );
}
