'use strict';

// Google ドライブからの取得
// - 権限は drive.file（このアプリで選んだファイルだけ読める）。ドライブのほかのファイルは見えない
// - 初回だけ Google Picker でファイルを選び、以降は同じファイルを「最新データを取得」で読み直す
// - Google のスクリプトは、ボタンを押したときに初めて読み込む（起動時には Google に通信しない）

// Google Cloud の設定値（公開しても問題ない値。API キーは HTTP リファラーと API の種類で制限しておく）
const GOOGLE = {
  clientId: '62334130469-9cd1ogi940lagb7cm9l25f8809l7k7tg.apps.googleusercontent.com',  // OAuth クライアント ID（…apps.googleusercontent.com）
  apiKey: 'AIzaSyD7iwB6KuIykAVptoMmMD7Dg43x0xm_nxQ',    // API キー（Google Picker API 用）
  appId: '62334130469',     // プロジェクト番号（数字）
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const Drive = (() => {
  let tokenClient = null;
  let token = null; // { value, expiresAt }
  let loading = null;

  const configured = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google のスクリプトを読み込めませんでした（通信を確認してください）'));
      document.head.append(s);
    });
  }

  // 読み込み済みなら false、今回読み込んだなら true を返す
  async function ensureLoaded() {
    if (tokenClient) return false;
    if (!loading) {
      loading = (async () => {
        await Promise.all([loadScript('https://accounts.google.com/gsi/client'), loadScript('https://apis.google.com/js/api.js')]);
        await new Promise((resolve) => gapi.load('picker', resolve));
        tokenClient = google.accounts.oauth2.initTokenClient({ client_id: GOOGLE.clientId, scope: SCOPE, callback: () => {} });
      })();
    }
    await loading;
    return true;
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (r) => {
        if (r.error) return reject(new Error('Google ログインに失敗しました：' + r.error));
        token = { value: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) - 60) * 1000 };
        resolve(token.value);
      };
      tokenClient.error_callback = (e) => {
        const err = new Error(e.type === 'popup_failed_to_open'
          ? 'ログイン画面を開けませんでした。もう一度ボタンを押してください。'
          : e.type === 'popup_closed' ? 'ログインが中断されました。' : 'Google ログインに失敗しました：' + e.type);
        err.retry = e.type === 'popup_failed_to_open';
        reject(err);
      };
      tokenClient.requestAccessToken({ prompt });
    });
  }

  async function getToken() {
    if (token && Date.now() < token.expiresAt) return token.value;
    return requestToken('');
  }

  // ファイルを選ぶ（初回・ファイルを変えるとき）。{ id, name } を返す。キャンセル時は null
  async function pick(title) {
    const accessToken = await getToken();
    return new Promise((resolve) => {
      const mine = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setMode(google.picker.DocsViewMode.LIST);
      const shared = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setOwnedByMe(false).setMode(google.picker.DocsViewMode.LIST);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE.apiKey)
        .setAppId(GOOGLE.appId)
        .setLocale('ja')
        .setTitle(title || 'データファイルを選んでください')
        .addView(shared)
        .addView(mine)
        .setCallback((d) => {
          if (d.action === google.picker.Action.PICKED) resolve({ id: d.docs[0].id, name: d.docs[0].name });
          else if (d.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function api(url, accessToken) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (res.status === 401) { token = null; throw Object.assign(new Error('ログインの有効期限が切れました。もう一度押してください。'), { retry: true }); }
    if (res.status === 403 || res.status === 404) throw Object.assign(new Error('ファイルにアクセスできません（共有が外れたか、ファイルが置き換えられた可能性があります）。ファイルを選び直してください。'), { repick: true });
    if (!res.ok) throw new Error('ドライブからの取得に失敗しました（HTTP ' + res.status + '）');
    return res;
  }

  // ファイルの情報と中身を取得
  async function download(fileId) {
    const accessToken = await getToken();
    const base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId);
    const meta = await (await api(base + '?fields=id,name,modifiedTime&supportsAllDrives=true', accessToken)).json();
    const text = await (await api(base + '?alt=media&supportsAllDrives=true', accessToken)).text();
    return { meta, text };
  }

  function signOut() {
    if (token && window.google) google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
  }

  return { configured, ensureLoaded, pick, download, signOut };
})();
