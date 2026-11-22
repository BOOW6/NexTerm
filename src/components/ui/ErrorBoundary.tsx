import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tStatic } from '../../i18n';
import { Button } from './button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered in logs so a crash can be attributed to its surface. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains render-time crashes so one broken surface cannot take the whole
 * workspace (or the whole window) down with it. The web preview used to
 * white-screen from the root when Tauri IPC was unavailable; with this, the
 * failure shows as actionable UI instead of an empty page.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] crashed: ${this.props.label ?? 'surface'}`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-4 text-center"
      >
        <p className="font-emphasis text-meta text-foreground">
          {tStatic('ui.errorBoundaryTitle')}
        </p>
        <p className="max-w-md text-tiny text-muted">{tStatic('ui.errorBoundaryBody')}</p>
        <details className="max-w-md text-left text-tiny text-muted">
          <summary className="cursor-pointer select-none">
            {tStatic('ui.errorBoundaryDetail')}
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all selectable">
            {String(error.message ?? error)}
          </pre>
        </details>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={this.reset}>
            {tStatic('ui.errorBoundaryRetry')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {tStatic('ui.errorBoundaryReload')}
          </Button>
        </div>
      </div>
    );
  }
}
