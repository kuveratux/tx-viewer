'use strict';

// Service Worker（端末内の受付係）
// - 画面のファイル：保管庫を優先して返し、裏で新しい版を取りに行く
// 取引データは扱わない（利用者がファイルを選んで読み込み、端末内の IndexedDB に保存する）
// 画面のファイルを変えたら version.js の APP_VERSION を上げる（古い保管庫が削除され、新しい版に入れ替わる）

importScripts('version.js');
const VERSION = self.APP_VERSION;
const SHELL = 'shell-' + VERSION;
const SHELL_FILES = [
  './',
  'index.html',
  'version.js',
  'deposit.js',
  'drive.js',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.cache === 'no-store' || e.request.cache === 'reload') return; // 更新確認などは保管庫を通さない

  // 保管庫優先（裏で更新）
  e.respondWith(
    caches.open(SHELL).then((c) =>
      c.match(e.request, { ignoreSearch: true }).then((hit) => {
        const update = fetch(e.request)
          .then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; })
          .catch(() => hit);
        return hit || update;
      })
    )
  );
});
