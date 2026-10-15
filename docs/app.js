'use strict';

// 取引ビューア
// 取引データは、利用者が操作したときだけ読み込む（ファイルを選ぶ、または Google ドライブから取得）。自動では取りに行かない。
// 取引データ・名前・分類（アドレス帳）は、すべて端末内の IndexedDB だけに保存する。

const $ = (id) => document.getElementById(id);

let data = null;   // 取引データ
let dataMeta = null; // { fileName, importedAt }
let book = new Map(); // address(小文字) -> { address, name, category, updatedAt }

//--------------------------------------------------------------
// 端末内の保存（IndexedDB）
//--------------------------------------------------------------
const DB_NAME = 'tx-viewer';
const STORE = 'addressbook';
const DATA_STORE = 'dataset';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'address' });
      if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn, store = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
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
// 取引データ：ファイルから読み込み、端末内に保存
//--------------------------------------------------------------
async function loadSavedData() {
  const saved = await dbRun('readonly', (s) => s.get('current'), DATA_STORE);
  if (saved) { data = saved.data; dataMeta = saved.meta; }
}

function validateData(d) {
  if (!d || (d.format && d.format !== 'tx-viewer-data') || d.version !== 1 ||
      !Array.isArray(d.targets) || !Array.isArray(d.tokens) || !Array.isArray(d.transfers) || !d.chain) {
    throw new Error('取引ビューアのデータファイルではありません');
  }
  return d;
}

// 暗号化ファイルの復号（取得プログラムと同じ方式：PBKDF2-SHA256 → AES-256-GCM）
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptData(enc, passphrase) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: enc.kdf.hash, salt: b64(enc.kdf.salt), iterations: enc.kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.cipher.iv) }, key, b64(enc.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

function askPassphrase() {
  return new Promise((resolve) => {
    const dlg = $('passDlg');
    $('passInput').value = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? { pass: $('passInput').value, save: $('passSave').checked } : null), { once: true });
    dlg.showModal();
  });
}

// 端末内の設定（取引データと同じ保存領域に、キーを分けて保存）
const getSetting = (key) => dbRun('readonly', (s) => s.get(key), DATA_STORE);
const putSetting = (key, value) => dbRun('readwrite', (s) => s.put(value, key), DATA_STORE);
const delSetting = (key) => dbRun('readwrite', (s) => s.delete(key), DATA_STORE);

// 暗号化されていれば復号する。保存済みの合言葉を先に試し、だめなら入力を求める。キャンセル時は null
async function decryptIfNeeded(json) {
  if (json.format !== 'tx-viewer-data-enc') return json;
  const saved = await getSetting('passphrase');
  if (saved) {
    try { return await decryptData(json, saved); } catch { /* 合言葉が変わった → 入力を求める */ }
  }
  for (;;) {
    const r = await askPassphrase();
    if (r == null) return null;
    $('status').textContent = '復号中…';
    try {
      const plain = await decryptData(json, r.pass);
      if (r.save) await putSetting('passphrase', r.pass);
      else await delSetting('passphrase');
      return plain;
    } catch {
      $('status').textContent = '';
      if (!confirm('合言葉が違うか、ファイルが壊れています。もう一度入力しますか？')) return null;
    }
  }
}

// ランク基準表（端末内に保存。預け入れタブと取引タブの報酬計算に使う）
let rank = null; // { ranks, generatedAt, fileName, importedAt }
async function loadSavedRank() { rank = (await getSetting('rank')) || null; }

const fmtJst = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

// 読み込んだ文字列（暗号化されていれば復号）を、取引データかランク基準表かを見分けて保存する
// 戻り値：表示するメッセージ。キャンセル時は null。失敗時は例外
async function importText(text, fileName, source) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('JSON 形式のファイルではありません'); }
  json = await decryptIfNeeded(json);
  if (!json) return null;

  if (json.format === 'tx-viewer-rank') {
    const ranks = Deposit.validateRanks(json);
    if (rank && source === 'drive' && rank.generatedAt === json.generatedAt) return 'ランク基準表は最新です';
    rank = { ranks, generatedAt: json.generatedAt, fileName, importedAt: new Date().toISOString() };
    await putSetting('rank', rank);
    refreshAll();
    return 'ランク基準表を読み込みました（' + ranks.length + ' ランク）';
  }

  validateData(json);
  if (data && source === 'drive' && json.generatedAt === data.generatedAt) {
    return 'すでに最新のデータです（取得：' + fmtJst(json.generatedAt) + '）';
  }
  const meta = { fileName, source, importedAt: new Date().toISOString() };
  await dbRun('readwrite', (s) => s.put({ data: json, meta }, 'current'), DATA_STORE);
  data = json;
  dataMeta = meta;
  refreshAll();
  return '読み込みました（取引 ' + data.transfers.length + ' 件' + (data.deposit ? '、預け先の入出金 ' + data.deposit.transfers.length + ' 件' : '') + '）';
}

// ファイルから読み込む（取引データ・ランク基準表のどちらでも可）
document.querySelectorAll('.dataFile').forEach((input) => input.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const msg = await importText(await file.text(), file.name, 'file');
    if (msg) alert(msg);
  } catch (err) {
    alert('読み込めませんでした：' + err.message);
  } finally {
    showStatus();
  }
}));

//--------------------------------------------------------------
// Google ドライブから最新データを取得（取引データと、選んであればランク基準表）
//--------------------------------------------------------------
let driveBusy = false;

// 記憶しているファイル（key: 'driveFile' | 'driveRankFile'）を取得して読み込む。必要ならファイルを選ばせる
async function driveImport(key, forcePick, what) {
  let file = forcePick ? null : await getSetting(key);
  if (!file) {
    $('status').textContent = what + 'のファイルを選択中…';
    file = await Drive.pick(what + 'のファイルを選んでください');
    if (!file) return null;
    await putSetting(key, file);
    renderDriveInfo();
  }
  $('status').textContent = what + 'を取得中…';
  try {
    const { meta, text } = await Drive.download(file.id);
    if (meta.name !== file.name) { await putSetting(key, { id: file.id, name: meta.name }); renderDriveInfo(); }
    return await importText(text, meta.name, 'drive');
  } catch (err) {
    if (err.repick) { await delSetting(key); renderDriveInfo(); }
    throw err;
  }
}

// mode: 'all'（取引データ＋ランク基準表）| 'pickData' | 'pickRank'
async function fetchFromDrive(mode) {
  if (driveBusy) return;
  if (!Drive.configured()) { alert('Google ドライブの連携が設定されていません。'); return; }
  driveBusy = true;
  const msgs = [];
  try {
    $('status').textContent = '準備中…';
    await Drive.ensureLoaded();
    if (mode !== 'pickRank') {
      const m = await driveImport('driveFile', mode === 'pickData', '取引データ');
      if (m) msgs.push(m);
    }
    if (mode === 'pickRank' || (mode === 'all' && await getSetting('driveRankFile'))) {
      const m = await driveImport('driveRankFile', mode === 'pickRank', 'ランク基準表');
      if (m) msgs.push(m);
    }
    if (mode === 'all' && data && data.deposit && !(await getSetting('driveRankFile')) && !rank) {
      msgs.push('※ 預け入れの報酬を計算するには、「設定」でランク基準表のファイルを選んでください。');
    }
  } catch (err) {
    msgs.push(err.message);
  } finally {
    driveBusy = false;
    showStatus();
  }
  if (msgs.length) alert(msgs.join('\n'));
}

async function renderDriveInfo() {
  const ok = Drive.configured();
  document.querySelectorAll('.driveOnly').forEach((e) => { e.hidden = !ok; });
  if (!ok) return;
  const file = await getSetting('driveFile');
  const rankFile = await getSetting('driveRankFile');
  const pass = await getSetting('passphrase');
  $('driveInfo').textContent = '取引データ：' + (file ? file.name : '未選択（初回に選びます）');
  $('driveRankInfo').textContent = 'ランク基準表：' + (rankFile ? rankFile.name : '未選択');
  $('forgetPassBtn').hidden = !pass;
}

document.querySelectorAll('.driveFetch').forEach((b) => b.addEventListener('click', () => fetchFromDrive('all')));
$('drivePickBtn').addEventListener('click', () => fetchFromDrive('pickData'));
$('driveRankPickBtn').addEventListener('click', () => fetchFromDrive('pickRank'));
$('driveSignOutBtn').addEventListener('click', async () => {
  Drive.signOut();
  await delSetting('driveFile');
  await delSetting('driveRankFile');
  renderDriveInfo();
  alert('Google との連携を解除しました（次回はログインとファイルの選択からやり直します）');
});
$('forgetPassBtn').addEventListener('click', async () => {
  await delSetting('passphrase');
  renderDriveInfo();
  alert('保存していた合言葉を削除しました');
});

function showStatus() {
  $('status').textContent = data
    ? '取得：' + new Date(data.generatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'データ未読み込み';
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
  tokSel.replaceChildren(el('option', { value: '' }, 'すべて'), ...orderSymbols(data.tokens.map((t) => t.symbol)).map((s) => el('option', { value: s }, s)));
  tokSel.value = curTok;
}

//--------------------------------------------------------------
// 残高の表示順（端末ごと）
//   balOrder：保存した順。データにない銘柄も残しておき、戻ってきたときは元の位置に出す
//   保存した順にない銘柄（あとから追加された銘柄）は末尾に、データの順で並べる
//--------------------------------------------------------------
let balOrder = [];

// データに出てくる銘柄（残高の銘柄 → トークン一覧の順。重複なし）
function dataSymbols() {
  if (!data) return [];
  const syms = [];
  for (const t of data.targets) for (const s of Object.keys(t.balances || {})) if (!syms.includes(s)) syms.push(s);
  for (const t of data.tokens) if (!syms.includes(t.symbol)) syms.push(t.symbol);
  return syms;
}

function orderSymbols(syms) {
  const saved = balOrder.filter((s) => syms.includes(s));
  return [...saved, ...syms.filter((s) => !saved.includes(s))];
}

async function moveSymbol(sym, delta) {
  const shown = orderSymbols(dataSymbols());
  const i = shown.indexOf(sym);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= shown.length) return;
  // 保存した順（データにない銘柄も含む）の中で、表示上の隣どうしを入れ替える
  const full = [...balOrder, ...shown.filter((s) => !balOrder.includes(s))];
  const a = full.indexOf(shown[i]);
  const b = full.indexOf(shown[j]);
  [full[a], full[b]] = [full[b], full[a]];
  balOrder = full;
  await putSetting('balanceOrder', balOrder);
  refreshAll();
}

function renderOrder() {
  const shown = orderSymbols(dataSymbols());
  $('orderList').replaceChildren(...(shown.length ? shown.map((sym, i) => el('li', {},
    el('span', { class: 'sym-name' }, sym),
    Object.assign(el('button', { type: 'button', 'aria-label': sym + ' を上へ', onclick: () => moveSymbol(sym, -1) }, '↑'), { disabled: i === 0 }),
    Object.assign(el('button', { type: 'button', 'aria-label': sym + ' を下へ', onclick: () => moveSymbol(sym, 1) }, '↓'), { disabled: i === shown.length - 1 })))
    : [el('li', { class: 'muted' }, 'データを読み込むと表示されます')]));
}

$('orderReset').addEventListener('click', async () => {
  balOrder = [];
  await delSetting('balanceOrder');
  refreshAll();
});

function renderTx() {
  if (!data) return;
  $('dummyNote').hidden = !data.dummy;
  const target = $('targetSel').value.toLowerCase();
  const token = $('tokenSel').value;
  const dir = $('dirSel').value;

  // 残高
  const t = data.targets.find((x) => x.address.toLowerCase() === target);
  const bal = t ? t.balances : {};
  $('balances').replaceChildren(...orderSymbols(Object.keys(bal)).map((sym) => balanceCard(sym, bal[sym], target)));

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
    // 相手側だけを表示する（自分＝上で選んだ対象アドレス）
    const cpBtn = el('button', { class: 'cp', type: 'button', onclick: () => openNameDialog(cp) },
      el('span', { class: 'cp-label' }, x.dir === 'in' ? '受取元：' : '送付先：'),
      b ? b.name : short(cp), b && b.category ? el('span', { class: 'cat' }, b.category) : null);
    const link = data.dummy || !data.chain.explorer ? null :
      el('a', { class: 'tx-link', href: data.chain.explorer + '/tx/' + x.tx, target: '_blank', rel: 'noopener noreferrer' }, 'エクスプローラーで見る');
    return el('li', {},
      el('div', { class: 'tx-top' },
        el('span', { class: 'tx-date' }, fmtDate(x.t)),
        el('span', { class: 'tx-amt ' + x.dir }, (x.dir === 'in' ? '+' : '−') + fmtAmount(x.amount) + ' ' + x.token)),
      cpBtn, link ? el('div', {}, link) : null);
  }));
}

// 残高カード。預け入れの集計トークンで、対象アドレスが預け入れ中なら、
// 残高に累計枚数（ウォレット＋預入＋報酬）を表示し、内訳を下に並べる
function balanceCard(sym, wallet, target) {
  const head = el('div', { class: 'sym' }, sym + ' 残高');
  const agg = depAggregate();
  const r = agg && sym === data.deposit.token ? Deposit.rewardFor(agg.byAddress.get(target), Date.parse(data.generatedAt) / 1000) : null;
  if (!r) return el('div', { class: 'card' }, head, el('div', { class: 'val' }, fmtAmount(wallet)));

  const total = Number(wallet) + r.holding + (r.reward || 0);
  const val = el('div', { class: 'val' }, fmtAmount(total), r.reward == null ? el('span', { class: 'val-note' }, '（報酬を除く）') : null);
  const rows = [['ウォレット', fmtAmount(wallet)], ['預入枚数', fmtAmount(r.holding)]];
  rows.push(['報酬枚数', r.reward == null ? 'ランク基準表が未読み込み' : fmtAmount(r.reward) + '（' + r.rank + ' ' + fmtPct(r.rate) + '・' + r.days + '日）']);
  rows.push(['最終預入', fmtDate(r.lastDepositT)]);
  return el('div', { class: 'card wide' }, head, val,
    el('div', { class: 'bal-extra' }, ...rows.flatMap(([k, v]) => [el('span', {}, k), el('b', {}, v)])));
}

//--------------------------------------------------------------
// 預け入れタブ（預け入れ枚数集計エクセルの移植）
//--------------------------------------------------------------
let depMode = Deposit.MODE_NET;
let depPrice = 0;
let depCache = null; // { key, agg }

const fmtPct = (v) => (v * 100).toFixed(2) + '%';
const fmt2 = (v) => Number(v).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 集計結果（データ・ランク基準表・集計方式・単価が変わったときだけ計算し直す）
function depAggregate() {
  if (!data || !data.deposit) return null;
  const key = [data.generatedAt, rank ? rank.generatedAt : '', depMode, depPrice].join('|');
  if (!depCache || depCache.key !== key) depCache = { key, agg: Deposit.aggregate(data.deposit, rank ? rank.ranks : null, { mode: depMode, price: depPrice }) };
  return depCache.agg;
}

function kvRows(rows) {
  return rows.flatMap(([k, v]) => [el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)]);
}

function renderDeposit() {
  const agg = depAggregate();
  $('depEmpty').hidden = !!agg;
  $('depBody').hidden = !agg;
  if (!agg) return;
  const d = data.deposit;
  const tt = agg.total;
  const hasRank = !!rank;
  const na = '—';
  $('depRankNote').hidden = hasRank;
  $('depMode').value = depMode;
  if (document.activeElement !== $('depPrice')) $('depPrice').value = depPrice || '';

  const diff = tt.custodyActual != null ? tt.custodyActual - tt.custodyCalc : null;
  $('depHeader').textContent = '取得：' + fmtJst(data.generatedAt) + '　トークン：' + d.token + '　預け先：' + labelOf(d.custodian) +
    (tt.custodyActual != null ? '　預け先の実際の残高：' + fmt2(tt.custodyActual) + '（取引からの計算との差：' + Number(diff.toFixed(6)).toLocaleString('ja-JP', { maximumFractionDigits: 6 }) + '）' : '') +
    (hasRank ? '　ランク基準表：' + rank.fileName : '');

  $('depTotal').replaceChildren(...kvRows([
    ['保有ユーザ数（人）', tt.users.toLocaleString('ja-JP')],
    ['総保有枚数', fmt2(tt.holding)],
    ['報酬枚数（日）', hasRank ? fmt2(tt.rewardDay) : na],
    ['報酬枚数（月）', hasRank ? fmt2(tt.rewardMonth) : na],
    ['報酬枚数（年）', hasRank ? fmt2(tt.rewardYear) : na],
    ['参考：対象外ユーザ数（除外指定・保有0以下）', tt.excluded.toLocaleString('ja-JP')],
    ['参考：預け先残高（取引からの計算：預入−返却）', fmt2(tt.custodyCalc)],
  ]));
  $('depCost').replaceChildren(...kvRows([
    ['1枚当たり単価', depPrice ? depPrice.toLocaleString('ja-JP', { maximumFractionDigits: 4 }) : '未入力'],
    ['費用（日）＝報酬枚数（日）×単価', hasRank ? fmt2(tt.costDay) : na],
    ['費用（月）＝報酬枚数（月）×単価', hasRank ? fmt2(tt.costMonth) : na],
    ['費用（年）＝報酬枚数（年）×単価', hasRank ? fmt2(tt.costYear) : na],
  ]));

  // ランク別集計（構成比は横棒で表示）
  const th = (t, n) => el('th', n ? { class: 'n' } : {}, t);
  const td = (t, n) => el('td', n ? { class: 'n' } : {}, t);
  if (hasRank) {
    const maxShare = Math.max(...agg.byRank.map((r) => r.share), 0.0001);
    $('depRanks').replaceChildren(
      el('tr', {}, th('ランク'), th('下限（枚）', 1), th('上限（枚）', 1), th('年利', 1), th('人数', 1), th('構成比'), th('保有枚数合計', 1), th('報酬枚数（日）合計', 1)),
      ...agg.byRank.map((r) => el('tr', { title: r.name + '：' + r.users + '人（' + (r.share * 100).toFixed(1) + '%）' },
        td(r.name), td(r.min.toLocaleString('ja-JP'), 1), td(r.max == null ? '以上' : r.max.toLocaleString('ja-JP'), 1), td(fmtPct(r.rate), 1), td(r.users.toLocaleString('ja-JP'), 1),
        el('td', {}, el('div', { class: 'share' }, el('div', { class: 'bar', style: 'width:' + Math.max(2, r.share / maxShare * 80) + 'px' }), el('span', { class: 'pct' }, (r.share * 100).toFixed(1) + '%'))),
        td(fmt2(r.holding), 1), td(fmt2(r.rewardDay), 1))),
      el('tr', { class: 'total' }, td('合計'), td(''), td(''), td(''), td(tt.users.toLocaleString('ja-JP'), 1), td(tt.users ? '100.0%' : '0.0%'), td(fmt2(tt.holding), 1), td(fmt2(tt.rewardDay), 1)));
  } else {
    $('depRanks').replaceChildren(el('tr', {}, el('td', {}, 'ランク基準表が未読み込みです')));
  }

  // 保有ユーザランキング
  $('depList').replaceChildren(
    el('tr', {}, th('順位', 1), th('保有ユーザ'), th('保有枚数', 1), th('ランク'), th('年利', 1), th('報酬枚数（日）', 1), th('報酬枚数（月）', 1), th('報酬枚数（年）', 1),
      th('費用（日）', 1), th('預入件数', 1), th('返却件数', 1), th('備考')),
    ...agg.list.map((u) => {
      const b = book.get(u.address);
      return el('tr', {},
        td(String(u.order), 1),
        el('td', {}, el('button', { class: 'cp', type: 'button', onclick: () => openNameDialog(u.address) }, short(u.address))),
        td(fmt2(u.holding), 1), td(hasRank ? u.rank : na), td(hasRank ? fmtPct(u.rate) : na, 1),
        td(hasRank ? fmt2(u.rewardDay) : na, 1), td(hasRank ? fmt2(u.rewardMonth) : na, 1), td(hasRank ? fmt2(u.rewardYear) : na, 1),
        td(hasRank && depPrice ? fmt2(u.costDay) : na, 1), td(String(u.depN), 1), td(String(u.wdN), 1),
        td(b ? b.name + (b.category ? '（' + b.category + '）' : '') : ''));
    }));
}

$('depMode').addEventListener('change', async () => {
  depMode = $('depMode').value;
  await putSetting('depMode', depMode);
  renderDeposit();
  renderTx();
});
$('depPrice').addEventListener('change', async () => {
  const v = Number($('depPrice').value);
  depPrice = Number.isFinite(v) && v > 0 ? v : 0;
  await putSetting('depPrice', depPrice);
  renderDeposit();
});

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
  $('emptyNote').hidden = !!data;
  $('txBody').hidden = !data;
  if (data) {
    renderTargets();
    renderTx();
    renderDeposit();
    const fmt = (s) => new Date(s).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    $('dataInfo').textContent = 'ファイル：' + dataMeta.fileName + '　取得：' + fmt(data.generatedAt) + '　読み込み：' + fmt(dataMeta.importedAt) +
      '　チェーン：' + data.chain.name + '　対象アドレス：' + data.targets.length + ' 件　取引：' + data.transfers.length + ' 件' +
      (data.deposit ? '　預け先の入出金：' + data.deposit.transfers.length + ' 件' : '') +
      '　ランク基準表：' + (rank ? rank.fileName + '（' + fmtJst(rank.generatedAt) + '）' : '未読み込み');
  } else {
    $('dummyNote').hidden = true;
    renderDeposit();
  }
  renderBook();
  renderOrder();
  renderDriveInfo();
  showStatus();
}

//--------------------------------------------------------------
// バージョンと更新
//--------------------------------------------------------------
$('appVersion').textContent = self.APP_VERSION;
// 保管庫（画面のファイル）を消してから再読み込みし、確実に新しい版を取り直す
async function applyUpdate() {
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch { /* 失敗しても再読み込みで取り直す */ }
  location.reload();
}
$('reloadBtn').addEventListener('click', applyUpdate);

if ('serviceWorker' in navigator) {
  // 新しい版の Service Worker に切り替わったら、再読み込みを促す（初回のインストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('updateNote').hidden = false; });
}

$('updateBtn').addEventListener('click', async () => {
  const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
  if (!reg) { alert('更新を確認できませんでした'); return; }
  $('updateBtn').disabled = true;
  try {
    await reg.update();
    const res = await fetch('version.js', { cache: 'no-store' });
    const latest = ((await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
    if (latest && latest !== self.APP_VERSION) {
      if (confirm('新しいバージョン（' + latest + '）があります。更新しますか？')) await applyUpdate();
    } else {
      alert('最新のバージョンです（' + self.APP_VERSION + '）');
    }
  } catch {
    alert('更新を確認できませんでした（通信を確認してください）');
  } finally {
    $('updateBtn').disabled = false;
  }
});

(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
  await loadBook();
  await loadSavedData();
  await loadSavedRank();
  depMode = (await getSetting('depMode')) || Deposit.MODE_NET;
  depPrice = Number(await getSetting('depPrice')) || 0;
  balOrder = (await getSetting('balanceOrder')) || [];
  refreshAll();
  showStorageInfo();
})();
