import { Pencil, Plug, Star, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { Session } from '../../types/session';
import { sessionSubtitle } from '../../types/session';
import { DropdownMenu } from '../ui/dropdown-menu';
import { showNativeContextMenu } from '../../lib/appWindows';
import { SESSION_KIND_ICON, sessionStatusDot } from '../../lib/sessionVisuals';
import { useI18n } from '../../i18n';

interface SessionRowProps {
  session: Session;
  active: boolean;
  onOpen: (sessionId: string) => void;
  onEdit: (sessionId: string) => void;
  onToggleFavorite: (sessionId: string) => void;
  onRemove: (sessionId: string) => void;
}

export default function SessionRow({
  session,
  active,
  onOpen,
  onEdit,
  onToggleFavorite,
  onRemove
}: SessionRowProps) {
  const KindIcon = SESSION_KIND_ICON[session.kind];
  const { t } = useI18n();

  return (
    <div
      role="button"
      tabIndex={0}
      data-native-context-menu
      onContextMenu={(event) => {
        event.preventDefault();
        void showNativeContextMenu([
          { label: t('session.open') },
          { label: t('session.edit') },
          { label: session.favorite ? t('session.unfavorite') : t('session.favorite') },
          { label: t('session.delete'), separatorBefore: true }
        ]).then((index) => {
          if (index === 0) {
            onOpen(session.id);
          } else if (index === 1) {
            onEdit(session.id);
          } else if (index === 2) {
            onToggleFavorite(session.id);
          } else if (index === 3) {
            onRemove(session.id);
          }
        });
      }}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(session.id);
        }
      }}
      data-active={active}
      className={cn(
        'app-list-row group flex cursor-pointer items-center gap-1.5 rounded-sm border px-1.5 py-1 transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
        active ? 'border-accent/40 bg-row-selected' : 'border-transparent hover:bg-row-hover'
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', sessionStatusDot(session.status, true))}
        title={session.status}
      />
      <KindIcon className="h-3.5 w-3.5 shrink-0 text-muted" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-foreground">{session.title}</p>
        <p className="truncate text-[10px] text-muted">{sessionSubtitle(session, t)}</p>
      </div>

      <button
        type="button"
        aria-label={session.favorite ? t('session.unfavorite') : t('session.favorite')}
        title={session.favorite ? t('session.unfavorite') : t('session.favorite')}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(session.id);
        }}
        className={cn(
          'rounded-sm p-0.5 transition-opacity',
          session.favorite
            ? 'text-warning opacity-100'
            : 'text-muted opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100'
        )}
      >
        <Star className={cn('h-3 w-3', session.favorite && 'fill-current')} />
      </button>

      <DropdownMenu
        label={t('session.more', { name: session.title })}
        items={[
          { label: t('session.open'), icon: Plug, onSelect: () => onOpen(session.id) },
          { label: t('session.edit'), icon: Pencil, onSelect: () => onEdit(session.id) },
          {
            label: session.favorite ? t('session.unfavorite') : t('session.favorite'),
            icon: Star,
            onSelect: () => onToggleFavorite(session.id)
          },
          {
            label: t('session.delete'),
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => onRemove(session.id)
          }
        ]}
      />
    </div>
  );
}
