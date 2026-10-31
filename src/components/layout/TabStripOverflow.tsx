import { useEffect, useRef } from 'react';
import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';

const SCROLL_STEP = 160;
// Chevron paths from lucide (24x24, stroke-based), inlined because these
// controls are injected outside the React tree.
const CHEVRON_LEFT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
const CHEVRON_RIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

export interface TabStripOverflowLabels {
  scrollLeft: string;
  scrollRight: string;
}

interface EdgeControls {
  edge: HTMLDivElement;
  button: HTMLButtonElement;
}

interface GroupControls {
  overlay: HTMLDivElement;
  tabs: HTMLElement;
  update: () => void;
  resizeObserver: ResizeObserver;
  handleScroll: () => void;
  handleWheel: (event: WheelEvent) => void;
  left: EdgeControls;
  right: EdgeControls;
}

function buildEdge(position: 'left' | 'right', label: string): EdgeControls {
  const edge = document.createElement('div');
  edge.className = `nexterm-tab-overflow-edge nexterm-tab-overflow-edge-${position}`;
  edge.dataset.hidden = 'true';

  const fade = document.createElement('div');
  fade.className = 'nexterm-tab-overflow-fade';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nexterm-tab-overflow-btn';
  button.setAttribute('aria-label', label);
  button.innerHTML = position === 'left' ? CHEVRON_LEFT : CHEVRON_RIGHT;

  if (position === 'left') {
    edge.append(button, fade);
  } else {
    edge.append(fade, button);
  }
  return { edge, button };
}

function updateEdge(edge: EdgeControls, tabs: HTMLElement, direction: -1 | 1): void {
  const maxScroll = tabs.scrollWidth - tabs.clientWidth;
  const canScroll = direction < 0 ? tabs.scrollLeft > 0 : tabs.scrollLeft < maxScroll - 1;
  edge.edge.dataset.hidden = canScroll ? 'false' : 'true';
}

function attachGroup(
  group: DockviewGroupPanel,
  labels: TabStripOverflowLabels
): GroupControls | null {
  const container = group.element.querySelector<HTMLElement>('.dv-tabs-and-actions-container');
  const tabs = container?.querySelector<HTMLElement>('.dv-tabs-container');
  if (!container || !tabs) {
    return null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'nexterm-tab-overflow';
  const left = buildEdge('left', labels.scrollLeft);
  const right = buildEdge('right', labels.scrollRight);
  overlay.append(left.edge, right.edge);
  container.appendChild(overlay);

  const update = () => {
    updateEdge(left, tabs, -1);
    updateEdge(right, tabs, 1);
  };

  const handleScroll = () => update();
  tabs.addEventListener('scroll', handleScroll, { passive: true });

  // Translate vertical wheel deltas into horizontal tab scrolling; browsers
  // only offer a shift+wheel fallback for horizontal-only containers.
  const handleWheel = (event: WheelEvent) => {
    if (tabs.scrollWidth <= tabs.clientWidth) {
      return;
    }
    const deltaY = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    if (Math.abs(deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    event.preventDefault();
    tabs.scrollLeft += deltaY;
  };
  tabs.addEventListener('wheel', handleWheel, { passive: false });

  // Instant scrolling on purpose: smooth behavior hangs when the webview
  // stops producing frames (occluded/minimized window), leaving the strip
  // stuck mid-scroll. Visibility is refreshed synchronously because scroll
  // events ride the rendering steps and can be deferred on throttled pages.
  left.button.addEventListener('click', () => {
    tabs.scrollBy({ left: -SCROLL_STEP });
    update();
  });
  right.button.addEventListener('click', () => {
    tabs.scrollBy({ left: SCROLL_STEP });
    update();
  });

  const resizeObserver = new ResizeObserver(update);
  resizeObserver.observe(tabs);
  update();

  return { overlay, tabs, update, resizeObserver, handleScroll, handleWheel, left, right };
}

function detachGroup(controls: GroupControls): void {
  controls.resizeObserver.disconnect();
  controls.tabs.removeEventListener('scroll', controls.handleScroll);
  controls.tabs.removeEventListener('wheel', controls.handleWheel);
  controls.overlay.remove();
}

/**
 * Per-group overflow controls for the dockview tab strip: the native
 * scrollbar is hidden in CSS, so edge buttons, fade masks, wheel-to-scroll
 * and active-tab reveal live here. Injected DOM is tracked per group and
 * fully torn down on group removal / unmount.
 */
export default function TabStripOverflow({
  api,
  labels
}: {
  api: DockviewApi | null;
  labels: TabStripOverflowLabels;
}) {
  const controlsRef = useRef(new Map<DockviewGroupPanel, GroupControls>());
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  useEffect(() => {
    if (!api) {
      return;
    }
    const controlsByGroup = controlsRef.current;
    let disposed = false;
    const pendingRafs = new Set<number>();

    const attach = (group: DockviewGroupPanel) => {
      if (controlsByGroup.has(group)) {
        return;
      }
      const controls = attachGroup(group, labelsRef.current);
      if (controls) {
        controlsByGroup.set(group, controls);
        return;
      }
      // Group header DOM may not be mounted yet (e.g. during layout
      // deserialization); retry on the next frame.
      const raf = requestAnimationFrame(() => {
        pendingRafs.delete(raf);
        if (disposed || controlsByGroup.has(group)) {
          return;
        }
        const retry = attachGroup(group, labelsRef.current);
        if (retry) {
          controlsByGroup.set(group, retry);
        }
      });
      pendingRafs.add(raf);
    };

    const detach = (group: DockviewGroupPanel) => {
      const controls = controlsByGroup.get(group);
      if (!controls) {
        return;
      }
      controlsByGroup.delete(group);
      detachGroup(controls);
    };

    api.groups.forEach(attach);
    const disposables = [
      api.onDidAddGroup(attach),
      api.onDidRemoveGroup(detach),
      api.onDidActivePanelChange((panel) => {
        const group = panel?.group;
        if (!group) {
          return;
        }
        const controls = controlsByGroup.get(group);
        const tabs =
          controls?.tabs ?? group.element.querySelector<HTMLElement>('.dv-tabs-container');
        const active = tabs?.querySelector<HTMLElement>('.dv-tab.dv-active-tab');
        if (!tabs || !active) {
          return;
        }
        // Viewport coordinates minus the strip origin give scroll-independent
        // content positions, avoiding offsetParent quirks.
        const stripLeft = tabs.getBoundingClientRect().left;
        const tabLeft = active.getBoundingClientRect().left - stripLeft + tabs.scrollLeft;
        const tabRight = tabLeft + active.offsetWidth;
        if (tabLeft < tabs.scrollLeft) {
          tabs.scrollTo({ left: tabLeft });
        } else if (tabRight > tabs.scrollLeft + tabs.clientWidth) {
          tabs.scrollTo({ left: tabRight - tabs.clientWidth });
        } else {
          return;
        }
        // Scroll events ride the rendering steps and can be deferred on
        // throttled pages; refresh button visibility right away.
        controls?.update();
      })
    ];

    return () => {
      disposed = true;
      disposables.forEach((disposable) => disposable.dispose());
      pendingRafs.forEach((raf) => cancelAnimationFrame(raf));
      pendingRafs.clear();
      controlsByGroup.forEach((controls) => detachGroup(controls));
      controlsByGroup.clear();
    };
  }, [api]);

  useEffect(() => {
    controlsRef.current.forEach((controls) => {
      controls.left.button.setAttribute('aria-label', labels.scrollLeft);
      controls.right.button.setAttribute('aria-label', labels.scrollRight);
    });
  }, [labels]);

  return null;
}
