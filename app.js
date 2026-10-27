import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const SUPABASE_URL = "https://exatkhjzmenobxhfiaic.supabase.co";
const SUPABASE_KEY = "sb_publishable_TzaeqEQ1_Ypsi_fQTjRL1Q_d8X7wlua";
// Link de "esqueci a senha": o Supabase volta para cá com type=recovery (ou com erro) no endereço.
const urlParams = new URLSearchParams(location.hash.slice(1));
let recovering = urlParams.get("type") === "recovery";
const linkError = urlParams.get("error_code") === "otp_expired" ? "O link expirou ou já foi usado. Peça um novo." : urlParams.get("error_description");
if (linkError) history.replaceState(null, "", location.pathname);
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

const $app = document.getElementById("app");
const $sheet = document.getElementById("sheet-root");

const state = {
  session: null,
  accounts: [],
  accById: new Map(),
  balances: new Map(),
  categories: [],
  catById: new Map(),
  payees: [],
  payeeById: new Map(),
  tags: [],
  tagById: new Map(),
  scheduled: [],
  exceptions: new Map(), // "agendado|data original" -> exceção daquela ocorrência
  showArchived: false,
};

// Utilidades -------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtCache = new Map();
function money(v, cur = "BRL") {
  if (!fmtCache.has(cur)) fmtCache.set(cur, new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }));
  return fmtCache.get(cur).format(Number(v) || 0);
}
const pad = (n) => String(n).padStart(2, "0");
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
const parseDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDay = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
const fmtMonth = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const dayLabel = (iso) => fmtDay.format(parseDate(iso)).replace(".", "");
const monthLabel = (iso) => { const s = fmtMonth.format(parseDate(iso)); return s[0].toUpperCase() + s.slice(1); };
const signClass = (v) => (Number(v) < 0 ? "neg" : Number(v) > 0 ? "pos" : "");

// Busca sem acento e sem diferenciar maiúsculas; um número em pt-BR ("19,50") também casa com o valor.
const norm = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function queryAmount(q) {
  const s = q.replace(/^(R\$)?\s*-?/i, "");
  return /^[0-9.]+(,[0-9]{1,2})?$/.test(s) ? Number(s.replace(/\./g, "").replace(",", ".")) : null;
}

function searchBox(placeholder, value = "") {
  return `<input class="search page" id="q" type="search" placeholder="${placeholder}" value="${esc(value)}" autocomplete="off" enterkeyhint="search">`;
}

let searchTimer;
function onSearch(fn) {
  const box = document.getElementById("q");
  box.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => fn(box.value.trim()), 300); });
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

async function must(promise) {
  const { data, error } = await promise;
  if (error) { toast("Erro: " + error.message); throw error; }
  return data;
}

// A API devolve no máximo 1.000 linhas por chamada; busca em páginas até acabar.
async function fetchAll(query) {
  const rows = [];
  for (let i = 0; ; i += 1000) {
    const page = await must(query().range(i, i + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function catLabel(id) {
  const c = state.catById.get(id);
  if (!c) return "";
  const p = c.parent_id && state.catById.get(c.parent_id);
  return p ? `${p.name} › ${c.name}` : c.name;
}

const ICONS = {
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16 14.5h2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4" cy="6.5" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17.5" r="1"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="5" width="3" height="12" rx="1"/><rect x="15.5" y="8.5" width="3" height="8.5" rx="1"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/></svg>',
};

// Dados ------------------------------------------------------------------------

async function loadAll() {
  const [accounts, balances, categories, payees, tags] = await Promise.all([
    must(sb.from("accounts").select("*").order("display_order")),
    must(sb.from("account_balances").select("*")),
    must(sb.from("categories").select("id,parent_id,name,kind,display_order").order("display_order")),
    fetchAll(() => sb.from("payee_usage").select("id,name,default_category_id,uses,last_used")
      .order("uses", { ascending: false }).order("id")),
    must(sb.from("tags").select("id,name").order("name")),
  ]);
  setTags(tags);
  state.accounts = accounts;
  state.accById = new Map(accounts.map((a) => [a.id, a]));
  state.balances = new Map(balances.map((b) => [b.account_id, b]));
  state.categories = categories;
  state.catById = new Map(categories.map((c) => [c.id, c]));
  state.payees = payees;
  state.payeeById = new Map(payees.map((p) => [p.id, p]));
  await loadScheduled();
}

async function loadScheduled() {
  const [scheduled, exceptions] = await Promise.all([
    must(sb.from("scheduled").select("*, scheduled_splits(category_id, amount), scheduled_tags(tag_id)")
      .eq("disabled", false).order("next_date").range(0, 999)),
    must(sb.from("scheduled_exceptions").select("*").range(0, 4999)),
  ]);
  state.scheduled = scheduled;
  state.exceptions = new Map(exceptions.map((e) => [e.scheduled_id + "|" + e.occurrence_date, e]));
}

function setTags(tags) {
  state.tags = tags.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  state.tagById = new Map(tags.map((t) => [t.id, t]));
}
const tagNames = (ids) => (ids || []).map((id) => state.tagById.get(id)?.name).filter(Boolean).join(", ");

// Próxima ocorrência de um agendado, já com a exceção daquela data, se houver.
function nextOcc(s) {
  const e = state.exceptions.get(s.id + "|" + s.next_date);
  return { date: e?.new_date || s.next_date, amount: Number(e?.amount ?? s.amount), changed: !!e };
}

async function refreshBalances() {
  const balances = await must(sb.from("account_balances").select("*"));
  state.balances = new Map(balances.map((b) => [b.account_id, b]));
}

const dueCount = () => state.scheduled.filter((s) => nextOcc(s).date <= today()).length;

// Estrutura ----------------------------------------------------------------------

function tabbar(active) {
  const due = dueCount();
  const tab = (route, icon, label, extra = "") =>
    `<button class="tab ${active === route ? "on" : ""}" data-go="#/${route}">${ICONS[icon]}${extra}<span>${label}</span></button>`;
  return `<nav class="tabbar">
    ${tab("contas", "wallet", "Contas")}
    ${tab("agendados", "clock", "Agendados", due ? `<span class="dot">${due}</span>` : "")}
    <button class="fab" data-action="new" aria-label="Novo lançamento">+</button>
    ${tab("relatorios", "chart", "Relatórios")}
    ${tab("mais", "more", "Mais")}
  </nav>`;
}

function render(html, active) {
  $app.innerHTML = `<main class="screen">${html}</main>${tabbar(active)}`;
}

// Tela: Contas -------------------------------------------------------------------

const GROUPS = [
  ["Contas", (a) => a.account_group === "active" && a.type !== "credit_card"],
  ["Cartões", (a) => a.account_group === "active" && a.type === "credit_card"],
  ["Investimentos", (a) => a.account_group === "investment"],
];

function accountRow(a) {
  const b = state.balances.get(a.id) || {};
  const cur = Number(b.current_balance || 0);
  const proj = Number(b.projected_balance || 0);
  const diff = Math.abs(proj - cur) >= 0.01;
  return `<button class="row" data-go="#/conta/${a.id}">
    <div class="main"><div class="title">${esc(a.name)}</div>
      ${diff ? `<div class="meta">Previsto ${money(proj, a.currency)}</div>` : ""}</div>
    <div class="amount ${signClass(cur)}">${money(cur, a.currency)}</div>
  </button>`;
}

function viewAccounts() {
  const brl = (a) => a.currency === "BRL" && a.include_in_net_worth && a.account_group !== "archived";
  const total = state.accounts.filter(brl).reduce((s, a) => s + Number(state.balances.get(a.id)?.current_balance || 0), 0);
  let html = `<div class="topbar"><h1>Contas</h1></div>
    <div class="hero"><div class="label">Patrimônio (BRL)</div><div class="value">${money(total)}</div></div>`;
  for (const [title, test] of GROUPS) {
    const list = state.accounts.filter(test);
    if (!list.length) continue;
    const sum = list.filter((a) => a.currency === "BRL").reduce((s, a) => s + Number(state.balances.get(a.id)?.current_balance || 0), 0);
    html += `<div class="section-title"><span>${title}</span><span>${money(sum)}</span></div>
      <div class="list">${list.map(accountRow).join("")}</div>`;
  }
  const archived = state.accounts.filter((a) => a.account_group === "archived");
  html += `<div class="section-title"><span>Arquivadas (${archived.length})</span>
    <button class="collapser" data-action="toggle-archived">${state.showArchived ? "Ocultar" : "Mostrar"}</button></div>`;
  if (state.showArchived) html += `<div class="list">${archived.map(accountRow).join("")}</div>`;
  render(html, "contas");
}

// Tela: Extrato de uma conta -----------------------------------------------------

const TX_SELECT = "id,kind,date,created_at,amount,description,notes,payee_id,account_id,transfer_peer_id," +
  "transaction_splits(category_id,amount),transaction_tags(tag_id),peer:transfer_peer_id(account_id,amount)";
const PAGE = 100;

function txTitle(t) {
  const payee = state.payeeById.get(t.payee_id)?.name;
  if (t.kind === "transfer_out" || t.kind === "transfer_in") {
    const other = state.accById.get(t.peer?.account_id)?.name || "outra conta";
    return (t.kind === "transfer_out" ? "→ " : "← ") + other;
  }
  return payee || t.description || "(sem descrição)";
}

function txMeta(t, withAccount) {
  const parts = [];
  if (withAccount) parts.push(state.accById.get(t.account_id)?.name);
  const splits = t.transaction_splits || [];
  if (splits.length > 1) parts.push(`${splits.length} categorias`);
  else if (splits.length === 1) parts.push(catLabel(splits[0].category_id));
  const isTransfer = t.kind === "transfer_out" || t.kind === "transfer_in";
  if (t.description && (state.payeeById.get(t.payee_id) || isTransfer)) parts.push(t.description);
  parts.push(tagNames((t.transaction_tags || []).map((x) => x.tag_id)));
  return parts.filter(Boolean).join(" · ");
}

function txRow(t, { withAccount = false, running = null, currency = "BRL" } = {}) {
  const fut = t.date > today();
  return `<button class="row ${fut ? "future" : ""}" data-action="edit-tx" data-id="${t.id}">
    <div class="main"><div class="title">${esc(txTitle(t))}${fut ? '<span class="badge">previsto</span>' : ""}</div>
      <div class="meta">${dayLabel(t.date)}${txMeta(t, withAccount) ? " · " + esc(txMeta(t, withAccount)) : ""}</div></div>
    <div class="amount ${signClass(t.amount)}">${money(t.amount, currency)}
      ${running !== null ? `<small>${money(running, currency)}</small>` : ""}</div>
  </button>`;
}

function groupByMonth(rows, rowHtml) {
  let html = "", month = null, buf = "";
  rows.forEach((t, i) => {
    const m = t.date.slice(0, 7);
    if (m !== month) {
      if (buf) html += `<div class="list">${buf}</div>`;
      html += `<div class="section-title"><span>${monthLabel(t.date)}</span></div>`;
      month = m; buf = "";
    }
    buf += rowHtml(t, i);
  });
  if (buf) html += `<div class="list">${buf}</div>`;
  return html;
}

const txCache = new Map(); // id -> transação carregada, para abrir a edição

async function viewAccount(id) {
  const a = state.accById.get(id);
  if (!a) return go("#/contas");
  const b = state.balances.get(id) || {};
  render(`<div class="topbar"><button class="back" data-go="#/contas">‹ Contas</button></div>
    <div class="hero"><div class="label">${esc(a.name)}</div>
      <div class="value ${signClass(b.current_balance)}">${money(b.current_balance, a.currency)}</div>
      <div class="sub">Previsto ${money(b.projected_balance, a.currency)}</div>
      <div class="sub" id="check-line"></div>
      <button class="link-inline" data-action="check-balance" data-id="${id}">Conferir saldo com o banco</button></div>
    ${searchBox("Buscar nesta conta", lastQuery())}<div id="tx-list"></div>`, "contas");
  showLastBalanceCheck(id);
  await txList({
    load: (q) => q ? sb.rpc("search_transactions", { p_query: q, p_account: id }).select(TX_SELECT)
      : sb.from("transactions").select(TX_SELECT).eq("account_id", id),
    // o saldo linha a linha só faz sentido no extrato completo
    rowsHtml: (rows, q) => {
      let running = Number(b.projected_balance || 0);
      return groupByMonth(rows, (t) => {
        const r = running; running -= Number(t.amount);
        return txRow(t, { running: q ? null : r, currency: a.currency });
      });
    },
  });
}

// Última conferência de saldo, refeita com os lançamentos de agora: se alguém mexeu
// em algo até aquela data, ela deixa de bater.
async function showLastBalanceCheck(id) {
  const last = (await must(sb.from("bank_checks").select("*").eq("account_id", id).eq("kind", "balance")
    .order("ref_date", { ascending: false }).limit(1)))[0];
  if (!last) return;
  const now = Number(await must(sb.rpc("account_balance_at", { p_account: id, p_date: last.ref_date })));
  const el = document.getElementById("check-line"), diff = Number(last.bank_amount) - now;
  if (el) el.innerHTML = Math.abs(diff) < 0.005 ? `Conferido com o banco em ${yearDay(last.ref_date)} <span class="pos">✓</span>`
    : `Em ${yearDay(last.ref_date)}, <span class="neg">difere ${money(diff, state.accById.get(id)?.currency)}</span> do banco`;
}

// Lista paginada de lançamentos com busca. A busca fica guardada para a mesma tela,
// assim voltar de uma edição não a perde.
const lastQuery = () => (state.search?.hash === location.hash ? state.search.q : "");

async function txList({ load, rowsHtml }) {
  let rows = [], q = lastQuery(), gen = 0;
  const $list = document.getElementById("tx-list");
  const loadPage = async () => {
    const g = gen;
    const page = await must(load(q).order("date", { ascending: false }).order("created_at", { ascending: false })
      .range(rows.length, rows.length + PAGE - 1));
    if (g !== gen || !$list.isConnected) return; // a busca mudou ou a tela já é outra
    page.forEach((t) => txCache.set(t.id, t));
    rows.push(...page);
    $list.innerHTML = (rows.length ? rowsHtml(rows, q) : `<div class="empty">${q ? "Nada encontrado." : "Nenhum lançamento."}</div>`) +
      (page.length === PAGE ? '<button class="more" data-action="more">Carregar mais</button>' : "");
  };
  pageLoader = loadPage;
  onSearch((v) => { q = v; state.search = { hash: location.hash, q }; gen++; rows = []; loadPage(); });
  await loadPage();
}

// Tela: Recentes -----------------------------------------------------------------

async function viewRecent() {
  render(`<div class="topbar"><button class="back" data-go="#/mais">‹ Mais</button></div>
    <div class="topbar"><h1>Recentes</h1></div>
    ${searchBox("Buscar em todas as contas", lastQuery())}<div id="tx-list"></div>`, "mais");
  await txList({
    load: (q) => q ? sb.rpc("search_transactions", { p_query: q }).select(TX_SELECT)
      : sb.from("transactions").select(TX_SELECT).lte("date", today()).neq("kind", "transfer_in"),
    rowsHtml: (rows) => groupByMonth(rows, (t) => txRow(t, { withAccount: true, currency: state.accById.get(t.account_id)?.currency })),
  });
}

// Tela: Agendados ----------------------------------------------------------------

// Ocorrências já passadas e total da série (total nulo = sem fim). Mesma conta de save_scheduled.
function schedProgress(s) {
  if (!s.repeatable) return { done: 0, total: null };
  let steps;
  if (s.interval_unit === "month" || s.interval_unit === "year") {
    const months = s.interval_unit === "year" ? 12 * s.interval_count : s.interval_count;
    const span = (d) => { const x = parseDate(d); return x.getFullYear() * 12 + x.getMonth(); };
    steps = (d) => Math.floor((span(d) - span(s.first_date)) / months);
  } else {
    const days = (s.interval_unit === "week" ? 7 : 1) * s.interval_count;
    steps = (d) => Math.floor((parseDate(d) - parseDate(s.first_date)) / 864e5 / days);
  }
  return { done: steps(s.next_date), total: s.end_date ? steps(s.end_date) + 1 : null };
}

function installment(s) {
  const { done, total } = schedProgress(s);
  return total > 1 ? `parcela ${done + 1}/${total}` : "";
}

const REPEATS = [["none", "Não repete"], ["week:1", "Toda semana"], ["month:1", "Todo mês"], ["month:2", "A cada 2 meses"],
  ["month:3", "A cada 3 meses"], ["month:4", "A cada 4 meses"], ["month:6", "A cada 6 meses"], ["year:1", "Todo ano"]];

const schedTitle = (s) => s.description || state.payeeById.get(s.payee_id)?.name || "(sem descrição)";

function scheduledRow(s) {
  const acc = state.accById.get(s.account_id);
  const to = s.kind === "transfer" ? state.accById.get(s.recipient_account_id) : null;
  const next = nextOcc(s);
  const late = next.date < today();
  const meta = [dayLabel(next.date), (acc?.name || "sem conta") + (to ? " → " + to.name : "")].join(" · ");
  const parc = installment(s);
  return `<div class="row">
    <div class="main" data-action="edit-sched" data-id="${s.id}"><div class="title">${esc(schedTitle(s))}${parc ? `<span class="badge">${parc}</span>` : ""}${next.changed ? '<span class="badge">alterado</span>' : ""}${late ? '<span class="badge warn">vencido</span>' : ""}</div>
      <div class="meta">${esc(meta)}</div></div>
    <div class="amount ${signClass(next.amount)}">${money(next.amount, s.currency)}</div>
    <div class="actions"><button class="btn-ok" data-action="confirm-sched" data-id="${s.id}">Lançar</button></div>
  </div>`;
}

function schedMatches(s, q) {
  const n = norm(q), val = queryAmount(q);
  const text = [s.description, state.payeeById.get(s.payee_id)?.name, state.accById.get(s.account_id)?.name,
    state.accById.get(s.recipient_account_id)?.name, ...(s.scheduled_splits || []).map((x) => catLabel(x.category_id))];
  return text.some((v) => norm(v).includes(n)) || (val !== null && Math.abs(Number(s.amount)) === val);
}

function viewScheduled() {
  state.schedQuery ??= "";
  state.schedMode ??= store("schedMode") === "cal" ? "cal" : "list";
  const mode = (m, label) => `<button class="${state.schedMode === m ? "on" : ""}" data-action="sched-mode" data-n="${m}">${label}</button>`;
  render(`<div class="topbar"><h1>Agendados</h1><button class="back" data-action="new-sched">+ Novo</button></div>
    <div class="segmented">${mode("list", "Lista")}${mode("cal", "Calendário")}</div>
    ${searchBox("Buscar agendados", state.schedQuery)}<div id="sched-list"></div>`, "agendados");
  drawScheduled();
  onSearch((v) => { state.schedQuery = v; drawScheduled(); });
}

function drawScheduled() {
  if (state.schedMode === "cal") return drawCalendar();
  const $list = document.getElementById("sched-list");
  if (!$list) return;
  const q = state.schedQuery;
  if (q) {
    const found = state.scheduled.filter((s) => schedMatches(s, q));
    $list.innerHTML = found.length ? `<div class="section-title"><span>Resultados</span><span>${found.length}</span></div>
      <div class="list">${found.map(scheduledRow).join("")}</div>` : '<div class="empty">Nada encontrado.</div>';
    return;
  }
  const t = today(), in7 = addDays(t, 7), in30 = addDays(t, 30);
  const buckets = [
    ["Vencidos e hoje", (d) => d <= t],
    ["Próximos 7 dias", (d) => d > t && d <= in7],
    ["Próximos 30 dias", (d) => d > in7 && d <= in30],
  ];
  const sorted = [...state.scheduled].sort((a, b) => nextOcc(a).date.localeCompare(nextOcc(b).date));
  let html = "";
  for (const [title, test] of buckets) {
    const list = sorted.filter((s) => test(nextOcc(s).date));
    if (list.length) html += `<div class="section-title"><span>${title}</span><span>${list.length}</span></div>
      <div class="list">${list.map(scheduledRow).join("")}</div>`;
  }
  const later = sorted.filter((s) => nextOcc(s).date > in30);
  html += `<div class="section-title"><span>Depois (${later.length})</span>
    <button class="collapser" data-action="toggle-later">${state.showLater ? "Ocultar" : "Mostrar"}</button></div>`;
  if (state.showLater) html += `<div class="list">${later.map(scheduledRow).join("")}</div>`;
  if (!state.scheduled.length) html += '<div class="empty">Nenhum agendado ativo.</div>';
  $list.innerHTML = html;
}

// Calendário dos agendados: o mês em grade, com o saldo de cada dia, e a lista do dia
// escolhido. Mostra as ocorrências ainda não lançadas (as vencidas ficam na data delas).
// Com busca, só aparecem os agendados que casam com ela.

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const fmtWeekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
let calToken = 0; // descarta respostas de um mês que já não está na tela

async function drawCalendar() {
  const $list = document.getElementById("sched-list");
  if (!$list) return;
  const t0 = today();
  state.calMonth ??= t0.slice(0, 7);
  state.calDay ??= t0;
  const first = parseDate(state.calMonth + "-01");
  const gridFrom = addDays(state.calMonth + "-01", -first.getDay());
  const gridTo = addDays(gridFrom, 41);
  const token = ++calToken;
  const occs = await fetchAll(() => sb.rpc("scheduled_occurrences", { p_from: gridFrom, p_to: gridTo }));
  if (token !== calToken || !document.getElementById("sched-list")) return;
  const schedById = new Map(state.scheduled.map((s) => [s.id, s]));
  const q = state.schedQuery;
  const byDay = new Map();
  for (const o of occs) {
    const s = schedById.get(o.scheduled_id);
    if (!s || o.skipped || (q && !schedMatches(s, q))) continue;
    if (!byDay.has(o.date)) byDay.set(o.date, []);
    byDay.get(o.date).push({ o, s, amount: Number(o.amount) });
  }
  // saldo do dia sem as transferências, que só mudam o dinheiro de conta
  const net = (list) => list.filter((x) => x.s.kind !== "transfer").reduce((sum, x) => sum + x.amount, 0);
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridFrom, i), list = byDay.get(d) || [], v = net(list);
    if (i === 35 && d.slice(0, 7) !== state.calMonth) break; // sexta semana só quando o mês precisa
    const cls = ["cal-day", d.slice(0, 7) !== state.calMonth && "out", d === t0 && "today", d === state.calDay && "sel",
      list.length && "has", d < t0 && list.length && "late"].filter(Boolean).join(" ");
    cells += `<button class="${cls}" data-action="cal-day" data-date="${d}" aria-label="${fmtWeekday.format(parseDate(d))}, ${list.length} agendados">
      <span class="n">${Number(d.slice(8))}</span>${list.length ? `<span class="v ${signClass(v)}">${Math.abs(v) >= 0.005 ? compactMoney(v) : "•"}</span>` : ""}</button>`;
  }
  const inMonth = [...byDay].filter(([d]) => d.slice(0, 7) === state.calMonth).flatMap(([, l]) => l);
  const flows = inMonth.filter((x) => x.s.kind !== "transfer");
  const inc = flows.filter((x) => x.amount > 0).reduce((sum, x) => sum + x.amount, 0);
  const out = flows.filter((x) => x.amount < 0).reduce((sum, x) => sum + x.amount, 0);
  const dayList = (byDay.get(state.calDay) || []).sort((a, b) => b.amount - a.amount);
  const [y, m] = state.calMonth.split("-").map(Number);
  const title = fmtWeekday.format(parseDate(state.calDay));
  $list.innerHTML = `<div class="month-nav"><button data-action="cal-month" data-step="-1" aria-label="Mês anterior">‹</button>
      <h1>${MONTHS[m - 1]} ${y}</h1>
      <button data-action="cal-month" data-step="1" aria-label="Próximo mês">›</button></div>
    <div class="cal">${WEEKDAYS.map((w) => `<span class="wd">${w}</span>`).join("")}${cells}</div>
    <div class="meta-line cal-sum">${inMonth.length} ${inMonth.length === 1 ? "agendado" : "agendados"} no mês · entradas <span class="pos">${money(inc)}</span> · saídas <span class="neg">${money(-out)}</span>
      ${state.calMonth !== t0.slice(0, 7) || state.calDay !== t0 ? ' · <button class="collapser" data-action="cal-today">Hoje</button>' : ""}</div>
    <div class="section-title"><span>${title[0].toUpperCase() + title.slice(1)}</span>${dayList.length ? `<span>${money(net(dayList))}</span>` : ""}</div>
    ${dayList.length ? `<div class="list">${dayList.map(({ o, s, amount }) =>
      // a próxima da série pode ser lançada; as seguintes abrem "Só nesta data"
      o.occurrence_date === s.next_date ? scheduledRow(s) : occRow(o, s, amount, null, true)).join("")}</div>`
      : '<div class="empty">Nenhum agendado neste dia.</div>'}`;
}

function calMove(step) {
  const [y, m] = state.calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + step, 1);
  state.calMonth = monthKey(d);
  // o dia escolhido vai junto: hoje, se for o mês atual, ou o dia 1
  state.calDay = state.calMonth === today().slice(0, 7) ? today() : state.calMonth + "-01";
  drawCalendar();
}

// Arrastar o dedo de lado na grade troca o mês.
let calSwipe = null;
document.addEventListener("touchstart", (ev) => {
  calSwipe = ev.target.closest?.(".cal") ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
}, { passive: true });
document.addEventListener("touchend", (ev) => {
  if (!calSwipe) return;
  const dx = ev.changedTouches[0].clientX - calSwipe.x, dy = ev.changedTouches[0].clientY - calSwipe.y;
  calSwipe = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) calMove(dx < 0 ? 1 : -1);
});

// Tela: Mais ---------------------------------------------------------------------

function viewMore() {
  render(`<div class="topbar"><h1>Mais</h1></div>
    <div class="list">
      <div class="row"><div class="main"><div class="title">Conectado como</div>
        <div class="meta">${esc(state.session?.user?.email)}</div></div></div>
      <button class="row" data-action="bio-toggle"><div class="main"><div class="title">Desbloquear com Face ID / Touch ID</div>
        <div class="meta">${lockCred() ? "Ativado neste aparelho. Toque para desativar." : "Desativado. Sem ele, o app pede a senha ao abrir."}</div></div></button>
      <button class="row" data-action="reload"><div class="main"><div class="title">Atualizar dados</div></div></button>
      <button class="row" data-go="#/recentes"><div class="main"><div class="title">Recentes</div>
        <div class="meta">Últimos lançamentos de todas as contas</div></div><span class="chev">›</span></button>
      <button class="row" data-go="#/orcamento"><div class="main"><div class="title">Exportar para o Orçamento</div>
        <div class="meta">Resumo do mês em CSV, no formato do MoneyWiz</div></div><span class="chev">›</span></button>
    </div>

    <button class="danger" data-action="logout">Sair</button>`, "mais");
}

// Tela: Exportar para o Orçamento-Familiar -----------------------------------------
// Gera o mesmo CSV do "Summary Report" do MoneyWiz, que o dashboard do orçamento importa.
// O mês e o ano saem do nome do arquivo (ex.: "Outubro 2026.csv").

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const brNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function budgetCsv(rows) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const line = (cells, width) => [...cells, ...Array(width - cells.length).fill("")].map(q).join(",");
  const out = ["sep=,", line(["Nome", "Saldo atual", "Conta", "Transferências", "Descrição", "Beneficiário", "Categoria", "Data",
    "Tempo", "Memo", "Valor", "Câmbio", "Número do cheque", "Tags", "Saldo"], 15)];
  for (const [section, title, total] of [["income", "Rendimentos", "Total de rendimentos"], ["expense", "Gastos", "Despesas totais"]]) {
    const list = rows.filter((r) => r.section === section);
    out.push(line([title], 14));
    list.forEach((r) => out.push(line([r.category, brNumber.format(r.amount), "BRL"], 15)));
    out.push(line([total, brNumber.format(list.reduce((s, r) => s + r.amount, 0)), "BRL"], 15));
    out.push(line([], 14));
  }
  return "\uFEFF" + out.join("\n") + "\n";
}

async function downloadFile(name, text) {
  const file = new File([text], name, { type: "text/csv" });
  // no iPhone a folha de compartilhar permite salvar em Arquivos ou mandar por AirDrop
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const monthEnd = (iso) => { const [y, m] = iso.split("-").map(Number); return addDays(`${y + (m === 12 ? 1 : 0)}-${pad(m === 12 ? 1 : m + 1)}-01`, -1); };
const summaryRows = (raw) => raw.map((r) => ({ ...r, amount: Number(r.amount) }))
  .sort((a, b) => a.category.localeCompare(b.category, "pt-BR"));

// Linhas de report_lines (por subcategoria) agrupadas na categoria principal, com as
// subcategorias em children. O lançado direto na principal aparece como "(sem subcategoria)".
function groupLines(raw) {
  const map = new Map();
  for (const l of raw) {
    const key = l.section + "|" + l.category;
    if (!map.has(key)) map.set(key, { section: l.section, category: l.category, amount: 0, children: [] });
    const g = map.get(key);
    g.amount += Number(l.amount);
    g.children.push({ name: l.subcategory ?? "(sem subcategoria)", amount: Number(l.amount) });
  }
  const rows = [...map.values()].filter((g) => Math.abs(g.amount) >= 0.005);
  rows.forEach((g) => { g.amount = Math.round(g.amount * 100) / 100; if (g.children.length === 1 && g.children[0].name === "(sem subcategoria)") g.children = []; });
  return summaryRows(rows);
}
const sectionSum = (rows, sec) => rows.filter((r) => r.section === sec).reduce((s, r) => s + r.amount, 0);

function summaryHero(rows, withScheduled) {
  const inc = sectionSum(rows, "income"), exp = sectionSum(rows, "expense");
  return `<div class="hero"><div class="label">Saldo</div>
    <div class="value ${signClass(inc - exp)}">${money(inc - exp)}</div>
    <div class="sub">Receitas ${money(inc)} · Despesas ${money(exp)}</div>
    ${withScheduled ? '<div class="sub">Inclui os agendados previstos até o fim do período.</div>' : ""}</div>`;
}

function summarySections(rows) {
  const section = (sec, title) => {
    const list = rows.filter((r) => r.section === sec);
    return list.length ? `<div class="section-title"><span>${title}</span><span>${money(sectionSum(rows, sec))}</span></div>
      <div class="list">${list.map((r) => r.children?.length ? `<button class="row" data-action="toggle-sub">
          <div class="main"><div class="title">${esc(r.category)}</div></div>
          <div class="amount">${money(r.amount)}</div><span class="chev">›</span></button>
        <div class="sub-rows" hidden>${r.children.map((c) => `<div class="row sub"><div class="main"><div class="title">${esc(c.name)}</div></div>
          <div class="amount">${money(c.amount)}</div></div>`).join("")}</div>`
        : `<div class="row"><div class="main"><div class="title">${esc(r.category)}</div></div>
        <div class="amount">${money(r.amount)}</div>${rows.some((x) => x.children?.length) ? '<span class="chev blank">›</span>' : ""}</div>`).join("")}</div>` : "";
  };
  return section("income", "Rendimentos") + section("expense", "Gastos") +
    (rows.length ? "" : '<div class="empty">Nada lançado neste período.</div>');
}

async function viewBudget() {
  if (!state.budgetMonth) {
    // padrão: mês anterior até o dia 10, depois o mês atual
    const d = new Date();
    if (d.getDate() <= 10) d.setMonth(d.getMonth() - 1, 1);
    state.budgetMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
  }
  const m = state.budgetMonth;
  const [y, mo] = m.split("-").map(Number);
  const raw = await must(sb.rpc("budget_summary", { p_month: m }));
  const rows = summaryRows(raw);
  state.budgetRows = rows;
  const accounts = state.accounts.filter((a) => a.in_budget || a.account_group !== "archived");
  render(`<div class="topbar"><button class="back" data-go="#/mais">‹ Mais</button></div>
    <div class="month-nav"><button data-action="budget-month" data-step="-1" aria-label="Mês anterior">‹</button>
      <h1>${MONTHS[mo - 1]} ${y}</h1>
      <button data-action="budget-month" data-step="1" aria-label="Próximo mês">›</button></div>
    ${summaryHero(rows, monthEnd(m) >= today())}
    <button class="primary" data-action="budget-export" ${rows.length ? "" : "disabled"}>Exportar “${MONTHS[mo - 1]} ${y}.csv”</button>
    ${summarySections(rows)}
    <div class="section-title"><span>Contas no orçamento (${state.accounts.filter((a) => a.in_budget).length})</span>
      <button class="collapser" data-action="toggle-budget-accounts">${state.showBudgetAccounts ? "Ocultar" : "Mostrar"}</button></div>
    ${state.showBudgetAccounts ? `<div class="list">${accounts.map((a) => `<label class="row check">
      <input type="checkbox" data-budget-account="${a.id}" ${a.in_budget ? "checked" : ""}>
      <div class="main"><div class="title">${esc(a.name)}</div>${a.account_group === "archived" ? '<div class="meta">arquivada</div>' : ""}</div></label>`).join("")}</div>` : ""}`, "mais");
}

// Tela: Relatórios -----------------------------------------------------------------
// Prontos: resumo por categoria ("summary"), previsão de saldo ("forecast") e faturas de
// cartão ("cards"), relatórios por mês ("monthly") e patrimônio ("networth").

function reportPeriod(cfg) {
  const d = new Date(), y = d.getFullYear();
  if (cfg.period === "this_year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (cfg.period === "last_year") return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (cfg.period === "last_12") return { from: `${monthKey(new Date(y, d.getMonth() - 11, 1))}-01`, to: today() };
  if (cfg.period === "next_12") return { from: `${monthKey(d)}-01`, to: monthEnd(`${monthKey(new Date(y, d.getMonth() + 11, 1))}-01`) };
  const shift = { last_month: -1, this_month: 0, next_month: 1 }[cfg.period];
  if (shift === undefined) return { from: cfg.from, to: cfg.to };
  const first = new Date(d.getFullYear(), d.getMonth() + shift, 1);
  const from = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`;
  return { from, to: monthEnd(from) };
}

function periodLabel({ from, to }) {
  const [y, m] = from.split("-").map(Number);
  if (from.endsWith("-01") && to === monthEnd(from)) return `${MONTHS[m - 1]} ${y}`;
  if (from.endsWith("-01-01") && to === `${y}-12-31`) return String(y);
  return `${dayLabel(from)} ${from.slice(0, 4)} a ${dayLabel(to)} ${to.slice(0, 4)}`;
}

const REPORT_TYPES = [["summary", "Resumos por categoria"], ["monthly", "Por mês"], ["forecast", "Previsões de saldo"], ["cards", "Faturas de cartão"], ["networth", "Patrimônio"]];
const TYPE_SHORT = { summary: "Resumo", monthly: "Por mês", forecast: "Previsão", cards: "Faturas", networth: "Patrimônio" };
const byName = (a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true });

async function loadReports() {
  state.reports = await must(sb.from("reports").select("id,name,config,display_order"));
}

async function viewReports() {
  await loadReports();
  const later = state.reports.filter((r) => !REPORT_TYPES.some(([t]) => t === r.config?.type)).sort(byName);
  const meta = (r) => r.config.type === "forecast" ? forecastLabel(r.config)
    : r.config.type === "cards" ? cardPeriodLabel(r.config)
    : r.config.type === "networth" ? networthLabel(r.config) : periodLabel(reportPeriod(r.config));
  render(`<div class="topbar"><h1>Relatórios</h1><button class="back" data-action="report-new">+ Novo</button></div>
    ${REPORT_TYPES.map(([type, title]) => {
      const list = state.reports.filter((r) => r.config?.type === type).sort(byName);
      return list.length ? `<div class="section-title"><span>${title}</span></div>
        <div class="list">${list.map((r) => `<button class="row" data-go="#/relatorio/${r.id}"><div class="main">
          <div class="title">${esc(r.name)}</div><div class="meta">${esc(meta(r))}</div></div><span class="chev">›</span></button>`).join("")}</div>` : "";
    }).join("")}
    ${later.length ? `<div class="section-title"><span>Em breve (${later.length})</span></div>
    <div class="list">${later.map((r) => `<div class="row"><div class="main"><div class="title muted">${esc(r.name)}</div></div></div>`).join("")}</div>` : ""}`, "relatorios");
}

async function viewReport(id) {
  if (!state.reports) await loadReports();
  const r = state.reports.find((x) => x.id === id);
  if (r?.config?.type === "forecast") return viewForecast(r);
  if (r?.config?.type === "cards") return viewCards(r);
  if (r?.config?.type === "monthly") return viewMonthly(r);
  if (r?.config?.type === "networth") return viewNetWorth(r);
  if (!r || r.config?.type !== "summary") return go("#/relatorios");
  const period = reportPeriod(r.config);
  const rows = groupLines(await must(sb.rpc("report_lines", {
    p_from: period.from, p_to: period.to, p_accounts: r.config.accounts,
    p_categories: r.config.categories, p_scheduled: r.config.scheduled, p_tags: r.config.tags || null })));
  state.reportRows = rows;
  state.reportFile = `${periodLabel(period)}.csv`;
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1><button class="back" data-action="report-edit" data-id="${r.id}">Editar</button></div>
    <div class="meta-line">${esc(reportFilters(r.config, period))}</div>
    ${summaryHero(rows, r.config.scheduled && period.to >= today())}
    ${summarySections(rows)}
    ${rows.length ? `<button class="more" data-action="report-export">Exportar CSV</button>` : ""}`, "relatorios");
}

// Período e filtros de um relatório, numa linha.
function reportFilters(cfg, period) {
  const n = (list, one, many) => (list ? `${list.length} ${list.length === 1 ? one : many}` : "");
  const tags = (cfg.tags || []).map((id) => state.tagById.get(id)?.name).filter(Boolean);
  return [periodLabel(period), cfg.accounts ? n(cfg.accounts, "conta", "contas") : "todas as contas",
    cfg.measure !== "transfers" && n(cfg.categories, "categoria", "categorias"),
    tags.length && (tags.length > 2 ? `${tags.length} tags` : `tag ${tags.join(", ")}`)].filter(Boolean).join(" · ");
}

// Tela: relatório por mês (categoria ao longo do tempo) ------------------------------------
// Barras por mês, empilhadas pelo agrupamento escolhido (categoria, subcategoria, conta ou
// tag), com o teto mensal quando houver. Abaixo, o total de cada grupo no período e os
// meses, que abrem com o valor de cada grupo.

const MONTHLY_GROUPS = [["category", "Categoria"], ["subcategory", "Subcategoria"], ["account", "Conta"], ["tag", "Tag"], ["total", "Só o total"]];
const MONTHLY_MEASURES = [["expense", "Gastos"], ["income", "Receitas"], ["transfers", "Transferências (aportes)"]];
const MONTHLY_PERIODS = [["last_12", "Últimos 12 meses"], ["this_year", "Este ano"], ["last_year", "Ano passado"], ["next_12", "Próximos 12 meses"]];
const MAX_SERIES = 8;

async function viewMonthly(r) {
  const c = r.config, period = reportPeriod(c);
  const rows = await fetchAll(() => sb.rpc("report_monthly", {
    p_from: period.from, p_to: period.to, p_accounts: c.accounts ?? null, p_categories: c.categories ?? null,
    p_tags: c.tags ?? null, p_scheduled: c.scheduled ?? true, p_group: c.group || "category", p_measure: c.measure || "expense" }));
  const months = [], byKey = new Map();
  for (const d = parseDate(period.from); monthKey(d) <= period.to.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
    const m = { key: monthKey(d), total: 0, by: new Map() };
    months.push(m); byKey.set(m.key, m);
  }
  const totals = new Map();
  for (const x of rows) totals.set(x.grp, (totals.get(x.grp) || 0) + Number(x.amount));
  // as maiores séries ganham cor; o resto vira "Outros"
  const ranked = [...totals].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([g]) => g);
  const keys = ranked.length > MAX_SERIES ? [...ranked.slice(0, MAX_SERIES - 1), "Outros"] : ranked;
  const keyOf = (g) => (keys.includes(g) ? g : "Outros");
  for (const x of rows) {
    const m = byKey.get(x.month.slice(0, 7)), v = Number(x.amount);
    if (!m) continue;
    m.total += v;
    m.by.set(keyOf(x.grp), (m.by.get(keyOf(x.grp)) || 0) + v);
    (m.detail ??= []).push([x.grp, v]);
  }
  months.forEach((m) => { m.total = Math.round(m.total * 100) / 100; });
  const now = today().slice(0, 7), sum = months.reduce((s, m) => s + m.total, 0);
  const done = months.filter((m) => m.key < now), over = c.limit ? months.filter((m) => m.total > c.limit) : [];
  const selected = Math.max(0, months.findIndex((m) => m.key === now));
  const groupTitle = { category: "Por categoria", subcategory: "Por subcategoria", account: "Por conta", tag: "Por tag" }[c.group];
  // gastos e receitas já vêm positivos; só nas transferências o sinal (aporte ou resgate) importa
  const tone = (v) => (c.measure === "transfers" ? signClass(v) : "");
  const monthRow = (m) => {
    const detail = (m.detail || []).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const badge = m.key > now ? '<span class="badge">previsto</span>' : m.key === now && c.scheduled !== false ? '<span class="badge">em curso</span>' : "";
    const meta = c.limit ? (m.total > c.limit ? `${money(m.total - c.limit)} acima do teto` : `${money(c.limit - m.total)} abaixo do teto`) : "";
    return `<button class="row" data-action="toggle-sub" id="mes-${m.key}"><div class="main">
        <div class="title">${monthLabel(m.key + "-01")}${badge}</div>${meta ? `<div class="meta ${m.total > c.limit ? "warn-text" : ""}">${meta}</div>` : ""}</div>
        <div class="amount ${tone(m.total)}">${money(m.total)}</div><span class="chev">›</span></button>
      <div class="sub-rows" hidden>${detail.length && c.group !== "total" ? detail.map(([g, v]) => `<div class="row sub"><div class="main"><div class="title">${esc(g)}</div></div>
        <div class="amount">${money(v)}</div></div>`).join("") : '<div class="row sub"><div class="main"><div class="title muted">Nada neste mês</div></div></div>'}</div>`;
  };
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1><button class="back" data-action="report-edit" data-id="${r.id}">Editar</button></div>
    <div class="meta-line">${esc(reportFilters(c, period))}</div>
    ${barsLegend(keys, undefined, c.limit)}${barsChart(months, keys, selected, { limit: c.limit, label: r.name })}
    <div class="hero"><div class="label">Total no período</div>
      <div class="value ${tone(sum)}">${money(sum)}</div>
      <div class="sub">Média de ${money(months.length ? sum / months.length : 0)} por mês${c.scheduled !== false && months.some((m) => m.key >= now) ? ", com os agendados previstos" : ""}</div>
      ${c.limit ? `<div class="sub">Teto de ${money(c.limit)} por mês: ${over.length ? `<span class="neg">${over.length} ${over.length === 1 ? "mês acima" : "meses acima"}</span>` : "nenhum mês acima"}</div>` : ""}</div>
    ${groupTitle && ranked.length > 1 ? `<div class="section-title"><span>${groupTitle}</span></div>
      <div class="list">${ranked.map((g) => `<div class="row"><div class="main"><div class="title">${esc(g)}</div>
        <div class="meta">${money(totals.get(g) / Math.max(1, months.length))} por mês</div></div>
        <div class="amount ${tone(totals.get(g))}">${money(totals.get(g))}</div></div>`).join("")}</div>` : ""}
    <div class="section-title"><span>Meses</span></div>
    <div class="list">${months.map(monthRow).join("")}</div>
    ${rows.length ? "" : '<div class="empty">Nada neste período.</div>'}`, "relatorios");
}

// Folha: editor de relatórios -----------------------------------------------------------
// Nome, contas e período de qualquer relatório; nos resumos, também categorias e agendados.
// O tipo só se escolhe ao criar. As listas de contas e categorias abrem em folhas próprias.

const SUMMARY_PERIODS = [["last_month", "Mês passado"], ["this_month", "Mês atual"], ["next_month", "Próximo mês"],
  ["last_12", "Últimos 12 meses"], ["this_year", "Este ano"], ["last_year", "Ano passado"]];
let rep = null;

function openReportEditor(r) {
  const c = r?.config || {};
  rep = {
    id: r?.id || null,
    name: r?.name || "",
    type: c.type || "summary",
    // contas e tags nulas = todas (só resumos e relatórios por mês)
    accounts: new Set(c.accounts || (!r || ["summary", "monthly"].includes(c.type) ? state.accounts.map((a) => a.id) : [])),
    categories: c.categories ? new Set(c.categories) : null, // null = todas
    tags: c.tags ? new Set(c.tags) : null,
    group: c.group || "category",
    measure: c.measure || "expense",
    limit: c.limit || null,
    period: c.period || "this_month",
    from: c.from, to: c.to,
    scheduled: c.scheduled ?? true,
    months: c.months || (c.type === "cards" ? 12 : 3),
  };
  drawReportEditor();
}

// nas faturas, só cartões (e as contas que o relatório já tiver)
const repAccounts = () => state.accounts.filter((a) => rep.type !== "cards" || a.type === "credit_card" || rep.accounts.has(a.id));

function drawReportEditor() {
  const e = rep;
  const base = e.type === "monthly" ? MONTHLY_PERIODS : SUMMARY_PERIODS;
  const periods = e.period === "fixed" ? [...base, ["fixed", `Datas fixas (${periodLabel({ from: e.from, to: e.to })})`]] : base;
  const nTag = e.tags ? e.tags.size : null;
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join("");
  const byMonth = e.type === "monthly", withCats = e.type === "summary" || (byMonth && e.measure !== "transfers");
  const months = e.type === "cards" ? CARD_PERIODS : FORECAST_MONTHS;
  const nAcc = repAccounts().filter((a) => e.accounts.has(a.id)).length;
  const nCat = e.categories ? e.categories.size : null;
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="close"></div>
  <div class="sheet" role="dialog" aria-label="Relatório">
    <div class="sheet-head"><button data-action="close">Cancelar</button><h2>${e.id ? "Editar relatório" : "Novo relatório"}</h2>
      <button class="save" data-action="report-save">Salvar</button></div>
    ${e.id ? "" : `<div class="segmented">${REPORT_TYPES.map(([t]) => `<button class="${e.type === t ? "on" : ""}" data-action="rep-type" data-n="${t}">${TYPE_SHORT[t]}</button>`).join("")}</div>`}
    <div class="form">
      <div class="field"><label>Nome</label><input id="rep-name" value="${esc(e.name)}" placeholder="Ex.: Gastos do mês" autocomplete="off"></div>
      ${byMonth ? `<div class="field"><label>Mostrar</label><select id="rep-measure">${opts(MONTHLY_MEASURES, e.measure)}</select></div>
      <div class="field"><label>Agrupar por</label><select id="rep-group">${opts(MONTHLY_GROUPS, e.group)}</select></div>` : ""}
      ${e.type === "networth" ? `<div class="field"><label>De</label><input id="rep-from-year" inputmode="numeric" maxlength="4" autocomplete="off" value="${e.from.slice(0, 4)}"></div>
      <div class="field"><label>Até</label><input id="rep-to-year" inputmode="numeric" maxlength="4" autocomplete="off" value="${e.to.slice(0, 4)}"></div>`
      : e.type === "summary" || byMonth ? `<div class="field"><label>Período</label><select id="rep-period">${opts(periods, e.period)}</select></div>
      <label class="field check"><span class="grow">Incluir agendados previstos</span><input type="checkbox" id="rep-scheduled" ${e.scheduled ? "checked" : ""}></label>`
      : `<div class="field"><label>Período</label><select id="rep-months">${months.map((n) =>
        `<option value="${n}" ${String(e.months) === String(n) ? "selected" : ""}>${n === "year" ? "Este ano" : `${e.type === "cards" ? "" : "Próximos "}${n} meses`}</option>`).join("")}</select></div>`}
      <div class="field"><label>${e.type === "cards" ? "Cartões" : "Contas"}</label>
        <button class="picker ${nAcc ? "" : "placeholder"}" data-action="rep-accounts">${nAcc ? `${nAcc} ${nAcc === 1 ? "escolhida" : "escolhidas"}` : "Escolher"}</button><span class="chev">›</span></div>
      ${withCats ? `<div class="field"><label>Categorias</label>
        <button class="picker" data-action="rep-categories">${nCat === null ? "Todas" : `${nCat} ${nCat === 1 ? "escolhida" : "escolhidas"}`}</button><span class="chev">›</span></div>` : ""}
      ${e.type === "summary" || byMonth ? `<div class="field"><label>Tags</label>
        <button class="picker" data-action="rep-tags">${nTag === null ? "Qualquer uma ou nenhuma" : `Só com ${nTag} ${nTag === 1 ? "tag" : "tags"}`}</button><span class="chev">›</span></div>` : ""}
      ${byMonth ? `<div class="field"><label>Teto mensal</label><input id="rep-limit" inputmode="numeric" autocomplete="off" placeholder="Opcional" value="${e.limit ? centsToText(Math.round(e.limit * 100)) : ""}"></div>` : ""}
    </div>
    ${e.id ? '<button class="more" data-action="report-dup">Duplicar relatório</button><button class="danger" data-action="report-delete">Apagar relatório</button>' : ""}
  </div>`;
}

function readReportFields() {
  const v = (id) => document.getElementById(id);
  if (!rep) return;
  if (v("rep-name")) rep.name = v("rep-name").value;
  if (v("rep-period")) rep.period = v("rep-period").value;
  if (v("rep-scheduled")) rep.scheduled = v("rep-scheduled").checked;
  if (v("rep-months")) rep.months = v("rep-months").value === "year" ? "year" : Number(v("rep-months").value);
  if (v("rep-group")) rep.group = v("rep-group").value;
  if (v("rep-measure")) rep.measure = v("rep-measure").value;
  if (v("rep-from-year")) rep.from = `${v("rep-from-year").value.replace(/\D/g, "")}-01-01`;
  if (v("rep-to-year")) rep.to = `${v("rep-to-year").value.replace(/\D/g, "")}-12-31`;
  if (v("rep-limit")) rep.limit = Number(v("rep-limit").value.replace(/\D/g, "")) / 100 || null;
}

// Lista de marcar com "Todas" e "Nenhuma" no topo; rows = [{ id, label, sub, indent }].
function checkSheet(title, rows, isOn) {
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="rep-back"></div>
  <div class="sheet"><div class="sheet-head"><button data-action="rep-back">‹ Voltar</button><h2>${title}</h2><span></span></div>
    <div class="actions pick-all"><button class="btn-skip" data-action="rep-all" data-n="1">Todas</button><button class="btn-skip" data-action="rep-all" data-n="0">Nenhuma</button></div>
    ${rows.map((g) => `${g.section ? `<div class="section-title"><span>${esc(g.section)}</span></div>` : ""}<div class="list">${g.items.map((x) =>
      `<label class="row check ${x.indent ? "cat-child" : ""}"><input type="checkbox" data-rep-item="${x.id}" ${isOn(x.id) ? "checked" : ""}>
        <div class="main"><div class="title ${x.bold ? "strong" : ""}">${esc(x.label)}</div>${x.sub ? `<div class="meta">${esc(x.sub)}</div>` : ""}</div></label>`).join("")}</div>`).join("")}
  </div>`;
  syncParents();
}

function openRepAccounts() {
  readReportFields();
  rep.sheet = "accounts";
  const accs = repAccounts();
  const groups = [...GROUPS, ["Arquivadas", (a) => a.account_group === "archived"]]
    .map(([section, test]) => ({ section, items: accs.filter(test).map((a) => ({ id: a.id, label: a.name, sub: a.currency !== "BRL" ? a.currency : "" })) }))
    .filter((g) => g.items.length);
  checkSheet(rep.type === "cards" ? "Cartões" : "Contas", groups, (id) => rep.accounts.has(id));
}

function openRepCategories() {
  readReportFields();
  rep.sheet = "categories";
  // nos resumos, "todas" é guardado como nulo; aqui vira a lista inteira marcada
  if (!rep.categories) rep.categories = new Set(state.categories.map((c) => c.id));
  const groups = [["income", "Rendimentos"], ["expense", "Gastos"]].map(([kind, section]) => ({ section,
    items: state.categories.filter((c) => c.kind === kind && !c.parent_id).flatMap((p) => [
      { id: p.id, label: p.name, bold: state.categories.some((c) => c.parent_id === p.id) },
      ...state.categories.filter((c) => c.parent_id === p.id).map((c) => ({ id: c.id, label: c.name, indent: true }))]) }));
  checkSheet("Categorias", groups, (id) => rep.categories.has(id));
}

function openRepTags() {
  readReportFields();
  rep.sheet = "tags";
  if (!rep.tags) rep.tags = new Set(state.tags.map((t) => t.id));
  checkSheet("Tags", [{ items: state.tags.map((t) => ({ id: t.id, label: t.name })) }], (id) => rep.tags.has(id));
  document.querySelector(".sheet .pick-all").insertAdjacentHTML("afterend",
    '<div class="meta-line">Com todas marcadas, o relatório não filtra por tag. Marque só algumas para ver apenas o que tem essas tags.</div>');
}

// A categoria principal marca e desmarca as subcategorias; com parte delas, fica indeterminada.
function syncParents() {
  if (rep?.sheet !== "categories") return;
  for (const p of state.categories.filter((c) => !c.parent_id)) {
    const kids = state.categories.filter((c) => c.parent_id === p.id);
    const box = document.querySelector(`[data-rep-item="${p.id}"]`);
    if (!box || !kids.length) continue;
    const on = kids.filter((k) => rep.categories.has(k.id)).length;
    box.indeterminate = on > 0 && on < kids.length;
  }
}

function repToggle(id, on) {
  const set = rep.sheet === "accounts" ? rep.accounts : rep.sheet === "tags" ? rep.tags : rep.categories;
  const ids = [id, ...(rep.sheet === "categories" ? state.categories.filter((c) => c.parent_id === id).map((c) => c.id) : [])];
  ids.forEach((x) => (on ? set.add(x) : set.delete(x)));
  // marcar uma subcategoria marca a principal, para o lançado direto nela também contar
  const parent = rep.sheet === "categories" && state.catById.get(id)?.parent_id;
  if (parent && on) set.add(parent);
  ids.concat(parent || []).forEach((x) => { const b = document.querySelector(`[data-rep-item="${x}"]`); if (b) b.checked = set.has(x); });
  syncParents();
}

async function saveReport() {
  readReportFields();
  const e = rep, name = e.name.trim();
  if (!name) return toast("Dê um nome ao relatório");
  const accounts = repAccounts().filter((a) => e.accounts.has(a.id)).map((a) => a.id);
  if (!accounts.length) return toast(e.type === "cards" ? "Escolha pelo menos um cartão" : "Escolha pelo menos uma conta");
  let config;
  if (e.type === "summary" || e.type === "monthly") {
    const all = !e.categories || e.categories.size === state.categories.length;
    if (e.categories && !e.categories.size) return toast("Escolha pelo menos uma categoria");
    if (e.tags && !e.tags.size) return toast("Marque pelo menos uma tag");
    const allTags = !e.tags || e.tags.size === state.tags.length;
    config = { type: e.type, period: e.period, scheduled: e.scheduled,
      accounts: accounts.length === state.accounts.length ? null : accounts,
      categories: all ? null : [...e.categories], tags: allTags ? null : [...e.tags] };
    if (e.type === "monthly") Object.assign(config, { group: e.group, measure: e.measure, limit: e.limit || null });
    if (e.period === "fixed") Object.assign(config, { from: e.from, to: e.to });
  } else if (e.type === "networth") {
    const y0 = Number(e.from.slice(0, 4)), y1 = Number(e.to.slice(0, 4));
    if (!(y0 >= 2000 && y1 >= y0 && y1 <= 2100)) return toast("Confira os anos do período");
    config = { type: e.type, from: e.from, to: e.to, accounts };
  } else config = { type: e.type, months: e.months, accounts };
  const old = state.reports.find((r) => r.id === e.id);
  const row = e.id
    ? await must(sb.from("reports").update({ name, config: { ...old?.config, ...config } }).eq("id", e.id).select("id").single())
    : await must(sb.from("reports").insert({ name, config }).select("id").single());
  closeSheet();
  await loadReports();
  toast("Relatório salvo");
  go(`#/relatorio/${row.id}`);
}

// Tela: previsão de saldo (os "FCST" do MoneyWiz) -----------------------------------
// Parte do saldo de hoje das contas do relatório e soma, em ordem de data, os
// lançamentos futuros e as ocorrências dos agendados (com as exceções) até o fim do
// mês daqui a config.months meses.

const FORECAST_MONTHS = [3, 6, 12, 24];
const forecastLabel = (cfg) => `próximos ${cfg.months || 3} meses`;
function forecastEnd(cfg) {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() + (cfg.months || 3), 1);
  return monthEnd(`${m.getFullYear()}-${pad(m.getMonth() + 1)}-01`);
}
const yearDay = (iso) => `${dayLabel(iso)} ${iso.slice(0, 4)}`;

function occRow(o, s, amount, running, withAccount) {
  const isTransfer = s.kind === "transfer";
  // numa transferência, a linha é da conta de origem (valor com o sinal da série) ou da de destino
  const mine = !isTransfer || amount === Number(o.amount) ? s.account_id : s.recipient_account_id;
  const other = isTransfer ? state.accById.get(mine === s.account_id ? s.recipient_account_id : s.account_id)?.name : null;
  const title = isTransfer ? (amount < 0 ? "→ " : "← ") + (other || "outra conta") : schedTitle(s);
  const splits = s.scheduled_splits || [];
  const meta = [dayLabel(o.date), withAccount && state.accById.get(mine)?.name,
    splits.length > 1 ? `${splits.length} categorias` : splits[0] && catLabel(splits[0].category_id)].filter(Boolean).join(" · ");
  return `<button class="row" data-action="occ" data-id="${s.id}" data-date="${o.occurrence_date}">
    <div class="main"><div class="title">${esc(title)}<span class="badge">agendado</span>${o.changed ? '<span class="badge">alterado</span>' : ""}${o.date < today() ? '<span class="badge warn">vencido</span>' : ""}</div>
      <div class="meta">${esc(meta)}</div></div>
    <div class="amount ${signClass(amount)}">${money(amount, s.currency)}${running !== null ? `<small>${money(running)}</small>` : ""}</div>
  </button>`;
}

// "12 mil", "1,2 mi": rótulos curtos do eixo
function compactMoney(v) {
  const a = Math.abs(v), f = (n, u) => `${(v / n).toLocaleString("pt-BR", { maximumFractionDigits: a / n < 10 ? 1 : 0 })} ${u}`;
  return a >= 1e6 ? f(1e6, "mi") : a >= 1e3 ? f(1e3, "mil") : String(Math.round(v));
}

let fcChart = null; // pontos do gráfico aberto, para o cursor

function forecastChart(start, items, to) {
  const t0 = today();
  const day = (iso) => Math.max(0, Math.round((parseDate(iso) - parseDate(t0)) / 864e5));
  const days = Math.max(1, day(to));
  const pts = [[0, start]];
  items.forEach((it) => pts.push([day(it.date), it.balance]));
  const vals = pts.map((p) => p[1]);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  // o eixo segue os dados; só desce até zero quando o menor saldo já está perto dele
  let lo = vmin >= 0 && vmin < vmax * 0.25 ? 0 : vmin, hi = vmax;
  if (hi - lo < 1) { hi += 50; lo -= 50; }
  const step = (() => { const raw = (hi - lo) / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const PW = 296, W = 340, H = 150, top = 20, bottom = H - 20;
  const X = (x) => (x / days) * PW, Y = (v) => top + ((hi - v) / (hi - lo)) * (bottom - top);
  const f = (n) => n.toFixed(1);
  let line = `M0,${f(Y(start))}`;
  pts.slice(1).forEach(([x, v]) => { line += `H${f(X(x))}V${f(Y(v))}`; });
  line += `H${PW}`;
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line class="${Math.abs(v) < step / 2 ? "zero" : "grid"}" x1="0" x2="${PW}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text x="${PW + 5}" y="${f(Y(v) + 3)}">${compactMoney(v)}</text>`;
  }
  const nMonths = Math.round(days / 30.4), every = Math.max(1, Math.ceil(nMonths / 8));
  let ticks = "";
  for (let m = new Date(parseDate(t0).getFullYear(), parseDate(t0).getMonth() + 1, 1); ; m.setMonth(m.getMonth() + 1)) {
    const iso = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-01`, x = X(day(iso));
    if (day(iso) >= days) break;
    if (m.getMonth() % every) continue;
    const label = MONTHS[m.getMonth()].slice(0, 3).toLowerCase() + (m.getMonth() === 0 ? `/${String(m.getFullYear()).slice(2)}` : "");
    ticks += `<line class="tick" x1="${f(x)}" x2="${f(x)}" y1="${top}" y2="${bottom}"/><text x="${f(x)}" y="${H - 4}" text-anchor="middle">${label}</text>`;
  }
  // marcas do maior e do menor saldo, com o rótulo para dentro do gráfico
  const mark = (idx, cls, above) => {
    const [x, v] = pts[idx], px = X(x), py = Y(v);
    const anchor = px < PW * 0.25 ? "start" : px > PW * 0.75 ? "end" : "middle";
    return `<circle class="${cls}" cx="${f(px)}" cy="${f(py)}" r="3.5"/>
      <text class="mark-label ${cls}" x="${f(px)}" y="${f(above ? py - 7 : py + 14)}" text-anchor="${anchor}">${cls === "min" ? "mín" : "máx"} ${money(v)} · ${(days > 366 ? yearDay : dayLabel)(addDays(t0, x))}</text>`;
  };
  const iMin = vals.indexOf(vmin), iMax = vals.indexOf(vmax);
  fcChart = { t0, days, pts, PW, W, X, Y };
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Saldo previsto">
    ${grid}${ticks}
    <path class="area" d="${line}V${f(lo < 0 ? Y(0) : bottom)}H0Z"/><path class="line" d="${line}"/>
    ${vmax > vmin ? mark(iMax, "max", true) + mark(iMin, "min", false) : ""}
    <line class="cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" hidden/><circle class="cursor-dot" r="4" hidden/>
  </svg><div class="chart-tip" hidden></div></div>`;
}

// Cursor: passar o mouse (ou arrastar o dedo) mostra a data e o saldo do dia.
function chartCursor(ev) {
  const svg = ev.target.closest?.(".chart svg");
  if (!svg || !fcChart || svg.classList.contains("bars")) return;
  const c = fcChart, box = svg.getBoundingClientRect(), scale = box.width / c.W;
  if (c.monthly) return monthCursor(svg, c, scale, (ev.clientX - box.left) / scale);
  const d = Math.round(Math.min(1, Math.max(0, (ev.clientX - box.left) / scale / c.PW)) * c.days);
  let v = c.pts[0][1];
  for (const [x, val] of c.pts) { if (x > d) break; v = val; }
  const px = c.X(d), py = c.Y(v);
  const cur = svg.querySelector(".cursor"), dot = svg.querySelector(".cursor-dot"), tip = svg.parentElement.querySelector(".chart-tip");
  cur.setAttribute("x1", px); cur.setAttribute("x2", px); dot.setAttribute("cx", px); dot.setAttribute("cy", py);
  [cur, dot, tip].forEach((el) => el.removeAttribute("hidden"));
  tip.innerHTML = `<span>${yearDay(addDays(c.t0, d))}</span><b class="${signClass(v)}">${money(v)}</b>`;
  const left = svg.offsetLeft + px * scale, w = tip.offsetWidth, max = svg.parentElement.clientWidth - w - 4;
  tip.style.left = `${Math.min(max, Math.max(4, left - w / 2))}px`;
}
// No patrimônio, o cursor anda de mês em mês.
function monthCursor(svg, c, scale, x) {
  const i = Math.round(Math.min(1, Math.max(0, x / c.PW)) * (c.n - 1)), r = c.rows[i];
  const px = c.X(i), py = c.Y(r.balance);
  const cur = svg.querySelector(".cursor"), dot = svg.querySelector(".cursor-dot"), tip = svg.parentElement.querySelector(".chart-tip");
  cur.setAttribute("x1", px); cur.setAttribute("x2", px); dot.setAttribute("cx", px); dot.setAttribute("cy", py);
  [cur, dot, tip].forEach((el) => el.removeAttribute("hidden"));
  tip.innerHTML = `<span>${shortMonth(r.month)}${r.forecast ? " · previsto" : ""}</span><b class="${signClass(r.balance)}">${money(r.balance)}</b>`;
  const left = svg.offsetLeft + px * scale, w = tip.offsetWidth, max = svg.parentElement.clientWidth - w - 4;
  tip.style.left = `${Math.min(max, Math.max(4, left - w / 2))}px`;
}
function chartCursorOff(ev) {
  const chart = ev.target.closest?.(".chart");
  if (!chart || chart.contains(ev.relatedTarget)) return;
  chart.querySelectorAll(".cursor, .cursor-dot, .chart-tip").forEach((el) => el.setAttribute("hidden", ""));
}
document.addEventListener("pointermove", chartCursor);
document.addEventListener("pointerdown", chartCursor);
document.addEventListener("pointerout", chartCursorOff);

async function viewForecast(r) {
  const accs = r.config.accounts, inSet = new Set(accs), to = forecastEnd(r.config), multi = accs.length > 1;
  const [txs, occs] = await Promise.all([
    fetchAll(() => sb.from("transactions").select(TX_SELECT).in("account_id", accs).gt("date", today()).lte("date", to)
      .order("date").order("created_at").order("id")),
    fetchAll(() => sb.rpc("scheduled_occurrences", { p_from: "2000-01-01", p_to: to })),
  ]);
  const items = [];
  for (const t of txs) {
    txCache.set(t.id, t);
    items.push({ date: t.date, amount: Number(t.amount), row: (bal) => txRow(t, { withAccount: multi, running: bal, currency: state.accById.get(t.account_id)?.currency }) });
  }
  const schedById = new Map(state.scheduled.map((s) => [s.id, s]));
  for (const o of occs) {
    const s = schedById.get(o.scheduled_id);
    if (!s || o.skipped) continue;
    const legs = [];
    if (inSet.has(s.account_id)) legs.push(Number(o.amount));
    if (s.kind === "transfer" && inSet.has(s.recipient_account_id)) legs.push(-Number(o.amount));
    legs.forEach((amount) => items.push({ date: o.date, amount, row: (bal) => occRow(o, s, amount, bal, multi) }));
  }
  // no mesmo dia, entradas antes das saídas (o saldo do dia não "afunda" à toa)
  items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const start = accs.reduce((sum, id) => sum + Number(state.balances.get(id)?.current_balance || 0), 0);
  let bal = start, min = { bal: start, date: today() };
  for (const it of items) {
    bal = Math.round((bal + it.amount) * 100) / 100;
    it.balance = bal;
    if (bal < min.bal) min = { bal, date: it.date };
  }
  let list = "", month = null, buf = "";
  items.forEach((it, i) => {
    if (it.date.slice(0, 7) !== month) {
      month = it.date.slice(0, 7);
      const last = items.filter((x) => x.date.slice(0, 7) === month).at(-1);
      list += `<div class="section-title"><span>${monthLabel(it.date)}</span><span class="${signClass(last.balance)}">${money(last.balance)}</span></div><div class="list">`;
    }
    list += it.row(it.balance);
    if (items[i + 1]?.date.slice(0, 7) !== month) list += "</div>";
  });
  const names = accs.map((id) => state.accById.get(id)?.name).filter(Boolean);
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1><button class="back" data-action="report-edit" data-id="${r.id}">Editar</button></div>
    <div class="meta-line">${esc(names.length > 2 ? `${names.length} contas` : names.join(" e "))} · até ${yearDay(to)}</div>
    <div class="segmented">${FORECAST_MONTHS.map((n) => `<button class="${(r.config.months || 3) === n ? "on" : ""}" data-action="fc-months" data-id="${r.id}" data-n="${n}">${n} meses</button>`).join("")}</div>
    ${forecastChart(start, items, to)}
    <div class="hero"><div class="label">Saldo hoje</div>
      <div class="value ${signClass(start)}">${money(start)}</div>
      <div class="sub">Em ${yearDay(to)}: <span class="${signClass(bal)}">${money(bal)}</span></div>
      <div class="sub">Menor saldo: <span class="${signClass(min.bal)}">${money(min.bal)}</span> em ${yearDay(min.date)}</div></div>
    <div class="forecast">${list || '<div class="empty">Nada previsto neste período.</div>'}</div>
    <div class="meta-line">Toque num agendado para mudar o valor ou a data só naquela ocorrência.</div>`, "relatorios");
}

// Tela: patrimônio (o "Net Worth 65 anos" do MoneyWiz) -------------------------------
// Saldo somado das contas em reais no fim de cada mês, de config.from a config.to. Até o
// mês passado é o realizado; daí em diante, a previsão com os lançamentos futuros e os
// agendados. Não há rendimento nem inflação na projeção, só o que está agendado.

const shortMonth = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3).toLowerCase()} ${iso.slice(0, 4)}`;
const networthLabel = (cfg) => `${cfg.from.slice(0, 4)} a ${cfg.to.slice(0, 4)}`;

function netWorthChart(rows) {
  const n = rows.length, vals = rows.map((r) => r.balance);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  let lo = vmin >= 0 && vmin < vmax * 0.25 ? 0 : vmin, hi = vmax;
  if (hi - lo < 1) { hi += 50; lo -= 50; }
  const step = (() => { const raw = (hi - lo) / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const PW = 296, W = 340, H = 150, top = 20, bottom = H - 20;
  const X = (i) => (i / Math.max(1, n - 1)) * PW, Y = (v) => top + ((hi - v) / (hi - lo)) * (bottom - top);
  const f = (x) => x.toFixed(1);
  const path = (from, to) => rows.slice(from, to + 1).map((r, k) => `${k ? "L" : "M"}${f(X(from + k))},${f(Y(r.balance))}`).join("");
  // o realizado vai até o último mês fechado; a linha prevista sai dele
  const now = rows.findIndex((r) => r.forecast), past = now < 0 ? n - 1 : Math.max(0, now - 1);
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line class="${Math.abs(v) < step / 2 ? "zero" : "grid"}" x1="0" x2="${PW}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text x="${PW + 5}" y="${f(Y(v) + 3)}">${compactMoney(v)}</text>`;
  }
  const years = rows.filter((r) => r.month.endsWith("-01-01")), every = Math.max(1, Math.ceil(years.length / 6));
  let ticks = "";
  years.forEach((r, k) => {
    if (k % every) return;
    const x = X(rows.indexOf(r));
    ticks += `<line class="tick" x1="${f(x)}" x2="${f(x)}" y1="${top}" y2="${bottom}"/><text x="${f(x)}" y="${H - 4}" text-anchor="middle">${r.month.slice(0, 4)}</text>`;
  });
  const mark = (i, cls, above) => {
    const px = X(i), py = Y(rows[i].balance);
    above = above || py + 14 > bottom - 4; // perto do eixo, o rótulo sobe para não cobrir os anos
    const anchor = px < PW * 0.25 ? "start" : px > PW * 0.75 ? "end" : "middle";
    return `<circle class="${cls}" cx="${f(px)}" cy="${f(py)}" r="3.5"/>
      <text class="mark-label ${cls}" x="${f(px)}" y="${f(above ? py - 7 : py + 14)}" text-anchor="${anchor}">${cls === "min" ? "mín" : "máx"} ${compactMoney(rows[i].balance)} · ${shortMonth(rows[i].month)}</text>`;
  };
  fcChart = { monthly: true, rows, n, PW, W, X, Y };
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Patrimônio por mês">
    ${grid}${ticks}
    <path class="area" d="${path(0, n - 1)}V${f(lo < 0 ? Y(0) : bottom)}H0Z"/>
    <path class="line" d="${path(0, past)}"/>${now >= 0 ? `<path class="line proj" d="${path(past, n - 1)}"/>
    <text class="now" x="${f(X(past))}" y="${top - 6}" text-anchor="middle">hoje</text>` : ""}
    ${vmax > vmin ? mark(vals.indexOf(vmax), "max", true) + mark(vals.indexOf(vmin), "min", false) : ""}
    <line class="cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" hidden/><circle class="cursor-dot" r="4" hidden/>
  </svg><div class="chart-tip" hidden></div></div>`;
}

async function viewNetWorth(r) {
  const cfg = r.config, accs = cfg.accounts || [];
  // um mês antes do início, para a variação do primeiro ano
  const before = new Date(Number(cfg.from.slice(0, 4)), Number(cfg.from.slice(5, 7)) - 2, 1);
  const data = (await must(sb.rpc("net_worth_monthly", { p_accounts: accs, p_from: `${monthKey(before)}-01`, p_to: cfg.to })))
    .map((x) => ({ month: x.month, balance: Number(x.balance), forecast: x.forecast }));
  const base = data.shift(), rows = data;
  const brl = accs.map((id) => state.accById.get(id)).filter((a) => a && a.currency === "BRL");
  const foreign = accs.length - brl.length;
  const now = brl.reduce((sum, a) => sum + Number(state.balances.get(a.id)?.current_balance || 0), 0);
  const last = rows.at(-1);
  // um ano por linha: saldo no fim do ano e quanto mudou desde o fim do anterior
  const years = [];
  rows.forEach((x) => { if (x.month.endsWith("-12-01") || x === last) years.push(x); });
  let prev = base.balance;
  const yearRows = years.map((x) => {
    const delta = x.balance - prev, y = x.month.slice(0, 4), started = rows.find((m) => m.month.startsWith(y));
    prev = x.balance;
    const status = !x.forecast ? "" : started.forecast ? "previsto" : "parte prevista";
    return `<div class="row"><div class="main"><div class="title">${y}${x.month.endsWith("-12-01") ? "" : ` (até ${shortMonth(x.month)})`}${status ? `<span class="badge">${status}</span>` : ""}</div>
      <div class="meta"><span class="${signClass(delta)}">${delta >= 0 ? "+" : ""}${money(delta)}</span> no ano</div></div>
      <div class="amount ${signClass(x.balance)}">${money(x.balance)}</div></div>`;
  }).reverse();
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1><button class="back" data-action="report-edit" data-id="${r.id}">Editar</button></div>
    <div class="meta-line">${brl.length} ${brl.length === 1 ? "conta" : "contas"} em reais · ${shortMonth(cfg.from)} a ${shortMonth(last.month)}</div>
    ${netWorthChart(rows)}
    <div class="hero"><div class="label">Patrimônio hoje</div>
      <div class="value ${signClass(now)}">${money(now)}</div>
      <div class="sub">Em ${shortMonth(last.month)}: <span class="${signClass(last.balance)}">${money(last.balance)}</span>${last.forecast ? " (previsto)" : ""}</div>
      <div class="sub">No início de ${shortMonth(cfg.from)}: ${money(base.balance)}</div></div>
    <div class="section-title"><span>Fim de cada ano</span></div>
    <div class="list">${yearRows.join("")}</div>
    <div class="meta-line">A previsão soma os lançamentos futuros e os agendados. Rendimento dos investimentos e inflação não entram.${foreign ? ` ${foreign} ${foreign === 1 ? "conta em outra moeda fica" : "contas em outra moeda ficam"} de fora.` : ""}</div>`, "relatorios");
}

// Tela: faturas de cartão (os relatórios de cartão do MoneyWiz) ------------------------
// Cada compra é lançada na data de vencimento da fatura, então a fatura de um mês é a
// soma dos gastos do cartão naquele mês, lançados e agendados. Os pagamentos são
// transferências para o cartão: ficam fora da soma e só marcam a fatura como paga.

const CARD_PERIODS = ["year", 6, 12, 24];
const cardPeriodLabel = (cfg) => (cfg.months === "year" ? `ano de ${new Date().getFullYear()}` : `próximos ${cfg.months || 12} meses`);
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

function cardRange(cfg) {
  const d = new Date();
  if (cfg.months === "year") return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
  const last = new Date(d.getFullYear(), d.getMonth() + (cfg.months || 12) - 1, 1);
  return { from: `${monthKey(d)}-01`, to: monthEnd(`${monthKey(last)}-01`) };
}

// O dia que mais aparece no mês é o vencimento.
function dueDate(items) {
  const count = new Map();
  items.forEach((it) => count.set(it.date, (count.get(it.date) || 0) + 1));
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

let barChart = null; // meses do gráfico aberto, para a dica

// Barras por mês, empilhadas por série (cartão, categoria, conta ou tag). months:
// [{ key: "AAAA-MM", total, by: Map(série -> valor) }]; keys: séries na ordem das cores,
// "Outros" fica cinza. Valores negativos descem abaixo do zero. opts.limit desenha o teto.
function barsChart(months, keys, selected, { name = (k) => k, limit = null, label = "Valor por mês" } = {}) {
  const PW = 296, W = 340, H = 150, top = 12, bottom = H - 20;
  const sums = (m, sign) => keys.reduce((s, k) => { const v = m.by.get(k) || 0; return s + (Math.sign(v) === sign ? v : 0); }, 0);
  const hi0 = Math.max(1, limit || 0, ...months.map((m) => sums(m, 1)));
  // um estorno de poucos reais não abre espaço abaixo do zero
  let lo0 = Math.min(0, ...months.map((m) => sums(m, -1)));
  if (-lo0 < hi0 * 0.03) lo0 = 0;
  const step = (() => { const raw = (hi0 - lo0) / 4, p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw); })();
  const hi = Math.ceil(hi0 / step) * step, lo = Math.floor(lo0 / step) * step;
  const Y = (v) => top + ((hi - v) / (hi - lo)) * (bottom - top), f = (n) => n.toFixed(1);
  const band = PW / months.length, bw = Math.min(22, band * 0.62), every = months.length > 12 ? 2 : 1, now = monthKey(new Date());
  const multi = keys.length > 1;
  let grid = "";
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid += `<line class="${Math.abs(v) < step / 2 ? "tick" : "grid"}" x1="0" x2="${PW}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text x="${PW + 5}" y="${f(Y(v) + 3)}">${compactMoney(v)}</text>`;
  }
  let bars = "";
  months.forEach((m, i) => {
    const x = i * band + (band - bw) / 2;
    // positivos sobem do zero e negativos descem; só a ponta de fora de cada pilha é arredondada
    for (const sign of [1, -1]) {
      const segs = keys.map((k, idx) => [k, idx, m.by.get(k) || 0]).filter(([, , v]) => Math.sign(v) === sign && Math.abs(v) > 0.005);
      let base = 0;
      segs.forEach(([k, idx, v], j) => {
        const ya = Y(base), yb = Y(base + v), r = j === segs.length - 1 ? Math.min(4, Math.abs(ya - yb), bw / 2) : 0;
        const gap = j ? sign : 0; // 2px de fundo entre os segmentos
        const cls = `bar ${!multi ? "s0" : k === "Outros" ? "so" : `s${idx + 1}`}${m.key < now ? " past" : ""}`;
        const y0 = ya - gap, tip = yb + sign * r, end = yb;
        bars += `<path class="${cls}" d="M${f(x)},${f(y0)}V${f(tip)}${r ? `Q${f(x)},${f(end)} ${f(x + r)},${f(end)}H${f(x + bw - r)}Q${f(x + bw)},${f(end)} ${f(x + bw)},${f(tip)}` : `H${f(x + bw)}`}V${f(y0)}Z"/>`;
        base += v;
      });
    }
    if (i % every === 0) bars += `<text x="${f(i * band + band / 2)}" y="${H - 4}" text-anchor="middle"${m.key === now ? ' class="now"' : ""}>${MONTHS[Number(m.key.slice(5)) - 1].slice(0, 3).toLowerCase()}</text>`;
    // virada do ano: linha discreta e o ano no topo
    if (i > 0 && m.key.endsWith("-01")) bars += `<line class="tick" x1="${f(i * band)}" x2="${f(i * band)}" y1="${top - 6}" y2="${bottom}"/><text class="year" x="${f(i * band + 3)}" y="${top + 1}">${m.key.slice(0, 4)}</text>`;
    bars += `<rect class="bar-hit" x="${f(i * band)}" y="${top}" width="${f(band)}" height="${bottom - top}" data-action="bar-month" data-month="${m.key}" data-i="${i}"/>`;
  });
  if (limit) bars += `<line class="limit" x1="0" x2="${PW}" y1="${f(Y(limit))}" y2="${f(Y(limit))}"/>`;
  barChart = { months, keys, name, selected };
  return `<div class="chart"><svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${bars}</svg>
    <div class="bar-readout">${barReadout(months[selected])}</div></div>`;
}

// Legenda das séries, com a mesma cor das barras.
const barsLegend = (keys, name = (k) => k, limit = null) => keys.length > 1 || limit
  ? `<div class="legend">${keys.length > 1 ? keys.map((k, i) => `<span><i class="sw ${k === "Outros" ? "so" : `s${i + 1}`}"></i>${esc(name(k))}</span>`).join("") : ""}${limit ? `<span><i class="sw-limit"></i>Teto ${money(limit)}</span>` : ""}</div>` : "";

// Linha abaixo do gráfico: mês, total e, com várias séries, o valor de cada uma.
function barReadout(m) {
  if (!m) return "";
  const keys = barChart?.keys || [], name = barChart?.name || ((k) => k);
  return `<span>${monthLabel(m.key + "-01")}</span><b>${money(m.total)}</b>` + (keys.length > 1 ? keys
    .map((k, i) => [k, i, m.by.get(k) || 0]).filter(([, , v]) => Math.abs(v) >= 0.005)
    .map(([k, i, v]) => `<span class="tip-card"><i class="sw ${k === "Outros" ? "so" : `s${i + 1}`}"></i>${esc(name(k))} ${money(v)}</span>`).join("") : "");
}

function barHover(ev) {
  const hit = ev.target.closest?.(".bar-hit"), out = document.querySelector(".bar-readout");
  if (!out || !barChart) return;
  const i = hit ? Number(hit.dataset.i) : barChart.selected;
  document.querySelectorAll(".bar-hit").forEach((h) => h.classList.toggle("on", Number(h.dataset.i) === i));
  out.innerHTML = barReadout(barChart.months[i]);
}
document.addEventListener("pointermove", barHover);
document.addEventListener("pointerdown", barHover);
document.addEventListener("pointerout", (ev) => { if (ev.target.closest?.("svg.bars") && !ev.relatedTarget?.closest?.("svg.bars")) barHover({ target: document.body }); });

// Nome curto do cartão para legenda e dica: sem o banco e a bandeira repetidos.
const cardName = (id) => (state.accById.get(id)?.name || "").replace(/\b(Banco|Mastercard|Visa|Itaú|Itau|Azul)\b/gi, "").replace(/\s+/g, " ").trim()
  || state.accById.get(id)?.name || "";

async function viewCards(r) {
  const accs = r.config.accounts, inSet = new Set(accs), { from, to } = cardRange(r.config), multi = accs.length > 1, t0 = today();
  const [txs, occs, checks] = await Promise.all([
    fetchAll(() => sb.from("transactions").select(TX_SELECT).in("account_id", accs).gte("date", from).lte("date", to)
      .order("date").order("created_at").order("id")),
    fetchAll(() => sb.rpc("scheduled_occurrences", { p_from: from, p_to: to })),
    must(sb.from("bank_checks").select("*").eq("kind", "invoice").in("account_id", accs).gte("ref_date", from).lte("ref_date", to)),
  ]);
  const checkOf = new Map(checks.map((c) => [`${c.account_id}|${c.ref_date.slice(0, 7)}`, c]));
  const months = [], byKey = new Map();
  for (const d = parseDate(from); monthKey(d) <= to.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
    const m = { key: monthKey(d), total: 0, byCard: new Map(), paidBy: new Map(), items: [] };
    m.by = m.byCard;
    months.push(m); byKey.set(m.key, m);
  }
  const add = (date, acc, amount, row, label) => {
    const m = byKey.get(date.slice(0, 7));
    m.total -= amount;
    m.byCard.set(acc, (m.byCard.get(acc) || 0) - amount);
    m.items.push({ date, acc, amount, row, label });
  };
  for (const t of txs) {
    txCache.set(t.id, t);
    if (t.kind === "transfer_in" || t.kind === "transfer_out") {
      const m = byKey.get(t.date.slice(0, 7));
      if (t.date <= t0) m.paidBy.set(t.account_id, (m.paidBy.get(t.account_id) || 0) + Number(t.amount));
      continue;
    }
    add(t.date, t.account_id, Number(t.amount), () => txRow(t, { withAccount: multi, currency: state.accById.get(t.account_id)?.currency }), txTitle(t));
  }
  const schedById = new Map(state.scheduled.map((s) => [s.id, s]));
  for (const o of occs) {
    const s = schedById.get(o.scheduled_id);
    if (!s || o.skipped || s.kind === "transfer" || !inSet.has(s.account_id)) continue;
    add(o.date, s.account_id, Number(o.amount), () => occRow(o, s, Number(o.amount), null, multi), schedTitle(s));
  }
  const now = t0.slice(0, 7);
  for (const m of months) {
    m.total = Math.round(m.total * 100) / 100;
    // cada cartão tem o seu vencimento e o seu pagamento
    m.cards = accs.filter((id) => Math.abs(m.byCard.get(id) || 0) >= 0.005).map((id) => {
      const total = m.byCard.get(id), due = dueDate(m.items.filter((it) => it.acc === id));
      const open = total > 0 && (m.paidBy.get(id) || 0) < total - 0.01;
      // conferida: o total do banco ainda bate com o que está lançado agora
      const check = checkOf.get(`${id}|${m.key}`);
      return { id, total, due, open, late: open && due < t0, check, ok: check && Math.abs(Number(check.bank_amount) - total) < 0.005 };
    });
    const open = m.cards.filter((c) => c.open);
    m.isPaid = m.total > 0 && !open.length;
    m.late = open.some((c) => c.late);
    m.due = (open.length ? open : m.cards).map((c) => c.due).sort()[0];
    m.items.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  }
  const next = months.find((m) => m.key >= now && m.cards.some((c) => c.open));
  const ahead = months.filter((m) => m.key >= now);
  const total = ahead.reduce((s, m) => s + m.total, 0);
  const names = accs.map(cardName);
  const legend = barsLegend(accs, cardName);
  state.cardMonths = byKey; // para a folha de conferência
  const checkText = (c) => (c.ok ? " · conferida" : c.check ? ` · difere ${money(Number(c.check.bank_amount) - c.total)} do banco` : "");
  const monthRow = (m) => {
    const checked = m.cards.length && m.cards.every((c) => c.ok), differs = m.cards.some((c) => c.check && !c.ok);
    const badge = (m.isPaid ? '<span class="badge">paga</span>' : m.late ? '<span class="badge warn">em aberto</span>' : "")
      + (checked ? '<span class="badge ok">conferida</span>' : differs ? '<span class="badge warn">difere do banco</span>' : "");
    const count = `${m.items.length} ${m.items.length === 1 ? "item" : "itens"}`;
    // no consolidado, uma linha por cartão com valor, vencimento, pagamento e conferência
    const meta = multi ? [count, ...m.cards.map((c) => `${cardName(c.id)} ${money(c.total)}${c.due ? ` · dia ${Number(c.due.slice(8))}` : ""}${c.late ? " · em aberto" : !c.open && !m.isPaid ? " · paga" : ""}${checkText(c)}`)]
      : [[m.due && `vence ${dayLabel(m.due)}`, count, !m.cards[0]?.ok && m.cards[0]?.check && checkText(m.cards[0]).slice(3)].filter(Boolean).join(" · ")];
    const conf = m.cards.map((c) => `<button class="row sub conf" data-action="check-invoice" data-id="${c.id}" data-month="${m.key}">
        <div class="main"><div class="title">Conferir com o banco${multi ? `: ${esc(cardName(c.id))}` : ""}</div></div><span class="chev">›</span></button>`).join("");
    return `<button class="row" data-action="toggle-sub" id="mes-${m.key}"><div class="main">
        <div class="title">${monthLabel(m.key + "-01")}${badge}</div>${meta.map((x) => `<div class="meta wrap">${esc(x)}</div>`).join("")}</div>
        <div class="amount">${money(m.total)}</div><span class="chev">›</span></button>
      <div class="sub-rows" hidden>${conf}${m.items.map((it) => it.row()).join("") || '<div class="empty">Nada nesta fatura.</div>'}</div>`;
  };
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1><button class="back" data-action="report-edit" data-id="${r.id}">Editar</button></div>
    <div class="meta-line">${esc(names.length > 2 ? `${names.length} cartões` : accs.map((id) => state.accById.get(id)?.name).join(" e "))} · ${cardPeriodLabel(r.config)}</div>
    <div class="segmented">${CARD_PERIODS.map((n) => `<button class="${(r.config.months || 12) === n ? "on" : ""}" data-action="card-months" data-id="${r.id}" data-n="${n}">${n === "year" ? "Este ano" : `${n} meses`}</button>`).join("")}</div>
    ${legend}${barsChart(months, accs, Math.max(0, months.indexOf(next ?? months.find((m) => m.key === now))), { name: cardName, label: "Fatura por mês" })}
    <div class="hero"><div class="label">${next ? `Próxima fatura${next.due ? `, vence ${yearDay(next.due)}` : ""}` : "Próxima fatura"}</div>
      <div class="value">${money(next?.total || 0)}</div>
      <div class="sub">De ${monthLabel(now + "-01").toLowerCase()} em diante: ${money(total)}, média de ${money(ahead.length ? total / ahead.length : 0)} por mês</div></div>
    <div class="section-title"><span>Faturas</span></div>
    <div class="list">${months.map(monthRow).join("")}</div>
    <div class="meta-line">Toque num mês para ver as compras. Toque num agendado para mudar só aquela parcela.</div>`, "relatorios");
}

// Folha: conferir com o banco ----------------------------------------------------------
// Fatura: o total do PDF contra o total lançado no cartão naquele mês. Saldo: o saldo do
// banco num dia contra o saldo do MoneyCau no fim daquele dia. Com diferença, a folha
// sugere onde procurar.

let chk = null;
const localDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function openInvoiceCheck(accId, key) {
  const m = state.cardMonths?.get(key), card = m?.cards.find((c) => c.id === accId);
  if (!m || !card) return;
  const items = m.items.filter((it) => it.acc === accId);
  chk = { kind: "invoice", account: accId, ref: key + "-01", app: card.total, items, prev: card.check,
    cents: card.check ? Math.round(Number(card.check.bank_amount) * 100) : 0,
    title: "Conferir fatura", sub: `${state.accById.get(accId)?.name} · ${monthLabel(key + "-01").toLowerCase()}` };
  drawCheck();
}

async function openBalanceCheck(accId) {
  const last = (await must(sb.from("bank_checks").select("*").eq("account_id", accId).eq("kind", "balance")
    .order("ref_date", { ascending: false }).limit(1)))[0];
  chk = { kind: "balance", account: accId, ref: today(), prev: last, cents: 0, negative: false,
    title: "Conferir saldo", sub: state.accById.get(accId)?.name };
  await loadBalanceAt();
  chk.negative = chk.app < 0;
  drawCheck();
}

// Saldo do MoneyCau no fim do dia escolhido e os lançamentos dos 45 dias anteriores,
// onde costuma estar a diferença.
async function loadBalanceAt() {
  const [bal, txs] = await Promise.all([
    must(sb.rpc("account_balance_at", { p_account: chk.account, p_date: chk.ref })),
    must(sb.from("transactions").select(TX_SELECT).eq("account_id", chk.account)
      .gte("date", addDays(chk.ref, -45)).lte("date", chk.ref).order("date", { ascending: false }).range(0, 999)),
  ]);
  chk.app = Number(bal);
  chk.items = txs.map((t) => { txCache.set(t.id, t); return { date: t.date, amount: Number(t.amount), label: txTitle(t), row: () => txRow(t) }; });
}

const checkBank = () => (chk.kind === "balance" && chk.negative ? -1 : 1) * chk.cents / 100;

// Onde procurar a diferença: um lançamento com o valor exato, dois que somam a
// diferença ou lançamentos repetidos (mesmo nome e valor).
function checkHints() {
  const diff = Math.round((chk.app - checkBank()) * 100); // positivo: o MoneyCau tem a mais
  if (!diff) return "";
  // na fatura, compra é positiva; no saldo, o que pesa é o valor com sinal
  const val = (it) => Math.round((chk.kind === "invoice" ? -it.amount : it.amount) * 100);
  const items = chk.items || [];
  const exact = items.filter((it) => Math.abs(val(it)) === Math.abs(diff));
  const pairs = [];
  for (let i = 0; i < items.length && pairs.length < 3; i++)
    for (let j = i + 1; j < items.length && pairs.length < 3; j++)
      if (val(items[i]) + val(items[j]) === diff) pairs.push([items[i], items[j]]);
  // repetido: mesmo nome e valor com até 3 dias de distância (salário de todo mês não conta)
  const dups = [];
  items.forEach((a, i) => items.slice(i + 1).forEach((b) => {
    if (norm(a.label) === norm(b.label) && val(a) === val(b) && Math.abs(parseDate(a.date) - parseDate(b.date)) <= 3 * 864e5)
      [a, b].forEach((x) => { if (!dups.includes(x)) dups.push(x); });
  }));
  const block = (title, rows) => rows.length ? `<div class="section-title"><span>${title}</span></div><div class="list">${rows.map((it) => it.row()).join("")}</div>` : "";
  const more = diff > 0;
  return `<div class="hero check-diff"><div class="label">Diferença</div>
      <div class="value warn-text">${money(Math.abs(diff) / 100)}</div>
      <div class="sub">${chk.kind === "invoice" ? (more ? "O MoneyCau tem a mais que a fatura: procure compra repetida, lançada no mês errado ou com valor maior." : "Falta lançar algo no MoneyCau, ou alguma compra está com valor menor.")
        : (more ? "O saldo do MoneyCau está maior que o do banco: falta lançar uma saída ou alguma entrada está a mais." : "O saldo do MoneyCau está menor que o do banco: falta lançar uma entrada ou alguma saída está a mais.")}</div></div>
    ${block(`Com o valor exato de ${money(Math.abs(diff) / 100)}`, exact)}
    ${block("Dois lançamentos que somam a diferença", pairs.flat())}
    ${block("Possíveis repetidos", dups)}
    ${!exact.length && !pairs.length && !dups.length ? '<div class="meta-line">Nenhum lançamento explica a diferença sozinho. Compare item a item com o extrato.</div>' : ""}`;
}

function drawCheck() {
  const e = chk, cur = state.accById.get(e.account)?.currency || "BRL";
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="close"></div>
  <div class="sheet" role="dialog" aria-label="${esc(e.title)}">
    <div class="sheet-head"><button data-action="close">Cancelar</button><h2>${esc(e.title)}</h2>
      <button class="save" data-action="check-save">Salvar</button></div>
    <div class="hero"><div class="label">${esc(e.sub)}</div>
      <div class="sub">No MoneyCau${e.kind === "balance" ? ` no fim de ${yearDay(e.ref)}` : ""}: <b>${money(e.app, cur)}</b>${e.kind === "invoice" ? ` em ${e.items.length} ${e.items.length === 1 ? "item" : "itens"}` : ""}</div>
      ${e.prev ? `<div class="sub">Última conferência${e.kind === "balance" ? ` (${yearDay(e.prev.ref_date)})` : ""}: banco ${money(e.prev.bank_amount, cur)}, feita em ${yearDay(localDate(e.prev.created_at))}</div>` : ""}</div>
    <div class="form">
      ${e.kind === "balance" ? `<div class="field"><label>Data</label><input id="check-date" type="date" value="${e.ref}" max="${today()}"></div>` : ""}
      <div class="field"><label>${e.kind === "invoice" ? "Total da fatura" : "Saldo no banco"}</label>
        <input id="check-amount" inputmode="numeric" autocomplete="off" placeholder="0,00" value="${e.cents ? centsToText(e.cents) : ""}"></div>
      ${e.kind === "balance" ? `<label class="field check"><span class="grow">Saldo negativo</span><input type="checkbox" id="check-negative" ${e.negative ? "checked" : ""}></label>` : ""}
    </div>
    <div id="check-result">${checkResult()}</div>
  </div>`;
}

function checkResult() {
  if (!chk.cents) return '<div class="meta-line">Digite o valor que aparece no banco.</div>';
  return Math.round((chk.app - checkBank()) * 100) === 0
    ? '<div class="hero"><div class="value pos">Bate ✓</div><div class="sub">O MoneyCau confere com o banco.</div></div>'
    : checkHints();
}

async function saveCheck() {
  if (!chk.cents && !(chk.kind === "balance")) return toast("Digite o valor do banco");
  await must(sb.from("bank_checks").upsert({ account_id: chk.account, kind: chk.kind, ref_date: chk.ref,
    bank_amount: checkBank(), app_amount: chk.app, created_at: new Date().toISOString() }, { onConflict: "account_id,kind,ref_date" }));
  const ok = Math.round((chk.app - checkBank()) * 100) === 0;
  closeSheet();
  toast(ok ? "Conferido: bate com o banco" : "Conferência salva com diferença");
  route();
}

// Folha: só nesta data (exceção de uma ocorrência) ----------------------------------

let occ = null;

function openOccurrence(sid, occDate) {
  const s = state.scheduled.find((x) => x.id === sid);
  if (!s) return;
  const ex = state.exceptions.get(sid + "|" + occDate);
  entry = null;
  occ = { s, occDate, ex, cents: Math.round(Math.abs(ex?.amount ?? s.amount) * 100), date: ex?.new_date || occDate };
  const kind = s.kind;
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="close"></div>
  <div class="sheet" role="dialog" aria-label="Só nesta data">
    <div class="sheet-head"><button data-action="close">Cancelar</button><h2>Só nesta data</h2>
      <button class="save" data-action="occ-save">Salvar</button></div>
    <div class="hero"><div class="label">${esc(schedTitle(s))}</div>
      <div class="sub">Na série: ${money(Math.abs(s.amount), s.currency)} em ${yearDay(occDate)}</div>
      ${ex?.skip ? '<div class="sub">Esta data está marcada para ser pulada.</div>' : ""}</div>
    <input id="occ-amount" class="amount-input ${kind}" inputmode="numeric" autocomplete="off" value="${centsToText(occ.cents)}">
    <div class="form"><div class="field"><label>Data</label><input id="occ-date" type="date" value="${occ.date}">
      <div class="hint">Muda só esta ocorrência. As outras seguem a série.</div></div></div>
    ${ex ? '<button class="more" data-action="occ-reset">Voltar ao que está na série</button>' : ""}
    <button class="more" data-action="occ-dup">Duplicar nesta data</button>
    <button class="more" data-action="occ-series">Editar a série inteira</button>
    ${ex?.skip ? "" : '<button class="danger" data-action="occ-skip">Pular esta data</button>'}
  </div>`;
}

async function saveOccurrence(fields) {
  await must(sb.rpc("set_scheduled_exception", { p_id: occ.s.id, p_occurrence: occ.occDate, ...fields }));
  closeSheet();
  await afterChange(true);
}

// Abre "Novo agendado" com os dados de um existente, sem repetição, numa data.
function duplicateScheduled(s, date, cents) {
  const fromIsAccount = !(s.kind === "transfer" && s.amount > 0);
  const splits = [...(s.scheduled_splits || [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  occ = null;
  openEntry({ kind: s.kind, schedEdit: true, date, cents, repeat: "none", tags: (s.scheduled_tags || []).map((x) => x.tag_id),
    account: fromIsAccount ? s.account_id : s.recipient_account_id,
    toAccount: fromIsAccount ? s.recipient_account_id : s.account_id,
    payee: state.payeeById.get(s.payee_id)?.name || "", description: s.description || "",
    category: splits.length === 1 ? splits[0].category_id : null, splits: splits.length > 1 ? splitsFrom(splits, cents) : null });
}

// Folha: lançamento --------------------------------------------------------------

let entry = null; // estado do formulário aberto

const selectableAccounts = () => state.accounts.filter((a) => a.account_group !== "archived");
const validAccount = (id) => (id && state.accById.get(id)?.account_group !== "archived" && state.accById.has(id) ? id : null);
const defaultAccount = () =>
  (state.accounts.find((a) => a.account_group === "active" && a.type === "checking") || selectableAccounts()[0])?.id;

function accountOptions(selected) {
  const groups = [["Contas", (a) => a.account_group === "active" && a.type !== "credit_card"],
    ["Cartões", (a) => a.account_group === "active" && a.type === "credit_card"],
    ["Investimentos", (a) => a.account_group === "investment"]];
  const list = selectableAccounts();
  if (selected && !list.some((a) => a.id === selected)) list.push(state.accById.get(selected));
  return groups.map(([label, test]) => {
    const opts = list.filter(test).map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    return opts ? `<optgroup label="${label}">${opts}</optgroup>` : "";
  }).join("") + (selected && state.accById.get(selected)?.account_group === "archived"
    ? `<option value="${selected}" selected>${esc(state.accById.get(selected).name)}</option>` : "");
}

const centsToText = (cents) => money(cents / 100).replace(/^R\$\s?/, "");

function openEntry(init = {}) {
  const kind = init.kind || "expense";
  entry = {
    id: init.id || null,
    kind,
    cents: init.cents || 0,
    toCents: init.toCents || 0,
    account: init.account || validAccount(store("mc.last." + kind)) || validAccount(store("mc.last.expense")) || defaultAccount(),
    toAccount: init.toAccount || store("mc.last.transfer.to") || null,
    payee: init.payee || "",
    category: init.category || null,
    categoryTouched: !!init.category || !!init.multiSplit || !!init.splits,
    date: init.date || today(),
    description: init.description || "",
    notes: init.notes || "",
    tags: init.tags || [],
    readOnly: init.readOnly || null,
    scheduled: init.scheduled || null,
    // edição da definição de um agendado: schedId é o id (null = novo agendado)
    schedEdit: !!init.schedEdit,
    schedId: init.schedId || null,
    repeat: init.repeat || "month:1",
    total: init.total ?? null,
    done: init.done || 0,
    multiSplit: init.multiSplit || 0, // agendado dividido sendo lançado: a divisão segue a proporção
    // divisão em várias categorias: [{ category, cents }] (null = categoria única);
    // splitIdx é a parte cuja categoria está sendo escolhida
    splits: init.splits || null,
    splitIdx: null,
    upcoming: init.upcoming || null, // próximas ocorrências, na edição de um agendado
  };
  drawEntry();
  if (!entry.id && !entry.readOnly) setTimeout(() => document.getElementById("amount")?.focus(), 250);
}

function closeSheet() { $sheet.innerHTML = ""; entry = null; occ = null; rep = null; chk = null; }

function drawEntry() {
  const e = entry;
  const from = state.accById.get(e.account);
  const to = state.accById.get(e.toAccount);
  const fx = e.kind === "transfer" && from && to && from.currency !== to.currency;
  const title = e.scheduled ? "Lançar agendado" : e.schedEdit ? (e.schedId ? "Editar agendado" : "Novo agendado")
    : e.id ? "Editar lançamento" : "Novo lançamento";
  const cat = e.category && !e.multiSplit ? esc(catLabel(e.category))
    : e.multiSplit ? `${e.multiSplit} categorias, na proporção do valor` : "Escolher";
  const repeats = REPEATS.some(([v]) => v === e.repeat) ? REPEATS
    : [...REPEATS, [e.repeat, `A cada ${e.repeat.split(":")[1]} ${{ day: "dias", week: "semanas", month: "meses", year: "anos" }[e.repeat.split(":")[0]]}`]];
  const disabled = e.readOnly ? "disabled" : "";
  // num agendado, só valor e data mudam; o resto vem da definição do agendado
  const lock = disabled || (e.scheduled ? "disabled" : "");
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="close"></div>
  <div class="sheet" role="dialog" aria-label="${title}">
    <div class="sheet-head"><button data-action="close">Cancelar</button><h2>${title}</h2>
      ${e.readOnly ? "<span></span>" : '<button class="save" data-action="save">Salvar</button>'}</div>
    ${e.readOnly ? `<div class="hero"><div class="sub">${esc(e.readOnly)}</div></div>` : ""}
    <div class="segmented">
      ${[["expense", "Despesa"], ["income", "Receita"], ["transfer", "Transferência"]].map(([k, l]) =>
        `<button class="${e.kind === k ? "on" : ""}" data-action="kind" data-kind="${k}" ${disabled || (e.scheduled ? "disabled" : "")}>${l}</button>`).join("")}
    </div>
    <input id="amount" class="amount-input ${e.kind}" inputmode="numeric" autocomplete="off" value="${centsToText(e.cents)}" ${disabled}>
    <div class="form">
      <div class="field"><label>${e.kind === "transfer" ? "De" : "Conta"}</label>
        <select id="account" ${lock}>${accountOptions(e.account)}</select></div>
      ${e.kind === "transfer" ? `<div class="field"><label>Para</label>
        <select id="toAccount" ${lock}><option value="">Escolher</option>${accountOptions(e.toAccount)}</select></div>` : ""}
      ${fx ? `<div class="field"><label>Recebido (${to.currency})</label>
        <input id="toAmount" inputmode="numeric" value="${centsToText(e.toCents)}" ${disabled}></div>` : ""}
      ${e.kind !== "transfer" ? `<div class="field"><label>Beneficiário</label>
        <input id="payee" autocomplete="off" value="${esc(e.payee)}" placeholder="Ex.: Pão de Açúcar" ${lock}>
        <div class="suggest" id="suggest" hidden></div></div>
      ${e.splits ? splitFields(e, lock) : `<div class="field"><label>Categoria</label>
        <button class="picker ${e.category || e.multiSplit ? "" : "placeholder"}" data-action="pick-cat" ${lock}>${cat}</button></div>`}` : ""}
      <div class="field"><label>${e.schedEdit ? "Próxima data" : "Data"}</label><input id="date" type="date" value="${e.date}" ${disabled}></div>
      <div class="field"><label>Descrição</label><input id="description" value="${esc(e.description)}" placeholder="Opcional" ${lock}></div>
      <div class="field"><label>Tags</label>
        <button class="picker ${e.tags.length ? "" : "placeholder"}" data-action="pick-tags" ${lock}>${esc(tagNames(e.tags)) || "Opcional"}</button></div>
      ${e.schedEdit ? `<div class="field"><label>Repetição</label>
        <select id="repeat">${repeats.map(([v, l]) => `<option value="${v}" ${v === e.repeat ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      ${e.repeat !== "none" ? `<div class="field"><label>Parcelas</label>
        <input id="total" inputmode="numeric" autocomplete="off" value="${e.total ?? ""}" placeholder="Sem fim">
        ${e.done ? `<div class="hint">A próxima é a parcela ${e.done + 1}. Deixe em branco se não tiver fim.</div>`
          : '<div class="hint">Total de parcelas. Deixe em branco se não tiver fim.</div>'}</div>` : ""}` : ""}
    </div>
    ${e.id ? '<button class="danger" data-action="delete">Apagar lançamento</button>' : ""}
    ${e.scheduled ? '<button class="danger" data-action="skip-sched">Pular esta ocorrência</button>' : ""}
    ${e.upcoming?.length ? `<div class="section-title"><span>Próximas datas</span></div>
      <div class="list">${e.upcoming.map((o) => `<button class="row" data-action="occ" data-id="${e.schedId}" data-date="${o.occurrence_date}">
        <div class="main"><div class="title">${yearDay(o.date)}${o.skipped ? '<span class="badge warn">pulada</span>' : o.changed ? '<span class="badge">alterado</span>' : ""}</div></div>
        <div class="amount ${o.skipped ? "muted" : signClass(o.amount)}">${money(o.amount)}</div><span class="chev">›</span></button>`).join("")}</div>
      <div class="meta-line">Toque numa data para mudar o valor ou a data só nela.</div>` : ""}
    ${e.schedId ? '<button class="more" data-action="dup-sched">Duplicar agendado</button>' : ""}
    ${e.schedId ? '<button class="danger" data-action="end-sched">Encerrar agendado</button>' : ""}
  </div>`;
}

// Partes da divisão: categoria, valor e remover; no topo, quanto falta distribuir.
function splitFields(e, lock) {
  return `<div class="field split-head"><label>Categorias</label><span id="split-sum">${splitSumText(e)}</span></div>
    ${e.splits.map((x, i) => `<div class="field split">
      <button class="picker ${x.category ? "" : "placeholder"}" data-action="pick-cat" data-i="${i}" title="${x.category ? esc(catLabel(x.category)) : ""}" ${lock}>${x.category ? esc(state.catById.get(x.category)?.name) : "Escolher categoria"}</button>
      <input class="split-amount" data-i="${i}" inputmode="numeric" autocomplete="off" value="${centsToText(x.cents)}" ${lock}>
      ${lock ? "" : `<button class="split-del" data-action="split-del" data-i="${i}" aria-label="Remover esta categoria">×</button>`}</div>`).join("")}
    ${lock ? "" : '<div class="field"><button class="picker add" data-action="split-add">+ Adicionar categoria</button></div>'}`;
}
const splitRest = (e) => e.cents - e.splits.reduce((sum, x) => sum + x.cents, 0);
function splitSumText(e) {
  const rest = splitRest(e);
  return rest === 0 ? '<span class="ok">Soma confere</span>'
    : `<span class="warn">${rest > 0 ? "Falta distribuir" : "Passou do valor em"} ${money(Math.abs(rest) / 100)}</span>`;
}

// Divisão vinda do banco (valores com sinal) em centavos positivos, ajustada a um total:
// na proporção, com os centavos de arredondamento na maior parte.
function splitsFrom(rows, totalCents) {
  const parts = [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((r) => ({ category: r.category_id, cents: Math.round(Math.abs(r.amount) * 100) }));
  const sum = parts.reduce((s, x) => s + x.cents, 0);
  if (totalCents == null || !sum || sum === totalCents) return parts;
  parts.forEach((x) => { x.cents = Math.round((x.cents * totalCents) / sum); });
  parts[0].cents += totalCents - parts.reduce((s, x) => s + x.cents, 0);
  return parts;
}

function readEntryFields() {
  const v = (id) => document.getElementById(id)?.value;
  if (!entry) return;
  if (v("account")) entry.account = v("account");
  if (v("toAccount") !== undefined) entry.toAccount = v("toAccount") || null;
  if (v("payee") !== undefined) entry.payee = v("payee");
  if (v("date")) entry.date = v("date");
  if (v("description") !== undefined) entry.description = v("description");
  if (v("repeat")) entry.repeat = v("repeat");
  if (v("total") !== undefined) entry.total = Number(v("total").replace(/\D/g, "")) || null;
}

function payeeSuggestions(text) {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const starts = [], contains = [];
  for (const p of state.payees) {
    const n = p.name.toLowerCase();
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) contains.push(p);
    if (starts.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}

function choosePayee(p) {
  entry.payee = p.name;
  if (!entry.categoryTouched && !entry.splits && p.default_category_id) {
    const c = state.catById.get(p.default_category_id);
    if (c && c.kind === entry.kind) entry.category = c.id;
  }
  drawEntry();
}

function openCategoryPicker() {
  readEntryFields();
  const kind = entry.kind === "income" ? "income" : "expense";
  const parents = state.categories.filter((c) => c.kind === kind && !c.parent_id);
  const children = (id) => state.categories.filter((c) => c.parent_id === id);
  const draw = (q = "") => {
    const ql = q.trim().toLowerCase();
    const match = (c) => !ql || c.name.toLowerCase().includes(ql) || catLabel(c.id).toLowerCase().includes(ql);
    let rows = "";
    for (const p of parents) {
      const kids = children(p.id).filter(match);
      if (!match(p) && !kids.length) continue;
      rows += `<button class="row cat-parent" data-action="set-cat" data-id="${p.id}">${esc(p.name)}</button>`;
      rows += kids.map((c) => `<button class="row cat-child" data-action="set-cat" data-id="${c.id}">${esc(c.name)}</button>`).join("");
    }
    document.getElementById("cat-list").innerHTML = rows || '<div class="empty">Nada encontrado.</div>';
  };
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="back-entry"></div>
  <div class="sheet"><div class="sheet-head"><button data-action="back-entry">‹ Voltar</button><h2>Categoria</h2><span></span></div>
    <input class="search" id="cat-search" placeholder="Buscar categoria" autocomplete="off">
    ${entry.splits ? "" : '<button class="more split-start" data-action="split-start">Dividir em várias categorias</button>'}
    <div class="list" id="cat-list"></div></div>`;
  draw();
  const s = document.getElementById("cat-search");
  s.addEventListener("input", () => draw(s.value));
}

function openTagPicker() {
  readEntryFields();
  const draw = (q = "") => {
    const n = norm(q.trim());
    const list = state.tags.filter((t) => !n || norm(t.name).includes(n));
    const exact = state.tags.some((t) => norm(t.name) === n);
    document.getElementById("tag-list").innerHTML =
      (n && !exact ? `<button class="row" data-action="new-tag" data-name="${esc(q.trim())}"><div class="main"><div class="title">Criar “${esc(q.trim())}”</div></div></button>` : "") +
      list.map((t) => `<label class="row check"><input type="checkbox" data-tag="${t.id}" ${entry.tags.includes(t.id) ? "checked" : ""}>
        <div class="main"><div class="title">${esc(t.name)}</div></div></label>`).join("") ||
      '<div class="empty">Nenhuma tag ainda. Digite um nome para criar.</div>';
  };
  $sheet.innerHTML = `<div class="sheet-backdrop" data-action="back-entry"></div>
  <div class="sheet"><div class="sheet-head"><button data-action="back-entry">‹ Voltar</button><h2>Tags</h2><span></span></div>
    <input class="search" id="tag-search" placeholder="Buscar ou criar tag" autocomplete="off">
    <div class="list" id="tag-list"></div></div>`;
  draw();
  const box = document.getElementById("tag-search");
  box.addEventListener("input", () => draw(box.value));
  entry.redrawTags = () => draw(box.value);
}

async function saveEntry() {
  readEntryFields();
  const e = entry;
  if (e.cents <= 0) return toast("Informe o valor");
  if (!e.account) return toast("Escolha a conta");
  if (e.kind === "transfer" && !e.toAccount) return toast("Escolha a conta de destino");
  if (e.kind === "transfer" && e.toAccount === e.account) return toast("As contas precisam ser diferentes");
  const fx = e.kind === "transfer" && state.accById.get(e.account)?.currency !== state.accById.get(e.toAccount)?.currency;
  if (fx && e.toCents <= 0) return toast("Informe o valor recebido");

  let splits = null;
  if (e.splits && e.kind !== "transfer" && !e.scheduled) {
    if (e.splits.some((x) => !x.category)) return toast("Escolha a categoria de cada parte");
    if (e.splits.some((x) => x.cents <= 0)) return toast("Cada categoria precisa de um valor");
    if (splitRest(e)) return toast(`A soma das categorias precisa dar ${money(e.cents / 100)}`);
    splits = e.splits.map((x) => ({ category_id: x.category, amount: x.cents / 100 }));
  }

  if (e.schedEdit && e.repeat !== "none" && e.total && e.total <= e.done)
    return toast(`O total precisa ser maior que ${e.done}, que já passaram`);

  if (e.schedEdit) {
    const [unit, count] = e.repeat === "none" ? ["month", 1] : e.repeat.split(":");
    const sid = await must(sb.rpc("save_scheduled", {
      p_id: e.schedId, p_kind: e.kind, p_account: e.account, p_amount: e.cents / 100, p_next_date: e.date,
      p_payee_name: e.kind === "transfer" ? null : e.payee || null,
      p_category: e.kind === "transfer" ? null : e.category,
      p_description: e.description || null,
      p_to_account: e.kind === "transfer" ? e.toAccount : null,
      p_repeatable: e.repeat !== "none", p_unit: unit, p_count: Number(count),
      p_total: e.repeat === "none" ? null : e.total, p_splits: splits,
    }));
    await must(sb.from("scheduled_tags").delete().eq("scheduled_id", sid));
    if (e.tags.length) await must(sb.from("scheduled_tags").insert(e.tags.map((tag_id) => ({ scheduled_id: sid, tag_id }))));
  } else if (e.scheduled) {
    await must(sb.rpc("execute_scheduled", { p_id: e.scheduled, p_date: e.date, p_amount: e.cents / 100 }));
  } else {
    await must(sb.rpc("save_entry", {
      p_id: e.id, p_kind: e.kind, p_account: e.account, p_amount: e.cents / 100, p_date: e.date,
      p_payee_name: e.kind === "transfer" ? null : e.payee || null,
      p_category: e.kind === "transfer" ? null : e.category,
      p_description: e.description || null, p_notes: e.notes || null,
      p_to_account: e.kind === "transfer" ? e.toAccount : null,
      p_to_amount: fx ? e.toCents / 100 : null, p_tags: e.tags, p_splits: splits,
    }));
  }
  store("mc.last." + e.kind, e.account);
  if (e.kind === "transfer") store("mc.last.transfer.to", e.toAccount);
  const wasScheduled = !!e.scheduled || e.schedEdit;
  closeSheet();
  toast(e.schedEdit ? "Agendado salvo" : e.scheduled ? "Agendado lançado" : "Lançamento salvo");
  await afterChange(wasScheduled);
}

async function afterChange(scheduledChanged) {
  const tasks = [refreshBalances()];
  if (scheduledChanged) tasks.push(loadScheduled());
  // um beneficiário novo pode ter sido criado
  tasks.push(fetchAll(() => sb.from("payee_usage").select("id,name,default_category_id,uses,last_used")
    .order("uses", { ascending: false }).order("id")).then((p) => {
    state.payees = p; state.payeeById = new Map(p.map((x) => [x.id, x]));
  }));
  await Promise.all(tasks);
  route();
}

async function openTransaction(id) {
  const t = txCache.get(id);
  if (!t) return;
  const tags = (await must(sb.from("transaction_tags").select("tag_id").eq("transaction_id", id))).map((r) => r.tag_id);
  const splits = t.transaction_splits || [];
  const base = { id, date: t.date, description: t.description || "", notes: t.notes || "", tags };
  if (t.kind === "transfer_out" || t.kind === "transfer_in") {
    const out = t.kind === "transfer_out";
    return openEntry({ ...base, kind: "transfer",
      account: out ? t.account_id : t.peer?.account_id, toAccount: out ? t.peer?.account_id : t.account_id,
      cents: Math.round(Math.abs(out ? t.amount : t.peer?.amount) * 100),
      toCents: Math.round(Math.abs(out ? t.peer?.amount : t.amount) * 100) });
  }
  let readOnly = null;
  if (!["expense", "income"].includes(t.kind)) readOnly = "Este tipo de lançamento veio do MoneyWiz e por enquanto só pode ser apagado.";
  else if (splits.some((x) => Math.sign(x.amount) !== Math.sign(t.amount)))
    readOnly = "Esta divisão mistura entradas e saídas (veio do MoneyWiz) e por enquanto só pode ser apagada.";
  openEntry({ ...base, kind: t.kind === "income" ? "income" : "expense", account: t.account_id,
    cents: Math.round(Math.abs(t.amount) * 100), payee: state.payeeById.get(t.payee_id)?.name || "",
    category: splits.length === 1 ? splits[0].category_id : null,
    splits: splits.length > 1 ? splitsFrom(splits) : null, readOnly });
}

function openScheduled(id) {
  const s = state.scheduled.find((x) => x.id === id);
  if (!s) return;
  const fromIsAccount = !(s.kind === "transfer" && s.amount > 0);
  const splits = s.scheduled_splits || [];
  const next = nextOcc(s);
  openEntry({ kind: s.kind, scheduled: s.id, date: next.date, cents: Math.round(Math.abs(next.amount) * 100),
    tags: (s.scheduled_tags || []).map((x) => x.tag_id),
    account: fromIsAccount ? s.account_id : s.recipient_account_id,
    toAccount: fromIsAccount ? s.recipient_account_id : s.account_id,
    payee: state.payeeById.get(s.payee_id)?.name || "", description: s.description || "",
    category: splits.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]?.category_id || null,
    multiSplit: splits.length > 1 ? splits.length : 0 });
}

async function editScheduled(id) {
  const s = state.scheduled.find((x) => x.id === id);
  if (!s) return;
  const upcoming = s.repeatable ? (await must(sb.rpc("scheduled_occurrences",
    { p_from: "2000-01-01", p_to: addDays(today(), 3 * 366), p_scheduled: id }))).slice(0, 12) : [];
  const fromIsAccount = !(s.kind === "transfer" && s.amount > 0);
  const splits = s.scheduled_splits || [];
  const { done, total } = schedProgress(s);
  openEntry({ kind: s.kind, schedEdit: true, schedId: s.id, date: s.next_date, cents: Math.round(Math.abs(s.amount) * 100),
    account: fromIsAccount ? s.account_id : s.recipient_account_id,
    toAccount: fromIsAccount ? s.recipient_account_id : s.account_id,
    payee: state.payeeById.get(s.payee_id)?.name || "", description: s.description || "",
    category: splits.length === 1 ? splits[0].category_id : null, splits: splits.length > 1 ? splitsFrom(splits) : null,
    repeat: s.repeatable ? `${s.interval_unit}:${s.interval_count}` : "none", total, done, upcoming,
    tags: (s.scheduled_tags || []).map((x) => x.tag_id) });
}

// Eventos ----------------------------------------------------------------------

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-go],[data-action]");
  if (!el) {
    const sg = document.getElementById("suggest");
    if (sg && !ev.target.closest(".field")) sg.hidden = true;
    return;
  }
  if (el.dataset.go) return go(el.dataset.go);
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case "new": return openEntry();
    case "close": return closeSheet();
    case "save": el.disabled = true; try { await saveEntry(); } finally { el.disabled = false; } return;
    case "kind":
      readEntryFields();
      entry.kind = el.dataset.kind;
      if (!entry.id && !entry.schedId) entry.account = store("mc.last." + entry.kind) || entry.account;
      if (entry.category && state.catById.get(entry.category)?.kind !== entry.kind) entry.category = null;
      entry.splits?.forEach((x) => { if (x.category && state.catById.get(x.category)?.kind !== entry.kind) x.category = null; });
      return drawEntry();
    case "pick-cat":
      entry.splitIdx = el.dataset.i !== undefined ? Number(el.dataset.i) : null;
      return openCategoryPicker();
    case "split-start":
      // a categoria atual vira a primeira parte, com o valor todo; a segunda já pede a categoria
      entry.splits = [{ category: entry.category, cents: entry.cents }, { category: null, cents: 0 }];
      entry.category = null; entry.categoryTouched = true; entry.splitIdx = entry.splits[0].category ? 1 : 0;
      return openCategoryPicker();
    case "split-add":
      readEntryFields();
      entry.splits.push({ category: null, cents: Math.max(0, splitRest(entry)) });
      entry.splitIdx = entry.splits.length - 1;
      return openCategoryPicker();
    case "split-del": {
      readEntryFields();
      entry.splits.splice(Number(el.dataset.i), 1);
      if (entry.splits.length === 1) { entry.category = entry.splits[0].category; entry.splits = null; }
      return drawEntry();
    }
    case "pick-tags": return openTagPicker();
    case "new-tag": {
      const tag = await must(sb.from("tags").insert({ name: el.dataset.name }).select("id,name").single());
      setTags([...state.tags, tag]);
      entry.tags.push(tag.id);
      document.getElementById("tag-search").value = "";
      return entry.redrawTags();
    }
    case "set-cat":
      if (entry.splitIdx !== null) entry.splits[entry.splitIdx].category = id;
      else entry.category = id;
      entry.categoryTouched = true; entry.splitIdx = null;
      return drawEntry();
    case "back-entry": entry.splitIdx = null; return drawEntry();
    case "payee": return choosePayee(state.payeeById.get(id));
    case "delete":
      if (!confirm("Apagar este lançamento?")) return;
      await must(sb.rpc("delete_entry", { p_id: entry.id }));
      closeSheet(); toast("Lançamento apagado"); return afterChange(false);
    case "skip-sched":
      if (!confirm("Pular esta ocorrência sem lançar?")) return;
      await must(sb.rpc("skip_scheduled", { p_id: entry.scheduled }));
      closeSheet(); toast("Ocorrência pulada"); return afterChange(true);
    case "confirm-sched": return openScheduled(id);
    case "edit-sched": return editScheduled(id);
    case "new-sched": return openEntry({ schedEdit: true });
    case "end-sched":
      if (!confirm("Encerrar este agendado? Ele sai da lista; o que já foi lançado continua no extrato.")) return;
      await must(sb.rpc("end_scheduled", { p_id: entry.schedId }));
      closeSheet(); toast("Agendado encerrado"); return afterChange(true);
    case "edit-tx": return openTransaction(id);
    case "occ": return openOccurrence(id, el.dataset.date);
    case "occ-save": {
      const date = document.getElementById("occ-date").value || occ.occDate;
      if (occ.cents <= 0) return toast("Informe o valor");
      el.disabled = true;
      try { await saveOccurrence({ p_amount: occ.cents / 100, p_date: date }); } finally { el.disabled = false; }
      return toast("Alterado só nesta data");
    }
    case "occ-reset": await saveOccurrence({}); return toast("Data voltou ao que está na série");
    case "occ-skip":
      if (!confirm("Pular esta data? As outras ocorrências continuam.")) return;
      await saveOccurrence({ p_skip: true }); return toast("Data pulada");
    case "occ-dup": return duplicateScheduled(occ.s, document.getElementById("occ-date").value || occ.date, occ.cents);
    case "occ-series": { const sid = occ.s.id; closeSheet(); return editScheduled(sid); }
    case "dup-sched": { const s = state.scheduled.find((x) => x.id === entry.schedId); return duplicateScheduled(s, s.next_date, entry.cents); }
    case "fc-months": {
      const r = state.reports.find((x) => x.id === id);
      r.config = { ...r.config, months: Number(el.dataset.n) };
      await must(sb.from("reports").update({ config: r.config }).eq("id", id));
      return route();
    }
    case "sched-mode":
      state.schedMode = el.dataset.n; store("schedMode", el.dataset.n);
      return viewScheduled();
    case "cal-day":
      state.calDay = el.dataset.date;
      if (el.dataset.date.slice(0, 7) !== state.calMonth) state.calMonth = el.dataset.date.slice(0, 7);
      return drawCalendar();
    case "cal-month": return calMove(Number(el.dataset.step));
    case "cal-today": state.calMonth = today().slice(0, 7); state.calDay = today(); return drawCalendar();
    case "report-new": return openReportEditor(null);
    case "report-edit": return openReportEditor(state.reports.find((x) => x.id === id));
    case "report-save": el.disabled = true; try { await saveReport(); } finally { el.disabled = false; } return;
    case "rep-type":
      readReportFields();
      rep.type = el.dataset.n;
      rep.months = rep.type === "cards" ? 12 : 3;
      // relatório novo: resumos e "por mês" começam com todas as contas; patrimônio, com as que
      // contam no patrimônio; previsão e faturas, sem nenhuma
      rep.accounts = new Set(["summary", "monthly"].includes(rep.type) ? state.accounts.map((a) => a.id)
        : rep.type === "networth" ? state.accounts.filter((a) => a.include_in_net_worth).map((a) => a.id) : []);
      if (rep.type === "networth") {
        const y = new Date().getFullYear();
        Object.assign(rep, { from: `${y - 2}-01-01`, to: `${y + 15}-12-31` });
      }
      if (rep.type === "monthly" && !MONTHLY_PERIODS.some(([v]) => v === rep.period)) rep.period = "last_12";
      if (rep.type === "summary" && !SUMMARY_PERIODS.some(([v]) => v === rep.period)) rep.period = "this_month";
      return drawReportEditor();
    case "rep-accounts": return openRepAccounts();
    case "rep-categories": return openRepCategories();
    case "rep-tags": return openRepTags();
    case "rep-back": rep.sheet = null; return drawReportEditor();
    case "rep-all": {
      const on = el.dataset.n === "1";
      document.querySelectorAll("[data-rep-item]").forEach((b) => { if (b.checked !== on) repToggle(b.dataset.repItem, on); });
      return;
    }
    case "report-dup":
      readReportFields();
      rep = { ...rep, id: null, name: `${rep.name} (cópia)`, accounts: new Set(rep.accounts), categories: rep.categories && new Set(rep.categories), tags: rep.tags && new Set(rep.tags) };
      return drawReportEditor();
    case "report-delete": {
      if (!confirm(`Apagar o relatório "${rep.name}"? Os lançamentos não mudam.`)) return;
      await must(sb.from("reports").delete().eq("id", rep.id));
      closeSheet(); toast("Relatório apagado");
      return go("#/relatorios");
    }
    case "check-invoice": return openInvoiceCheck(id, el.dataset.month);
    case "check-balance": return openBalanceCheck(id);
    case "check-save": el.disabled = true; try { await saveCheck(); } finally { el.disabled = false; } return;
    case "card-months": {
      const r = state.reports.find((x) => x.id === id);
      r.config = { ...r.config, months: el.dataset.n === "year" ? "year" : Number(el.dataset.n) };
      await must(sb.from("reports").update({ config: r.config }).eq("id", id));
      return route();
    }
    case "bar-month": {
      const row = document.getElementById("mes-" + el.dataset.month);
      if (row?.nextElementSibling.hidden) row.click();
      return row?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    case "more": return pageLoader?.();
    case "toggle-archived": state.showArchived = !state.showArchived; return viewAccounts();
    case "toggle-later": state.showLater = !state.showLater; return drawScheduled();
    case "reload": await loadAll(); toast("Dados atualizados"); return route();
    case "budget-month": {
      const [y, m] = state.budgetMonth.split("-").map(Number);
      const d = new Date(y, m - 1 + Number(el.dataset.step), 1);
      state.budgetMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
      return viewBudget();
    }
    case "budget-export": {
      const [y, m] = state.budgetMonth.split("-").map(Number);
      return downloadFile(`${MONTHS[m - 1]} ${y}.csv`, budgetCsv(state.budgetRows));
    }
    case "report-export": return downloadFile(state.reportFile, budgetCsv(state.reportRows));
    case "toggle-sub": { const sub = el.nextElementSibling; sub.hidden = !sub.hidden; el.classList.toggle("open", !sub.hidden); return; }
    case "toggle-budget-accounts": state.showBudgetAccounts = !state.showBudgetAccounts; return viewBudget();
    case "logout": await sb.auth.signOut(); return;
    case "bio-toggle":
      if (lockCred()) {
        if (!confirm("Desativar o Face ID / Touch ID neste aparelho? O app vai pedir a senha ao abrir.")) return;
        try { localStorage.removeItem(LOCK_KEY); } catch {}
        toast("Desbloqueio com Face ID / Touch ID desativado");
      } else {
        if (!(await bioAvailable())) return toast("Este aparelho não oferece Face ID ou Touch ID para o app");
        try { await enrollBio(); toast("Pronto: o app vai desbloquear com Face ID / Touch ID"); }
        catch { toast("Não foi possível ativar agora"); }
      }
      return viewMore();
  }
});

document.addEventListener("change", (ev) => {
  const id = ev.target.dataset?.repItem;
  if (id && rep) repToggle(id, ev.target.checked);
  if (chk && ev.target.id === "check-negative") { chk.negative = ev.target.checked; document.getElementById("check-result").innerHTML = checkResult(); }
  if (chk && ev.target.id === "check-date" && ev.target.value) {
    chk.ref = ev.target.value;
    loadBalanceAt().then(() => { if (chk) drawCheck(); });
  }
  // trocar o que o relatório mostra muda os campos (transferências não têm categoria)
  if (ev.target.id === "rep-measure" && rep) { readReportFields(); drawReportEditor(); }
});

document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "check-amount" && chk) {
    chk.cents = Math.min(Number(t.value.replace(/\D/g, "") || 0), 99999999999);
    t.value = chk.cents ? centsToText(chk.cents) : "";
    document.getElementById("check-result").innerHTML = checkResult();
    return;
  }
  if (t.id === "occ-amount" && occ) {
    occ.cents = Math.min(Number(t.value.replace(/\D/g, "") || 0), 99999999999);
    t.value = centsToText(occ.cents);
    return;
  }
  if (!entry) return;
  if (t.id === "amount" || t.id === "toAmount") {
    const cents = Math.min(Number(t.value.replace(/\D/g, "") || 0), 99999999999);
    entry[t.id === "amount" ? "cents" : "toCents"] = cents;
    t.value = centsToText(cents);
    if (entry.splits && t.id === "amount") document.getElementById("split-sum").innerHTML = splitSumText(entry);
  } else if (t.classList.contains("split-amount")) {
    const cents = Math.min(Number(t.value.replace(/\D/g, "") || 0), 99999999999);
    entry.splits[Number(t.dataset.i)].cents = cents;
    t.value = centsToText(cents);
    document.getElementById("split-sum").innerHTML = splitSumText(entry);
  } else if (t.id === "payee") {
    entry.payee = t.value;
    const box = document.getElementById("suggest");
    const list = payeeSuggestions(t.value);
    box.innerHTML = list.map((p) => `<button data-action="payee" data-id="${p.id}">${esc(p.name)}${p.default_category_id ? `<small>${esc(catLabel(p.default_category_id))}</small>` : ""}</button>`).join("");
    box.hidden = !list.length;
  }
});

document.addEventListener("change", async (ev) => {
  const budgetAcc = ev.target.dataset?.budgetAccount;
  if (budgetAcc) {
    const on = ev.target.checked;
    await must(sb.from("accounts").update({ in_budget: on }).eq("id", budgetAcc));
    state.accById.get(budgetAcc).in_budget = on;
    return viewBudget();
  }
  if (!entry) return;
  const tag = ev.target.dataset?.tag;
  if (tag) {
    entry.tags = ev.target.checked ? [...entry.tags, tag] : entry.tags.filter((x) => x !== tag);
    return;
  }
  if (["account", "toAccount", "repeat"].includes(ev.target.id)) { readEntryFields(); drawEntry(); }
});

// Rotas ------------------------------------------------------------------------

let pageLoader = null;

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  if (!state.session) return;
  pageLoader = null;
  const [, name, arg] = (location.hash || "#/contas").split("/");
  window.scrollTo(0, 0);
  switch (name) {
    case "conta": return viewAccount(arg);
    case "agendados": return viewScheduled();
    case "recentes": return viewRecent();
    case "mais": return viewMore();
    case "orcamento": return viewBudget();
    case "relatorios": return viewReports();
    case "relatorio": return viewReport(arg);
    default: return viewAccounts();
  }
}
window.addEventListener("hashchange", route);

// Bloqueio ----------------------------------------------------------------------
// Com a sessão guardada no aparelho, o app abre bloqueado e pede Face ID / Touch ID (uma chave
// WebAuthn do próprio aparelho) ou a senha, e volta a bloquear depois de 5 minutos fora.
// É uma tranca local: protege de quem pega o aparelho; a sessão continua guardada no navegador.

const LOCK_AFTER = 5 * 60 * 1000;
const LOCK_KEY = "mc-lock-cred"; // id da chave do aparelho, em base64url
let unlocked = false, hiddenAt = 0, bioOffered = false;
const lockCred = () => { try { return localStorage.getItem(LOCK_KEY); } catch { return null; } };
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function bioAvailable() {
  try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

async function enrollBio() {
  const u = state.session.user;
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "MoneyCau" },
    user: { id: new TextEncoder().encode(u.id), name: u.email, displayName: u.email },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
    timeout: 60000,
  } });
  localStorage.setItem(LOCK_KEY, b64url(cred.rawId));
}

async function verifyBio() {
  await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: "public-key", id: fromB64url(lockCred()) }],
    userVerification: "required",
    timeout: 60000,
  } });
}

function unlock() {
  unlocked = true;
  start(state.session);
}

function viewLock(message = "") {
  closeSheet();
  const bio = !!lockCred();
  $app.innerHTML = `<form class="login" id="unlock">
    <h1>MoneyCau</h1><p>${bio ? "Desbloqueie para ver suas finanças." : "Digite sua senha para desbloquear."}</p>
    ${bio ? '<button class="primary" type="button" id="bio">Desbloquear com Face ID / Touch ID</button><p class="or">ou use a senha</p>' : ""}
    <input id="email" type="email" autocomplete="username" value="${esc(state.session.user.email)}" readonly hidden>
    <input id="password" type="password" autocomplete="current-password" placeholder="Senha" required>
    <div class="error">${esc(message)}</div>
    <button class="${bio ? "secondary" : "primary"}" type="submit">Desbloquear com a senha</button>
    <button class="link" type="button" id="lock-out">Sair desta conta</button></form>`;
  document.getElementById("bio")?.addEventListener("click", async () => {
    try { await verifyBio(); unlock(); }
    catch { viewLock("Não foi possível confirmar. Tente de novo ou use a senha."); }
  });
  document.getElementById("unlock").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    ev.target.querySelector("[type=submit]").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: state.session.user.email, password: document.getElementById("password").value });
    if (error) return viewLock(error.message === "Invalid login credentials" ? "Senha incorreta." : error.message);
    unlock();
  });
  document.getElementById("lock-out").addEventListener("click", () => sb.auth.signOut());
}

// Depois de entrar com a senha, oferece o Face ID / Touch ID uma vez por abertura do app.
function viewBioOffer() {
  bioOffered = true;
  $app.innerHTML = `<div class="login">
    <h1>Desbloqueio rápido</h1>
    <p>Quer usar o Face ID (iPhone) ou o Touch ID (Mac) para abrir o MoneyCau, em vez de digitar a senha?</p>
    <button class="primary" type="button" id="bio-yes">Usar Face ID / Touch ID</button>
    <button class="link" type="button" id="bio-no">Agora não</button></div>`;
  document.getElementById("bio-yes").addEventListener("click", async () => {
    try { await enrollBio(); toast("Pronto: da próxima vez, use o Face ID / Touch ID"); }
    catch { toast("Não foi possível ativar agora. Dá para ativar depois em Mais."); }
    start(state.session);
  });
  document.getElementById("bio-no").addEventListener("click", () => start(state.session));
}

// Voltar ao app depois de 5 minutos fora bloqueia de novo.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (unlocked && state.session && !recovering && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER) {
    unlocked = false;
    viewLock();
  }
});

// Login --------------------------------------------------------------------------

function viewLogin(message = "") {
  $app.innerHTML = `<form class="login" id="login">
    <h1>MoneyCau</h1><p>Entre para ver suas finanças.</p>
    <input id="email" type="email" autocomplete="username" placeholder="E-mail" required>
    <input id="password" type="password" autocomplete="current-password" placeholder="Senha" required>
    <div class="error">${esc(message)}</div>
    <button class="primary" type="submit">Entrar</button>
    <button class="link" type="button" id="forgot">Esqueci minha senha</button></form>`;
  document.getElementById("login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    unlocked = true; // acabou de digitar a senha: não pede de novo
    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById("email").value.trim(),
      password: document.getElementById("password").value,
    });
    btn.disabled = false;
    if (error) unlocked = false;
    if (error) viewLogin(error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message);
  });
  document.getElementById("forgot").addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    if (!email) return viewLogin("Digite seu e-mail e toque de novo em Esqueci minha senha.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    viewLogin(error ? error.message : "Enviamos um link para o seu e-mail. Abra o link neste aparelho para criar a nova senha.");
  });
}

function viewNewPassword(message = "") {
  $app.innerHTML = `<form class="login" id="newpass">
    <h1>Nova senha</h1><p>Escolha a senha que você vai usar para entrar.</p>
    <input id="password" type="password" autocomplete="new-password" placeholder="Nova senha (mínimo 6 caracteres)" minlength="6" required>
    <input id="password2" type="password" autocomplete="new-password" placeholder="Repita a nova senha" minlength="6" required>
    <div class="error">${esc(message)}</div>
    <button class="primary" type="submit">Salvar senha</button></form>`;
  document.getElementById("newpass").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const password = document.getElementById("password").value;
    if (password !== document.getElementById("password2").value) return viewNewPassword("As duas senhas não são iguais.");
    ev.target.querySelector("button").disabled = true;
    const { error } = await sb.auth.updateUser({ password });
    if (error) return viewNewPassword(error.message);
    recovering = false;
    unlocked = true; // acabou de criar a senha
    history.replaceState(null, "", location.pathname);
    toast("Senha alterada.");
    start(state.session);
  });
}

async function start(session) {
  state.session = session;
  if (!session) { unlocked = false; closeSheet(); return viewLogin(linkError || ""); }
  if (recovering) return viewNewPassword();
  if (!unlocked) return viewLock();
  if (!lockCred() && !bioOffered && await bioAvailable()) return viewBioOffer();
  $app.innerHTML = '<div class="loading">Carregando…</div>';
  try {
    await loadAll();
    route();
  } catch (e) {
    $app.innerHTML = `<div class="loading">Não foi possível carregar os dados.<br><button class="more" onclick="location.reload()">Tentar de novo</button></div>`;
  }
}

// O Supabase recomenda não chamar o cliente dentro deste callback (pode travar),
// por isso o carregamento roda no próximo ciclo com setTimeout.
let started = false;
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    recovering = true;
    state.session = session;
    setTimeout(() => viewNewPassword(), 0);
  } else if (event === "INITIAL_SESSION" || event === "SIGNED_IN" && !started || event === "SIGNED_OUT") {
    started = !!session;
    setTimeout(() => start(session), 0);
  } else {
    state.session = session;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
