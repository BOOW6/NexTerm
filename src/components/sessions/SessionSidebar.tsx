import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Plus,
  Search,
  Star,
  TerminalSquare,
  Upload,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { useWorkspace } from '../../features/workspace/useWorkspace';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTransferStore } from '../../stores/transferStore';
import { toast } from '../ui/toastStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { DropdownMenu } from '../ui/dropdown-menu';
import { invoke } from '@tauri-apps/api/core';
import {
  importKey,
  importSessionsFromText,
  serializeSessionBackup,
  type ImportFormat
} from '../../lib/sessionImport';
import { DEFAULT_GROUP, type Session, type SessionDraft } from '../../types/session';
import { useI18n } from '../../i18n';
import SessionRow from './SessionRow';
import { confirmAction } from '../../lib/appWindows';
import { forgetSessionCredentials } from '../../lib/credentialVault';
import { clearTerminalSnapshot } from '../../lib/terminalSnapshot';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';

interface GroupSectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  icon?: LucideIcon;
  depth?: number;
  children: ReactNode;
}

function GroupSection({
  title,
  count,
  collapsed,
  onToggle,
  icon: Icon,
  depth = 0,
  children
}: GroupSectionProps) {
  return (
    <section className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        style={{ paddingLeft: 6 + depth * 10 }}
        className="app-group-header flex w-full items-center gap-1 py-1 pr-1.5 text-meta font-emphasis text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {Icon ? <Icon className="h-3 w-3" /> : null}
        <span className="flex-1 truncate text-left">{title}</span>
        <span className="text-muted-foreground">{count}</span>
      </button>
      {collapsed ? null : <div className="app-list space-y-px">{children}</div>}
    </section>
  );
}

interface SessionGroupNode {
  name: string;
  path: string;
  sessions: Session[];
  children: SessionGroupNode[];
}

interface MutableGroupNode {
  name: string;
  path: string;
  sessions: Session[];
  children: Map<string, MutableGroupNode>;
}

function buildGroupTree(sessions: Session[]): SessionGroupNode[] {
  const roots = new Map<string, MutableGroupNode>();

  for (const session of sessions) {
    const segments = session.group
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    const parts = segments.length > 0 ? segments : [DEFAULT_GROUP];

    let siblings = roots;
    let node: MutableGroupNode | null = null;
    for (let index = 0; index < parts.length; index += 1) {
      const segment = parts[index];
      let current = siblings.get(segment);
      if (!current) {
        current = {
          name: segment,
          path: parts.slice(0, index + 1).join('/'),
          sessions: [],
          children: new Map()
        };
        siblings.set(segment, current);
      }
      node = current;
      siblings = current.children;
    }
    node?.sessions.push(session);
  }

  const toNodes = (map: Map<string, MutableGroupNode>): SessionGroupNode[] =>
    Array.from(map.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((node) => ({
        name: node.name,
        path: node.path,
        sessions: [...node.sessions].sort((a, b) => a.title.localeCompare(b.title)),
        children: toNodes(node.children)
      }));

  return toNodes(roots);
}

function groupSessionCount(node: SessionGroupNode): number {
  return (
    node.sessions.length + node.children.reduce((sum, child) => sum + groupSessionCount(child), 0)
  );
}

export default function SessionSidebar() {
  const sessions = useSessionStore((state) => state.sessions);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const removeSession = useSessionStore((state) => state.removeSession);
  const addSessions = useSessionStore((state) => state.addSessions);

  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const setActiveSessionId = useWorkspaceStore((state) => state.setActiveSessionId);
  const openQuickConnect = useQuickConnectLauncher();
  const { t } = useI18n();

  const { openSession, closeSessionPanel } = useWorkspace();

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [width, setWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem('nexterm.sidebar.width'));
    return Number.isFinite(saved) && saved >= 190 && saved <= 420 ? saved : 240;
  });
  const resizingRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem('nexterm.sidebar.width', String(Math.round(width)));
  }, [width]);

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) {
      return;
    }
    setWidth(Math.min(420, Math.max(190, event.clientX)));
  };

  const toggleGroup = (key: string) =>
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return sessions;
    }
    return sessions.filter((session) =>
      [session.title, session.host, session.username, session.group]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(keyword))
    );
  }, [sessions, query]);

  const favorites = useMemo(() => filtered.filter((session) => session.favorite), [filtered]);

  const groupTree = useMemo(
    () => buildGroupTree(filtered.filter((session) => !session.favorite)),
    [filtered]
  );

  const handleOpen = (sessionId: string) => openSession(sessionId);

  const handleEdit = (sessionId: string) => openQuickConnect({ sessionId });

  const handleRemove = async (sessionId: string) => {
    const target = sessions.find((session) => session.id === sessionId);
    const name = target?.title ?? 'Session';
    const ok = await confirmAction(t('sidebar.deleteConfirm', { name }), {
      title: t('sidebar.deleteTitle'),
      okLabel: t('session.delete')
    });
    if (!ok) {
      return;
    }
    closeSessionPanel(sessionId);
    removeSession(sessionId);
    void forgetSessionCredentials(sessionId);
    clearTerminalSnapshot(sessionId);
    // The session is gone: its transfer entries could never retry again.
    useTransferStore.getState().removeSessionTransfers(sessionId);
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
    }
    toast({ title: t('sidebar.deleted', { name }), variant: 'success' });
  };

  const handleImport = async (format: ImportFormat) => {
    try {
      // The backend opens the dialog and reads the file itself; the path never
      // crosses the IPC boundary.
      const content = await invoke<string | null>('import_sessions', {
        format,
        title: t('sidebar.importPick')
      });
      if (content === null) {
        return;
      }

      const imported = importSessionsFromText(format, content);
      if (imported.length === 0) {
        toast({ title: t('sidebar.importNone'), variant: 'default' });
        return;
      }

      const known = new Set(
        useSessionStore.getState().sessions.map((session) => importKey(session))
      );
      const drafts: SessionDraft[] = [];
      let skipped = 0;
      for (const item of imported) {
        const key = importKey(item);
        if (known.has(key)) {
          skipped += 1;
          continue;
        }
        known.add(key);
        drafts.push({
          kind: item.kind,
          title: item.title,
          host: item.host,
          port: item.port,
          // Imported configs often omit User; fall back to the configured
          // default so the session can actually connect.
          username: item.username || useSettingsStore.getState().defaultUsername,
          authMethod: item.authMethod,
          keyPath: item.keyPath,
          certPath: item.certPath,
          group: item.group,
          favorite: item.favorite
        });
      }

      const created = addSessions(drafts);
      toast({
        title: t('sidebar.imported', { count: created.length }),
        description: skipped > 0 ? t('sidebar.importedSkipped', { count: skipped }) : undefined,
        variant: created.length > 0 ? 'success' : 'default'
      });
    } catch (reason) {
      toast({ title: t('sidebar.importFailed'), description: String(reason), variant: 'error' });
    }
  };

  const handleExport = async () => {
    try {
      // The backend opens the save dialog and writes the file itself; the
      // path never crosses the IPC boundary.
      const saved = await invoke<boolean>('export_sessions', {
        contents: serializeSessionBackup(useSessionStore.getState().sessions),
        title: t('sidebar.export')
      });
      if (!saved) {
        return;
      }
      toast({ title: t('sidebar.exported'), variant: 'success' });
    } catch (reason) {
      toast({ title: t('sidebar.exportFailed'), description: String(reason), variant: 'error' });
    }
  };

  const renderGroupNode = (node: SessionGroupNode, depth: number): ReactNode => (
    <GroupSection
      key={node.path}
      title={node.name}
      count={groupSessionCount(node)}
      collapsed={Boolean(collapsed[node.path])}
      onToggle={() => toggleGroup(node.path)}
      depth={depth}
    >
      {node.sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          active={activeSessionId === session.id}
          onOpen={handleOpen}
          onEdit={handleEdit}
          onToggleFavorite={toggleFavorite}
          onRemove={handleRemove}
        />
      ))}
      {node.children.map((child) => renderGroupNode(child, depth + 1))}
    </GroupSection>
  );

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="app-panel-header flex h-7 shrink-0 items-center justify-between border-b border-border bg-panel-title px-2">
        <span className="text-xs font-emphasis text-foreground">{t('sidebar.title')}</span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu
            label={t('sidebar.importMenu')}
            items={[
              {
                label: t('sidebar.import'),
                icon: Upload,
                onSelect: () => void handleImport('ssh-config')
              },
              {
                label: t('sidebar.importMoba'),
                icon: FileText,
                onSelect: () => void handleImport('mobaxterm')
              },
              {
                label: t('sidebar.importPutty'),
                icon: FileText,
                onSelect: () => void handleImport('putty')
              },
              {
                label: t('sidebar.importBackup'),
                icon: Upload,
                onSelect: () => void handleImport('nexterm')
              },
              {
                label: t('sidebar.export'),
                icon: Download,
                separatorBefore: true,
                onSelect: () => void handleExport()
              }
            ]}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('sidebar.newSession')}
            title={t('sidebar.newSession')}
            onClick={() => openQuickConnect()}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex gap-1 px-2 pt-2">
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => openQuickConnect()}>
          <Plus className="h-3 w-3" />
          {t('sidebar.newSession')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => openQuickConnect({ kind: 'ssh' })}
        >
          <Zap className="h-3 w-3" />
          {t('sidebar.quickConnect')}
        </Button>
      </div>

      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sidebar.search')}
            size="compact"
            className="pl-7"
            aria-label={t('sidebar.search')}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
            <TerminalSquare className="h-7 w-7 text-muted-foreground" />
            <p className="text-meta text-muted">{t('sidebar.empty')}</p>
            <Button size="sm" variant="primary" onClick={() => openQuickConnect()}>
              <Plus className="h-3 w-3" />
              {t('sidebar.newSession')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-meta text-muted">{t('sidebar.noMatch')}</p>
        ) : (
          <>
            {favorites.length > 0 ? (
              <GroupSection
                title={t('sidebar.favorites')}
                count={favorites.length}
                collapsed={Boolean(collapsed['__favorites'])}
                onToggle={() => toggleGroup('__favorites')}
                icon={Star}
              >
                {favorites.map((session) => (
                  <SessionRow
                    key={`fav-${session.id}`}
                    session={session}
                    active={activeSessionId === session.id}
                    onOpen={handleOpen}
                    onEdit={handleEdit}
                    onToggleFavorite={toggleFavorite}
                    onRemove={handleRemove}
                  />
                ))}
              </GroupSection>
            ) : null}

            {groupTree.map((node) => renderGroupNode(node, 0))}
          </>
        )}
      </div>

      <div className="border-t border-border bg-background-alt px-2 py-1 text-meta text-muted">
        {t('sidebar.total', { count: sessions.length })}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('ui.resizeSidebar')}
        onPointerDown={(event) => {
          event.preventDefault();
          resizingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={handleResizeMove}
        onPointerUp={(event) => {
          resizingRef.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          resizingRef.current = false;
        }}
        onLostPointerCapture={() => {
          resizingRef.current = false;
        }}
        onDoubleClick={() => setWidth(240)}
        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/20"
      />
    </aside>
  );
}
