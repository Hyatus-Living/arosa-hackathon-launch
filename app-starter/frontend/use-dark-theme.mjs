import {useSyncExternalStore} from 'react';

const isDark = () => document.documentElement.classList.contains('dark');
const subscribe = onChange => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
  return () => observer.disconnect();
};

export const useDarkTheme = () => useSyncExternalStore(subscribe, isDark, () => false);
