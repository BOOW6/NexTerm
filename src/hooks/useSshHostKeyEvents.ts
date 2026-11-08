import { useEffect } from 'react';
import { openModalWindow } from '../lib/appWindows';
import { toast } from '../components/ui/toastStore';
import {
  listenHostKeyMismatch,
  listenHostKeyPrompt,
  listenHostKeyTimeout,
  respondHostKey
} from './useTauriSsh';

export function useSshHostKeyEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let disposers: Array<() => void> = [];

    Promise.all([
      listenHostKeyPrompt((payload) => {
        void openModalWindow<boolean>('host-key', {
          title: '未知主机密钥',
          width: 520,
          height: 520,
          data: { mode: 'prompt', prompt: payload }
        }).then((accepted) => {
          void respondHostKey(payload.request_id, accepted === true).catch(() => undefined);
        });
      }),
      listenHostKeyMismatch((payload) => {
        void openModalWindow('host-key', {
          title: '主机密钥不匹配',
          width: 560,
          height: 540,
          data: { mode: 'mismatch', mismatch: payload }
        });
      }),
      listenHostKeyTimeout((payload) => {
        toast({
          title: `主机密钥确认超时：${payload.host}:${payload.port}`,
          description: '指纹确认窗口已关闭，连接已取消，可重新发起连接。',
          variant: 'warning'
        });
      })
    ])
      .then(([disposePrompt, disposeMismatch, disposeTimeout]) => {
        if (cancelled) {
          disposePrompt();
          disposeMismatch();
          disposeTimeout();
        } else {
          disposers = [disposePrompt, disposeMismatch, disposeTimeout];
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, []);
}
