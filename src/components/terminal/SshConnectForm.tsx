import { useState, type FormEvent } from 'react';
import { KeyRound, Pencil } from 'lucide-react';
import { useCredentialStore } from '../../stores/credentialStore';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { sessionSubtitle, type Session } from '../../types/session';
import { Button } from '../ui/button';
import { Input, Label } from '../ui/input';

export default function SshConnectForm({ session }: { session: Session }) {
  const setPassword = useCredentialStore((state) => state.setPassword);
  const setPassphrase = useCredentialStore((state) => state.setPassphrase);
  const authorize = useCredentialStore((state) => state.authorize);
  const openQuickConnect = useQuickConnectLauncher();

  const authMethod = session.authMethod ?? 'password';
  const keyPath = session.keyPath ?? '';

  const [password, setPasswordValue] = useState('');
  const [passphrase, setPassphraseValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (authMethod === 'password') {
      if (!password) {
        setError('请输入密码');
        return;
      }
      setPassword(session.id, password);
    } else {
      if (!keyPath) {
        setError('请先在「编辑连接」中选择私钥文件');
        return;
      }
      setPassphrase(session.id, passphrase);
    }

    setError(null);
    authorize(session.id);
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm overflow-hidden rounded-sm border border-border-strong bg-surface-elevated shadow-panel"
      >
        <div className="app-dialog-header border-b border-border bg-panel-title px-3 py-2 text-xs font-semibold text-foreground">
          <span className="app-dialog-title">
            {authMethod === 'password' ? 'SSH 登录' : 'SSH 密钥认证'}
          </span>
        </div>

        <div className="space-y-2.5 p-4">
          <div className="rounded-sm border border-border bg-background-alt px-2 py-1 text-[11px] text-muted">
            <p className="font-medium text-foreground">{session.title}</p>
            <p className="font-mono">{sessionSubtitle(session)}</p>
          </div>

          {authMethod === 'password' ? (
            <div>
              <Label htmlFor="ssh-password">密码</Label>
              <Input
                id="ssh-password"
                type="password"
                autoFocus
                value={password}
                onChange={(event) => setPasswordValue(event.target.value)}
                placeholder="输入登录密码"
                autoComplete="new-password"
              />
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="ssh-key-path">私钥</Label>
                <Input id="ssh-key-path" value={keyPath || '未选择私钥'} readOnly />
              </div>
              <div>
                <Label htmlFor="ssh-passphrase">私钥口令（可选）</Label>
                <Input
                  id="ssh-passphrase"
                  type="password"
                  autoFocus
                  value={passphrase}
                  onChange={(event) => setPassphraseValue(event.target.value)}
                  placeholder="加密私钥需要填写"
                  autoComplete="off"
                />
              </div>
            </>
          )}

          {error ? <p className="text-[11px] text-error">{error}</p> : null}

          <p className="text-[10px] text-muted-foreground">
            凭据仅保存在内存中，退出应用后需重新输入。
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-border bg-background-alt px-4 py-2">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => void openQuickConnect({ sessionId: session.id })}
          >
            <Pencil className="h-3 w-3" />
            编辑连接
          </Button>
          <Button size="sm" variant="primary" type="submit">
            <KeyRound className="h-3 w-3" />
            连接
          </Button>
        </div>
      </form>
    </div>
  );
}
