function createSidebarStore() {
  const STORAGE_KEY = 'sidebar_collapsed';
  const WIDTH_STORAGE_KEY = 'sidebar_width';
  const DEFAULT_WIDTH = 240;
  const MIN_WIDTH = 190;
  const MAX_WIDTH = 420;

  const stored =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(STORAGE_KEY) === 'true'
      : false;

  const storedWidth =
    typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem(WIDTH_STORAGE_KEY))
      : NaN;

  let collapsed = $state(stored); // persistent
  let width = $state(
    !isNaN(storedWidth) && storedWidth >= MIN_WIDTH && storedWidth <= MAX_WIDTH
      ? storedWidth
      : DEFAULT_WIDTH,
  );
  let isResizing = $state(false);
  let mobileOpen = $state(false);

  return {
    get collapsed() {
      return collapsed;
    },

    get width() {
      return width;
    },

    get isResizing() {
      return isResizing;
    },

    get defaultWidth() {
      return DEFAULT_WIDTH;
    },

    get minWidth() {
      return MIN_WIDTH;
    },

    get maxWidth() {
      return MAX_WIDTH;
    },

    get mobileOpen() {
      return mobileOpen;
    },

    toggle() {
      collapsed = !collapsed;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, String(collapsed));
      }
    },

    set(value: boolean) {
      collapsed = value;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, String(value));
      }
    },

    setWidth(newWidth: number) {
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(newWidth)));
      width = clamped;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
      }
    },

    resetWidth() {
      width = DEFAULT_WIDTH;
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(WIDTH_STORAGE_KEY);
      }
    },

    setResizing(value: boolean) {
      isResizing = value;
    },

    // mobile
    openMobile() {
      mobileOpen = true;
    },

    closeMobile() {
      mobileOpen = false;
    },

    toggleMobile() {
      mobileOpen = !mobileOpen;
    },
  };
}

export const sidebarStore = createSidebarStore();