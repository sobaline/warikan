// 精算の計算（画面とは独立した部分）

// 文字列から決まった数を作る（同じ文字列なら必ず同じ数）
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 金額を、割る人たちに1円単位で均等に配分する。
// 割り切れない端数の1円は、立て替えた人以外から「くじ」で選んだ人が持つ。
// くじは支払いID（seed）で決まるので、同じ支払いなら誰の画面でも何度開いても同じ結果になり、
// 支払いごとに違う人へ散らばる。立て替えた人は最後に回す（払った人が損しないように）。
export function splitShares(total, payerId, memberIds, seed = '') {
  const result = new Map();
  const n = memberIds.length;
  if (n === 0) return result;
  const base = Math.floor(total / n);
  let rest = total - base * n;
  const lottery = (id) => hash(`${seed}:${id}`);
  const order = [
    ...memberIds.filter((id) => id !== payerId).sort((a, b) => lottery(a) - lottery(b) || (a < b ? -1 : 1)),
    ...memberIds.filter((id) => id === payerId),
  ];
  for (const id of order) {
    let v = base;
    if (rest > 0) { v += 1; rest -= 1; }
    result.set(id, v);
  }
  return result;
}

// 1つの支払いを配分する。
// fixed：個別に入力した金額（メンバーID → 円）。合計から個別分を引いた残りを、割る人全員で均等に割る。
export function splitExpense(total, payerId, memberIds, fixed = new Map(), seed = '') {
  const result = new Map();
  if (memberIds.length === 0) return result;
  let fixedSum = 0;
  for (const id of memberIds) fixedSum += Math.max(0, Math.round(Number(fixed.get(id)) || 0));
  const remainder = Math.max(0, total - fixedSum);
  const even = splitShares(remainder, payerId, memberIds, seed);
  for (const id of memberIds) {
    result.set(id, Math.max(0, Math.round(Number(fixed.get(id)) || 0)) + (even.get(id) || 0));
  }
  return result;
}

// 一人ひとりの内訳。
// paid：立て替えた合計 / owed：自分の負担分（＝使ったお金） / spotGave・spotGot：その場で払った・受け取った
// sent・received：送金や貸し借りで渡した・受け取った / net：差し引き（プラス＝受け取る、マイナス＝払う）
// opts.settled：支払いID → その場で払い済みの人の集合
// opts.fixed：支払いID → （メンバーID → 個別金額）
export function computeBreakdown(memberIds, expenses, sharesByExpense, payments, opts = {}) {
  const settledByExpense = opts.settled || new Map();
  const fixedByExpense = opts.fixed || new Map();
  const blank = () => ({ paid: 0, owed: 0, spotGave: 0, spotGot: 0, sent: 0, received: 0, net: 0 });
  const r = new Map(memberIds.map((id) => [id, blank()]));
  const get = (id) => {
    if (!r.has(id)) r.set(id, blank());
    return r.get(id);
  };
  for (const e of expenses) {
    const ids = sharesByExpense.get(e.id) || [];
    if (ids.length === 0) continue;
    const total = Math.round(Number(e.jpy_amount));
    const settled = settledByExpense.get(e.id) || new Set();
    get(e.payer_id).paid += total;
    for (const [id, v] of splitExpense(total, e.payer_id, ids, fixedByExpense.get(e.id), e.id)) {
      get(id).owed += v;
      if (settled.has(id) && id !== e.payer_id) {
        get(id).spotGave += v;
        get(e.payer_id).spotGot += v;
      }
    }
  }
  for (const p of payments) {
    get(p.from_member_id).sent += Number(p.amount);
    get(p.to_member_id).received += Number(p.amount);
  }
  for (const v of r.values()) {
    v.net = v.paid - v.owed + v.spotGave - v.spotGot + v.sent - v.received;
  }
  return r;
}

// 各メンバーの差し引きだけを取り出す。
export function computeBalances(memberIds, expenses, sharesByExpense, payments, opts = {}) {
  const bal = new Map();
  for (const [id, v] of computeBreakdown(memberIds, expenses, sharesByExpense, payments, opts)) bal.set(id, v.net);
  return bal;
}

// 自動：送金回数が少なくなるように組み合わせる。
// 1) 払う額と受け取る額がぴったり同じ人どうしを先にペアにする
// 2) 残りは「いちばん多く払う人」→「いちばん多く受け取る人」の順に割り当てる
export function settleAuto(bal) {
  const creditors = [];
  const debtors = [];
  for (const [id, v] of bal) {
    if (v > 0) creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  const out = [];

  for (const d of debtors) {
    const c = creditors.find((x) => x.v === d.v && x.v > 0);
    if (c) {
      out.push({ from: d.id, to: c.id, amount: d.v });
      c.v = 0;
      d.v = 0;
    }
  }

  const cs = creditors.filter((x) => x.v > 0);
  const ds = debtors.filter((x) => x.v > 0);
  while (cs.length && ds.length) {
    cs.sort((a, b) => b.v - a.v);
    ds.sort((a, b) => b.v - a.v);
    const c = cs[0];
    const d = ds[0];
    const x = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amount: x });
    c.v -= x;
    d.v -= x;
    if (c.v === 0) cs.shift();
    if (d.v === 0) ds.shift();
  }
  return out;
}

// 幹事にまとめる：全員が幹事とだけやり取りする。
export function settleHub(bal, hubId) {
  const out = [];
  for (const [id, v] of bal) {
    if (id === hubId || v === 0) continue;
    if (v < 0) out.push({ from: id, to: hubId, amount: -v });
    else out.push({ from: hubId, to: id, amount: v });
  }
  return out;
}
