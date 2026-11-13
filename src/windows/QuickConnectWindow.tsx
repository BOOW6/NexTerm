import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../components/ui/button';
import { Input, Label } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { cancelModal, getModalPayload, submitModal } from '../lib/appWindows';
import {
  formatShellArgs,
  loadLocalShellCatalog,
  matchLocalShellPreset,
  normalizeShellCommand,
  splitShellArgs,
  type LocalShellCatalog
} from '../lib/localShells';
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
  certPath: string;
  passphrase: string;
  jumpSessionId: string;
  shellPreset: string;
  shellCommand: string;
  shellArgs: string;
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
  certPath: '',
  passphrase: '',
  jumpSessionId: '',
  shellPreset: 'default',
  shellCommand: '',
  shellArgs: '',
  group: DEFAULT_GROUP
};

/** Display names for the shell preset labelKeys (migrated to i18n with the window). */
const SHELL_LABELS: Record<string, string> = {
  'localShell.default': '系统默认',
  'localShell.powershell': 'Windows PowerShell',
  'localShell.pwsh': 'PowerShell 7',
  'localShell.wsl': 'WSL',
  'localShell.gitbash': 'Git Bash',
  'localShell.cmd': '命令提示符',
  'localShell.bash': 'Bash',
  'localShell.zsh': 'Zsh',
  'localShell.fish': 'Fish'
};

export default function QuickConnectWindow() {
  const [payload, setPayload] = useState<QuickConnectPayload | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<LocalShellCatalog | null>(null);
  const shellInitializedRef = useRef(false);

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
          certPath: data.session.certPath ?? '',
          passphrase: '',
          jumpSessionId: data.session.jumpSessionId ?? '',
          shellPreset: data.session.shellCommand ? 'custom' : 'default',
          shellCommand: data.session.shellCommand ?? '',
          shellArgs: formatShellArgs(data.session.shellArgs ?? []),
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

  useEffect(() => {
    let cancelled = false;
    void loadLocalShellCatalog()
      .then((loaded) => {
        if (!cancelled) {
          setCatalog(loaded);
        }
      })
      .catch(() => {
        /* probe unavailable — the select falls back to the default shell */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Map an edited session's stored shell back to a preset once the catalog
  // (and its probe results) has loaded; runs once per modal.
  useEffect(() => {
    if (!payload || !catalog || shellInitializedRef.current) {
      return;
    }
    shellInitializedRef.current = true;
    const session = payload.session;
    if (session?.kind === 'local' && session.shellCommand) {
      const presetId = matchLocalShellPreset(
        session.shellCommand,
        session.shellArgs ?? [],
        catalog
      );
      setForm((current) => ({
        ...current,
        shellPreset: presetId,
        shellCommand: session.shellCommand ?? '',
        shellArgs: formatShellArgs(session.shellArgs ?? [])
      }));
    }
  }, [payload, catalog]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const isRemote = form.kind !== 'local';
  // Telnet authenticates in-band after connecting; only SSH/SFTP sessions
  // carry NexTerm-side credentials and jump hosts.
  const hasAuth = form.kind === 'ssh' || form.kind === 'sftp';

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

  const browseCert = async () => {
    try {
      const selected = await openDialog({ multiple: false, title: '选择证书文件' });
      if (typeof selected === 'string') {
        update('certPath', selected);
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
    if (!isRemote && form.shellPreset === 'custom' && !normalizeShellCommand(form.shellCommand)) {
      setError('请填写自定义 Shell 的可执行文件');
      return;
    }
    if (hasAuth && form.authMethod === 'key' && !form.keyPath.trim()) {
      setError('请选择私钥文件');
      return;
    }
    if (hasAuth && form.authMethod === 'certificate' && !form.keyPath.trim()) {
      setError('请选择证书对应的私钥文件');
      return;
    }
    if (hasAuth && form.authMethod === 'certificate' && !form.certPath.trim()) {
      setError('请选择证书文件（*-cert.pub）');
      return;
    }
    if (isRemote && form.port) {
      const port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setError('端口必须是 1–65535 之间的数字');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const shellForDraft = (() => {
        if (isRemote) {
          return { shellCommand: '', shellArgs: [] as string[] };
        }
        if (form.shellPreset === 'custom') {
          return {
            shellCommand: normalizeShellCommand(form.shellCommand),
            shellArgs: splitShellArgs(form.shellArgs)
          };
        }
        const resolved = catalog?.commands[form.shellPreset];
        return {
          shellCommand: resolved?.command ?? '',
          shellArgs: resolved?.args ?? []
        };
      })();
      await submitModal({
        draft: {
          kind: form.kind,
          title: form.title,
          host: form.host,
          username: form.username,
          port: form.port ? Number(form.port) : undefined,
          authMethod: hasAuth ? form.authMethod : undefined,
          keyPath: hasAuth ? form.keyPath : '',
          certPath: hasAuth ? form.certPath : '',
          jumpSessionId: hasAuth ? form.jumpSessionId : '',
          shellCommand: shellForDraft.shellCommand,
          shellArgs: shellForDraft.shellArgs,
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
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
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
              <option value="telnet">{SESSION_KIND_LABEL.telnet}</option>
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

          {!isRemote ? (
            <>
              <div>
                <Label htmlFor="session-shell">Shell</Label>
                <Select
                  id="session-shell"
                  value={form.shellPreset}
                  onChange={(event) => update('shellPreset', event.target.value)}
                >
                  {(catalog?.presets ?? [{ id: 'default', labelKey: 'localShell.default' }]).map(
                    (preset) => (
                      <option
                        key={preset.id}
                        value={preset.id}
                        disabled={preset.available === false}
                      >
                        {SHELL_LABELS[preset.labelKey] ?? preset.labelKey}
                        {preset.available === false ? '（未检测到）' : ''}
                      </option>
                    )
                  )}
                  <option value="custom">自定义 Shell…</option>
                </Select>
                <p className="mt-1 text-[11px] text-muted">
                  本地会话启动的 Shell；「系统默认」在 Windows 上为 cmd.exe，其他平台跟随登录
                  Shell。
                </p>
              </div>
              {form.shellPreset === 'custom' ? (
                <>
                  <div>
                    <Label htmlFor="session-shell-command">可执行文件</Label>
                    <Input
                      id="session-shell-command"
                      value={form.shellCommand}
                      onChange={(event) => update('shellCommand', event.target.value)}
                      placeholder="pwsh.exe 或 C:\Program Files\Git\bin\bash.exe"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <Label htmlFor="session-shell-args">启动参数（可选）</Label>
                    <Input
                      id="session-shell-args"
                      value={form.shellArgs}
                      onChange={(event) => update('shellArgs', event.target.value)}
                      placeholder="--cd ~（空格分隔，双引号包裹含空格的参数）"
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : null}
            </>
          ) : null}

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
                    onChange={(event) => update('port', event.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="22"
                    inputMode="numeric"
                  />
                </div>
              </div>

              {hasAuth ? (
                <>
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
                      <option value="certificate">OpenSSH 证书</option>
                      <option value="agent">SSH Agent</option>
                    </Select>
                  </div>

                  {form.authMethod === 'agent' ? (
                    <div className="rounded-sm border border-border bg-background-alt px-2 py-2 text-[11px] text-muted">
                      连接时使用系统 SSH Agent 中的密钥，无需在 NexTerm 中保存凭据。
                    </div>
                  ) : form.authMethod === 'password' ? (
                    <div>
                      <Label htmlFor="session-password">密码</Label>
                      <Input
                        id="session-password"
                        type="password"
                        value={form.password}
                        onChange={(event) => update('password', event.target.value)}
                        placeholder={payload?.session ? '留空则沿用内存中的密码' : '仅保存在内存中'}
                        autoComplete="new-password"
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        <Label htmlFor="session-key-path">
                          {form.authMethod === 'certificate' ? '证书对应私钥' : '私钥文件'}
                        </Label>
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

                      {form.authMethod === 'certificate' ? (
                        <div>
                          <Label htmlFor="session-cert-path">证书文件</Label>
                          <div className="flex items-stretch gap-1">
                            <Input
                              id="session-cert-path"
                              value={form.certPath}
                              onChange={(event) => update('certPath', event.target.value)}
                              placeholder="~/.ssh/id_ed25519-cert.pub"
                              autoComplete="off"
                              className="flex-1"
                            />
                            <Button
                              size="icon"
                              variant="secondary"
                              aria-label="选择证书文件"
                              title="选择证书文件"
                              onClick={() => void browseCert()}
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <p className="mt-1 text-[11px] text-muted">
                            使用 OpenSSH 用户证书（ssh-keygen 签发的
                            *-cert.pub）认证，服务器需信任对应的 CA。
                          </p>
                        </div>
                      ) : null}

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
              ) : (
                <p className="rounded-sm border border-border bg-background-alt px-2 py-2 text-[11px] text-muted">
                  Telnet 连接建立后按服务器提示在终端内登录，NexTerm 不保存凭据。
                </p>
              )}
            </>
          ) : null}

          {hasAuth && payload?.jumpCandidates.length ? (
            <div>
              <Label htmlFor="session-jump">跳板机（可选）</Label>
              <Select
                id="session-jump"
                value={form.jumpSessionId}
                onChange={(event) => update('jumpSessionId', event.target.value)}
              >
                <option value="">无</option>
                {payload.jumpCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[11px] text-muted">
                连接将经由所选会话的主机转发（ProxyJump），跳板机的认证沿用其自身配置。
              </p>
            </div>
          ) : null}

          <div>
            <Label htmlFor="session-group">分组</Label>
            <Input
              id="session-group"
              value={form.group}
              onChange={(event) => update('group', event.target.value)}
              placeholder={`${DEFAULT_GROUP}（支持 服务器/生产 这样的多级分组）`}
            />
          </div>

          {error ? <p className="text-xs text-error">{error}</p> : null}
        </form>
      </div>

      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
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
