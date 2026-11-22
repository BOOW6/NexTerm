import { Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../../components/ui/button';
import type { KnownHost } from '../../hooks/useTauriSsh';

export interface KnownHostsSectionProps {
  hosts: KnownHost[];
  /** Hosts pending deletion; deletions are deferred to the apply flow. */
  pendingRemovals: string[];
  loading: boolean;
  error: string | null;
  hashHostnames: boolean;
  onHashHostnamesChange: (value: boolean) => void;
  onImport: () => void;
  onExport: () => void;
  onRemove: (host: string) => void;
}

/** The known_hosts management card of the security tab. Pure presentation:
 * the parent owns the state, because deletions only take effect with the
 * surrounding "apply" flow (they share its unsaved-changes bookkeeping). */
export function KnownHostsSection({
  hosts,
  pendingRemovals,
  loading,
  error,
  hashHostnames,
  onHashHostnamesChange,
  onImport,
  onExport,
  onRemove
}: KnownHostsSectionProps) {
  const { t } = useI18n();

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-emphasis text-foreground">
          {t('settings.security.knownHosts.title')}
        </h3>
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-tiny text-muted">
            <input
              type="checkbox"
              checked={hashHostnames}
              onChange={(event) => onHashHostnamesChange(event.target.checked)}
            />
            {t('settings.security.knownHosts.hashHostnames')}
          </label>
          <Button size="xs" variant="secondary" onClick={onImport}>
            {t('settings.security.knownHosts.import')}
          </Button>
          <Button size="xs" variant="secondary" onClick={onExport}>
            {t('settings.security.knownHosts.export')}
          </Button>
        </div>
      </div>
      {loading ? (
        <p className="text-meta text-muted">{t('settings.security.knownHosts.loading')}</p>
      ) : error ? (
        <p className="selectable text-meta text-error">{error}</p>
      ) : hosts.length === 0 ? (
        <p className="text-meta text-muted">{t('settings.security.knownHosts.empty')}</p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-sm border border-border">
          {hosts.map((entry) => (
            <div
              key={entry.host}
              className="flex items-center gap-2 border-b border-border-muted/60 px-2 py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="selectable truncate font-mono text-meta text-foreground">
                  {entry.host}
                </p>
                <p className="selectable truncate text-tiny text-muted" title={entry.fingerprint}>
                  {entry.algorithm} - {entry.fingerprint}
                </p>
              </div>
              <Button
                size="icon-md"
                variant="ghost"
                aria-label={t('settings.security.knownHosts.removeAria')}
                title={t('settings.security.knownHosts.removeAria')}
                onClick={() => onRemove(entry.host)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {pendingRemovals.length > 0 ? (
        <p className="mt-2 text-tiny text-warning">
          {t('settings.security.knownHosts.pendingRemoval', { count: pendingRemovals.length })}
        </p>
      ) : null}
      <p className="mt-2 text-tiny text-muted-foreground">
        {t('settings.security.knownHosts.removeHint')}
      </p>
    </div>
  );
}
