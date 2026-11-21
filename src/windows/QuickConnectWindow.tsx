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
import { listSerialPorts, type SerialPortInfo } from '../hooks/useTauriSerial';
import { useI18n } from '../i18n';
import {
  DEFAULT_GROUP,
  SESSION_KIND_LABEL_KEY,
  type SessionAuthMethod,
  type SessionKind
} from '../types/session';
import { localizeBackendError } from '../lib/backendErrors';
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
  serialPort: string;
  serialBaud: string;
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
  serialPort: '',
  serialBaud: '115200',
  group: DEFAULT_GROUP
};

export default function QuickConnectWindow() {
  const { t } = useI18n();
  const [payload, setPayload] = useState<QuickConnectPayload | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<LocalShellCatalog | null>(null);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
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
          serialPort: data.session.serialPort ?? '',
          serialBaud: data.session.serialBaud ? String(data.session.serialBaud) : '115200',
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
    if (form.kind !== 'serial') {
      return;
    }
    let cancelled = false;
    void listSerialPorts()
      .then((ports) => {
        if (!cancelled) {
          setSerialPorts(ports);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSerialPorts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form.kind]);

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

  const isRemote = form.kind !== 'local' && form.kind !== 'serial';
  const isSerial = form.kind === 'serial';
  // Telnet authenticates in-band after connecting; only SSH/SFTP sessions
  // carry NexTerm-side credentials and jump hosts.
  const hasAuth = form.kind === 'ssh' || form.kind === 'sftp';

  const browseKey = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: t('quickConnect.selectKeyFile')
      });
      if (typeof selected === 'string') {
        update('keyPath', selected);
      }
    } catch {
      /* dialog unavailable */
    }
  };

  const browseCert = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: t('quickConnect.selectCertFile')
      });
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
      setError(t('quickConnect.errorHostRequired'));
      return;
    }
    if (isSerial && !form.serialPort.trim()) {
      setError(t('quickConnect.serialPortRequired'));
      return;
    }
    if (isSerial && form.serialBaud && !Number.isFinite(Number(form.serialBaud))) {
      setError(t('quickConnect.serialBaudInvalid'));
      return;
    }
    if (!isRemote && form.shellPreset === 'custom' && !normalizeShellCommand(form.shellCommand)) {
      setError(t('quickConnect.errorShellRequired'));
      return;
    }
    if (hasAuth && form.authMethod === 'key' && !form.keyPath.trim()) {
      setError(t('quickConnect.errorKeyRequired'));
      return;
    }
    if (hasAuth && form.authMethod === 'certificate' && !form.keyPath.trim()) {
      setError(t('quickConnect.errorCertKeyRequired'));
      return;
    }
    if (hasAuth && form.authMethod === 'certificate' && !form.certPath.trim()) {
      setError(t('quickConnect.errorCertRequired'));
      return;
    }
    if (isRemote && form.port) {
      const port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setError(t('quickConnect.errorPortRange'));
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const shellForDraft = (() => {
        if (isRemote || isSerial) {
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
          serialPort: isSerial ? form.serialPort.trim() : '',
          serialBaud: isSerial ? Number(form.serialBaud) || 115200 : undefined,
          group: form.group
        },
        password: form.password,
        passphrase: form.passphrase
      } satisfies QuickConnectResult);
    } catch (reason) {
      setBusy(false);
      setError(localizeBackendError(String(reason)));
    }
  };

  return (
    <div className="app-dialog-window flex h-full flex-col bg-background text-foreground">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <form onSubmit={handleSubmit} className="space-y-2.5">
          <div>
            <Label htmlFor="session-kind">{t('quickConnect.field.kind')}</Label>
            <Select
              id="session-kind"
              value={form.kind}
              onChange={(event) => update('kind', event.target.value as SessionKind)}
            >
              <option value="local">{t(SESSION_KIND_LABEL_KEY.local)}</option>
              <option value="ssh">{t(SESSION_KIND_LABEL_KEY.ssh)}</option>
              <option value="sftp">{t(SESSION_KIND_LABEL_KEY.sftp)}</option>
              <option value="telnet">{t(SESSION_KIND_LABEL_KEY.telnet)}</option>
              <option value="serial">{t(SESSION_KIND_LABEL_KEY.serial)}</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="session-title">{t('quickConnect.field.title')}</Label>
            <Input
              id="session-title"
              value={form.title}
              onChange={(event) => update('title', event.target.value)}
              placeholder={
                isRemote
                  ? t('quickConnect.titlePlaceholderRemote')
                  : t('quickConnect.titlePlaceholderLocal')
              }
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
                        {t(preset.labelKey)}
                        {preset.available === false ? t('localShell.notDetected') : ''}
                      </option>
                    )
                  )}
                  <option value="custom">{t('quickConnect.shellCustom')}</option>
                </Select>
                <p className="mt-1 text-meta text-muted">{t('quickConnect.shellHint')}</p>
              </div>
              {form.shellPreset === 'custom' ? (
                <>
                  <div>
                    <Label htmlFor="session-shell-command">
                      {t('quickConnect.shellExecutableLabel')}
                    </Label>
                    <Input
                      id="session-shell-command"
                      value={form.shellCommand}
                      onChange={(event) => update('shellCommand', event.target.value)}
                      placeholder={t('quickConnect.shellCommandPlaceholder')}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <Label htmlFor="session-shell-args">{t('quickConnect.shellArgsLabel')}</Label>
                    <Input
                      id="session-shell-args"
                      value={form.shellArgs}
                      onChange={(event) => update('shellArgs', event.target.value)}
                      placeholder={t('quickConnect.shellArgsPlaceholder')}
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {isSerial ? (
            <div>
              <Label htmlFor="session-serial-port">{t('quickConnect.serialPort')}</Label>
              <div className="flex items-stretch gap-1">
                <Input
                  id="session-serial-port"
                  value={form.serialPort}
                  onChange={(event) => update('serialPort', event.target.value)}
                  placeholder={t('quickConnect.serialPortPlaceholder')}
                  autoComplete="off"
                  className="flex-1"
                  list="serial-port-options"
                />
                <datalist id="serial-port-options">
                  {serialPorts.map((port) => (
                    <option key={port.name} value={port.name}>
                      {port.kind}
                    </option>
                  ))}
                </datalist>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label={t('quickConnect.serialRefresh')}
                  title={t('quickConnect.serialRefresh')}
                  onClick={() => {
                    void listSerialPorts()
                      .then(setSerialPorts)
                      .catch(() => setSerialPorts([]));
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="mt-2">
                <Label htmlFor="session-serial-baud">{t('quickConnect.serialBaud')}</Label>
                <Select
                  id="session-serial-baud"
                  value={form.serialBaud}
                  onChange={(event) => update('serialBaud', event.target.value)}
                >
                  {['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map(
                    (baud) => (
                      <option key={baud} value={baud}>
                        {baud}
                      </option>
                    )
                  )}
                </Select>
              </div>
            </div>
          ) : null}

          {isRemote ? (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-3">
                <div>
                  <Label htmlFor="session-host">{t('quickConnect.field.host')}</Label>
                  <Input
                    id="session-host"
                    value={form.host}
                    onChange={(event) => update('host', event.target.value)}
                    placeholder={t('quickConnect.hostPlaceholder')}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="session-port">{t('quickConnect.field.port')}</Label>
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
                    <Label htmlFor="session-username">{t('quickConnect.field.username')}</Label>
                    <Input
                      id="session-username"
                      value={form.username}
                      onChange={(event) => update('username', event.target.value)}
                      placeholder="root"
                      autoComplete="off"
                    />
                  </div>

                  <div>
                    <Label htmlFor="session-auth-method">
                      {t('quickConnect.field.authMethod')}
                    </Label>
                    <Select
                      id="session-auth-method"
                      value={form.authMethod}
                      onChange={(event) =>
                        update('authMethod', event.target.value as SessionAuthMethod)
                      }
                    >
                      <option value="password">{t('quickConnect.authMethod.password')}</option>
                      <option value="key">{t('quickConnect.authMethod.key')}</option>
                      <option value="certificate">
                        {t('quickConnect.authMethod.certificate')}
                      </option>
                      <option value="agent">{t('quickConnect.authMethod.agent')}</option>
                    </Select>
                  </div>

                  {form.authMethod === 'agent' ? (
                    <div className="rounded-sm border border-border bg-background-alt px-2 py-2 text-meta text-muted">
                      {t('quickConnect.agentHint')}
                    </div>
                  ) : form.authMethod === 'password' ? (
                    <div>
                      <Label htmlFor="session-password">{t('quickConnect.field.password')}</Label>
                      <Input
                        id="session-password"
                        type="password"
                        value={form.password}
                        onChange={(event) => update('password', event.target.value)}
                        placeholder={
                          payload?.session
                            ? t('quickConnect.passwordPlaceholderExisting')
                            : t('quickConnect.passwordPlaceholderNew')
                        }
                        autoComplete="new-password"
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        <Label htmlFor="session-key-path">
                          {form.authMethod === 'certificate'
                            ? t('quickConnect.field.certKey')
                            : t('quickConnect.field.keyPath')}
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
                            aria-label={t('quickConnect.selectKeyFile')}
                            title={t('quickConnect.selectKeyFile')}
                            onClick={() => void browseKey()}
                          >
                            <FolderOpen className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {form.authMethod === 'certificate' ? (
                        <div>
                          <Label htmlFor="session-cert-path">
                            {t('quickConnect.field.certPath')}
                          </Label>
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
                              aria-label={t('quickConnect.selectCertFile')}
                              title={t('quickConnect.selectCertFile')}
                              onClick={() => void browseCert()}
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <p className="mt-1 text-meta text-muted">{t('quickConnect.certHint')}</p>
                        </div>
                      ) : null}

                      <div>
                        <Label htmlFor="session-passphrase">
                          {t('quickConnect.field.passphrase')}
                        </Label>
                        <Input
                          id="session-passphrase"
                          type="password"
                          value={form.passphrase}
                          onChange={(event) => update('passphrase', event.target.value)}
                          placeholder={t('quickConnect.passphrasePlaceholder')}
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="rounded-sm border border-border bg-background-alt px-2 py-2 text-meta text-muted">
                  {t('quickConnect.telnetHint')}
                </p>
              )}
            </>
          ) : null}

          {hasAuth && payload?.jumpCandidates.length ? (
            <div>
              <Label htmlFor="session-jump">{t('quickConnect.field.jump')}</Label>
              <Select
                id="session-jump"
                value={form.jumpSessionId}
                onChange={(event) => update('jumpSessionId', event.target.value)}
              >
                <option value="">{t('quickConnect.jumpNone')}</option>
                {payload.jumpCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-meta text-muted">{t('quickConnect.jumpHint')}</p>
            </div>
          ) : null}

          <div>
            <Label htmlFor="session-group">{t('quickConnect.field.group')}</Label>
            <Input
              id="session-group"
              value={form.group}
              onChange={(event) => update('group', event.target.value)}
              placeholder={t('quickConnect.groupPlaceholder', { group: DEFAULT_GROUP })}
            />
          </div>

          {error ? <p className="text-xs text-error">{error}</p> : null}
        </form>
      </div>

      <div className="app-dialog-footer flex items-center justify-end gap-2 border-t border-border bg-background-alt px-5 py-3">
        <Button variant="ghost" onClick={() => void cancelModal()}>
          {t('quickConnect.cancel')}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void handleSubmit()}>
          {payload?.session ? t('quickConnect.save') : t('quickConnect.connect')}
        </Button>
      </div>
    </div>
  );
}
