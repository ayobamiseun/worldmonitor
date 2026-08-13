import { expect, test } from '@playwright/test';

/**
 * #6426: the desktop app treats >= 900px as ultrawide (getUltraWideMinWidth,
 * src/app/panel-layout.ts) and moves saved bottom-set panels into
 * #mapBottomGrid — but panels.css hid that container below 1600px
 * unconditionally, so for any desktop window in the 900-1599px band the
 * user's bottom-zone panels sat in a display:none container with nothing
 * indicating where they went.
 *
 * The web bundle is booted in desktop mode through isDesktopRuntime()'s
 * user-agent sniff ("Tauri" in navigator.userAgent) — the same signal the
 * packaged app can be detected by — so this runs against the standard e2e
 * dev server without a desktop build.
 */

test.use({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Tauri/2.0',
});

test.describe('desktop bottom zone in the 900-1599px band', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
      localStorage.setItem('worldmonitor-variant', 'happy');
    });
  });

  test('saved bottom-set panel is visible at 1200px and returns to the main grid below 900px', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The Tauri UA sniff must have produced the desktop layout, or the band
    // under test does not exist.
    await expect(page.locator('main.main-content.desktop-grid')).toHaveCount(1, { timeout: 30_000 });

    // Discover a real panel id in this variant, then persist it as the
    // bottom set the same way savePanelOrder() does. Both keys are needed:
    // applySavedPanelOrder() early-returns when `panel-order` is absent, so
    // seeding only the bottom-set key never reaches the zone logic.
    const firstPanel = page.locator('#panelsGrid > .panel[data-panel]').first();
    await firstPanel.waitFor({ state: 'attached', timeout: 60_000 });
    const panelId = await firstPanel.getAttribute('data-panel');
    expect(panelId).toBeTruthy();

    await page.evaluate((id) => {
      const order = Array.from(document.querySelectorAll('.panel[data-panel]'))
        .map((el) => (el as HTMLElement).dataset.panel)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      localStorage.setItem('panel-order', JSON.stringify(order));
      localStorage.setItem('panel-order-bottom-set', JSON.stringify([id]));
    }, panelId);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // The panel must land in the bottom grid AND be visible — before the
    // fix it landed there but the container was display:none !important.
    const seeded = page.locator(`#mapBottomGrid .panel[data-panel="${panelId}"]`);
    await expect(seeded).toBeVisible({ timeout: 60_000 });

    // Below the desktop ultrawide threshold the zone logic moves the panel
    // back to the main grid; it must stay visible through the transition.
    await page.setViewportSize({ width: 850, height: 800 });
    await expect(page.locator(`#panelsGrid .panel[data-panel="${panelId}"]`)).toBeVisible({ timeout: 30_000 });
  });
});
