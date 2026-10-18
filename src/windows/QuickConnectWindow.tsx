import { useEffect, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../components/ui/button';
import { Input, Label } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';
import {
  DEFAULT_GROUP,
  SESSION_KIND_LABEL,
  type SessionAuthMethod,
  type SessionKind
} from '../types/session';
import type {
  QuickConnectPayload,
  QuickConnectResult
} from '../features/workspace/useQuickConnectLauncher';

interface FormState {
  kind: SessionKind;
  title: string;
  host: string;
  port: string;
  username: string;
  authMethod: SessionAuthMethod;
  password: string;
  keyPath: string;
  passphrase: string;
  group: string;
}

const EMPTY_FORM: FormState = {
  kind: 'local',
  title: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keyPath: '',
  passphrase: '',
  group: DEFAULT_GROUP
};

export default function QuickConnectWindow() {
  const [payload, setPayload] = useState<QuickConnectPayload | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getModalPayload<QuickConnectPayload>().then((data) => {
      if (cancelled || !data) {
        return;
      }
      setPayload(data);
      if (data.session) {
        setForm({
          kind: data.session.kind,
          title: data.session.title,
          host: data.session.host ?? '',
          port: data.session.port ? String(data.session.port) : '22',
          username: data.session.username ?? '',
          authMethod: data.session.authMethod ?? 'password',
          password: '',
          keyPath: data.session.keyPath ?? '',
          passphrase: '',
          group: data.session.group
        });
      } else {
        setForm({
          ...EMPTY_FORM,
          kind: data.defaults.kind,
          authMethod: data.defaults.authMethod,
          port: String(data.defaults.port),
          username: data.defaults.username
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const isRemote = form.kind !== 'local';

  const browseKey = async () => {
    try {
      const selected = await openDialog({ multiple: false, title: '选择私钥文件' });
      if (typeof selected === 'string') {
        update('keyPath', selected);
      }
    } catch {
      /* dialog unavailable */
    }
  };

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!payload) {
      return;
    }
    if (isRemote && !form.host.trim()) {
      setError('请填写主机地址');
      return;
    }
    if (isRemote && form.authMethod === 'key' && !form.keyPath.trim()) {
      setError('请选择私钥文件');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await submitModal({
        draft: {
          kind: form.kind,
          title: form.title,
          host: form.host,
          username: form.username,
          port: form.port ? Number(form.port) : undefined,
          authMethod: form.authMethod,
          keyPath: form.keyPath,
          group: form.group
        },
        password: form.password,
        passphrase: form.passphrase
      } satisfies QuickConnectResult);
    } catch (reason) {
      setBusy(false);
      setError(String(reason));
    }
  };

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <div>
            <Label htmlFor="session-kind">类型</Label>
            <Select
              id="session-kind"
              value={form.kind}
              onChange={(event) => update('kind', event.target.value as SessionKind)}
            >
              <option value="local">{SESSION_KIND_LABEL.local}</option>
              <option value="ssh">{SESSION_KIND_LABEL.ssh}</option>
              <option value="sftp">{SESSION_KIND_LABEL.sftp}</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="session-title">名称</Label>
            <Input
              id="session-title"
              value={form.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder={isRemote ? '例如：生产服务器' : '例如：本地终端'}
            />
          </div>

          {isRemote ? (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <div>
                  <Label htmlFor="session-host">主机</Label>
                  <Input
                    id="session-host"
                    value={form.host}
                    onChange={(event) => update('host', event.target.value)}
                    placeholder="example.com 或 192.168.1.10"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="session-port">端口</Label>
                  <Input
                    id="session-port"
                    value={form.port}
                    onChange={(event) =>
                      update('port', event.target.value.replace(/[^0-9]/g, ''))
                    }
                    placeholder="22"
                    inputMode="numeric"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="session-username">用户名</Label>
                <Input
                  id="session-username"
                  value={form.username}
                  onChange={(event) => update('username', event.target.value)}
                  placeholder="root"
                  autoComplete="off"
                />
              </div>

              <div>
                <Label htmlFor="session-auth-method">认证方式</Label>
                <Select
                  id="session-auth-method"
                  value={form.authMethod}
                  onChange={(event) =>
                    update('authMethod', event.target.value as SessionAuthMethod)
                  }
                >
                  <option value="password">密码</option>
                  <option value="key">私钥</option>
                </Select>
              </div>

              {form.authMethod === 'password' ? (
                <div>
                  <Label htmlFor="session-password">密码</Label>
                  <Input
                    id="session-password"
                    type="password"
                    value={form.password}
                    onChange={(event) => update('password', event.target.value)}
                    placeholder={
                      payload?.session ? '留空则沿用内存中的密码' : '仅保存在内存中'
                    }
                    autoComplete="new-password"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <Label htmlFor="session-key-path">私钥文件</Label>
                    <div className="flex items-stretch gap-1">
                      <Input
                        id="session-key-path"
                        value={form.keyPath}
                        onChange={(event) => update('keyPath', event.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        autoComplete="off"
                        className="flex-1"
                      />
                      <Button
                        size="icon"
                        variant="secondary"
                        aria-label="选择私钥文件"
                        title="选择私钥文件"
                        onClick={() => void browseKey()}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="session-passphrase">私钥口令（可选）</Label>
                    <Input
                      id="session-passphrase"
                      type="password"
                      value={form.passphrase}
                      onChange={(event) => update('passphrase', event.target.value)}
                      placeholder="加密私钥需要填写"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
            </>
          ) : null}

          <div>
            <Label htmlFor="session-group">分组</Label>
            <Input
              id="session-group"
              value={form.group}
              onChange={(event) => update('group', event.target.value)}
              placeholder={DEFAULT_GROUP}
            />
          </div>

          {error ? <p className="text-xs text-error">{error}</p> : null}
        </form>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" onClick={() => void cancelModal()}>
          取消
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void handleSubmit()}>
          {payload?.session ? '保存' : '连接'}
        </Button>
      </div>
    </div>
  );
}
