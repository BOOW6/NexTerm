import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LockKeyhole, Pencil } from 'lucide-react';
import { useCredentialStore } from '../../stores/credentialStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';
import { rememberSessionCredentials } from '../../lib/credentialVault';
import { openModalWindow } from '../../lib/appWindows';
import { toast } from '../ui/toastStore';
import { sessionSubtitle, type Session } from '../../types/session';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Input, Label } from '../ui/input';

export default function SshConnectForm({ session }: { session: Session }) {
  const setPassword = useCredentialStore((state) => state.setPassword);
  const setPassphrase = useCredentialStore((state) => state.setPassphrase);
  const authorize = useCredentialStore((state) => state.authorize);
  const rememberEnabled = useSettingsStore((state) => state.sshRememberCredentials);
  const vaultStatus = useVaultStore((state) => state.status);
  const refreshVault = useVaultStore((state) => state.refresh);
  const unlockVault = useVaultStore((state) => state.unlock);
  const openQuickConnect = useQuickConnectLauncher();
  const { t } = useI18n();

  const authMethod = session.authMethod ?? 'password';
  const keyPath = session.keyPath ?? '';
  const certPath = session.certPath ?? '';

  const [password, setPasswordValue] = useState('');
  const [passphrase, setPassphraseValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (authMethod === 'password') {
      if (!password) {
        setError(t('ssh.enterPassword'));
        return;
      }
      setPassword(session.id, password);
    } else if (authMethod === 'key' || authMethod === 'certificate') {
      if (!keyPath || (authMethod === 'certificate' && !certPath)) {
        setError(t('ssh.pickKey'));
        return;
      }
      setPassphrase(session.id, passphrase);
    }

    setError(null);
    authorize(session.id);
    void rememberSessionCredentials(session).then((results) => {
      if (results.includes('locked')) {
        toast({
          title: t('ssh.memoryOnlyToast'),
          description: t('ssh.vaultLockedToast'),
          variant: 'default'
        });
      } else if (results.includes('uninitialized')) {
        toast({
          title: t('ssh.memoryOnlyToast'),
          description: t('ssh.vaultSetupToast'),
          variant: 'default'
        });
      }
    });
  };

  const handleUnlockVault = async () => {
    if (unlocking) {
      return;
    }
    setUnlocking(true);
    try {
      const masterPassword = await openModalWindow<string>('prompt', {
        title: t('ssh.vaultUnlockTitle'),
        width: 420,
        height: 200,
        data: {
          title: t('ssh.vaultUnlockTitle'),
          label: t('ssh.vaultMasterPassword'),
          initialValue: '',
          placeholder: t('ssh.vaultMasterPlaceholder'),
          confirmLabel: t('ssh.vaultUnlock'),
          password: true
        }
      });
      if (!masterPassword) {
        return;
      }
      const ok = await unlockVault(masterPassword);
      if (ok) {
        toast({
          title: t('ssh.vaultUnlockedToast'),
          description: t('ssh.vaultUnlockedDesc'),
          variant: 'success'
        });
      } else {
        setError(t('ssh.wrongMasterPassword'));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm overflow-hidden rounded-sm border border-border-strong bg-surface-elevated shadow-panel"
      >
        <div className="app-dialog-header border-b border-border bg-panel-title px-3 py-2 text-xs font-emphasis text-foreground">
          <span className="app-dialog-title">
            {authMethod === 'password'
              ? t('ssh.login')
              : authMethod === 'agent'
                ? t('ssh.agentLogin')
                : authMethod === 'certificate'
                  ? t('ssh.certLogin')
                  : t('ssh.keyLogin')}
          </span>
        </div>

        <div className="space-y-2.5 p-4">
          <div className="rounded-sm border border-border bg-background-alt px-2 py-1 text-meta text-muted">
            <p className="font-medium text-foreground">{session.title}</p>
            <p className="font-mono">{sessionSubtitle(session, t)}</p>
          </div>

          {authMethod === 'password' ? (
            <div>
              <Label htmlFor="ssh-password">{t('ssh.password')}</Label>
              <Input
                id="ssh-password"
                type="password"
                autoFocus
                value={password}
                onChange={(event) => setPasswordValue(event.target.value)}
                placeholder={t('ssh.passwordPlaceholder')}
                autoComplete="new-password"
              />
            </div>
          ) : authMethod === 'agent' ? (
            <div className="rounded-sm border border-border bg-background px-2 py-6 text-center text-meta text-muted">
              {t('ssh.agentHint')}
              <br />
              {t('ssh.agentHint2')}
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="ssh-key-path">{t('ssh.keyPath')}</Label>
                <Input id="ssh-key-path" value={keyPath || t('ssh.noKey')} readOnly />
              </div>
              {authMethod === 'certificate' ? (
                <div>
                  <Label htmlFor="ssh-cert-path">{t('ssh.certPath')}</Label>
                  <Input id="ssh-cert-path" value={certPath || t('ssh.noKey')} readOnly />
                </div>
              ) : null}
              <div>
                <Label htmlFor="ssh-passphrase">{t('ssh.passphrase')}</Label>
                <Input
                  id="ssh-passphrase"
                  type="password"
                  autoFocus
                  value={passphrase}
                  onChange={(event) => setPassphraseValue(event.target.value)}
                  placeholder={t('ssh.passphrasePlaceholder')}
                  autoComplete="off"
                />
              </div>
            </>
          )}

          {error ? <p className="text-meta text-error">{error}</p> : null}

          {rememberEnabled ? (
            vaultStatus.initialized && !vaultStatus.unlocked ? (
              <div className="flex items-center gap-2 rounded-sm border border-border bg-background-alt px-2 py-1.5">
                <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted" />
                <p className="flex-1 text-tiny text-muted-foreground">{t('ssh.vaultLocked')}</p>
                <Button
                  size="xs"
                  variant="secondary"
                  type="button"
                  disabled={unlocking}
                  onClick={() => void handleUnlockVault()}
                >
                  {t('ssh.unlock')}
                </Button>
              </div>
            ) : vaultStatus.initialized && vaultStatus.unlocked ? (
              <p className="text-tiny text-muted-foreground">{t('ssh.vaultUnlocked')}</p>
            ) : (
              <p className="text-tiny text-muted-foreground">{t('ssh.vaultSetup')}</p>
            )
          ) : (
            <p className="text-tiny text-muted-foreground">
              {authMethod === 'agent' ? t('ssh.agentManaged') : t('ssh.memoryOnly')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-background-alt px-4 py-2">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => void openQuickConnect({ sessionId: session.id })}
          >
            <Pencil className="h-3 w-3" />
            {t('ssh.edit')}
          </Button>
          <Button size="sm" variant="primary" type="submit">
            <KeyRound className="h-3 w-3" />
            {t('ssh.connect')}
          </Button>
        </div>
      </form>
    </div>
  );
}
