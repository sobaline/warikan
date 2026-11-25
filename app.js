import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { computeBalances, settleAuto, settleHub } from './settle.js';

const app = document.getElementById('app');
const CURRENCIES = ['JPY', 'USD', 'EUR', 'KRW', 'TWD', 'CNY', 'HKD', 'THB', 'SGD', 'GBP', 'AUD', 'PHP', 'VND'];

const state = {
  gid: null,      // 開いているグループID
  me: null,       // 自分のメンバーID
  db: null,       // Supabaseクライアント
  data: null,     // 読み込んだデータ一式
  tab: 'expenses',
  view: null,     // 開いている入力画面 { type: 'expense', id }
  busy: false,
};

/* ---------- 小さな道具 ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const yen = (n) => `${Math.round(Number(n) || 0).toLocaleString('ja-JP')}円`;
const fmtTime = (s) => new Date(s).toLocaleString('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const today = () => new Date().toLocaleDateString('sv-SE');

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// LINEの中のブラウザでは保存が使えないことがあるので、失敗しても止まらないようにする
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 無視 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 無視 */ } }

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function check(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// ボタン操作をまとめて実行し、エラーは画面に出す
async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err?.message ? `エラー：${err.message}` : 'エラーが発生しました');
  } finally {
    state.busy = false;
  }
}

function makeClient(gid, me) {
  const headers = { 'x-group-id': gid };
  if (me) headers['x-member-id'] = me;
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const groupUrl = () => `${location.origin}${location.pathname}#/g/${state.gid}`;
const nameOf = (id) => state.data?.members.find((m) => m.id === id)?.name ?? '不明';

function sharesOf(expenseId) {
  const order = state.data.members.map((m) => m.id);
  return state.data.shares
    .filter((s) => s.expense_id === expenseId)
    .map((s) => s.member_id)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function shareMap() {
  const map = new Map();
  for (const e of state.data.expenses) map.set(e.id, sharesOf(e.id));
  return map;
}

// その場で払い済みの人（立て替えた本人は除く）
function settledOf(e) {
  return state.data.shares
    .filter((s) => s.expense_id === e.id && s.settled && s.member_id !== e.payer_id)
    .map((s) => s.member_id);
}

function settledMap() {
  const map = new Map();
  for (const e of state.data.expenses) map.set(e.id, new Set(settledOf(e)));
  return map;
}

// 支払いの精算状況：'all'＝全員その場で精算済み、'some'＝一部、null＝なし
function settledStatus(e) {
  const others = sharesOf(e.id).filter((id) => id !== e.payer_id);
  const done = settledOf(e).length;
  if (!others.length || !done) return null;
  return done >= others.length ? 'all' : 'some';
}

/* ---------- データの読み込み ---------- */

async function load() {
  const g = state.gid;
  const db = state.db;
  const [group, members, expenses, shares, payments, notes, items, logs] = await Promise.all([
    check(db.from('groups').select('*').eq('id', g).maybeSingle()),
    check(db.from('members').select('*').eq('group_id', g).order('created_at').order('id')),
    check(db.from('expenses').select('*').eq('group_id', g)
      .order('paid_at', { ascending: false }).order('created_at', { ascending: false })),
    check(db.from('expense_shares').select('*').eq('group_id', g)),
    check(db.from('payments').select('*').eq('group_id', g).order('created_at', { ascending: false })),
    check(db.from('notes').select('*').eq('group_id', g).order('created_at', { ascending: false })),
    check(db.from('checklist_items').select('*').eq('group_id', g).order('created_at')),
    check(db.from('logs').select('*').eq('group_id', g).order('created_at', { ascending: false }).limit(100)),
  ]);
  state.data = { group, members, expenses, shares, payments, notes, items, logs };
}

async function refresh() {
  await load();
  render();
}

/* ---------- 画面の切り替え ---------- */

function route() {
  const m = location.hash.match(/^#\/g\/([0-9a-f-]{36})/i);
  state.view = null;
  if (m) {
    openGroup(m[1].toLowerCase());
  } else {
    state.gid = null;
    state.data = null;
    renderTop();
  }
}

async function openGroup(gid) {
  state.gid = gid;
  state.me = lsGet(`me:${gid}`);
  state.db = makeClient(gid, state.me);
  state.tab = 'expenses';
  app.innerHTML = '<p class="loading">読み込み中…</p>';
  try {
    await load();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="card"><p>読み込みに失敗しました。通信環境を確認して、もう一度開いてください。</p>
      <a class="btn" href="#/">トップへ</a></div>`;
    return;
  }
  if (state.me && !state.data.members.some((m) => m.id === state.me)) {
    state.me = null;
    state.db = makeClient(gid, null);
  }
  render();
}

function render() {
  if (!state.gid) return renderTop();
  if (!state.data?.group) {
    app.innerHTML = `<div class="card"><h2>グループが見つかりません</h2>
      <p>URLが正しいか確認してください。</p><a class="btn" href="#/">トップへ</a></div>`;
    return;
  }
  if (!state.me) return renderPick();
  renderGroup();
}

/* ---------- トップ（グループ作成） ---------- */

const memberInput = () => '<input class="member-name" maxlength="20" placeholder="名前">';

function renderTop() {
  app.innerHTML = `
    <header class="hero">
      <h1>割り勘精算</h1>
      <p>立て替えを入力するだけで、送金回数が少なくなる精算方法を自動で計算します。URLをLINEに貼るだけで、みんなで使えます。</p>
    </header>
    <form id="create-form" class="card">
      <label>グループ名<input name="name" required maxlength="40" placeholder="例：箱根旅行"></label>
      <div class="label">メンバー</div>
      <div id="member-inputs">${memberInput()}${memberInput()}${memberInput()}</div>
      <button type="button" class="btn ghost" data-act="add-member-input">＋ メンバーを追加</button>
      <button class="btn primary wide">グループを作る</button>
    </form>`;
}

async function createGroup(form) {
  const name = form.name.value.trim();
  const names = [...new Set(
    [...form.querySelectorAll('.member-name')].map((i) => i.value.trim()).filter(Boolean),
  )];
  if (!name) return toast('グループ名を入れてください');
  if (names.length < 2) return toast('メンバーを2人以上入れてください');
  const gid = uuid();
  const db = makeClient(gid, null);
  await check(db.from('groups').insert({ id: gid, name }));
  await check(db.from('members').insert(names.map((n) => ({ group_id: gid, name: n }))));
  location.hash = `#/g/${gid}`;
}

/* ---------- 自分を選ぶ ---------- */

function renderPick() {
  const d = state.data;
  app.innerHTML = `
    <div class="card">
      <h2>${esc(d.group.name)}</h2>
      <p>あなたはどのメンバーですか？</p>
      <div class="pick">
        ${d.members.map((m) => `<button class="btn" data-act="pick-me" data-id="${m.id}">${esc(m.name)}</button>`).join('')}
      </div>
      <details>
        <summary>リストに名前がない場合</summary>
        <form id="join-form" class="row">
          <input name="name" required maxlength="20" placeholder="名前">
          <button class="btn primary">参加する</button>
        </form>
      </details>
    </div>`;
}

function setMe(id) {
  state.me = id;
  lsSet(`me:${state.gid}`, id);
  state.db = makeClient(state.gid, id);
  render();
}

async function joinGroup(form) {
  const name = form.name.value.trim();
  if (!name) return;
  if (state.data.members.some((m) => m.name === name)) return toast('同じ名前の人がいます');
  const row = await check(state.db.from('members')
    .insert({ group_id: state.gid, name }).select('id').single());
  await load();
  setMe(row.id);
}

/* ---------- グループのホーム ---------- */

function renderGroup() {
  const d = state.data;
  const tabs = [['expenses', '支払い'], ['settle', '精算'], ['memo', 'メモ'], ['log', 'ログ']];
  const views = { expenses: viewExpenses, settle: viewSettle, memo: viewMemo, log: viewLog };
  app.innerHTML = `
    <header class="bar">
      <div>
        <h1>${esc(d.group.name)}</h1>
        <button class="link" data-act="change-me">${esc(nameOf(state.me))} として参加中（変更）</button>
      </div>
      <button class="btn small" data-act="share">共有</button>
    </header>
    <nav class="tabs">
      ${tabs.map(([k, l]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}
    </nav>
    <main>${views[state.tab]()}</main>
    ${state.view?.type === 'expense' ? viewExpenseForm() : ''}`;
  if (state.view?.type === 'expense') updatePreview();
}

/* 支払いタブ */

function viewExpenses() {
  const d = state.data;
  const total = d.expenses.reduce((s, e) => s + Number(e.jpy_amount), 0);
  const items = d.expenses.map((e) => {
    const n = sharesOf(e.id).length;
    const st = settledStatus(e);
    const stBadge = st === 'all' ? ' <span class="badge ok">精算済み</span>'
      : st === 'some' ? ' <span class="badge ok">一部精算済み</span>' : '';
    const foreign = e.currency !== 'JPY'
      ? `<div class="sub">${Number(e.amount).toLocaleString('ja-JP')} ${esc(e.currency)}${e.jpy_confirmed ? '' : ' <span class="badge">仮</span>'}</div>`
      : '';
    return `
      <li class="item" data-act="edit-expense" data-id="${e.id}">
        <div class="main">
          <div class="title">${esc(e.title)}${stBadge}</div>
          <div class="sub">${esc(nameOf(e.payer_id))}が立て替え・${n}人で割り勘・${esc(e.paid_at.slice(5).replace('-', '/'))}</div>
        </div>
        <div class="amt">${yen(e.jpy_amount)}${foreign}</div>
      </li>`;
  }).join('');
  return `
    <div class="summary">合計 <b>${yen(total)}</b>（${d.expenses.length}件）</div>
    <button class="btn primary wide" data-act="new-expense">＋ 支払いを追加</button>
    ${d.expenses.length ? `<ul class="list">${items}</ul>` : '<p class="empty">まだ支払いがありません</p>'}
    ${d.expenses.some((e) => !e.jpy_confirmed) ? '<p class="hint"><span class="badge">仮</span> は自動レートで計算した金額です。カード明細の金額がわかったら、支払いを開いて書き換えてください。</p>' : ''}
    ${viewLoans()}`;
}

/* 貸し借り（payments の kind='loan' として記録する。貸した人→借りた人へお金が動いた扱い） */

function viewLoans() {
  const d = state.data;
  const loans = d.payments.filter((p) => p.kind === 'loan');
  const rows = loans.map((p) => `
    <li class="item">
      <div class="main">
        <b>${esc(nameOf(p.to_member_id))}</b> が <b>${esc(nameOf(p.from_member_id))}</b> から借りた
        <div class="sub">${p.note ? `${esc(p.note)}・` : ''}${fmtTime(p.created_at)}</div>
      </div>
      <div class="amt">${yen(p.amount)}</div>
      <button class="x" data-act="delete-loan" data-id="${p.id}" aria-label="削除">×</button>
    </li>`).join('');
  return `
    <h3>貸し借り</h3>
    <details class="card manual">
      <summary>＋ お金を借りた・貸した記録を追加</summary>
      <p class="hint">「現金が足りなくてAさんに5,000円借りた」などを記録すると、最後の精算にまとめて反映されます。</p>
      <form id="loan-form">
        <div class="row">
          <label class="grow">借りた人<select name="borrower">${d.members.map((m) => `<option value="${m.id}" ${m.id === state.me ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label class="grow">貸した人<select name="lender">${d.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
        </div>
        <label>金額（円）<input name="amount" type="number" inputmode="numeric" min="1" step="1" required></label>
        <label>メモ（任意）<input name="note" maxlength="60" placeholder="例：タクシー代"></label>
        <button class="btn primary wide">記録する</button>
      </form>
    </details>
    ${loans.length ? `<ul class="list">${rows}</ul>` : ''}`;
}

function viewExpenseForm() {
  const d = state.data;
  const e = state.view.id ? d.expenses.find((x) => x.id === state.view.id) : null;
  const cur = e?.currency ?? 'JPY';
  const shareIds = e ? sharesOf(e.id) : d.members.map((m) => m.id);
  const actual = e && e.currency !== 'JPY' && e.jpy_confirmed ? Number(e.jpy_amount) : '';
  const settledIds = e ? settledOf(e) : [];
  return `
    <div class="sheet">
      <form id="expense-form" class="card">
        <h2>${e ? '支払いを編集' : '支払いを追加'}</h2>
        <label>何に<input name="title" required maxlength="60" value="${esc(e?.title ?? '')}" placeholder="例：夕食"></label>
        <div class="row">
          <label class="grow">金額<input name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${e ? Number(e.amount) : ''}"></label>
          <label>通貨<select name="currency">${CURRENCIES.map((c) => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        </div>
        <div class="fx" ${cur === 'JPY' ? 'hidden' : ''}>
          <label>レート（1通貨あたり何円）
            <div class="row">
              <input name="rate" type="number" inputmode="decimal" min="0" step="any" value="${e && e.currency !== 'JPY' ? Number(e.rate) : ''}">
              <button type="button" class="btn small" data-act="fetch-rate">今日のレート</button>
            </div>
          </label>
          <label>カード明細の実際の円額（わかったら入力）
            <input name="jpy_actual" type="number" inputmode="numeric" min="0" step="1" value="${actual}" placeholder="入力すると、この金額で精算します">
          </label>
          <p class="hint" id="jpy-preview"></p>
        </div>
        <label>立て替えた人
          <select name="payer">${d.members.map((m) => `<option value="${m.id}" ${m.id === (e?.payer_id ?? state.me) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        </label>
        <div class="label">誰の分？</div>
        <div class="checks">
          ${d.members.map((m) => `<label class="check"><input type="checkbox" name="share" value="${m.id}" ${shareIds.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}
        </div>
        <details class="settled-box" ${settledIds.length ? 'open' : ''}>
          <summary>その場で精算した人がいる</summary>
          <p class="hint">立て替えた人にその場で自分の分を払った人にチェックを入れると、その人の分は最後の精算から外れます。</p>
          <label class="check"><input type="checkbox" id="settle-all">この会計は全員その場で精算済み</label>
          <div class="checks">
            ${d.members.map((m) => `<label class="check"><input type="checkbox" name="settled" value="${m.id}" ${settledIds.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}
          </div>
        </details>
        <label>日付<input name="paid_at" type="date" value="${esc(e?.paid_at ?? today())}"></label>
        <div class="actions">
          ${e ? '<button type="button" class="btn danger" data-act="delete-expense">削除</button>' : ''}
          <span class="grow"></span>
          <button type="button" class="btn ghost" data-act="close">キャンセル</button>
          <button class="btn primary">保存</button>
        </div>
      </form>
    </div>`;
}

function updatePreview() {
  const f = document.getElementById('expense-form');
  if (!f) return;
  const cur = f.currency.value;
  f.querySelector('.fx').hidden = cur === 'JPY';
  const p = document.getElementById('jpy-preview');
  const amount = Number(f.amount.value);
  const rate = Number(f.rate.value);
  if (f.jpy_actual.value !== '') p.textContent = `精算には ${yen(f.jpy_actual.value)} を使います（確定）`;
  else if (amount && rate) p.textContent = `仮の円額：${yen(amount * rate)}（明細の金額がわかったら上に入力）`;
  else p.textContent = '';
}

async function fetchRate(cur) {
  const urls = [
    `https://api.frankfurter.dev/v1/latest?base=${cur}&symbols=JPY`,
    `https://api.frankfurter.app/latest?from=${cur}&to=JPY`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.rates?.JPY) return j.rates.JPY;
    } catch { /* 次を試す */ }
  }
  throw new Error(`${cur}のレートを取得できませんでした。手で入力してください`);
}

async function fillRate() {
  const f = document.getElementById('expense-form');
  if (!f || f.currency.value === 'JPY') return;
  const cur = f.currency.value;
  const rate = await fetchRate(cur);
  if (f.currency.value === cur) {
    f.rate.value = rate;
    updatePreview();
  }
}

async function saveExpense(f) {
  const shares = [...f.querySelectorAll('input[name="share"]:checked')].map((i) => i.value);
  if (!shares.length) return toast('誰の分かを1人以上選んでください');
  const title = f.title.value.trim();
  const amount = Number(f.amount.value);
  const currency = f.currency.value;
  if (!title || !(amount >= 0)) return toast('内容と金額を入れてください');

  let rate = 1;
  let jpy = Math.round(amount);
  let confirmed = true;
  if (currency !== 'JPY') {
    rate = Number(f.rate.value);
    if (f.jpy_actual.value !== '') {
      jpy = Math.round(Number(f.jpy_actual.value));
      if (!rate) rate = amount ? jpy / amount : 1;
    } else {
      if (!rate) return toast('レートを入れるか、実際の円額を入れてください');
      jpy = Math.round(amount * rate);
      confirmed = false;
    }
  }

  const row = {
    group_id: state.gid,
    payer_id: f.payer.value,
    title,
    amount,
    currency,
    rate: Math.round(rate * 1e6) / 1e6,
    jpy_amount: jpy,
    jpy_confirmed: confirmed,
    paid_at: f.paid_at.value || today(),
  };
  const db = state.db;
  let id = state.view.id;
  if (id) {
    await check(db.from('expenses').update(row).eq('id', id));
    await check(db.from('expense_shares').delete().eq('expense_id', id));
  } else {
    id = (await check(db.from('expenses').insert(row).select('id').single())).id;
  }
  const settled = [...f.querySelectorAll('input[name="settled"]:checked')].map((i) => i.value);
  await check(db.from('expense_shares').insert(shares.map((m) => ({
    expense_id: id,
    member_id: m,
    group_id: state.gid,
    settled: settled.includes(m) && m !== row.payer_id,
  }))));
  state.view = null;
  await refresh();
  toast('保存しました');
}

/* 精算タブ */

function currentPlan() {
  const d = state.data;
  const ids = d.members.map((m) => m.id);
  const bal = computeBalances(ids, d.expenses, shareMap(), d.payments, settledMap());
  const hub = ids.includes(d.group.hub_member_id) ? d.group.hub_member_id : null;
  const mode = d.group.settle_mode === 'hub' && hub ? 'hub' : 'auto';
  const plan = mode === 'hub' ? settleHub(bal, hub) : settleAuto(bal);
  return { bal, hub, mode, plan };
}

function viewSettle() {
  const d = state.data;
  const { bal, hub, mode, plan } = currentPlan();

  const rows = plan.map((t, i) => `
    <li class="item ${t.from === state.me || t.to === state.me ? 'mine' : ''}">
      <div class="main"><b>${esc(nameOf(t.from))}</b> → <b>${esc(nameOf(t.to))}</b></div>
      <div class="amt">${yen(t.amount)}</div>
      <button class="btn small primary" data-act="paid" data-i="${i}">払った</button>
    </li>`).join('');

  const balRows = d.members.map((m) => {
    const v = bal.get(m.id) || 0;
    const label = v > 0 ? `<span class="plus">${yen(v)} 受け取る</span>`
      : v < 0 ? `<span class="minus">${yen(-v)} 払う</span>` : '<span class="sub">精算済み</span>';
    return `<li class="item"><div class="main">${esc(m.name)}</div><div class="amt">${label}</div></li>`;
  }).join('');

  const paid = d.payments.filter((p) => p.kind !== 'loan');
  const history = paid.map((p) => `
    <li class="item">
      <div class="main">${esc(nameOf(p.from_member_id))} → ${esc(nameOf(p.to_member_id))}<div class="sub">${fmtTime(p.created_at)}</div></div>
      <div class="amt">${yen(p.amount)}</div>
      <button class="btn small ghost" data-act="undo-paid" data-id="${p.id}">取り消し</button>
    </li>`).join('');

  return `
    <div class="seg">
      <button class="${mode === 'auto' ? 'on' : ''}" data-act="mode" data-mode="auto">自動（回数を最小に）</button>
      <button class="${mode === 'hub' ? 'on' : ''}" data-act="mode" data-mode="hub">幹事にまとめる</button>
    </div>
    ${mode === 'hub' ? `<label class="inline">幹事
      <select id="hub-select">${d.members.map((m) => `<option value="${m.id}" ${m.id === hub ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    </label>` : ''}
    <h3>送金リスト</h3>
    ${plan.length ? `<ul class="list">${rows}</ul>` : '<p class="empty">精算はすべて完了しています</p>'}
    <h3>一人ひとりの差し引き</h3>
    <ul class="list">${balRows}</ul>
    <details class="card manual">
      <summary>リスト以外で送金した分を記録する</summary>
      <p class="hint">「Bさんだけ先にAさんへ払った」など、リストと違う形で払った分を記録すると、残りの精算が計算し直されます。</p>
      <form id="manual-pay-form">
        <div class="row">
          <label class="grow">払った人<select name="from">${d.members.map((m) => `<option value="${m.id}" ${m.id === state.me ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label class="grow">受け取った人<select name="to">${d.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
        </div>
        <label>金額（円）<input name="amount" type="number" inputmode="numeric" min="1" step="1" required></label>
        <button class="btn primary wide">記録する</button>
      </form>
    </details>
    ${paid.length ? `<h3>送金済み</h3><ul class="list">${history}</ul>` : ''}`;
}

async function setMode(mode) {
  const patch = { settle_mode: mode };
  if (mode === 'hub' && !state.data.group.hub_member_id) patch.hub_member_id = state.me;
  await check(state.db.from('groups').update(patch).eq('id', state.gid));
  await refresh();
}

async function markPaid(i) {
  const t = currentPlan().plan[i];
  if (!t) return;
  if (!confirm(`${nameOf(t.from)} → ${nameOf(t.to)} ${yen(t.amount)} を送金済みにしますか？`)) return;
  await check(state.db.from('payments').insert({
    group_id: state.gid, from_member_id: t.from, to_member_id: t.to, amount: t.amount,
  }));
  await refresh();
}

/* メモタブ */

function viewMemo() {
  const d = state.data;
  const items = d.items.map((it) => `
    <li class="item">
      <label class="check grow">
        <input type="checkbox" data-act="toggle-item" data-id="${it.id}" ${it.done ? 'checked' : ''}>
        <span class="${it.done ? 'done' : ''}">${esc(it.text)}</span>
      </label>
      ${it.done && it.done_by ? `<span class="sub">${esc(nameOf(it.done_by))}</span>` : ''}
      <button class="x" data-act="delete-item" data-id="${it.id}" aria-label="削除">×</button>
    </li>`).join('');
  const notes = d.notes.map((n) => `
    <li class="note">
      <div class="body">${esc(n.body)}</div>
      <div class="meta"><span class="sub">${fmtTime(n.created_at)}</span>
        <button class="x" data-act="delete-note" data-id="${n.id}" aria-label="削除">×</button></div>
    </li>`).join('');
  return `
    <h3>チェックリスト</h3>
    <form id="item-form" class="row">
      <input name="text" required maxlength="80" placeholder="例：レンタカーを予約">
      <button class="btn primary">追加</button>
    </form>
    ${d.items.length ? `<ul class="list">${items}</ul>` : '<p class="empty">項目はまだありません</p>'}
    <h3>メモ</h3>
    <form id="note-form">
      <textarea name="body" required maxlength="1000" rows="3" placeholder="集合場所、予約番号など"></textarea>
      <button class="btn primary">メモを追加</button>
    </form>
    ${d.notes.length ? `<ul class="notes">${notes}</ul>` : ''}`;
}

/* ログタブ */

function describeLog(l) {
  const r = l.detail || {};
  const A = { INSERT: '追加', UPDATE: '変更', DELETE: '削除' }[l.action] ?? l.action;
  switch (l.table_name) {
    case 'members':
      return `メンバーを${A}：${r.name}`;
    case 'expenses':
      return `支払いを${A}：${r.title}（${yen(r.jpy_amount)}）`;
    case 'payments': {
      if (r.kind === 'loan') {
        const loan = `${nameOf(r.to_member_id)}が${nameOf(r.from_member_id)}から${yen(r.amount)}借りた${r.note ? `（${r.note}）` : ''}`;
        return l.action === 'DELETE' ? `貸し借りを削除：${loan}` : `貸し借りを${A}：${loan}`;
      }
      const what = `${nameOf(r.from_member_id)} → ${nameOf(r.to_member_id)} ${yen(r.amount)}`;
      if (l.action === 'INSERT') return `送金済みにした：${what}`;
      if (l.action === 'DELETE') return `送金済みを取り消した：${what}`;
      return `送金を変更：${what}`;
    }
    case 'notes':
      return `メモを${A}：${String(r.body ?? '').slice(0, 30)}`;
    case 'checklist_items':
      if (l.action === 'UPDATE') return `「${r.text}」の${r.done ? 'チェックを付けた' : 'チェックを外した'}`;
      return `チェック項目を${A}：${r.text}`;
    default:
      return `${l.table_name} を${A}`;
  }
}

function viewLog() {
  const logs = state.data.logs;
  if (!logs.length) return '<p class="empty">まだ記録がありません</p>';
  return `<ul class="list">${logs.map((l) => `
    <li class="item log">
      <div class="main">${esc(describeLog(l))}<div class="sub">${fmtTime(l.created_at)}・${esc(l.member_id ? nameOf(l.member_id) : '不明')}</div></div>
    </li>`).join('')}</ul>`;
}

/* ---------- 共有 ---------- */

async function share() {
  const url = groupUrl();
  const text = `「${state.data.group.name}」の精算はこちら\n${url}`;
  const lineUrl = `https://line.me/R/share?text=${encodeURIComponent(text)}`;
  app.insertAdjacentHTML('beforeend', `
    <div class="sheet" id="share-sheet">
      <div class="card">
        <h2>メンバーに共有</h2>
        <p class="sub">このURLを知っている人は、誰でも見たり編集したりできます。</p>
        <input readonly value="${esc(url)}" onclick="this.select()">
        <a class="btn primary wide line" href="${lineUrl}" target="_blank" rel="noopener">LINEで送る</a>
        <button class="btn wide" data-act="copy-url">URLをコピー</button>
        <button class="btn ghost wide" data-act="close-share">閉じる</button>
      </div>
    </div>`);
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(groupUrl());
    toast('コピーしました');
  } catch {
    prompt('このURLをコピーしてください', groupUrl());
  }
}

/* ---------- 操作の受け付け ---------- */

app.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'add-member-input':
      document.getElementById('member-inputs').insertAdjacentHTML('beforeend', memberInput());
      break;
    case 'pick-me': setMe(id); break;
    case 'change-me':
      lsDel(`me:${state.gid}`);
      state.me = null;
      state.db = makeClient(state.gid, null);
      render();
      break;
    case 'tab': state.tab = t.dataset.tab; render(); break;
    case 'share': share(); break;
    case 'copy-url': copyUrl(); break;
    case 'close-share': document.getElementById('share-sheet')?.remove(); break;
    case 'new-expense': state.view = { type: 'expense', id: null }; render(); break;
    case 'edit-expense': state.view = { type: 'expense', id }; render(); break;
    case 'close': state.view = null; render(); break;
    case 'fetch-rate': run(fillRate); break;
    case 'delete-expense':
      if (confirm('この支払いを削除しますか？')) {
        run(async () => {
          await check(state.db.from('expenses').delete().eq('id', state.view.id));
          state.view = null;
          await refresh();
        });
      }
      break;
    case 'mode': run(() => setMode(t.dataset.mode)); break;
    case 'paid': run(() => markPaid(Number(t.dataset.i))); break;
    case 'undo-paid':
      if (confirm('この送金済みを取り消しますか？')) {
        run(async () => {
          await check(state.db.from('payments').delete().eq('id', id));
          await refresh();
        });
      }
      break;
    case 'toggle-item':
      run(async () => {
        await check(state.db.from('checklist_items')
          .update({ done: t.checked, done_by: t.checked ? state.me : null }).eq('id', id));
        await refresh();
      });
      break;
    case 'delete-loan':
      if (confirm('この貸し借りの記録を削除しますか？')) {
        run(async () => {
          await check(state.db.from('payments').delete().eq('id', id));
          await refresh();
        });
      }
      break;
    case 'delete-item':
      run(async () => {
        await check(state.db.from('checklist_items').delete().eq('id', id));
        await refresh();
      });
      break;
    case 'delete-note':
      if (confirm('このメモを削除しますか？')) {
        run(async () => {
          await check(state.db.from('notes').delete().eq('id', id));
          await refresh();
        });
      }
      break;
    default:
      break;
  }
});

app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  switch (f.id) {
    case 'create-form': run(() => createGroup(f)); break;
    case 'join-form': run(() => joinGroup(f)); break;
    case 'expense-form': run(() => saveExpense(f)); break;
    case 'item-form':
      run(async () => {
        await check(state.db.from('checklist_items').insert({ group_id: state.gid, text: f.text.value.trim() }));
        await refresh();
      });
      break;
    case 'manual-pay-form':
      run(async () => {
        const from = f.from.value;
        const to = f.to.value;
        const amount = Math.round(Number(f.amount.value));
        if (from === to) return toast('払った人と受け取った人が同じです');
        if (!(amount > 0)) return toast('金額を入れてください');
        await check(state.db.from('payments').insert({
          group_id: state.gid, from_member_id: from, to_member_id: to, amount,
        }));
        await refresh();
        toast('記録しました');
      });
      break;
    case 'loan-form':
      run(async () => {
        const borrower = f.borrower.value;
        const lender = f.lender.value;
        const amount = Math.round(Number(f.amount.value));
        if (borrower === lender) return toast('借りた人と貸した人が同じです');
        if (!(amount > 0)) return toast('金額を入れてください');
        // 貸した人 → 借りた人 へお金が動いたので、貸した人が受け取る側になる
        await check(state.db.from('payments').insert({
          group_id: state.gid,
          from_member_id: lender,
          to_member_id: borrower,
          amount,
          kind: 'loan',
          note: f.note.value.trim() || null,
        }));
        await refresh();
        toast('記録しました');
      });
      break;
    case 'note-form':
      run(async () => {
        await check(state.db.from('notes').insert({ group_id: state.gid, body: f.body.value.trim() }));
        await refresh();
      });
      break;
    default:
      break;
  }
});

app.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.name === 'currency') {
    updatePreview();
    if (t.value !== 'JPY') run(fillRate);
  }
  if (t.id === 'settle-all') {
    const f = t.closest('form');
    const shares = [...f.querySelectorAll('input[name="share"]:checked')].map((i) => i.value);
    f.querySelectorAll('input[name="settled"]').forEach((i) => {
      i.checked = t.checked && shares.includes(i.value) && i.value !== f.payer.value;
    });
  }
  if (t.id === 'hub-select') {
    run(async () => {
      await check(state.db.from('groups').update({ hub_member_id: t.value }).eq('id', state.gid));
      await refresh();
    });
  }
});

app.addEventListener('input', (ev) => {
  if (ev.target.closest('#expense-form')) updatePreview();
});

/* ---------- 自動で最新にする ---------- */

// 入力途中の文字を消さないように、何か書きかけのときは更新しない
function hasDraft() {
  if (state.view || document.getElementById('share-sheet')) return true;
  return [...app.querySelectorAll('input[type="text"], input:not([type]), textarea')]
    .some((el) => el.value.trim() !== '' && !el.readOnly);
}

function autoRefresh() {
  if (!state.gid || !state.me || !state.data?.group || document.hidden || state.busy || hasDraft()) return;
  load().then(render).catch(() => { /* 次回また試す */ });
}

setInterval(autoRefresh, 20000);
document.addEventListener('visibilitychange', autoRefresh);
window.addEventListener('hashchange', route);
route();
