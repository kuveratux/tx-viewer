'use strict';

// 取引ビューア
// 取引データ（data/transactions.json）は公開データ。名前・分類（アドレス帳）は端末内の IndexedDB だけに保存する。

const DATA_URL = 'data/transactions.json';
const $ = (id) => document.getElementById(id);

let data = null;   // 取引データ
let book = new Map(); // address(小文字) -> { address, name, category, updatedAt }

//--------------------------------------------------------------
// アドレス帳（IndexedDB）
//--------------------------------------------------------------
const DB_NAME = 'tx-viewer';
const STORE = 'addressbook';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'address' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

async function loadBook() {
  const rows = await dbRun('readonly', (s) => s.getAll());
  book = new Map(rows.map((r) => [r.address, r]));
}

async function saveEntry(address, name, category) {
  const entry = { address: address.toLowerCase(), name: name.trim(), category: (category || '').trim(), updatedAt: new Date().toISOString() };
  await dbRun('readwrite', (s) => s.put(entry));
  book.set(entry.address, entry);
}

async function deleteEntry(address) {
  await dbRun('readwrite', (s) => s.delete(address));
  book.delete(address);
}

//--------------------------------------------------------------
// 表示用の小道具
//--------------------------------------------------------------
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const fmtAmount = (n) => Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 6 });
const fmtDate = (unix) => new Date(unix * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function labelOf(address) {
  const b = book.get(address.toLowerCase());
  return b ? b.name : short(address);
}

//--------------------------------------------------------------
// 取引データの読み込み
//--------------------------------------------------------------
async function loadData() {
  $('status').textContent = '読み込み中…';
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
    $('status').textContent = '更新：' + new Date(data.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('status').textContent = 'データを取得できませんでした';
    console.error(e);
  }
}

//--------------------------------------------------------------
// 取引タブ
//--------------------------------------------------------------
function renderTargets() {
  const sel = $('targetSel');
  const current = sel.value;
  sel.replaceChildren(...data.targets.map((t) => el('option', { value: t.address }, labelOf(t.address) + (book.has(t.address.toLowerCase()) ? '（' + short(t.address) + '）' : ''))));
  if (current) sel.value = current;

  const tokSel = $('tokenSel');
  const curTok = tokSel.value;
  tokSel.replaceChildren(el('option', { value: '' }, 'すべて'), ...data.tokens.map((t) => el('option', { value: t.symbol }, t.symbol)));
  tokSel.value = curTok;
}

function renderTx() {
  if (!data) return;
  $('dummyNote').hidden = !data.dummy;
  const target = $('targetSel').value.toLowerCase();
  const token = $('tokenSel').value;
  const dir = $('dirSel').value;

  // 残高
  const t = data.targets.find((x) => x.address.toLowerCase() === target);
  $('balances').replaceChildren(...Object.entries(t ? t.balances : {}).map(([sym, v]) =>
    el('div', { class: 'card' }, el('div', { class: 'sym' }, sym + ' 残高'), el('div', { class: 'val' }, fmtAmount(v)))));

  // 取引
  const rows = data.transfers
    .filter((x) => x.from.toLowerCase() === target || x.to.toLowerCase() === target)
    .map((x) => ({ ...x, dir: x.to.toLowerCase() === target ? 'in' : 'out' }))
    .filter((x) => (!token || x.token === token) && (!dir || x.dir === dir))
    .sort((a, b) => b.t - a.t || b.log - a.log);

  $('txCount').textContent = rows.length + ' 件';
  $('txList').replaceChildren(...rows.map((x) => {
    const cp = x.dir === 'in' ? x.from : x.to;
    const b = book.get(cp.toLowerCase());
    const cpBtn = el('button', { class: 'cp', type: 'button', onclick: () => openNameDialog(cp) },
      (x.dir === 'in' ? '← ' : '→ ') + (b ? b.name : short(cp)), b && b.category ? el('span', { class: 'cat' }, b.category) : null);
    const link = data.dummy || !data.chain.explorer ? null :
      el('a', { class: 'tx-link', href: data.chain.explorer + '/tx/' + x.tx, target: '_blank', rel: 'noopener noreferrer' }, 'エクスプローラーで見る');
    return el('li', {},
      el('div', { class: 'tx-top' },
        el('span', { class: 'tx-date' }, fmtDate(x.t)),
        el('span', { class: 'tx-amt ' + x.dir }, (x.dir === 'in' ? '+' : '−') + fmtAmount(x.amount) + ' ' + x.token)),
      cpBtn, link ? el('div', {}, link) : null);
  }));
}

//--------------------------------------------------------------
// 名前の登録ダイアログ（取引一覧の相手先をタップ）
//--------------------------------------------------------------
function openNameDialog(address) {
  const b = book.get(address.toLowerCase());
  $('dlgAddr').textContent = address;
  $('dlgName').value = b ? b.name : '';
  $('dlgCat').value = b ? b.category : '';
  $('nameDlg').dataset.addr = address;
  $('nameDlg').showModal();
}

$('nameDlg').addEventListener('close', async () => {
  const dlg = $('nameDlg');
  if (dlg.returnValue !== 'save') return;
  const name = $('dlgName').value.trim();
  if (name) await saveEntry(dlg.dataset.addr, name, $('dlgCat').value);
  else await deleteEntry(dlg.dataset.addr.toLowerCase());
  refreshAll();
});

//--------------------------------------------------------------
// アドレス帳タブ
//--------------------------------------------------------------
function renderBook() {
  const rows = [...book.values()].sort((a, b) => (a.category || '').localeCompare(b.category || '', 'ja') || a.name.localeCompare(b.name, 'ja'));
  $('bookList').replaceChildren(...(rows.length ? rows.map((r) => el('li', {},
    el('div', { class: 'b-name' }, r.name, r.category ? el('span', { class: 'muted' }, '　' + r.category) : null),
    el('div', { class: 'mono' }, r.address),
    el('div', { class: 'b-actions' },
      el('button', { type: 'button', onclick: () => { $('bAddr').value = r.address; $('bName').value = r.name; $('bCat').value = r.category; $('bName').focus(); } }, '編集'),
      el('button', { type: 'button', onclick: async () => { if (confirm(r.name + ' を削除しますか？')) { await deleteEntry(r.address); refreshAll(); } } }, '削除'))))
    : [el('li', { class: 'muted' }, 'まだ登録がありません。取引一覧の相手先をタップしても登録できます。')]));

  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))];
  $('catList').replaceChildren(...cats.map((c) => el('option', { value: c })));
}

$('bookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const addr = $('bAddr').value.trim();
  if (!isAddress(addr)) { alert('アドレスの形式が正しくありません（0x で始まる42文字）'); return; }
  await saveEntry(addr, $('bName').value, $('bCat').value);
  $('bookForm').reset();
  refreshAll();
});
$('bClear').addEventListener('click', () => $('bookForm').reset());

//--------------------------------------------------------------
// 設定タブ：書き出し・読み込み
//--------------------------------------------------------------
$('exportBtn').addEventListener('click', () => {
  const body = JSON.stringify({ format: 'tx-viewer-addressbook', version: 1, exportedAt: new Date().toISOString(), entries: [...book.values()] }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'addressbook_' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json.format !== 'tx-viewer-addressbook' || !Array.isArray(json.entries)) throw new Error('形式が違います');
    const valid = json.entries.filter((x) => x && isAddress(x.address) && typeof x.name === 'string' && x.name.trim());
    if (!confirm(valid.length + ' 件を読み込みます。同じアドレスは上書きされます。よろしいですか？')) return;
    for (const x of valid) await saveEntry(x.address, x.name, x.category);
    refreshAll();
    alert(valid.length + ' 件を読み込みました。');
  } catch (err) {
    alert('読み込めませんでした：' + err.message);
  }
});

async function showStorageInfo() {
  if (!navigator.storage || !navigator.storage.persist) return;
  const persisted = await navigator.storage.persisted() || await navigator.storage.persist();
  $('storageInfo').textContent = persisted
    ? '保存の持続化：有効（容量不足でも自動で消されにくくなっています）'
    : '保存の持続化：未許可（念のため定期的に書き出しをおすすめします）';
}

$('reloadBtn').addEventListener('click', async () => { await loadData(); refreshAll(); });

//--------------------------------------------------------------
// インストール（Android の Chrome などで使える）
//--------------------------------------------------------------
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('installBtn').hidden = true;
});

//--------------------------------------------------------------
// タブ切り替え・全体
//--------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + btn.dataset.tab; });
}));
['targetSel', 'tokenSel', 'dirSel'].forEach((id) => $(id).addEventListener('change', renderTx));

function refreshAll() {
  if (data) {
    renderTargets();
    renderTx();
    $('dataInfo').textContent = 'チェーン：' + data.chain.name + '　対象アドレス：' + data.targets.length + ' 件　取引：' + data.transfers.length + ' 件';
  }
  renderBook();
}

(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
  await loadBook();
  await loadData();
  refreshAll();
  showStorageInfo();
})();
