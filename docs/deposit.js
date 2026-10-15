'use strict';

// 預け入れ枚数の集計（預け入れ枚数集計エクセルの移植）
// - 預け先への送付（from=ユーザ, to=預け先）＝預入、預け先からの送付（from=預け先, to=ユーザ）＝返却
// - 保有枚数：純額＝預入−返却、預入のみ＝預入合計
// - 対象外：除外一覧のユーザ、保有枚数 0 以下のユーザ
// - ランク：下限で判定（最下位の下限未満は「ランク外」）。報酬（年）＝保有枚数×年利、月＝年÷12、日＝年÷365
// ブラウザ（self.Deposit）と Node（module.exports）の両方で使う

(function (root) {
  const MODE_NET = 'net';
  const MODE_DEPOSIT = 'deposit';
  const OUT_OF_RANK = 'ランク外';
  const DAY = 86400;

  const round8 = (v) => Math.round(v * 1e8) / 1e8;

  // ランク基準表から、保有枚数に対応するランクを返す。{ name, rate }
  function rankOf(holding, ranks) {
    if (!ranks || !ranks.length || holding < ranks[0].min) return { name: OUT_OF_RANK, rate: 0 };
    let hit = ranks[0];
    for (const r of ranks) if (holding >= r.min) hit = r;
    return { name: hit.name, rate: hit.rate };
  }

  // 集計本体
  //   deposit: データファイルの deposit（custodian, exclude, transfers, balance）
  //   ranks:   ランク基準表（下限の小さい順）。null ならランク・報酬は計算しない
  //   opts:    { mode: 'net' | 'deposit', price: 単価 }
  function aggregate(deposit, ranks, opts = {}) {
    const mode = opts.mode === MODE_DEPOSIT ? MODE_DEPOSIT : MODE_NET;
    const price = Number(opts.price) || 0;
    const custodian = deposit.custodian.toLowerCase();
    const exclude = new Map((deposit.exclude || []).map((x) => [x.address.toLowerCase(), x.memo || '']));
    const users = new Map();
    const user = (a) => {
      if (!users.has(a)) users.set(a, { address: a, dep: 0, wd: 0, depN: 0, wdN: 0, lastDepositT: 0 });
      return users.get(a);
    };

    for (const x of deposit.transfers) {
      const from = x.from.toLowerCase();
      const to = x.to.toLowerCase();
      const amt = Number(x.amount);
      if (to === custodian && from !== custodian) {
        const u = user(from);
        u.dep += amt; u.depN++;
        if (x.t > u.lastDepositT) u.lastDepositT = x.t;
      } else if (from === custodian && to !== custodian) {
        const u = user(to);
        u.wd += amt; u.wdN++;
      }
    }

    const all = [];
    let custodyCalc = 0;
    for (const u of users.values()) {
      custodyCalc += u.dep - u.wd;
      u.net = round8(u.dep - u.wd);
      u.holding = round8(mode === MODE_DEPOSIT ? u.dep : u.dep - u.wd);
      if (exclude.has(u.address)) u.status = 'excluded';
      else if (u.holding > 0) u.status = 'target';
      else u.status = 'zero';
      if (ranks) {
        const r = rankOf(u.holding, ranks);
        u.rank = r.name; u.rate = r.rate;
        u.rewardYear = u.holding * u.rate;
        u.rewardMonth = u.rewardYear / 12;
        u.rewardDay = u.rewardYear / 365;
        u.costDay = u.rewardDay * price;
      }
      all.push(u);
    }

    // ランキング（保有枚数の多い順。同じ枚数は同じ順位）
    const list = all.filter((u) => u.status === 'target').sort((a, b) => b.holding - a.holding || a.address.localeCompare(b.address));
    list.forEach((u, i) => { u.order = i > 0 && list[i - 1].holding === u.holding ? list[i - 1].order : i + 1; });

    const sum = (arr, k) => arr.reduce((s, u) => s + (u[k] || 0), 0);
    const total = {
      users: list.length,
      holding: sum(list, 'holding'),
      rewardDay: ranks ? sum(list, 'rewardDay') : null,
      rewardMonth: ranks ? sum(list, 'rewardMonth') : null,
      rewardYear: ranks ? sum(list, 'rewardYear') : null,
      excluded: all.length - list.length,
      custodyCalc: round8(custodyCalc),
      custodyActual: deposit.balance != null ? Number(deposit.balance) : null,
    };
    total.costDay = total.rewardDay != null ? total.rewardDay * price : null;
    total.costMonth = total.rewardMonth != null ? total.rewardMonth * price : null;
    total.costYear = total.rewardYear != null ? total.rewardYear * price : null;

    let byRank = null;
    if (ranks) {
      byRank = ranks.map((r) => {
        const us = list.filter((u) => u.rank === r.name);
        return { name: r.name, min: r.min, max: r.max, rate: r.rate, users: us.length, share: list.length ? us.length / list.length : 0, holding: sum(us, 'holding'), rewardDay: sum(us, 'rewardDay') };
      });
    }

    return { mode, list, all, total, byRank, byAddress: new Map(all.map((u) => [u.address, u])) };
  }

  // 取引タブ用：指定アドレスの預入枚数・報酬枚数（最終預入日時から asOf までの経過 24 時間ごとに1日分）
  // 預入が複数回ある場合も、最終預入日時を預入枚数の全量に適用する（条件を変えるときはここだけ直す）
  function rewardFor(u, asOfUnix) {
    if (!u || u.status !== 'target') return null;
    const days = u.lastDepositT ? Math.max(0, Math.floor((asOfUnix - u.lastDepositT) / DAY)) : 0;
    const reward = u.rate != null ? u.holding * u.rate / 365 * days : null;
    return { holding: u.holding, rank: u.rank, rate: u.rate, days, reward, lastDepositT: u.lastDepositT };
  }

  // ランク基準表ファイルの検証（下限の小さい順に並べ替えて返す）
  function validateRanks(json) {
    if (!json || json.format !== 'tx-viewer-rank' || json.version !== 1 || !Array.isArray(json.ranks) || !json.ranks.length) {
      throw new Error('ランク基準表のファイルではありません');
    }
    const ranks = json.ranks.map((r) => ({ name: String(r.name), min: Number(r.min), max: r.max == null ? null : Number(r.max), rate: Number(r.rate) }));
    if (ranks.some((r) => !r.name || !Number.isFinite(r.min) || !Number.isFinite(r.rate))) throw new Error('ランク基準表の内容が正しくありません');
    return ranks.sort((a, b) => a.min - b.min);
  }

  const api = { MODE_NET, MODE_DEPOSIT, OUT_OF_RANK, aggregate, rankOf, rewardFor, validateRanks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deposit = api;
})(typeof self !== 'undefined' ? self : this);
