'use strict';

// 表示と配色（表示名・アイコン・配色）。端末ごとの設定
// 画面が描かれる前に反映するため <head> で読み込む。設定の正本は IndexedDB（app.js）で、
// 起動直後に使うための写しを localStorage に置く（消えても既定の表示になるだけ）

const APPEARANCE_DEFAULT = { name: '', icon: { type: 'preset', id: 'exchange' }, theme: 'auto' };
const APP_NAME_DEFAULT = '取引ビューア';
const ICON_PRESETS = [
  { id: 'exchange', label: 'エクスチェンジ' },
  { id: 'candle', label: 'キャンドル' },
  { id: 'trend', label: 'トレンド' },
  { id: 'chain', label: 'ブロックチェーン' },
  { id: 'gold', label: 'ゴールド' },
  { id: 'classic', label: 'クラシック' },
];
const THEME_COLOR = { light: '#1f5fbf', dark: '#15243d' };

function iconUrl(icon) {
  if (icon && icon.type === 'custom' && icon.data) return icon.data;
  const id = icon && icon.type === 'preset' ? icon.id : 'exchange';
  return id === 'exchange' ? 'icons/icon-180.png' : 'icons/presets/' + id + '.png';
}

function resolvedTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyAppearance(a) {
  a = Object.assign({}, APPEARANCE_DEFAULT, a || {});
  const name = (a.name || '').trim() || APP_NAME_DEFAULT;
  const root = document.documentElement;
  if (a.theme === 'light' || a.theme === 'dark') root.setAttribute('data-theme', a.theme);
  else root.removeAttribute('data-theme');

  document.title = name;
  const set = (sel, attr, v) => { const e = document.querySelector(sel); if (e) e.setAttribute(attr, v); };
  set('meta[name="apple-mobile-web-app-title"]', 'content', name);
  set('meta[name="theme-color"]', 'content', THEME_COLOR[resolvedTheme(a.theme)]);
  const icon = iconUrl(a.icon);
  set('link[rel="apple-touch-icon"]', 'href', icon);
  set('link[rel="icon"]', 'href', icon);
  const h1 = document.querySelector('.bar h1');
  if (h1) h1.textContent = name;
  window.__appearance = a;
}

function cacheAppearance(a) {
  try { localStorage.setItem('txv-appearance', JSON.stringify(a)); } catch { /* 保存できなくても表示には影響しない */ }
}

(function init() {
  let a = null;
  try { a = JSON.parse(localStorage.getItem('txv-appearance') || 'null'); } catch { a = null; }
  applyAppearance(a);
  // 「自動」のとき、端末の明暗が変わったら上部のバーの色も合わせる
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(window.__appearance));
  }
})();
