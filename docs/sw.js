'use strict';

// Service Worker（端末内の受付係）
// - 画面のファイル：保管庫を優先して返し、裏で新しい版を取りに行く
// - 取引データ（data/）：ネットワークを優先し、つながらないときだけ保管庫の前回分を返す
// 画面のファイルを変えたら VERSION を上げる（古い保管庫が削除され、新しい版に入れ替わる）

const VERSION = 'v1';
const SHELL = 'shell-' + VERSION;
const DATA = 'data';
const SHELL_FILES = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.includes('/data/')) {
    // ネットワーク優先
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() => caches.open(DATA).then((c) => c.match(url.pathname)).then((hit) => hit || Response.error()))
    );
    return;
  }

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
