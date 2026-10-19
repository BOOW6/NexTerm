import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Star,
  TerminalSquare,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { useWorkspace } from '../../features/workspace/WorkspaceContext';
import { useSessionStore } from '../../stores/sessionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { toast } from '../ui/toast';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import SessionRow from './SessionRow';
import { confirmAction } from '../../lib/appWindows';
import { useQuickConnectLauncher } from '../../features/workspace/useQuickConnectLauncher';

interface GroupSectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  icon?: LucideIcon;
  children: ReactNode;
}

function GroupSection({ title, count, collapsed, onToggle, icon: Icon, children }: GroupSectionProps) {
  return (
    <section className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="app-group-header flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
        {Icon ? <Icon className="h-3 w-3" /> : null}
        <span className="flex-1 truncate text-left">{title}</span>
        <span className="text-muted-foreground">{count}</span>
      </button>
      {collapsed ? null : <div className="app-list space-y-px">{children}</div>}
    </section>
  );
}

export default function SessionSidebar() {
  const sessions = useSessionStore((state) => state.sessions);
  const toggleFavorite = useSessionStore((state) => state.toggleFavorite);
  const removeSession = useSessionStore((state) => state.removeSession);

  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);
  const setActiveSessionId = useWorkspaceStore((state) => state.setActiveSessionId);
  const openQuickConnect = useQuickConnectLauncher();

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

  const favorites = useMemo(
    () => filtered.filter((session) => session.favorite),
    [filtered]
  );

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const session of filtered) {
      if (session.favorite) {
        continue;
      }
      const list = map.get(session.group) ?? [];
      list.push(session);
      map.set(session.group, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [filtered]);

  const handleOpen = (sessionId: string) => openSession(sessionId);

  const handleEdit = (sessionId: string) => openQuickConnect({ sessionId });

  const handleRemove = async (sessionId: string) => {
    const target = sessions.find((session) => session.id === sessionId);
    const ok = await confirmAction(`确定删除「${target?.title ?? '会话'}」吗？`, {
      title: '删除会话',
      okLabel: '删除'
    });
    if (!ok) {
      return;
    }
    closeSessionPanel(sessionId);
    removeSession(sessionId);
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
    }
    toast({ title: `已删除「${target?.title ?? '会话'}」`, variant: 'success' });
  };

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="app-panel-header flex h-7 shrink-0 items-center justify-between border-b border-border bg-panel-title px-2">
        <span className="text-xs font-semibold text-foreground">会话管理器</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="新建会话"
          title="新建会话"
          onClick={() => openQuickConnect()}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex gap-1 px-2 pt-2">
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => openQuickConnect()}>
          <Plus className="h-3 w-3" />
          新建会话
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => openQuickConnect({ kind: 'ssh' })}
        >
          <Zap className="h-3 w-3" />
          快速连接
        </Button>
      </div>

      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话..."
            size="compact"
            className="pl-7"
            aria-label="搜索会话"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
            <TerminalSquare className="h-7 w-7 text-muted-foreground" />
            <p className="text-[11px] text-muted">还没有任何会话</p>
            <Button size="sm" variant="primary" onClick={() => openQuickConnect()}>
              <Plus className="h-3 w-3" />
              新建会话
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted">没有匹配的会话</p>
        ) : (
          <>
            {favorites.length > 0 ? (
              <GroupSection
                title="收藏"
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

            {groups.map(([group, list]) => (
              <GroupSection
                key={group}
                title={group}
                count={list.length}
                collapsed={Boolean(collapsed[group])}
                onToggle={() => toggleGroup(group)}
              >
                {list.map((session) => (
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
              </GroupSection>
            ))}
          </>
        )}
      </div>

      <div className="border-t border-border bg-background-alt px-2 py-1 text-[11px] text-muted">
        共 {sessions.length} 个会话
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
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
