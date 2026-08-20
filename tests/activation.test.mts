import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { bindActivationKeys } from '../src/utils/activation.ts';
import { createBrowserEnvironment, type MiniElement } from './helpers/mini-dom.mts';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');

function installDom() {
  const browser = createBrowserEnvironment();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: browser.document,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    writable: true,
    value: browser.HTMLElement,
  });
  return browser.document;
}

function restoreDom(): void {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
  else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
}

afterEach(restoreDom);

describe('bindActivationKeys', () => {
  it('turns Enter/Space on a matching row into a click, ignoring other keys and non-rows', () => {
    const document = installDom();
    const content = document.createElement('div');
    const handlers = new Map<string, EventListener>();
    content.addEventListener = ((type: string, listener: EventListener) => {
      handlers.set(type, listener);
    }) as typeof content.addEventListener;

    const row = document.createElement('div');
    row.className = 'drill-row';
    content.appendChild(row);
    const outside = document.createElement('div');
    content.appendChild(outside);

    let clicks = 0;
    (row as unknown as { click: () => void }).click = () => { clicks += 1; };
    (outside as unknown as { click: () => void }).click = () => { clicks += 100; };

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    const dispatch = (target: MiniElement, key: string): Event => {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperties(event, {
        target: { value: target },
        key: { value: key },
      });
      handlers.get('keydown')?.(event);
      return event;
    };

    const enter = dispatch(row, 'Enter');
    const space = dispatch(row, ' ');
    dispatch(row, 'Tab');
    dispatch(outside, 'Enter');

    assert.equal(clicks, 2);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(space.defaultPrevented, true);
  });

  it('leaves keydown alone when focus is on a nested control inside the row', () => {
    const document = installDom();
    const content = document.createElement('div');
    const handlers = new Map<string, EventListener>();
    content.addEventListener = ((type: string, listener: EventListener) => {
      handlers.set(type, listener);
    }) as typeof content.addEventListener;

    const row = document.createElement('div');
    row.className = 'drill-row';
    const nested = document.createElement('button');
    row.appendChild(nested);
    content.appendChild(row);

    let rowClicks = 0;
    (row as unknown as { click: () => void }).click = () => { rowClicks += 1; };

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    const event = new Event('keydown', { cancelable: true });
    Object.defineProperties(event, {
      target: { value: nested },
      key: { value: 'Enter' },
    });
    handlers.get('keydown')?.(event);

    assert.equal(rowClicks, 0);
    assert.equal(event.defaultPrevented, false);
  });
});
