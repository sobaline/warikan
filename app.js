import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import {
  computeBalances, computeBreakdown, splitExpense, settleAuto, settleHub,
} from './settle.js';

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

const localDate = (ts) => new Date(ts).toLocaleDateString('sv-SE');

// 最近開いたグループ（この端末だけに保存）
function recentGroups() {
  try { return JSON.parse(lsGet('recent') || '[]'); } catch { return []; }
}
function rememberGroup(id, name, done = false) {
  const list = recentGroups().filter((g) => g.id !== id);
  list.unshift({ id, name, at: Date.now(), done });
  lsSet('recent', JSON.stringify(list.slice(0, 20)));
}
function forgetGroup(id) {
  lsSet('recent', JSON.stringify(recentGroups().filter((g) => g.id !== id)));
}

// 1人あたりの金額。割り切れないときは「3,333〜3,334円」のように幅で出す
function perPerson(total, n) {
  if (!n) return '';
  const t = Math.round(Number(total) || 0);
  const base = Math.floor(t / n);
  if (t % n === 0) return yen(base);
  return `${base.toLocaleString('ja-JP')}〜${yen(base + 1)}`;
}

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
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  el.onclick = action ? (ev) => {
    if (!ev.target.closest('.toast-btn')) return;
    el.hidden = true;
    action.fn();
  } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}

// 削除したあとに「元に戻す」付きの通知を出す（ログの記録から戻す）
function offerUndo(deletedId, msg) {
  const l = state.data.logs.find((x) => x.action === 'DELETE' && x.detail?.id === deletedId);
  if (!l) return toast(msg);
  toast(msg, { label: '元に戻す', fn: () => run(() => restoreFromLog(l.id, true)) });
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
    if (/row-level security|not_logged_in/i.test(err?.message || '')) {
      // 暗証番号のリセットなどで、ログインが切れていた
      logout('ログインが切れていたため、保存できませんでした。もう一度、自分の名前を選んで暗証番号を入れてください。');
      try { await load(); } catch { /* 無視 */ }
      render();
    } else if (/duplicate|unique|foreign key/i.test(err?.message || '')) {
      // ほかの人と同時に同じものを操作した
      toast('ほかの人と同時に操作したため、最新の状態に更新しました。もう一度確認してください');
      state.view = null;
      try { await refresh(); } catch { /* 無視 */ }
    } else {
      toast(err?.message ? `エラー：${err.message}` : 'エラーが発生しました');
    }
  } finally {
    state.busy = false;
  }
}

function makeClient(gid, me, token) {
  const headers = { 'x-group-id': gid };
  if (me) headers['x-member-id'] = me;
  if (token) headers['x-member-token'] = token; // 暗証番号でログインしたときの合い鍵
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: { headers },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const tokenKey = () => `tok:${state.gid}`;

// ログイン状態を消して、名前を選ぶ画面に戻す
function logout(reason) {
  lsDel(`me:${state.gid}`);
  lsDel(tokenKey());
  state.me = null;
  state.view = null;
  state.pick = null;
  state.db = makeClient(state.gid, null, null);
  state.logoutReason = reason || '';
}

// 共有用のURL。LINEで開いたときにSafariやChromeで開くよう ?openExternalBrowser=1 を付ける
const groupUrl = () => `${location.origin}/?openExternalBrowser=1#/g/${state.gid}`;
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

const CATEGORIES = ['食事', '交通', '宿', '観光・遊び', 'その他'];
const PAGE_SIZE = 5;      // 支払い一覧で最初に出す件数
const PAGE_STEP = 10;     // 「もっと見る」で増やす件数
const LOG_PAGE = 20;      // ログで最初に出す件数
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const nowTime = () => new Date().toTimeString().slice(0, 5);

function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
}

// 個別金額（メンバーID → 円）。均等割りの支払いなら null
function fixedOf(e) {
  const rows = state.data.shares.filter((s) => s.expense_id === e.id && s.fixed_amount != null);
  if (!rows.length) return null;
  return new Map(rows.map((s) => [s.member_id, Number(s.fixed_amount)]));
}

function fixedMap() {
  const map = new Map();
  for (const e of state.data.expenses) {
    const f = fixedOf(e);
    if (f) map.set(e.id, f);
  }
  return map;
}

const calcOpts = () => ({ settled: settledMap(), fixed: fixedMap() });

// その支払いで、一人ひとりが負担する金額
function shareAmounts(e) {
  return splitExpense(Math.round(Number(e.jpy_amount)), e.payer_id, sharesOf(e.id), fixedOf(e) || undefined, e.id);
}

// 編集を始めた時点の支払いの中身（同時編集に気づくため）
function expenseSnapshot(id) {
  const e = state.data.allExpenses.find((x) => x.id === id);
  if (!e) return null;
  const shares = state.data.shares.filter((s) => s.expense_id === id)
    .map((s) => `${s.member_id}:${s.settled ? 1 : 0}:${s.fixed_amount ?? ''}`).sort().join(',');
  return { row: { ...e }, shares };
}

// 自分の買い物（立て替えた本人だけの支払い）。精算には影響せず、家計簿としてだけ数える
function isPersonal(e) {
  const ids = sharesOf(e.id);
  return ids.length === 1 && ids[0] === e.payer_id;
}

// 新しい順（日付 → 時間 → 入力した順）
function sortedExpenses() {
  return [...state.data.expenses].sort((a, b) => b.paid_at.localeCompare(a.paid_at)
    || (b.paid_time || '').localeCompare(a.paid_time || '')
    || b.created_at.localeCompare(a.created_at));
}

/* ---------- データの読み込み ---------- */

async function load() {
  const g = state.gid;
  const db = state.db;
  const [group, members, expenses, shares, payments, notes, items, logs, who] = await Promise.all([
    check(db.from('groups').select('*').eq('id', g).maybeSingle()),
    check(db.from('members').select('id,group_id,name,created_at,pin_set').eq('group_id', g).order('created_at').order('id')),
    check(db.from('expenses').select('*').eq('group_id', g)
      .order('paid_at', { ascending: false }).order('created_at', { ascending: false })),
    check(db.from('expense_shares').select('*').eq('group_id', g)),
    check(db.from('payments').select('*').eq('group_id', g).order('created_at', { ascending: false })),
    check(db.from('notes').select('*').eq('group_id', g).order('created_at', { ascending: false })),
    check(db.from('checklist_items').select('*').eq('group_id', g).order('created_at')),
    check(db.from('logs').select('*').eq('group_id', g).order('created_at', { ascending: false }).limit(100)),
    state.me ? check(db.rpc('whoami')) : Promise.resolve(null),
  ]);
  // 暗証番号がリセットされたなどで、ログインが切れていないか
  if (state.me && who !== state.me) {
    const hadToken = !!lsGet(tokenKey());
    logout(hadToken ? 'ログインが切れました。もう一度、自分の名前を選んで暗証番号を入れてください。' : '');
  }
  // 他の人の「自分の買い物」は、一覧・合計・ログから外す（本人の画面にだけ出す）
  const personalOf = (e) => {
    const ids = shares.filter((s) => s.expense_id === e.id);
    return ids.length === 1 && ids[0].member_id === e.payer_id;
  };
  const hidden = new Set(expenses.filter((e) => personalOf(e) && e.payer_id !== state.me).map((e) => e.id));
  for (const l of logs) {
    const r = l.detail || {};
    if (l.table_name === 'expenses' && l.action === 'DELETE' && r.payer_id !== state.me
      && Array.isArray(r.shares) && r.shares.length === 1 && r.shares[0].member_id === r.payer_id) {
      hidden.add(r.id);
    }
  }
  state.data = {
    group,
    members,
    allExpenses: expenses,
    expenses: expenses.filter((e) => !hidden.has(e.id)),
    shares,
    payments,
    notes,
    items,
    logs: logs.filter((l) => !(l.table_name === 'expenses' && hidden.has(l.detail?.id))),
  };
}

async function refresh() {
  await load();
  if (state.data?.group && state.me) rememberGroup(state.gid, state.data.group.name, mySettlement().done);
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
  state.showCount = PAGE_SIZE;
  state.listFilter = 'all';
  state.listSort = 'new';
  state.logCount = LOG_PAGE;
  state.logFilter = 'all';
  formMemory.forms = {};
  formMemory.open = new Set();
  state.gid = gid;
  state.me = lsGet(`me:${gid}`);
  state.pick = null;
  state.logoutReason = '';
  state.db = makeClient(gid, state.me, lsGet(`tok:${gid}`));
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
  if (state.data.group) {
    const prev = recentGroups().find((g) => g.id === gid);
    rememberGroup(gid, state.data.group.name, prev?.done ?? false);
  }
  if (state.me && !state.data.members.some((m) => m.id === state.me)) logout();
  if (state.me) restoreDraft();
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
    </form>
    ${recentGroups().length ? `
      <h3>最近開いたグループ</h3>
      <ul class="list">${recentGroups().map((g) => `
        <li class="item">
          <a class="main grouplink" href="#/g/${esc(g.id)}">${esc(g.name)}${g.done ? ' <span class="badge ok">精算完了</span>' : ''}</a>
          <button class="x" data-act="forget-group" data-id="${esc(g.id)}" aria-label="一覧から外す">×</button>
        </li>`).join('')}</ul>
      <p class="hint">この端末で開いたグループだけが表示されます。×を押しても、グループ自体は消えません。</p>` : ''}`;
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
  const target = state.pick ? d.members.find((m) => m.id === state.pick) : null;
  if (target) return renderPin(target);
  app.innerHTML = `
    <div class="card">
      <h2>${esc(d.group.name)}</h2>
      ${state.logoutReason ? `<p class="notice">${esc(state.logoutReason)}</p>` : ''}
      <p>あなたはどのメンバーですか？</p>
      <div class="pick">
        ${d.members.map((m) => `<button class="btn" data-act="pick-me" data-id="${m.id}">${esc(m.name)}${m.pin_set ? ' <span class="lock" aria-label="暗証番号あり">🔒</span>' : ''}</button>`).join('')}
      </div>
      <p class="hint">🔒 の人は暗証番号を設定済みです。初めて選ぶときに、自分だけの4桁の暗証番号を決めます。</p>
      <details>
        <summary>リストに名前がない場合</summary>
        <form id="join-form" class="row">
          <input name="name" required maxlength="20" placeholder="名前">
          <button class="btn primary">参加する</button>
        </form>
      </details>
    </div>`;
}

// 暗証番号を決める・入れる画面
function renderPin(m) {
  const first = !m.pin_set;
  app.innerHTML = `
    <div class="card">
      <h2>${esc(m.name)} さん</h2>
      ${first
    ? '<p>はじめてなので、<b>4桁の暗証番号</b>を決めてください。別のスマホやPCで開いたときに使います。ほかの人には教えないでください。</p>'
    : '<p>暗証番号（4桁）を入れてください。</p>'}
      <form id="pin-form" data-id="${m.id}" data-first="${first ? 1 : 0}">
        <label>暗証番号<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required class="pin-input"></label>
        ${first ? '<label>もう一度<input name="pin2" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required class="pin-input"></label>' : ''}
        <p class="pin-error" id="pin-error"></p>
        <button class="btn primary wide">${first ? 'この番号に決める' : '入る'}</button>
      </form>
      ${first ? '' : '<p class="hint">忘れたときは、グループのほかのメンバーに「メンバー」画面からリセットしてもらってください。</p>'}
      <button class="btn ghost wide" data-act="pick-back">名前を選び直す</button>
    </div>`;
  app.querySelector('.pin-input')?.focus();
}

async function submitPin(f) {
  const id = f.dataset.id;
  const pin = f.pin.value.trim();
  const err = document.getElementById('pin-error');
  if (!/^[0-9]{4}$/.test(pin)) { err.textContent = '数字4桁で入れてください'; return; }
  let token;
  if (f.dataset.first === '1') {
    if (pin !== f.pin2.value.trim()) { err.textContent = '2回の番号が一致しません'; return; }
    const { data, error } = await state.db.rpc('set_pin', { p_member: id, p_pin: pin });
    if (error) {
      if (/pin_already_set/.test(error.message)) {
        await load();
        render();
        return toast('ついさっき、この名前の暗証番号が設定されました。暗証番号を入れてください');
      }
      throw error;
    }
    token = data;
  } else {
    const res = await check(state.db.rpc('login', { p_member: id, p_pin: pin }));
    if (res.error === 'wrong_pin') { err.textContent = `暗証番号が違います（あと${res.left}回まちがえると10分間ロックされます）`; f.pin.value = ''; return; }
    if (res.error === 'locked') { err.textContent = `まちがいが続いたため、ロックしています。${res.minutes}分ほど待ってください`; return; }
    if (res.error === 'pin_not_set') { await load(); render(); return; }
    if (res.error) throw new Error(res.error);
    token = res.token;
  }
  lsSet(tokenKey(), token);
  state.pick = null;
  state.logoutReason = '';
  state.me = id;
  lsSet(`me:${state.gid}`, id);
  state.db = makeClient(state.gid, id, token);
  await refresh();
  toast(f.dataset.first === '1' ? '暗証番号を設定しました' : 'ログインしました');
}

function setMe(id) {
  // 自分の名前を選んだら、暗証番号を決める・入れる画面へ
  state.pick = id;
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
  if (app.querySelector('.tabs')) rememberForms();
  if (state.view?.type !== 'expense' || state.skipKeep) delete formMemory.forms['expense-form'];
  const tabs = [['expenses', '支払い'], ['settle', '精算'], ['memo', 'メモ'], ['log', 'ログ']];
  const views = { expenses: viewExpenses, settle: viewSettle, memo: viewMemo, log: viewLog };
  app.innerHTML = `
    <header class="bar">
      <div>
        <h1>${esc(d.group.name)}</h1>
        <button class="link" data-act="change-me">${esc(nameOf(state.me))} として参加中（変更）</button>
      </div>
      <div class="bar-btns">
        <button class="btn small ghost" data-act="open-members">メンバー</button>
        <button class="btn small" data-act="share">共有</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabs.map(([k, l]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}
    </nav>
    <main>${views[state.tab]()}</main>
    ${viewSheet()}`;
  // 画面を描き直しても（タブを切り替えても）、入力途中の値と開いていた折りたたみを残す
  if (state.pendingDraft) {
    Object.assign(formMemory.forms, state.pendingDraft.forms || {});
    formMemory.open = new Set(state.pendingDraft.open || []);
    if (state.pendingDraft.notify) toast('入力途中の内容を復元しました');
    state.pendingDraft = null;
  }
  applyFormState(formMemory);
  state.skipKeep = false;
  if (state.view?.type === 'expense') updatePreview();
  saveDraft();
}

/* ---------- 入力途中の内容を守る ---------- */

const DRAFT_FORMS = ['expense-form', 'advance-form', 'loan-form', 'manual-pay-form', 'item-form', 'note-form'];
const DRAFT_MAX_AGE = 6 * 60 * 60 * 1000; // 6時間より前の下書きは使わない

// 今の画面の入力値と、開いている折りたたみを取り出す
function captureFormState() {
  const forms = {};
  for (const id of DRAFT_FORMS) {
    const f = document.getElementById(id);
    if (!f) continue;
    const vals = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox' || el.type === 'radio') vals[`${el.name}=${el.value}`] = el.checked;
      else vals[el.name] = el.value;
    }
    if (id === 'expense-form') vals.__more = !!f.querySelector('details.more')?.open;
    forms[id] = vals;
  }
  // 支払いの入力画面の中の折りたたみは、フォームの値と一緒に扱う
  const details = [...app.querySelectorAll('details > summary')]
    .filter((x) => !x.closest('#expense-form'))
    .map((x) => [x.textContent.trim(), x.parentElement.open]);
  return { forms, details };
}

// 画面に出ているフォームの値を覚えておく（出ていないタブの分は前の値のまま）
const formMemory = { forms: {}, open: new Set() };
function rememberForms() {
  const st = captureFormState();
  Object.assign(formMemory.forms, st.forms);
  for (const [key, isOpen] of st.details) {
    if (isOpen) formMemory.open.add(key);
    else formMemory.open.delete(key);
  }
}

function applyFormState(st) {
  for (const [id, vals] of Object.entries(st.forms || {})) {
    const f = document.getElementById(id);
    if (!f) continue;
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        const k = `${el.name}=${el.value}`;
        if (k in vals) el.checked = vals[k];
      } else if (el.name in vals) {
        el.value = vals[el.name];
      }
    }
    if (vals.__more) f.querySelector('details.more')?.setAttribute('open', '');
  }
  const open = new Set(st.open || []);
  for (const sm of app.querySelectorAll('details > summary')) {
    if (open.has(sm.textContent.trim())) sm.parentElement.open = true;
  }
}

// スマホがページを閉じても戻せるよう、端末に下書きとして残す
function saveDraft() {
  if (!state.gid || !state.me || !state.data?.group || !app.querySelector('.tabs')) return;
  rememberForms();
  const view = state.view?.type === 'expense' ? { id: state.view.id, newId: state.view.newId, personal: !!state.view.personal } : null;
  const forms = { ...formMemory.forms };
  if (!view) delete forms['expense-form'];
  lsSet(`draft:${state.gid}`, JSON.stringify({
    at: Date.now(), me: state.me, tab: state.tab, view, forms, open: [...formMemory.open],
  }));
}

let draftTimer;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
}

// グループを開いたときに、使える下書きがあれば戻す準備をする
function restoreDraft() {
  let d;
  try { d = JSON.parse(lsGet(`draft:${state.gid}`) || 'null'); } catch { d = null; }
  if (!d || d.me !== state.me || Date.now() - d.at > DRAFT_MAX_AGE) return;
  if (d.tab) state.tab = d.tab;
  let typed = false;
  if (d.view && (!d.view.id || state.data.allExpenses.some((e) => e.id === d.view.id))) {
    state.view = { type: 'expense', id: d.view.id, newId: d.view.newId || uuid(), personal: d.view.personal };
    if (d.view.id) state.view.snapshot = expenseSnapshot(d.view.id);
    typed = true;
  }
  // 支払い以外のフォームに、文字や金額が入っていたか
  const TYPED = ['amount', 'note', 'text', 'body'];
  for (const [id, vals] of Object.entries(d.forms || {})) {
    if (id !== 'expense-form' && TYPED.some((k) => (vals[k] ?? '') !== '')) typed = true;
  }
  if (!typed && !(d.open || []).length) return;
  state.pendingDraft = { ...d, notify: typed };
}

function viewSheet() {
  switch (state.view?.type) {
    case 'expense': return viewExpenseForm();
    case 'person': return viewPerson();
    case 'mine': return viewMine();
    case 'members': return viewMembers();
    default: return '';
  }
}

/* 支払いタブ */

function viewExpenses() {
  const d = state.data;
  const all = sortedExpenses();
  const mine = (e) => shareAmounts(e).get(state.me) || 0;
  const groupList = all.filter((e) => !isPersonal(e));
  const total = groupList.reduce((sum, e) => sum + Math.round(Number(e.jpy_amount)), 0);
  const myTotal = all.reduce((sum, e) => sum + mine(e), 0);
  const myPersonal = all.filter((e) => isPersonal(e) && e.payer_id === state.me).reduce((sum, e) => sum + mine(e), 0);
  const avg = d.members.length ? Math.round(total / d.members.length) : 0;

  // 自分の精算の状況（押すと精算タブへ）
  const m = mySettlement();
  const st = mySettleText(m);
  const settleLine = m.empty ? '' : `<div class="settle-line tap ${st.cls}" data-act="tab" data-tab="settle"><span class="sub">精算</span>${esc(st.text)}<span class="chev">›</span></div>`;

  // 明細の金額がまだ決まっていない外貨の支払い（お知らせはチェックリストに入る）
  const pending = all.filter((e) => e.currency !== 'JPY' && !e.jpy_confirmed);

  // 並び替えと絞り込み
  const filter = state.listFilter === 'pending' && !pending.length ? 'all' : (state.listFilter || 'all');
  const sort = state.listSort || 'new';
  let list = all;
  if (filter === 'mine') list = all.filter((e) => e.payer_id === state.me || sharesOf(e.id).includes(state.me));
  if (filter === 'pending') list = pending;
  if (sort === 'amount') list = [...list].sort((a, b) => Number(b.jpy_amount) - Number(a.jpy_amount));
  const tools = all.length ? `
    <div class="list-tools">
      <select id="list-filter" aria-label="絞り込み">
        <option value="all" ${filter === 'all' ? 'selected' : ''}>すべて</option>
        <option value="mine" ${filter === 'mine' ? 'selected' : ''}>自分が関わった支払い</option>
        ${pending.length ? `<option value="pending" ${filter === 'pending' ? 'selected' : ''}>明細の金額がまだ</option>` : ''}
      </select>
      <select id="list-sort" aria-label="並び替え">
        <option value="new" ${sort === 'new' ? 'selected' : ''}>新しい順</option>
        <option value="amount" ${sort === 'amount' ? 'selected' : ''}>金額が大きい順</option>
      </select>
    </div>` : '';

  // 新しいものから決まった件数だけ出し、残りは「もっと見る」で出す
  const limit = state.showCount || PAGE_SIZE;
  const visible = list.slice(0, limit);
  let body;
  if (sort === 'amount') {
    body = `<ul class="list">${visible.map(expenseRow).join('')}</ul>`;
  } else {
    // 日付ごとに区切る。小計は、隠れている分も含めたその日の自分の負担額
    const days = [];
    for (const e of visible) {
      let g = days[days.length - 1];
      if (!g || g.date !== e.paid_at) {
        g = { date: e.paid_at, items: [] };
        days.push(g);
      }
      g.items.push(e);
    }
    body = days.map((g) => {
      const dayMine = list.filter((e) => e.paid_at === g.date).reduce((sum, e) => sum + mine(e), 0);
      return `
        <div class="day"><b>${dayLabel(g.date)}</b><span class="sub">あなた ${yen(dayMine)}</span></div>
        <ul class="list">${g.items.map(expenseRow).join('')}</ul>`;
    }).join('');
  }
  const rest = list.length - visible.length;
  const more = rest > 0
    ? `<button class="btn ghost wide more-btn" data-act="show-more">もっと見る（残り${rest}件）</button>`
    : '';
  const emptyMsg = all.length ? '<p class="empty">条件に合う支払いはありません</p>' : '<p class="empty">まだ支払いがありません</p>';

  return `
    <div class="totals">
      <div class="tap" data-act="open-mine"><div class="sub">あなたが使ったお金</div><b>${yen(myTotal)}</b>${myPersonal ? `<div class="sub">うち自分の買い物 ${yen(myPersonal)}</div>` : ''}<div class="more-link">わたしの家計簿 ›</div></div>
      <div><div class="sub">グループ全体（${groupList.length}件）</div><b>${yen(total)}</b><div class="sub">1人平均 ${yen(avg)}</div></div>
    </div>
    ${settleLine}
    <div class="row add-row">
      <button class="btn primary grow" data-act="new-expense">＋ 支払いを追加</button>
      <button class="btn" data-act="new-personal">＋ 自分の買い物</button>
    </div>
    ${tools}
    ${list.length ? body + more : emptyMsg}
    ${all.some((e) => !e.jpy_confirmed) ? '<p class="hint"><span class="badge">仮</span> は自動レートで計算した金額です。カード明細の金額がわかったら、支払いを開いて書き換えてください。</p>' : ''}
    ${viewLoans()}`;
}

function expenseRow(e) {
  const n = sharesOf(e.id).length;
  const st = settledStatus(e);
  const stBadge = st === 'all' ? ' <span class="badge ok">精算済み</span>'
    : st === 'some' ? ' <span class="badge ok">一部精算済み</span>' : '';
  const foreign = e.currency !== 'JPY'
    ? `<div class="sub">${Number(e.amount).toLocaleString('ja-JP')} ${esc(e.currency)}${e.jpy_confirmed ? '' : ' <span class="badge">仮</span>'}</div>`
    : '';
  const total = Math.round(Number(e.jpy_amount));
  const myShare = shareAmounts(e).get(state.me);
  // 割り切れないときは幅ではなく、自分の負担額をぴったりで出す
  const how = fixedOf(e) ? '個別金額'
    : total % n === 0 ? `1人${yen(total / n)}`
      : myShare != null ? `あなた ${yen(myShare)}` : `1人${perPerson(total, n)}`;
  const time = e.paid_time ? `${e.paid_time.slice(0, 5)}・` : '';
  const cat = e.category ? ` <span class="tag">${esc(e.category)}</span>` : '';
  return `
    <li class="item" data-act="edit-expense" data-id="${e.id}">
      <div class="main">
        <div class="title">${esc(e.title)}${stBadge}</div>
        <div class="sub">${time}${isPersonal(e) ? `${esc(nameOf(e.payer_id))}の買い物 <span class="tag">個人</span>` : `${esc(nameOf(e.payer_id))}が立て替え・${n}人（${how}）`}${cat}</div>
      </div>
      <div class="amt">${yen(e.jpy_amount)}${foreign}</div>
    </li>`;
}

/* 貸し借り（payments の kind='loan' として記録する。貸した人→借りた人へお金が動いた扱い） */

function viewLoans() {
  const d = state.data;
  const loans = d.payments.filter((p) => p.kind === 'loan');
  const advances = d.payments.filter((p) => p.kind === 'advance');
  const memberOptions = (sel) => d.members.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const loanRows = loans.map((p) => `
    <li class="item">
      <div class="main">
        <b>${esc(nameOf(p.to_member_id))}</b> が <b>${esc(nameOf(p.from_member_id))}</b> から借りた
        <div class="sub">${p.note ? `${esc(p.note)}・` : ''}${fmtTime(p.created_at)}</div>
      </div>
      <div class="amt">${yen(p.amount)}</div>
      <button class="x" data-act="delete-loan" data-id="${p.id}" aria-label="削除">×</button>
    </li>`).join('');

  // 前払い金は、受け取った人ごとにまとめて見せる
  const byReceiver = new Map();
  for (const p of advances) {
    if (!byReceiver.has(p.to_member_id)) byReceiver.set(p.to_member_id, []);
    byReceiver.get(p.to_member_id).push(p);
  }
  const advanceRows = [...byReceiver.entries()].map(([to, ps]) => `
    <li class="item adv-head"><div class="main"><b>${esc(nameOf(to))}</b> が受け取った前払い金</div>
      <div class="amt">${yen(ps.reduce((a, p) => a + Number(p.amount), 0))}</div></li>
    ${ps.map((p) => `
      <li class="item adv-row">
        <div class="main">${esc(nameOf(p.from_member_id))} から
          <div class="sub">${p.note ? `${esc(p.note)}・` : ''}${fmtTime(p.created_at)}</div></div>
        <div class="amt">${yen(p.amount)}</div>
        <button class="x" data-act="delete-advance" data-id="${p.id}" aria-label="削除">×</button>
      </li>`).join('')}`).join('');

  const receiver = state.me;
  return `
    <h3>前払い金・貸し借り</h3>
    <details class="card manual advance">
      <summary>＋ 前払い金（集金）を記録</summary>
      <p class="hint">幹事が先に集めたお金を記録します。航空券やホテル代そのものは、ふつうの支払いとして入れてください。精算で差し引きされ、多く集めた分は幹事から返します。</p>
      <form id="advance-form">
        <label>受け取った人（幹事など）<select name="receiver">${memberOptions(receiver)}</select></label>
        <label>1人あたりの金額（円）<input name="amount" type="number" inputmode="numeric" min="1" step="1" required></label>
        <div class="label">払った人</div>
        <div class="checks">
          ${d.members.map((m) => `<label class="check"><input type="checkbox" name="advance_from" value="${m.id}" ${m.id !== receiver ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}
        </div>
        <label>メモ（任意）<input name="note" maxlength="60" placeholder="例：航空券・ホテル代"></label>
        <p class="hint" id="advance-preview"></p>
        <button class="btn primary wide">まとめて記録する</button>
      </form>
    </details>
    ${advances.length ? `<ul class="list">${advanceRows}</ul>` : ''}
    <details class="card manual loan">
      <summary>＋ お金を借りた・貸した記録を追加</summary>
      <p class="hint">「現金が足りなくてAさんに5,000円借りた」などを記録すると、最後の精算にまとめて反映されます。</p>
      <form id="loan-form">
        <div class="row">
          <label class="grow">借りた人<select name="borrower">${memberOptions(state.me)}</select></label>
          <label class="grow">貸した人<select name="lender">${memberOptions(null)}</select></label>
        </div>
        <label>金額（円）<input name="amount" type="number" inputmode="numeric" min="1" step="1" required></label>
        <label>メモ（任意）<input name="note" maxlength="60" placeholder="例：タクシー代"></label>
        <button class="btn primary wide">記録する</button>
      </form>
    </details>
    ${loans.length ? `<ul class="list">${loanRows}</ul>` : ''}`;
}

// 記録が済んだ入力欄の折りたたみを閉じる
function closeSection(f) {
  const det = f.closest('details');
  if (!det) return;
  formMemory.open.delete(det.querySelector('summary').textContent.trim());
  det.open = false;
}

// 前払い金のフォームで、何人分・合計いくらになるかを出す
function updateAdvancePreview() {
  const f = document.getElementById('advance-form');
  if (!f) return;
  const from = [...f.querySelectorAll('input[name="advance_from"]:checked')].map((i) => i.value).filter((id) => id !== f.receiver.value);
  const amount = Math.round(Number(f.amount.value));
  document.getElementById('advance-preview').textContent = from.length && amount > 0
    ? `${from.map(nameOf).join('・')} から ${yen(amount)} ずつ（合計 ${yen(amount * from.length)}）` : '';
}

async function saveAdvance(f) {
  const receiver = f.receiver.value;
  const amount = Math.round(Number(f.amount.value));
  const from = [...f.querySelectorAll('input[name="advance_from"]:checked')].map((i) => i.value).filter((id) => id !== receiver);
  if (!(amount > 0)) return toast('金額を入れてください');
  if (!from.length) return toast('払った人を1人以上選んでください（受け取った人以外）');
  await load();
  const dup = state.data.payments.some((p) => p.kind === 'advance' && p.to_member_id === receiver
    && Number(p.amount) === amount && localDate(p.created_at) === today() && from.includes(p.from_member_id));
  if (dup && !confirm(`今日すでに同じ金額（${yen(amount)}）の前払い金が記録されています。二重入力ではありませんか？　このまま記録しますか？`)) return;
  const note = f.note.value.trim() || null;
  await check(state.db.from('payments').insert(from.map((id) => ({
    group_id: state.gid, from_member_id: id, to_member_id: receiver, amount, kind: 'advance', note,
  }))));
  f.reset();
  closeSection(f);
  await refresh();
  toast(`前払い金を${from.length}人分記録しました`);
}

function viewExpenseForm() {
  const d = state.data;
  const e = state.view.id ? d.expenses.find((x) => x.id === state.view.id) : null;
  const cur = e?.currency ?? 'JPY';
  const personal = !e && state.view.personal;
  const shareIds = e ? sharesOf(e.id) : personal ? [state.me] : d.members.map((m) => m.id);
  const actual = e && e.currency !== 'JPY' && e.jpy_confirmed ? Number(e.jpy_amount) : '';
  const settledIds = e ? settledOf(e) : [];
  const fixed = e ? fixedOf(e) : null;
  const openMore = cur !== 'JPY' || !!fixed || settledIds.length > 0;
  return `
    <div class="sheet">
      <form id="expense-form" class="card">
        <h2>${e ? '支払いを編集' : personal ? '自分の買い物を追加' : '支払いを追加'}</h2>
        <label>何に<input name="title" required maxlength="60" value="${esc(e?.title ?? '')}" placeholder="${personal ? '例：お土産' : '例：夕食'}"></label>
        <label>金額（<span id="cur-label">${esc(cur)}</span>）
          <div class="row amount-row">
            <input name="amount" type="text" inputmode="decimal" autocomplete="off" required value="${e ? Number(e.amount) : ''}" placeholder="例：3000　または　1200+800">
            <button type="button" class="btn small" data-act="amount-plus" aria-label="足し算の＋を入れる">＋</button>
          </div>
          <span class="calc" id="calc-result"></span>
        </label>
        <label>立て替えた人
          <select name="payer">${d.members.map((m) => `<option value="${m.id}" ${m.id === (e?.payer_id ?? state.me) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        </label>
        <div class="label">誰の分？</div>
        <div class="checks">
          ${d.members.map((m) => `<label class="check"><input type="checkbox" name="share" value="${m.id}" ${shareIds.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}
        </div>
        <p class="per-person" id="per-person"></p>

        <details class="more" ${openMore ? 'open' : ''}>
          <summary>詳細（日時・種類・通貨・個別金額・その場で精算）</summary>
          <div class="row">
            <label class="grow">日付<input name="paid_at" type="date" value="${esc(e?.paid_at ?? today())}"></label>
            <label class="grow">時間<input name="paid_time" type="time" value="${esc(e ? (e.paid_time ?? '').slice(0, 5) : nowTime())}"></label>
          </div>
          <label>種類
            <select name="category">
              <option value="">未分類</option>
              ${CATEGORIES.map((c) => `<option ${c === e?.category ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
          <label>通貨<select name="currency">${CURRENCIES.map((c) => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
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

          <div class="label">割り方</div>
          <div class="radios">
            <label class="check"><input type="radio" name="split" value="even" ${fixed ? '' : 'checked'}>均等</label>
            <label class="check"><input type="radio" name="split" value="custom" ${fixed ? 'checked' : ''}>金額を個別に入力</label>
          </div>
          <div class="custom" ${fixed ? '' : 'hidden'}>
            <p class="hint">食べた分などを1人ずつ円で入れてください。合計との差（シェアした料理や税など）は、割る人全員で均等に割ります。空欄は0円です。</p>
            ${d.members.map((m) => `
              <label class="fixed-row" data-member="${m.id}">${esc(m.name)}
                <input name="fixed_${m.id}" type="number" inputmode="numeric" min="0" step="1" value="${fixed?.has(m.id) && fixed.get(m.id) ? fixed.get(m.id) : ''}">
              </label>`).join('')}
            <p class="hint" id="custom-preview"></p>
          </div>

          <div class="label">その場で精算した人</div>
          <p class="hint">立て替えた人にその場で自分の分を払った人にチェックを入れると、その人の分は最後の精算から外れます。</p>
          <label class="check"><input type="checkbox" id="settle-all">この会計は全員その場で精算済み</label>
          <div class="checks">
            ${d.members.map((m) => `<label class="check"><input type="checkbox" name="settled" value="${m.id}" ${settledIds.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}
          </div>
        </details>

        <div class="actions">
          ${e ? '<button type="button" class="btn danger" data-act="delete-expense">削除</button>' : ''}
          <span class="grow"></span>
          <button type="button" class="btn ghost" data-act="close">キャンセル</button>
          <button class="btn primary">保存</button>
        </div>
      </form>
    </div>`;
}

// 金額の欄の文字を数にする。「1200+800-100」のような足し算・引き算と、全角数字に対応
function evalAmount(str) {
  const t = String(str ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[＋]/g, '+').replace(/[－ー−]/g, '-').replace(/[．]/g, '.')
    .replace(/[,，円\s]/g, '');
  if (!t || !/^[0-9.+-]+$/.test(t) || /[+-]{2}|[+-]$|^\+/.test(t)) return NaN;
  const nums = t.match(/-?[0-9.]+/g) || [];
  if (nums.join('') !== t.replace(/\+/g, '')) return NaN;
  let sum = 0;
  for (const n of nums) {
    if ((n.match(/\./g) || []).length > 1) return NaN;
    sum += Number(n);
  }
  return Math.round(sum * 100) / 100;
}

const hasOperator = (str) => /[+\-＋－ー−]/.test(String(str).replace(/^[-－ー−]/, ''));

// 入力画面の今の値から、精算に使う円の金額を出す
function formJpy(f) {
  const amount = evalAmount(f.amount.value) || 0;
  if (f.currency.value === 'JPY') return Math.round(amount) || 0;
  if (f.jpy_actual.value !== '') return Math.round(Number(f.jpy_actual.value)) || 0;
  const rate = Number(f.rate.value);
  return amount && rate ? Math.round(amount * rate) : 0;
}

// 入力中の支払いのID（新しい支払いは、画面を開いたときに決めておく）
const formSeed = () => state.view?.id || state.view?.newId || '';

const formShares = (f) => [...f.querySelectorAll('input[name="share"]:checked')].map((i) => i.value);
const formCustom = (f) => f.querySelector('input[name="split"]:checked')?.value === 'custom';

function formFixed(f, shares) {
  const map = new Map();
  for (const id of shares) {
    const v = f.elements[`fixed_${id}`]?.value;
    map.set(id, v ? Math.max(0, Math.round(Number(v)) || 0) : 0);
  }
  return map;
}

function updatePreview() {
  const f = document.getElementById('expense-form');
  if (!f) return;
  const cur = f.currency.value;
  document.getElementById('cur-label').textContent = cur;
  f.querySelector('.fx').hidden = cur === 'JPY';

  const p = document.getElementById('jpy-preview');
  const amount = evalAmount(f.amount.value) || 0;
  const calc = document.getElementById('calc-result');
  const raw = f.amount.value;
  if (raw && hasOperator(raw)) calc.textContent = Number.isNaN(evalAmount(raw)) ? '式が正しくありません' : `＝ ${evalAmount(raw).toLocaleString('ja-JP')}`;
  else if (raw && Number.isNaN(evalAmount(raw))) calc.textContent = '数字で入力してください';
  else if (cur === 'JPY' && raw && !Number.isInteger(evalAmount(raw))) calc.textContent = '円は1円単位で入力してください';
  else calc.textContent = '';
  const rate = Number(f.rate.value);
  if (f.jpy_actual.value !== '') p.textContent = `精算には ${yen(f.jpy_actual.value)} を使います（確定）`;
  else if (amount && rate) p.textContent = `仮の円額：${yen(amount * rate)}（明細の金額がわかったら上に入力）`;
  else p.textContent = '';

  const shares = formShares(f);
  const custom = formCustom(f);
  f.querySelector('.custom').hidden = !custom;
  f.querySelectorAll('.fixed-row').forEach((row) => { row.hidden = !shares.includes(row.dataset.member); });

  const pp = document.getElementById('per-person');
  const cp = document.getElementById('custom-preview');
  const jpy = formJpy(f);
  cp.classList.remove('error');
  if (!(jpy > 0) || !shares.length) {
    pp.textContent = '';
    cp.textContent = '';
    return;
  }
  if (!custom) {
    if (shares.length === 1 && shares[0] === f.payer.value) {
      pp.textContent = '自分だけの買い物（精算には影響しません）';
    } else if (jpy % shares.length === 0) {
      pp.textContent = `${shares.length}人で割ると 1人あたり ${yen(jpy / shares.length)}`;
    } else {
      // 割り切れないときは、誰が1円多いかがわかるよう名前つきで出す
      const parts = splitExpense(jpy, f.payer.value, shares, undefined, formSeed());
      pp.textContent = `${shares.length}人で割ると　${shares.map((id) => `${nameOf(id)} ${yen(parts.get(id))}`).join('　')}`;
    }
    cp.textContent = '';
    return;
  }
  const fixed = formFixed(f, shares);
  let sum = 0;
  for (const v of fixed.values()) sum += v;
  if (sum > jpy) {
    pp.textContent = '';
    cp.textContent = `個別の合計 ${yen(sum)} が、支払いの合計 ${yen(jpy)} を超えています`;
    cp.classList.add('error');
    return;
  }
  const parts = splitExpense(jpy, f.payer.value, shares, fixed, formSeed());
  cp.textContent = `個別の合計 ${yen(sum)}・残り ${yen(jpy - sum)} を${shares.length}人で均等に割ります`;
  pp.textContent = shares.map((id) => `${nameOf(id)} ${yen(parts.get(id))}`).join('　');
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
  const shares = formShares(f);
  if (!shares.length) return toast('誰の分かを1人以上選んでください');
  const title = f.title.value.trim();
  const amount = evalAmount(f.amount.value);
  const currency = f.currency.value;
  if (!title) return toast('「何に」を入れてください');
  if (Number.isNaN(amount) || amount < 0) return toast('金額を正しく入力してください');
  if (currency === 'JPY' && !Number.isInteger(amount)) return toast('円は1円単位で入力してください');

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

  const custom = formCustom(f);
  const fixed = custom ? formFixed(f, shares) : new Map();
  let fixedSum = 0;
  for (const v of fixed.values()) fixedSum += v;
  if (fixedSum > jpy) return toast('個別の金額の合計が、支払いの合計を超えています');

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
    paid_time: f.paid_time.value || null,
    category: f.category.value || null,
  };

  // 時間差で他の人が入力・削除していることがあるので、保存の直前に最新を読み直す
  await load();
  if (state.view.id && !state.data.allExpenses.some((x) => x.id === state.view.id)) {
    state.view = null;
    render();
    return toast('この支払いは、ほかの人が削除しました');
  }
  // 編集中にほかの人が同じ支払いを変えていたら、上書きしてよいか確かめる
  if (state.view.id && state.view.snapshot) {
    const before = state.view.snapshot;
    const latest = expenseSnapshot(state.view.id);
    const keys = ['title', 'amount', 'currency', 'rate', 'jpy_amount', 'jpy_confirmed', 'payer_id', 'paid_at', 'paid_time', 'category'];
    const rowChanged = keys.some((k) => String(before.row[k] ?? '') !== String(latest.row[k] ?? ''));
    if (rowChanged || before.shares !== latest.shares) {
      const what = rowChanged ? expenseDiff(before.row, latest.row) : '割る人などを変更';
      if (!confirm(`あなたが編集している間に、ほかの人がこの支払いを変更しました。\n（${what}）\n\nあなたの内容で上書きしますか？\n「キャンセル」を押すと、最新の内容を表示します。`)) {
        state.view = { type: 'expense', id: state.view.id, snapshot: latest };
        state.skipKeep = true;
        render();
        return;
      }
    }
  }
  const orig = state.view.id ? state.data.expenses.find((x) => x.id === state.view.id) : null;
  const unchanged = orig && orig.paid_at === row.paid_at && Math.round(Number(orig.jpy_amount)) === jpy;
  if (!unchanged && !okToSaveDespiteDuplicates(row.paid_at, jpy, state.view.id)) return;

  const db = state.db;
  let id = state.view.id;
  if (id) {
    await check(db.from('expenses').update(row).eq('id', id));
    await check(db.from('expense_shares').delete().eq('expense_id', id));
  } else {
    id = (await check(db.from('expenses').insert({ ...row, id: formSeed() }).select('id').single())).id;
  }
  const settled = [...f.querySelectorAll('input[name="settled"]:checked')].map((i) => i.value);
  await check(db.from('expense_shares').insert(shares.map((m) => ({
    expense_id: id,
    member_id: m,
    group_id: state.gid,
    settled: settled.includes(m) && m !== row.payer_id,
    fixed_amount: custom ? fixed.get(m) : null,
  }))));
  state.view = null;
  await refresh();
  await syncPendingItem(id);
  toast('保存しました');
}

/* 自分の精算の状況（支払いタブと精算タブの上に出す） */

function mySettlement() {
  const { plan } = currentPlan();
  const pay = plan.filter((t) => t.from === state.me);
  const get = plan.filter((t) => t.to === state.me);
  const hasGroupExpenses = state.data.expenses.some((e) => !isPersonal(e)) || state.data.payments.length > 0;
  return { pay, get, plan, done: hasGroupExpenses && plan.length === 0, empty: !hasGroupExpenses };
}

function mySettleText(m) {
  const sum = (xs) => xs.reduce((a, t) => a + t.amount, 0);
  if (m.done) return { cls: 'st-done', text: '精算はすべて完了しました' };
  if (m.pay.length === 1) return { cls: 'st-pay', text: `あなたは ${nameOf(m.pay[0].to)} に ${yen(m.pay[0].amount)} 払う` };
  if (m.pay.length > 1) return { cls: 'st-pay', text: `あなたは ${m.pay.length}人に 合計 ${yen(sum(m.pay))} 払う` };
  if (m.get.length === 1) return { cls: 'st-get', text: `あなたは ${nameOf(m.get[0].from)} から ${yen(m.get[0].amount)} 受け取る` };
  if (m.get.length > 1) return { cls: 'st-get', text: `あなたは ${m.get.length}人から 合計 ${yen(sum(m.get))} 受け取る` };
  return { cls: 'st-done', text: 'あなたの精算はありません' };
}

// 精算タブの上：自分が送る・受け取るお金を大きく出す
function viewMySettleBox() {
  const m = mySettlement();
  if (m.empty) return '';
  if (m.done) return '<div class="my-settle st-done"><b>精算はすべて完了しました</b><div class="sub">追加の支払いが入ると、また計算されます</div></div>';
  const lines = [
    ...m.pay.map((t) => `<div class="ms-row"><span>${esc(nameOf(t.to))} に</span><b class="minus">${yen(t.amount)}</b><span>払う</span></div>`),
    ...m.get.map((t) => `<div class="ms-row"><span>${esc(nameOf(t.from))} から</span><b class="plus">${yen(t.amount)}</b><span>受け取る</span></div>`),
  ];
  return `<div class="my-settle"><div class="sub">あなたの精算</div>${lines.length ? lines.join('') : '<b>あなたの精算はありません</b>'}</div>`;
}

/* 外貨の支払いで、明細の金額がまだのものをチェックリストに入れる。
   明細の金額を入れたら自動でチェックが付き、支払いを消すと項目も消える */
async function syncPendingItem(expenseId) {
  const e = state.data.allExpenses.find((x) => x.id === expenseId);
  if (!e || isPersonal(e)) return; // 自分の買い物は他の人に見せない
  const item = state.data.items.find((it) => it.expense_id === expenseId);
  const pending = e.currency !== 'JPY' && !e.jpy_confirmed;
  const text = `「${e.title}」（${Number(e.amount).toLocaleString('ja-JP')} ${e.currency}）の明細の金額を入力する（${nameOf(e.payer_id)}）`;
  if (pending && !item) {
    await check(state.db.from('checklist_items').insert({ group_id: state.gid, text, expense_id: e.id }));
  } else if (pending && item && (item.text !== text || item.done)) {
    await check(state.db.from('checklist_items').update({ text, done: false, done_by: null }).eq('id', item.id));
  } else if (!pending && item && !item.done) {
    await check(state.db.from('checklist_items').update({ done: true, done_by: state.me }).eq('id', item.id));
  } else {
    return;
  }
  await refresh();
}

/* 精算タブ */

function currentPlan() {
  const d = state.data;
  const ids = d.members.map((m) => m.id);
  const bal = computeBalances(ids, d.expenses, shareMap(), d.payments, calcOpts());
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
    return `<li class="item" data-act="open-person" data-id="${m.id}"><div class="main">${esc(m.name)}</div><div class="amt">${label}</div><span class="chev">›</span></li>`;
  }).join('');

  const paid = d.payments.filter((p) => p.kind === 'payment' || !p.kind);
  const history = paid.map((p) => `
    <li class="item">
      <div class="main">${esc(nameOf(p.from_member_id))} → ${esc(nameOf(p.to_member_id))}<div class="sub">${fmtTime(p.created_at)}</div></div>
      <div class="amt">${yen(p.amount)}</div>
      <button class="btn small ghost" data-act="undo-paid" data-id="${p.id}">取り消し</button>
    </li>`).join('');

  return `
    ${viewMySettleBox()}
    <div class="seg">
      <button class="${mode === 'auto' ? 'on' : ''}" data-act="mode" data-mode="auto">自動（回数を最小に）</button>
      <button class="${mode === 'hub' ? 'on' : ''}" data-act="mode" data-mode="hub">幹事にまとめる</button>
    </div>
    ${mode === 'hub' ? `<label class="inline">幹事
      <select id="hub-select">${d.members.map((m) => `<option value="${m.id}" ${m.id === hub ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    </label>` : ''}
    ${viewConfirmBox()}
    <h3>送金リスト</h3>
    ${plan.length ? `<ul class="list">${rows}</ul>
      <div class="row share-row">
        <a class="btn small line grow" href="https://line.me/R/share?text=${encodeURIComponent(settleText(plan))}" target="_blank" rel="noopener">送金リストをLINEで送る</a>
        <button class="btn small" data-act="copy-settle">コピー</button>
      </div>` : '<p class="empty">精算はすべて完了しています</p>'}
    <h3>一人ひとりの差し引き</h3>
    <p class="hint">名前を押すと、計算の内訳が見られます。</p>
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
  // 同じ送金をほかの人が先に記録していないか、最新の状態で確かめる
  await load();
  const still = currentPlan().plan.some((x) => x.from === t.from && x.to === t.to && x.amount === t.amount);
  if (!still) {
    render();
    return toast('ほかの人が先に記録したか、支払いが変わったため、送金リストを更新しました');
  }
  await check(state.db.from('payments').insert({
    group_id: state.gid, from_member_id: t.from, to_member_id: t.to, amount: t.amount,
  }));
  await refresh();
}

function settleText(plan) {
  const lines = plan.map((t) => `${nameOf(t.from)} → ${nameOf(t.to)}　${yen(t.amount)}`);
  return `【${state.data.group.name}】精算\n${lines.join('\n')}\n\n詳しくはこちら\n${groupUrl()}`;
}

/* 精算の確定と、確定後の変更の警告 */

// 確定後に気をつけるべき変更：支払いと貸し借り（送金済みの記録は除く）
function changesAfterConfirm() {
  const at = state.data.group.confirmed_at;
  if (!at) return [];
  return state.data.logs.filter((l) => new Date(l.created_at) > new Date(at)
    && (l.table_name === 'expenses' || (l.table_name === 'payments' && l.detail?.kind === 'loan')));
}

function viewConfirmBox() {
  const g = state.data.group;
  if (!g.confirmed_at) {
    return `<div class="confirm-box">
      <p class="hint">支払いが出そろったら確定しておくと、そのあとに誰かが支払いを変えたときにここで警告が出ます。</p>
      <button class="btn small" data-act="confirm-settle">精算を確定する</button>
    </div>`;
  }
  const changes = changesAfterConfirm();
  const who = g.confirmed_by ? nameOf(g.confirmed_by) : '';
  if (!changes.length) {
    return `<div class="confirm-box ok">
      <b>確定済み</b>（${fmtTime(g.confirmed_at)}${who ? `・${esc(who)}` : ''}）。確定後の変更はありません。
      <div><button class="btn small" data-act="unconfirm">確定を取り消す</button></div>
    </div>`;
  }
  return `<div class="confirm-box warn">
    <b>確定後に ${changes.length} 件の変更があります</b>
    <ul>${changes.map((l) => `<li>${esc(describeLog(l))}<span class="sub">（${fmtTime(l.created_at)}・${esc(l.member_id ? nameOf(l.member_id) : '不明')}）</span></li>`).join('')}</ul>
    <p class="hint">内容に問題がなければ、確定し直すと警告が消えます。</p>
    <button class="btn small" data-act="confirm-settle">この内容で確定し直す</button>
  </div>`;
}

async function confirmSettle(on) {
  const patch = on ? { confirmed_at: new Date().toISOString(), confirmed_by: state.me }
    : { confirmed_at: null, confirmed_by: null };
  await check(state.db.from('groups').update(patch).eq('id', state.gid));
  await refresh();
}

/* わたしの家計簿（自分の負担分だけを集計） */

function viewMine() {
  const me = state.me;
  const items = sortedExpenses()
    .map((e) => ({ e, v: shareAmounts(e).get(me) || 0 }))
    .filter((x) => x.v > 0);
  const total = items.reduce((sum, x) => sum + x.v, 0);
  const personal = items.filter((x) => isPersonal(x.e)).reduce((sum, x) => sum + x.v, 0);

  const sumBy = (key) => {
    const m = new Map();
    for (const x of items) m.set(key(x.e), (m.get(key(x.e)) || 0) + x.v);
    return m;
  };
  const bars = (m, order, label) => {
    const max = Math.max(...m.values(), 1);
    return order.filter((k) => m.has(k)).map((k) => `
      <li class="bar-row">
        <span class="bar-label">${esc(label(k))}</span>
        <span class="bar"><span style="width:${Math.max(2, Math.round((m.get(k) / max) * 100))}%"></span></span>
        <span class="bar-val">${yen(m.get(k))}</span>
      </li>`).join('');
  };
  const byCat = sumBy((e) => e.category || '未分類');
  const byDay = sumBy((e) => e.paid_at);
  const days = [...byDay.keys()].sort();

  // 種類ごとに、最初は金額だけを見せて閉じておく
  const maxCat = Math.max(...byCat.values(), 1);
  const genres = [...CATEGORIES, '未分類'].filter((k) => byCat.has(k)).map((k) => {
    const its = items.filter((x) => (x.e.category || '未分類') === k);
    return `
      <details class="genre">
        <summary>
          <span class="g-name">${esc(k)}<span class="sub">（${its.length}件）</span></span>
          <span class="bar"><span style="width:${Math.max(2, Math.round((byCat.get(k) / maxCat) * 100))}%"></span></span>
          <span class="g-val">${yen(byCat.get(k))}</span>
        </summary>
        <ul class="list">${its.map(mineRow).join('')}</ul>
      </details>`;
  }).join('');

  function mineRow({ e, v }) {
    return `
    <li class="item" data-act="edit-expense" data-id="${e.id}">
      <div class="main">
        <div class="title">${esc(e.title)}${isPersonal(e) ? ' <span class="tag">個人</span>' : ''}</div>
        <div class="sub">${dayLabel(e.paid_at)}${e.paid_time ? ` ${e.paid_time.slice(0, 5)}` : ''}${isPersonal(e) ? '' : `・${yen(e.jpy_amount)}のうち`}</div>
      </div>
      <div class="amt">${yen(v)}</div>
    </li>`;
  }

  return `
    <div class="sheet">
      <div class="card">
        <h2>わたしの家計簿</h2>
        <p class="sub">「${esc(state.data.group.name)}」で${esc(nameOf(me))}が使ったお金（自分の負担分）</p>
        <div class="mine-total"><b>${yen(total)}</b>
          <span class="sub">割り勘 ${yen(total - personal)} ／ 自分の買い物 ${yen(personal)}</span></div>
        ${items.length ? `
          <h3>種類別</h3>
          <div class="genres">${genres}</div>
          <p class="hint">種類を押すと明細が開きます。種類は、支払いを開いて「詳細」から付けたり変えたりできます。</p>
          ${days.length > 1 ? `<h3>日別</h3><ul class="bars">${bars(byDay, days, dayLabel)}</ul>` : ''}` : '<p class="empty">まだありません</p>'}
        <button class="btn ghost wide" data-act="close">閉じる</button>
      </div>
    </div>`;
}

/* 個人ごとの内訳 */

function viewPerson() {
  const d = state.data;
  const id = state.view.id;
  const ids = d.members.map((m) => m.id);
  const b = computeBreakdown(ids, d.expenses, shareMap(), d.payments, calcOpts()).get(id);
  const line = (label, v, sign) => (v ? `<tr><td>${label}</td><td class="num">${sign}${yen(v)}</td></tr>` : '');
  const net = b.net > 0 ? `<span class="plus">${yen(b.net)} 受け取る</span>`
    : b.net < 0 ? `<span class="minus">${yen(-b.net)} 払う</span>` : '精算済み';

  const related = sortedExpenses().filter((e) => e.payer_id === id || sharesOf(e.id).includes(id)).map((e) => {
    const ids2 = sharesOf(e.id);
    const total = Math.round(Number(e.jpy_amount));
    const n = ids2.length;
    const mine = ids2.includes(id) ? shareAmounts(e).get(id) : 0;
    const parts = [];
    if (e.payer_id === id) parts.push(`立て替え ${yen(total)}`);
    if (mine) parts.push(`負担 ${yen(mine)}`);
    if (settledOf(e).includes(id)) parts.push('その場で精算済み');
    return `<li class="item"><div class="main">${esc(e.title)}<div class="sub">${dayLabel(e.paid_at)}${e.paid_time ? ` ${e.paid_time.slice(0, 5)}` : ''}・${n}人${fixedOf(e) ? '（個別金額）' : 'で割り勘'}</div></div><div class="amt small">${parts.join('<br>')}</div></li>`;
  }).join('');

  return `
    <div class="sheet">
      <div class="card">
        <h2>${esc(nameOf(id))} の内訳</h2>
        <table class="calc">
          ${line('立て替えた合計', b.paid, '+')}
          ${line('自分の負担分', b.owed, '−')}
          ${line('その場で払った分', b.spotGave, '+')}
          ${line('その場で受け取った分', b.spotGot, '−')}
          ${line('渡したお金（送金・前払い・貸した）', b.sent, '+')}
          ${line('受け取ったお金（送金・前払い・借りた）', b.received, '−')}
          <tr class="total"><td>差し引き</td><td class="num">${net}</td></tr>
        </table>
        <h3>関わった支払い</h3>
        ${related ? `<ul class="list">${related}</ul>` : '<p class="empty">まだありません</p>'}
        <button class="btn ghost wide" data-act="close">閉じる</button>
      </div>
    </div>`;
}

/* メンバーの管理 */

// 支払いや送金に関わっている人は、消すとデータが壊れるので削除できない
function memberInUse(id) {
  const d = state.data;
  return d.allExpenses.some((e) => e.payer_id === id)
    || d.shares.some((s) => s.member_id === id)
    || d.payments.some((p) => p.from_member_id === id || p.to_member_id === id);
}

function viewMembers() {
  const d = state.data;
  return `
    <div class="sheet">
      <div class="card">
        <h2>メンバー</h2>
        <ul class="members">${d.members.map((m) => `
          <li>
            <form class="row member-form" data-id="${m.id}">
              <input name="name" required maxlength="20" value="${esc(m.name)}">
              <button class="btn small">名前を変更</button>
              <button type="button" class="btn small danger" data-act="delete-member" data-id="${m.id}">削除</button>
            </form>
            <div class="pin-row sub">暗証番号：${m.pin_set ? '設定済み' : '未設定'}
              ${m.pin_set ? `<button type="button" class="link" data-act="reset-pin" data-id="${m.id}">リセット</button>` : ''}</div>
          </li>`).join('')}</ul>
        <p class="hint">支払いや送金に関わっている人は削除できません。暗証番号を忘れた人がいたらリセットしてください。その人は次に開いたときに新しい番号を決めます（リセットした人はログに残ります）。</p>
        <h3>メンバーを追加</h3>
        <form id="add-member-form" class="row">
          <input name="name" required maxlength="20" placeholder="名前">
          <button class="btn primary">追加</button>
        </form>
        <button class="btn ghost wide" data-act="close">閉じる</button>
      </div>
    </div>`;
}

async function resetPin(id) {
  const self = id === state.me;
  const msg = self ? '自分の暗証番号をリセットしますか？ このあと新しい番号を決め直します。'
    : `${nameOf(id)} さんの暗証番号をリセットしますか？ リセットしたことはログに残ります。`;
  if (!confirm(msg)) return;
  await check(state.db.rpc('reset_pin', { p_member: id }));
  if (self) {
    logout();
    await load();
    state.pick = id;
    render();
    return;
  }
  await refresh();
  toast('暗証番号をリセットしました');
}

async function renameMember(id, name) {
  name = name.trim();
  if (!name) return;
  if (state.data.members.some((m) => m.name === name && m.id !== id)) return toast('同じ名前の人がいます');
  await check(state.db.from('members').update({ name }).eq('id', id));
  await refresh();
  toast('名前を変更しました');
}

async function deleteMember(id) {
  if (id === state.me) return toast('自分は削除できません');
  if (memberInUse(id)) return toast('支払いや送金に関わっているため削除できません');
  if (!confirm(`${nameOf(id)} をメンバーから削除しますか？`)) return;
  await check(state.db.from('members').delete().eq('id', id));
  await refresh();
}

async function addMember(name) {
  name = name.trim();
  if (!name) return;
  if (state.data.members.some((m) => m.name === name)) return toast('同じ名前の人がいます');
  await check(state.db.from('members').insert({ group_id: state.gid, name }));
  await refresh();
  toast('追加しました');
}

/* 二重入力の警告（支払いと貸し借りの両方を見る） */

function findDuplicates(date, amount, excludeId) {
  const d = state.data;
  const hits = [];
  for (const e of d.expenses) {
    if (e.id !== excludeId && e.paid_at === date && Math.round(Number(e.jpy_amount)) === amount) {
      hits.push(`支払い「${e.title}」（${nameOf(e.payer_id)}が立て替え）`);
    }
  }
  for (const p of d.payments) {
    if (p.kind === 'loan' && p.id !== excludeId && localDate(p.created_at) === date && Number(p.amount) === amount) {
      hits.push(`貸し借り「${nameOf(p.to_member_id)}が${nameOf(p.from_member_id)}から借りた」`);
    }
    if (p.kind === 'advance' && localDate(p.created_at) === date && Number(p.amount) === amount) {
      hits.push(`前払い金「${nameOf(p.from_member_id)}から${nameOf(p.to_member_id)}へ」`);
    }
  }
  return hits;
}

function okToSaveDespiteDuplicates(date, amount, excludeId) {
  const hits = findDuplicates(date, amount, excludeId);
  if (!hits.length) return true;
  return confirm(`同じ日付・同じ金額（${yen(amount)}）の記録がすでにあります。\n\n${hits.map((h) => `・${h}`).join('\n')}\n\n二重入力ではありませんか？　このまま保存しますか？`);
}

/* 削除した支払い・貸し借りの復元 */

async function restoreFromLog(logId, quiet = false) {
  const d = state.data;
  const l = d.logs.find((x) => x.id === logId);
  if (!l || l.action !== 'DELETE') return;
  const r = l.detail || {};
  if (l.table_name === 'expenses') {
    if (d.allExpenses.some((e) => e.id === r.id)) return toast('すでに元に戻っています');
    if (!d.members.some((m) => m.id === r.payer_id)) return toast('立て替えた人がもういないため戻せません');
    if (!quiet && !confirm(`支払い「${r.title}」（${yen(r.jpy_amount)}）を元に戻しますか？`)) return;
    const row = {};
    for (const k of ['id', 'group_id', 'payer_id', 'title', 'amount', 'currency', 'rate', 'jpy_amount', 'jpy_confirmed', 'receipt_path', 'paid_at', 'paid_time', 'category', 'created_at']) {
      if (k in r) row[k] = r[k];
    }
    await check(state.db.from('expenses').insert(row));
    const memberIds = d.members.map((m) => m.id);
    let shares = (r.shares || []).filter((s) => memberIds.includes(s.member_id));
    if (!shares.length) {
      shares = memberIds.map((id) => ({ member_id: id, settled: false }));
      toast('割る人は全員に戻しました。必要なら直してください');
    }
    await check(state.db.from('expense_shares').insert(shares.map((s) => ({
      expense_id: r.id, member_id: s.member_id, group_id: state.gid, settled: !!s.settled,
      fixed_amount: s.fixed_amount ?? null,
    }))));
  } else if (l.table_name === 'payments') {
    if (d.payments.some((p) => p.id === r.id)) return toast('すでに元に戻っています');
    if (!quiet && !confirm('この記録を元に戻しますか？')) return;
    const row = {};
    for (const k of ['id', 'group_id', 'from_member_id', 'to_member_id', 'amount', 'kind', 'note', 'created_at']) row[k] = r[k];
    await check(state.db.from('payments').insert(row));
  } else {
    return;
  }
  await refresh();
  if (l.table_name === 'expenses') await syncPendingItem(r.id);
  toast('元に戻しました');
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

// 支払いの変更前→変更後を文章にする
// 支払いの変更点を { 項目, 前, 後 } の一覧にする
function expenseChanges(o, n) {
  const out = [];
  const add = (label, a, b) => out.push({ label, from: a, to: b });
  if (o.title !== n.title) add('名前', o.title, n.title);
  if (Math.round(Number(o.jpy_amount)) !== Math.round(Number(n.jpy_amount))) add('金額', yen(o.jpy_amount), yen(n.jpy_amount));
  if ((o.currency !== n.currency || Number(o.amount) !== Number(n.amount)) && (o.currency !== 'JPY' || n.currency !== 'JPY')) {
    add('元の金額', `${Number(o.amount).toLocaleString('ja-JP')} ${o.currency}`, `${Number(n.amount).toLocaleString('ja-JP')} ${n.currency}`);
  }
  if (o.payer_id !== n.payer_id) add('立て替えた人', nameOf(o.payer_id), nameOf(n.payer_id));
  if (o.paid_at !== n.paid_at) add('日付', o.paid_at, n.paid_at);
  if ((o.paid_time || '') !== (n.paid_time || '')) add('時間', (o.paid_time || 'なし').slice(0, 5), (n.paid_time || 'なし').slice(0, 5));
  if ((o.category || '') !== (n.category || '')) add('種類', o.category || '未分類', n.category || '未分類');
  return out;
}

function expenseDiff(o, n) {
  const ch = expenseChanges(o, n);
  return ch.length ? ch.map((c) => `${c.label} ${c.from} → ${c.to}`).join('、') : '割る人などを変更';
}

function describeLog(l) {
  const r = l.detail || {};
  const A = { INSERT: '追加', UPDATE: '変更', DELETE: '削除' }[l.action] ?? l.action;
  switch (l.table_name) {
    case 'members':
      if (l.action === 'PIN_SET') return `${r.name} さんが暗証番号を設定した`;
      if (l.action === 'LOGIN') return `${r.name} さんが暗証番号でログインした`;
      if (l.action === 'PIN_RESET') return `${r.name} さんの暗証番号をリセットした`;
      if (l.action === 'UPDATE' && l.old_detail && l.old_detail.name !== r.name) {
        return `メンバーの名前を変更：${l.old_detail.name} → ${r.name}`;
      }
      return `メンバーを${A}：${r.name}`;
    case 'expenses':
      if (l.action === 'UPDATE' && l.old_detail) return `支払い「${r.title}」を変更：${expenseDiff(l.old_detail, r)}`;
      return `支払いを${A}：${r.title}（${yen(r.jpy_amount)}）`;
    case 'payments': {
      if (r.kind === 'advance') {
        const adv = `${nameOf(r.from_member_id)} → ${nameOf(r.to_member_id)} ${yen(r.amount)}${r.note ? `（${r.note}）` : ''}`;
        return l.action === 'DELETE' ? `前払い金を削除：${adv}` : `前払い金を${A}：${adv}`;
      }
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
    case 'groups':
      if (l.action === 'CONFIRM') return '精算を確定した';
      if (l.action === 'UNCONFIRM') return '精算の確定を取り消した';
      if (l.action === 'SETTLE_MODE') {
        return r.settle_mode === 'hub' ? `精算方法を「幹事にまとめる」（幹事：${nameOf(r.hub_member_id)}）にした` : '精算方法を「自動」にした';
      }
      return '精算の設定を変更';
    case 'checklist_items':
      if (l.action === 'UPDATE') return `「${r.text}」の${r.done ? 'チェックを付けた' : 'チェックを外した'}`;
      return `チェック項目を${A}：${r.text}`;
    default:
      return `${l.table_name} を${A}`;
  }
}

function canRestore(l) {
  if (l.action !== 'DELETE') return false;
  const id = l.detail?.id;
  if (l.table_name === 'expenses') return !state.data.allExpenses.some((e) => e.id === id);
  if (l.table_name === 'payments') return !state.data.payments.some((p) => p.id === id);
  return false;
}

function viewLog() {
  const all = state.data.logs;
  if (!all.length) return '<p class="empty">まだ記録がありません</p>';
  const filter = state.logFilter || 'all';
  const logs = filter === 'changes' ? all.filter((l) => l.action !== 'INSERT') : all;
  const count = state.logCount || LOG_PAGE;
  const LABEL = {
    INSERT: ['追加', 'add'], UPDATE: ['変更', 'upd'], DELETE: ['削除', 'del'],
    CONFIRM: ['確定', 'cfm'], UNCONFIRM: ['取消', 'upd'], SETTLE_MODE: ['精算', 'upd'],
    PIN_SET: ['設定', 'cfm'], LOGIN: ['ログイン', 'cfm'], PIN_RESET: ['リセット', 'del'],
  };

  const row = (l) => {
    const [label, cls] = LABEL[l.action] || [l.action, ''];
    // 支払いの変更は、項目ごとに「前 → 後」を並べて見せる
    let body = esc(describeLog(l));
    if (l.table_name === 'expenses' && l.action === 'UPDATE' && l.old_detail) {
      const ch = expenseChanges(l.old_detail, l.detail || {});
      body = `支払い「${esc(l.detail?.title)}」${ch.length ? `<div class="diffs">${ch.map((c) => `
        <div class="diff"><span class="d-label">${esc(c.label)}</span><s>${esc(c.from)}</s> → <b>${esc(c.to)}</b></div>`).join('')}</div>` : '<div class="sub">割る人などを変更</div>'}`;
    }
    return `
      <li class="item log ${l.action === 'DELETE' ? 'deleted' : ''}">
        <span class="act ${cls}">${label}</span>
        <div class="main">${body}<div class="sub">${fmtTime(l.created_at)}・${esc(l.member_id ? nameOf(l.member_id) : '不明')}</div></div>
        ${canRestore(l) ? `<button class="btn small" data-act="restore" data-id="${l.id}">元に戻す</button>` : ''}
      </li>`;
  };

  const changes = all.filter((l) => l.action !== 'INSERT').length;
  return `
    <div class="seg">
      <button class="${filter === 'all' ? 'on' : ''}" data-act="log-filter" data-filter="all">すべて（${all.length}）</button>
      <button class="${filter === 'changes' ? 'on' : ''}" data-act="log-filter" data-filter="changes">変更・削除だけ（${changes}）</button>
    </div>
    ${logs.length ? `<ul class="list">${logs.slice(0, count).map(row).join('')}</ul>` : '<p class="empty">変更や削除はまだありません</p>'}
    ${logs.length > count ? `<button class="btn ghost wide more-btn" data-act="log-more">もっと見る（残り${logs.length - count}件）</button>` : ''}`;
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
        <div class="tips">
          <p><b>見失わないコツ：</b>LINEで送ったメッセージを長押しして「アナウンス」に登録すると、トークの上に固定されます。</p>
          <p><b>ホーム画面に追加：</b>iPhoneはSafariの共有ボタン →「ホーム画面に追加」、Androidはメニュー →「ホーム画面に追加」で、アプリのように開けます。</p>
        </div>
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

/* 折りたたみ（詳細など）を、なめらかにスライドして開閉する */
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function slideDetails(det) {
  if (det._anim) {
    det._anim.cancel();
    det._anim = null;
  }
  const opening = !det.open;
  const start = det.offsetHeight;
  det.open = true;                 // 開いた状態の高さを測るため、いったん開く
  const full = det.offsetHeight;
  det.open = opening;
  const end = opening ? full : det.offsetHeight;
  det.open = true;                 // 閉じるときも、動いている間は中身を見せておく
  det.style.overflow = 'hidden';
  det._anim = det.animate(
    [{ height: `${start}px` }, { height: `${end}px` }],
    { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  );
  det._anim.onfinish = () => {
    det.open = opening;
    det.style.overflow = '';
    det._anim = null;
  };
}

app.addEventListener('click', (ev) => {
  const summary = ev.target.closest('summary');
  if (!summary || reduceMotion()) return;
  const det = summary.parentElement;
  if (det?.tagName !== 'DETAILS') return;
  ev.preventDefault();
  slideDetails(det);
});

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
      logout();
      render();
      break;
    case 'pick-back': state.pick = null; render(); break;
    case 'reset-pin': run(() => resetPin(id)); break;
    case 'tab': state.tab = t.dataset.tab; render(); break;
    case 'list-filter':
      state.listFilter = t.dataset.filter;
      state.showCount = PAGE_SIZE;
      render();
      break;
    case 'show-more': state.showCount = (state.showCount || PAGE_SIZE) + PAGE_STEP; render(); break;
    case 'log-filter': state.logFilter = t.dataset.filter; state.logCount = LOG_PAGE; render(); break;
    case 'log-more': state.logCount = (state.logCount || LOG_PAGE) + LOG_PAGE; render(); break;
    case 'share': share(); break;
    case 'copy-url': copyUrl(); break;
    case 'close-share': document.getElementById('share-sheet')?.remove(); break;
    case 'new-expense': state.view = { type: 'expense', id: null, newId: uuid() }; render(); break;
    case 'open-mine': state.view = { type: 'mine' }; render(); break;
    case 'new-personal': state.view = { type: 'expense', id: null, newId: uuid(), personal: true }; render(); break;
    case 'edit-expense': state.view = { type: 'expense', id, snapshot: expenseSnapshot(id) }; render(); break;
    case 'close': state.view = null; render(); break;
    case 'fetch-rate': run(fillRate); break;
    case 'amount-plus': {
      const input = document.querySelector('#expense-form input[name="amount"]');
      if (input.value && !/[+]$/.test(input.value)) input.value += '+';
      input.focus();
      updatePreview();
      break;
    }
    case 'delete-expense':
      if (confirm('この支払いを削除しますか？')) {
        run(async () => {
          const delId = state.view.id;
          await check(state.db.from('expenses').delete().eq('id', delId));
          state.view = null;
          await refresh();
          offerUndo(delId, '支払いを削除しました');
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
          offerUndo(id, '送金済みを取り消しました');
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
    case 'forget-group': forgetGroup(id); renderTop(); break;
    case 'open-members': state.view = { type: 'members' }; render(); break;
    case 'open-person': state.view = { type: 'person', id }; render(); break;
    case 'delete-member': run(() => deleteMember(id)); break;
    case 'restore': run(() => restoreFromLog(id)); break;
    case 'confirm-settle': run(() => confirmSettle(true)); break;
    case 'unconfirm':
      if (confirm('確定を取り消しますか？')) run(() => confirmSettle(false));
      break;
    case 'copy-settle': {
      const text = settleText(currentPlan().plan);
      navigator.clipboard.writeText(text).then(() => toast('コピーしました'), () => prompt('コピーしてください', text));
      break;
    }
    case 'delete-advance':
      if (confirm('この前払い金の記録を削除しますか？')) {
        run(async () => {
          await check(state.db.from('payments').delete().eq('id', id));
          await refresh();
          offerUndo(id, '前払い金を削除しました');
        });
      }
      break;
    case 'delete-loan':
      if (confirm('この貸し借りの記録を削除しますか？')) {
        run(async () => {
          await check(state.db.from('payments').delete().eq('id', id));
          await refresh();
          offerUndo(id, '貸し借りを削除しました');
        });
      }
      break;
    case 'delete-item': {
      const it = state.data.items.find((x) => x.id === id);
      if (!confirm(`「${it?.text ?? ''}」を削除しますか？`)) break;
      run(async () => {
        await check(state.db.from('checklist_items').delete().eq('id', id));
        await refresh();
      });
      break;
    }
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
  if (f.classList.contains('member-form')) {
    run(() => renameMember(f.dataset.id, f.name.value));
    return;
  }
  switch (f.id) {
    case 'pin-form': run(() => submitPin(f)); break;
    case 'add-member-form': run(() => addMember(f.name.value)); break;
    case 'create-form': run(() => createGroup(f)); break;
    case 'join-form': run(() => joinGroup(f)); break;
    case 'expense-form': run(() => saveExpense(f)); break;
    case 'item-form':
      run(async () => {
        await check(state.db.from('checklist_items').insert({ group_id: state.gid, text: f.text.value.trim() }));
        f.reset();
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
        f.reset();
        closeSection(f);
        await refresh();
        toast('記録しました');
      });
      break;
    case 'advance-form': run(() => saveAdvance(f)); break;
    case 'loan-form':
      run(async () => {
        const borrower = f.borrower.value;
        const lender = f.lender.value;
        const amount = Math.round(Number(f.amount.value));
        if (borrower === lender) return toast('借りた人と貸した人が同じです');
        if (!(amount > 0)) return toast('金額を入れてください');
        if (!okToSaveDespiteDuplicates(today(), amount, null)) return;
        // 貸した人 → 借りた人 へお金が動いたので、貸した人が受け取る側になる
        await check(state.db.from('payments').insert({
          group_id: state.gid,
          from_member_id: lender,
          to_member_id: borrower,
          amount,
          kind: 'loan',
          note: f.note.value.trim() || null,
        }));
        f.reset();
        closeSection(f);
        await refresh();
        toast('記録しました');
      });
      break;
    case 'note-form':
      run(async () => {
        await check(state.db.from('notes').insert({ group_id: state.gid, body: f.body.value.trim() }));
        f.reset();
        await refresh();
      });
      break;
    default:
      break;
  }
});

app.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.closest('#expense-form')) updatePreview();
  if (t.closest('#advance-form')) updateAdvancePreview();
  if (t.name === 'currency' && t.value !== 'JPY') run(fillRate);
  if (t.id === 'list-filter' || t.id === 'list-sort') {
    if (t.id === 'list-filter') state.listFilter = t.value;
    else state.listSort = t.value;
    state.showCount = PAGE_SIZE;
    t.blur();
    render();
    return;
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

['input', 'change'].forEach((type) => app.addEventListener(type, (ev) => {
  if (ev.target.closest('form')) saveDraftSoon();
}));

// 金額の欄から離れたら、足し算の式を計算結果に置き換える
app.addEventListener('focusout', (ev) => {
  const t = ev.target;
  if (t.name === 'amount' && t.closest('#expense-form') && hasOperator(t.value)) {
    const v = evalAmount(t.value);
    if (!Number.isNaN(v)) {
      t.value = String(v);
      updatePreview();
      saveDraftSoon();
    }
  }
});

// ページを離れる直前にも下書きを残す
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });

app.addEventListener('input', (ev) => {
  if (ev.target.closest('#advance-form')) updateAdvancePreview();
  if (ev.target.closest('#expense-form')) updatePreview();
});

/* ---------- 自動で最新にする ---------- */

// 10秒ごとに最新を読み込む。入力途中の文字を消さないように、何か書きかけのときは更新しない
function hasDraft() {
  if (state.view || document.getElementById('share-sheet')) return true;
  // 入力欄にカーソルがある間は更新しない（描き直すとカーソルが外れるため）。
  // それ以外は描き直しても入力値は残るので、更新してよい
  const a = document.activeElement;
  if (a && app.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return true;
  return false;
}

function autoRefresh() {
  if (!state.gid || !state.me || !state.data?.group || document.hidden || state.busy || hasDraft()) return;
  load().then(render).catch(() => { /* 次回また試す */ });
}

setInterval(autoRefresh, 10000);
document.addEventListener('visibilitychange', autoRefresh);
window.addEventListener('hashchange', route);
route();
