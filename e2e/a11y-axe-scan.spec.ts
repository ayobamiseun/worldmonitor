import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Automated axe-core scan of the hydrated dashboard (#6573).
 *
 * Biome's a11y lint group only analyzes JSX, so the template-string DOM this
 * app builds gets zero static a11y coverage — this scan is the regression
 * gate that role. It runs the WCAG 2.x A/AA rule tags and fails when a
 * violation appears for any rule NOT already on the known-violations list
 * below.
 *
 * The known-violation lists are shrink-only escape hatches: an entry that
 * stops firing fails the test until it is deleted, so the lists always
 * reflect reality. Both are empty as of introduction.
 *
 * CI invokes this file via `npm run test:e2e:ci-smoke` (nothing in CI runs
 * the `e2e/` glob). `REQUIRED_CI_SMOKE_SPECS` pins the argv token.
 */

async function loadDashboard(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    undefined,
    { timeout: 60_000 },
  );
  await page.locator('[role="tablist"]').first().waitFor({ timeout: 30_000 });
  await page.locator('#panelsGrid .panel').first().waitFor({ timeout: 30_000 });
}

// Empty as of introduction (the #6573 remediation PRs cleared the backlog axe
// can detect). If a violation must temporarily ship, add its rule id here WITH
// a link to a tracking issue — the shrink-only guard below deletes entries the
// moment they stop firing, so the list cannot rot.
const KNOWN_VIOLATION_RULES: string[] = [];

const KNOWN_SETTINGS_VIOLATION_RULES: string[] = [];

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

function assertOnlyKnownViolations(results: AxeResults, known: string[], surface: string): void {
  const violationIds = [...new Set(results.violations.map((v) => v.id))].sort();
  const unexpected = results.violations.filter((v) => !known.includes(v.id));
  const stale = known.filter((id) => !violationIds.includes(id));

  const describe = (vs: AxeResults['violations']) =>
    vs.map((v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}`).join('\n') +
      (v.nodes.length > 5 ? `\n    …and ${v.nodes.length - 5} more nodes` : ''),
    ).join('\n\n');

  expect(
    unexpected,
    `New axe violations on ${surface} (not on the known backlog):\n\n${describe(unexpected)}`,
  ).toEqual([]);

  // Shrink-only guard: an entry that no longer fires must be deleted, so the
  // backlog list always reflects reality.
  expect(
    stale,
    `These known-violation entries for ${surface} no longer fire — delete them: ${stale.join(', ')}`,
  ).toEqual([]);
}

test.describe('a11y — axe-core WCAG A/AA scan', () => {
  test('dashboard has no axe violations outside the known backlog', async ({ page }) => {
    await loadDashboard(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // Vite's dev-server error overlay is tooling, not app UI; without this
      // an unrelated local build hiccup would fail the a11y gate.
      .exclude('vite-error-overlay')
      .analyze();

    console.log(`[axe] scanned=${results.passes.reduce((a, p) => a + p.nodes.length, 0)} pass-nodes, incomplete=${results.incomplete.map((i) => `${i.id}:${i.nodes.length}`).join(',') || 'none'}`);
    console.log(`[axe] violations: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })), null, 2)}`);

    // Sanity: an empty page would also produce zero violations. Require real
    // scanned content so a broken boot can't masquerade as a green scan.
    expect(results.passes.reduce((a, p) => a + p.nodes.length, 0)).toBeGreaterThan(100);

    assertOnlyKnownViolations(results, KNOWN_VIOLATION_RULES, 'the dashboard');
  });

  test('settings dialog has no axe violations outside the known backlog', async ({ page }) => {
    await loadDashboard(page);
    await page.locator('#unifiedSettingsBtn').click();
    await page.locator('#unifiedSettingsModal.active').waitFor({ timeout: 30_000 });

    const results = await new AxeBuilder({ page })
      .include('#unifiedSettingsModal')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    console.log(`[axe:settings] violations: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target })), null, 2)}`);
    expect(results.passes.reduce((a, p) => a + p.nodes.length, 0)).toBeGreaterThan(20);

    assertOnlyKnownViolations(results, KNOWN_SETTINGS_VIOLATION_RULES, 'the settings dialog');
  });
});
