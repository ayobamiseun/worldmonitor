/**
 * Shared modal focus trap.
 *
 * Keeps Tab / Shift+Tab cycling inside an overlay while it is open and
 * restores focus to the element that opened it on close — the two halves of
 * the dialog contract that `aria-modal="true"` promises but does not provide.
 *
 * Modeled on the per-surface implementations in confirm-dialog.ts,
 * market-chart-interactions.ts, and CountryDeepDivePanel.ts; new overlays
 * should use this instead of hand-rolling another copy.
 */

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.offsetParent !== null,
  );
}

export interface FocusTrapOptions {
  /**
   * Called on Escape. When omitted the trap leaves Escape alone so a
   * surface's existing close handler keeps working.
   */
  onEscape?: () => void;
  /** Element to focus on activate; defaults to the first focusable child. */
  initialFocus?: HTMLElement | null | (() => HTMLElement | null);
}

export interface FocusTrap {
  activate(): void;
  deactivate(options?: { restoreFocus?: boolean }): void;
}

export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrap {
  let active = false;
  let returnFocus: HTMLElement | null = null;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && options.onEscape) {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    }
    if (event.key !== 'Tab') return;

    const current = document.activeElement;
    // A stacked dialog (e.g. confirm-dialog over the settings modal) owns the
    // focus while it is up — leave its Tab handling alone.
    if (current && current !== document.body && !container.contains(current)) return;

    const focusable = focusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const shouldWrap = !focusable.includes(current as HTMLElement)
      || (event.shiftKey && current === first)
      || (!event.shiftKey && current === last);
    if (!shouldWrap) return;

    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  return {
    activate(): void {
      if (active) return;
      active = true;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', onKeydown, true);
      const requested = typeof options.initialFocus === 'function' ? options.initialFocus() : options.initialFocus;
      (requested ?? focusableElements(container)[0] ?? container).focus();
    },
    deactivate({ restoreFocus = true } = {}): void {
      if (!active) return;
      active = false;
      document.removeEventListener('keydown', onKeydown, true);
      if (restoreFocus && returnFocus?.isConnected) {
        returnFocus.focus();
      }
      returnFocus = null;
    },
  };
}
