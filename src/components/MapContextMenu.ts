export interface MapContextMenuItem {
  label: string;
  action: () => void;
}

let activeMenu: HTMLElement | null = null;
let returnFocus: HTMLElement | null = null;

function menuItems(): HTMLElement[] {
  return activeMenu ? Array.from(activeMenu.querySelectorAll<HTMLElement>('.map-context-menu-item')) : [];
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    dismissMapContextMenu();
    return;
  }
  if (!activeMenu) return;

  const items = menuItems();
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[(current + 1) % items.length]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[(current - 1 + items.length) % items.length]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
  } else if ((e.key === 'Enter' || e.key === ' ') && current >= 0) {
    e.preventDefault();
    items[current]?.click();
  }
}

export function dismissMapContextMenu(): void {
  if (activeMenu) {
    const hadFocus = activeMenu.contains(document.activeElement);
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('keydown', onMenuKeydown);
    // Removing the menu while focus was inside drops focus to <body>;
    // hand it back to whatever had it before the menu opened.
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }
}

export function showMapContextMenu(x: number, y: number, items: MapContextMenuItem[]): void {
  dismissMapContextMenu();
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement('div');
  menu.className = 'map-context-menu';
  menu.setAttribute('role', 'menu');
  const clampedX = Math.min(x, window.innerWidth - 200);
  const clampedY = Math.min(y, window.innerHeight - items.length * 32 - 8);
  menu.style.left = `${clampedX}px`;
  menu.style.top = `${clampedY}px`;
  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'map-context-menu-item';
    el.setAttribute('role', 'menuitem');
    el.tabIndex = -1;
    el.textContent = item.label;
    el.addEventListener('click', (e) => { e.stopPropagation(); item.action(); dismissMapContextMenu(); });
    menu.append(el);
  });
  requestAnimationFrame(() => {
    document.addEventListener('click', dismissMapContextMenu, { once: true });
  });
  document.addEventListener('keydown', onMenuKeydown);
  document.body.appendChild(menu);
  activeMenu = menu;
  // Menu pattern: focus moves into the menu on open; arrows walk the items.
  menuItems()[0]?.focus();
}
