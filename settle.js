// 精算の計算（画面とは独立した部分）

// 1つの支払いを、割る人たちに1円単位で配分する。
// 割り切れない端数は、立て替えた人以外が先に1円ずつ多く持つ（払った人が損しないように）。
export function splitShares(total, payerId, memberIds) {
  const result = new Map();
  const n = memberIds.length;
  if (n === 0) return result;
  const base = Math.floor(total / n);
  let rest = total - base * n;
  const order = [
    ...memberIds.filter((id) => id !== payerId),
    ...memberIds.filter((id) => id === payerId),
  ];
  for (const id of order) {
    let v = base;
    if (rest > 0) { v += 1; rest -= 1; }
    result.set(id, v);
  }
  return result;
}

// 各メンバーの差し引き。プラス＝受け取る、マイナス＝払う。
export function computeBalances(memberIds, expenses, sharesByExpense, payments) {
  const bal = new Map(memberIds.map((id) => [id, 0]));
  const add = (id, v) => bal.set(id, (bal.get(id) || 0) + v);
  for (const e of expenses) {
    const ids = sharesByExpense.get(e.id) || [];
    if (ids.length === 0) continue;
    const total = Math.round(Number(e.jpy_amount));
    add(e.payer_id, total);
    for (const [id, v] of splitShares(total, e.payer_id, ids)) add(id, -v);
  }
  for (const p of payments) {
    add(p.from_member_id, Number(p.amount));
    add(p.to_member_id, -Number(p.amount));
  }
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
