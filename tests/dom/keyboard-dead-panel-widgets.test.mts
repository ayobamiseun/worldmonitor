/**
 * #7023 (phase-2 residual) — two still-live keyboard-dead widgets from the
 * "remaining click-only panels" bucket, fixed with the established
 * activation idiom (tabindex on the template + bindActivationKeys
 * delegation, role left off table semantics — the #6964 call):
 *
 *   - WsbTickerScannerPanel's sortable column headers: click-only <th>
 *     elements with no tabindex, no aria-sort, no keyboard path.
 *   - CountryDeepDivePanel's trade-exposure sector rows: click-only <tr>
 *     drill-ins with no tabindex and no expanded-state signal.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { WsbTickerScannerPanel } from '@/components/WsbTickerScannerPanel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';

/** Panel.setSafeContent debounces string content by 150ms. */
const flushPanelContent = () => new Promise((resolve) => setTimeout(resolve, 200));

function pressEnter(el: HTMLElement): void {
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function ticker(symbol: string, mentionCount: number, totalScore: number) {
  return {
    symbol,
    mentionCount,
    uniquePosts: 1,
    totalScore,
    avgUpvoteRatio: 0.9,
    subreddits: ['wallstreetbets'],
    velocityScore: 1,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('WsbTickerScannerPanel sortable headers (#7023)', () => {
  async function renderedPanel(): Promise<{ panel: WsbTickerScannerPanel; content: HTMLElement }> {
    const panel = new WsbTickerScannerPanel();
    document.body.appendChild(panel.getElement());
    panel.updateData([ticker('GME', 50, 10), ticker('AMC', 20, 90)]);
    await flushPanelContent();
    const content = panel.getElement().querySelector<HTMLElement>('.panel-content');
    expect(content).toBeTruthy();
    return { panel, content: content! };
  }

  it('sort headers are focusable and announce the active sort direction', async () => {
    const { content } = await renderedPanel();
    const headers = [...content.querySelectorAll<HTMLElement>('th[data-sort]')];
    expect(headers.length).toBe(3);
    for (const th of headers) {
      expect(th.getAttribute('tabindex')).toBe('0');
    }
    // Default sort: mentionCount descending.
    expect(content.querySelector('th[data-sort="mentionCount"]')!.getAttribute('aria-sort')).toBe('descending');
    expect(content.querySelector('th[data-sort="totalScore"]')!.hasAttribute('aria-sort')).toBe(false);
  });

  it('Enter on a header sorts by that column, exactly like a click', async () => {
    const { content } = await renderedPanel();

    pressEnter(content.querySelector<HTMLElement>('th[data-sort="totalScore"]')!);
    await flushPanelContent();

    const rows = [...content.querySelectorAll<HTMLElement>('tbody tr')];
    const firstRowText = rows[0]?.textContent ?? '';
    expect(firstRowText).toContain('AMC');
    expect(content.querySelector('th[data-sort="totalScore"]')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('Enter on the active header flips the direction', async () => {
    const { content } = await renderedPanel();

    pressEnter(content.querySelector<HTMLElement>('th[data-sort="mentionCount"]')!);
    await flushPanelContent();

    expect(content.querySelector('th[data-sort="mentionCount"]')!.getAttribute('aria-sort')).toBe('ascending');
    const rows = [...content.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows[0]?.textContent ?? '').toContain('AMC');
  });
});

describe('CountryDeepDivePanel sector rows (#7023)', () => {
  type CdpInternals = {
    tradeExposureBody: HTMLElement | null;
    cachedTradeExposureData: unknown;
    cachedSectors: unknown;
    renderTradeExposureContent(): void;
    handleSectorRowClick(hs2: string): void;
  };

  function renderedRows(): { internals: CdpInternals; body: HTMLElement } {
    const panel = new CountryDeepDivePanel(null);
    const internals = panel as unknown as CdpInternals;
    const body = document.createElement('div');
    document.body.appendChild(body);
    internals.tradeExposureBody = body;
    internals.cachedTradeExposureData = { vulnerabilityIndex: 42 };
    internals.cachedSectors = [
      { hs2: '85', label: 'Electronics', dependencyFlag: 'none', primaryChokepointName: 'Malacca', exposureScore: 61 },
      { hs2: '27', label: 'Fuels', dependencyFlag: 'none', primaryChokepointName: 'Hormuz', exposureScore: 88 },
    ];
    internals.renderTradeExposureContent();
    return { internals, body };
  }

  it('rows are focusable and carry the expanded state, without a table-breaking role', () => {
    const { body } = renderedRows();
    const rows = [...body.querySelectorAll<HTMLElement>('tr.cdp-sector-row')];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(row.getAttribute('aria-expanded')).toBe('false');
      expect(row.hasAttribute('role')).toBe(false);
    }
  });

  it('Enter on a row drills in exactly like a click', () => {
    const { internals, body } = renderedRows();
    const seen: string[] = [];
    internals.handleSectorRowClick = (hs2: string) => { seen.push(hs2); };

    pressEnter(body.querySelector<HTMLElement>('tr.cdp-sector-row[data-hs2="27"]')!);

    expect(seen).toEqual(['27']);
  });

  it('a selected row announces aria-expanded true', () => {
    const panel = new CountryDeepDivePanel(null);
    const internals = panel as unknown as CdpInternals & { selectedSectorHs2: string | null };
    const body = document.createElement('div');
    document.body.appendChild(body);
    internals.tradeExposureBody = body;
    internals.cachedTradeExposureData = { vulnerabilityIndex: 42 };
    internals.cachedSectors = [
      { hs2: '85', label: 'Electronics', dependencyFlag: 'none', primaryChokepointName: 'Malacca', exposureScore: 61 },
    ];
    internals.selectedSectorHs2 = '85';
    // buildRouteDetail renders the expanded detail row; it may need richer
    // state than this fixture carries, so tolerate its failure — the row
    // attribute under test is written before the detail row builds.
    try {
      internals.renderTradeExposureContent();
    } catch {
      /* detail-row construction is not under test */
    }
    const row = body.querySelector<HTMLElement>('tr.cdp-sector-row');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
  });
});
