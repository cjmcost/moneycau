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
    must(sb.from("payee_usage").select("id,name,default_category_id,uses,last_used")
      .order("uses", { ascending: false }).range(0, 9999)),
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
      <div class="sub">Previsto ${money(b.projected_balance, a.currency)}</div></div>
    ${searchBox("Buscar nesta conta", lastQuery())}<div id="tx-list"></div>`, "contas");
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
  render(`<div class="topbar"><h1>Agendados</h1><button class="back" data-action="new-sched">+ Novo</button></div>
    ${searchBox("Buscar agendados", state.schedQuery)}<div id="sched-list"></div>`, "agendados");
  drawScheduled();
  onSearch((v) => { state.schedQuery = v; drawScheduled(); });
}

function drawScheduled() {
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

// Tela: Mais ---------------------------------------------------------------------

function viewMore() {
  render(`<div class="topbar"><h1>Mais</h1></div>
    <div class="list">
      <div class="row"><div class="main"><div class="title">Conectado como</div>
        <div class="meta">${esc(state.session?.user?.email)}</div></div></div>
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
// Por enquanto só os de resumo por categoria (config.type = "summary"); os outros
// relatórios do MoneyWiz aparecem na lista como "em breve".

function reportPeriod(cfg) {
  const d = new Date();
  const shift = { last_month: -1, this_month: 0, next_month: 1 }[cfg.period];
  if (shift === undefined) return { from: cfg.from, to: cfg.to };
  const first = new Date(d.getFullYear(), d.getMonth() + shift, 1);
  const from = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`;
  return { from, to: monthEnd(from) };
}

function periodLabel({ from, to }) {
  const [y, m] = from.split("-").map(Number);
  if (from.endsWith("-01") && to === monthEnd(from)) return `${MONTHS[m - 1]} ${y}`;
  return `${dayLabel(from)} ${from.slice(0, 4)} a ${dayLabel(to)} ${to.slice(0, 4)}`;
}

async function viewReports() {
  state.reports = await must(sb.from("reports").select("id,name,config,display_order").order("display_order").order("name"));
  const ready = state.reports.filter((r) => ["summary", "forecast"].includes(r.config?.type));
  const later = state.reports.filter((r) => !ready.includes(r));
  render(`<div class="topbar"><h1>Relatórios</h1></div>
    <div class="list">${ready.map((r) => `<button class="row" data-go="#/relatorio/${r.id}"><div class="main">
      <div class="title">${esc(r.name)}</div><div class="meta">${r.config.type === "forecast" ? `Previsão de saldo, ${forecastLabel(r.config)}` : periodLabel(reportPeriod(r.config))}</div></div><span class="chev">›</span></button>`).join("")}</div>
    <div class="section-title"><span>Em breve (${later.length})</span></div>
    <div class="list">${later.map((r) => `<div class="row"><div class="main"><div class="title muted">${esc(r.name)}</div></div></div>`).join("")}</div>`, "relatorios");
}

async function viewReport(id) {
  if (!state.reports) state.reports = await must(sb.from("reports").select("id,name,config,display_order"));
  const r = state.reports.find((x) => x.id === id);
  if (r?.config?.type === "forecast") return viewForecast(r);
  if (!r || r.config?.type !== "summary") return go("#/relatorios");
  const period = reportPeriod(r.config);
  const rows = groupLines(await must(sb.rpc("report_lines", {
    p_from: period.from, p_to: period.to, p_accounts: r.config.accounts,
    p_categories: r.config.categories, p_scheduled: r.config.scheduled })));
  state.reportRows = rows;
  state.reportFile = `${periodLabel(period)}.csv`;
  render(`<div class="topbar"><button class="back" data-go="#/relatorios">‹ Relatórios</button></div>
    <div class="topbar"><h1>${esc(r.name)}</h1></div>
    <div class="meta-line">${periodLabel(period)} · ${r.config.accounts.length} conta${r.config.accounts.length === 1 ? "" : "s"}</div>
    ${summaryHero(rows, r.config.scheduled && period.to >= today())}
    ${summarySections(rows)}
    ${rows.length ? `<button class="more" data-action="report-export">Exportar CSV</button>` : ""}`, "relatorios");
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
    <div class="amount ${signClass(amount)}">${money(amount, s.currency)}<small>${money(running)}</small></div>
  </button>`;
}

function forecastChart(start, items, to) {
  const t0 = parseDate(today());
  const day = (iso) => Math.max(0, Math.round((parseDate(iso) - t0) / 864e5));
  const days = Math.max(1, day(to));
  const pts = [[0, start]];
  items.forEach((it) => pts.push([day(it.date), it.balance]));
  pts.push([days, items.length ? items[items.length - 1].balance : start]);
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals) || 1;
  const W = 340, H = 130, top = 14;
  const X = (x) => ((x / days) * W).toFixed(1), Y = (v) => (top + ((hi - v) / (hi - lo)) * (H - top - 4)).toFixed(1);
  const line = `M0,${Y(start)}` + pts.map(([x, v]) => `H${X(x)}V${Y(v)}`).join("");
  let ticks = "";
  for (let m = new Date(t0.getFullYear(), t0.getMonth() + 1, 1); day(`${m.getFullYear()}-${pad(m.getMonth() + 1)}-01`) < days; m.setMonth(m.getMonth() + 1)) {
    const x = X(day(`${m.getFullYear()}-${pad(m.getMonth() + 1)}-01`));
    ticks += `<line class="tick" x1="${x}" x2="${x}" y1="${top}" y2="${H}"/><text x="${x}" y="${H + 12}" text-anchor="middle">${MONTHS[m.getMonth()].slice(0, 3).toLowerCase()}</text>`;
  }
  return `<div class="chart"><svg viewBox="0 -2 ${W} ${H + 16}" role="img" aria-label="Saldo previsto">
    ${ticks}
    ${lo < 0 ? `<line class="zero" x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}"/>` : ""}
    <path class="area" d="${line}V${Y(lo < 0 ? 0 : lo)}H0Z"/><path class="line" d="${line}"/>
    <text x="2" y="9">${money(Math.max(...vals))}</text>
    <text x="2" y="${H - 6}">${money(Math.min(...vals))}</text>
  </svg></div>`;
}

async function viewForecast(r) {
  const accs = r.config.accounts, inSet = new Set(accs), to = forecastEnd(r.config), multi = accs.length > 1;
  const [txs, occs] = await Promise.all([
    must(sb.from("transactions").select(TX_SELECT).in("account_id", accs).gt("date", today()).lte("date", to)
      .order("date").order("created_at").range(0, 4999)),
    must(sb.rpc("scheduled_occurrences", { p_from: "2000-01-01", p_to: to })),
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
    <div class="topbar"><h1>${esc(r.name)}</h1></div>
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
    category: splits[0]?.category_id || null });
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
    categoryTouched: !!init.category || !!init.multiSplit,
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
    multiSplit: init.multiSplit || 0,
    upcoming: init.upcoming || null, // próximas ocorrências, na edição de um agendado
  };
  drawEntry();
  if (!entry.id && !entry.readOnly) setTimeout(() => document.getElementById("amount")?.focus(), 250);
}

function closeSheet() { $sheet.innerHTML = ""; entry = null; occ = null; }

function drawEntry() {
  const e = entry;
  const from = state.accById.get(e.account);
  const to = state.accById.get(e.toAccount);
  const fx = e.kind === "transfer" && from && to && from.currency !== to.currency;
  const title = e.scheduled ? "Lançar agendado" : e.schedEdit ? (e.schedId ? "Editar agendado" : "Novo agendado")
    : e.id ? "Editar lançamento" : "Novo lançamento";
  const cat = e.category ? esc(catLabel(e.category))
    : e.multiSplit ? `${e.multiSplit} categorias (mantidas)` : "Escolher";
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
      <div class="field"><label>Categoria</label>
        <button class="picker ${e.category ? "" : "placeholder"}" data-action="pick-cat" ${lock}>${cat}</button></div>` : ""}
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
  if (!entry.categoryTouched && p.default_category_id) {
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
      p_total: e.repeat === "none" ? null : e.total,
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
      p_to_amount: fx ? e.toCents / 100 : null, p_tags: e.tags,
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
  tasks.push(must(sb.from("payee_usage").select("id,name,default_category_id,uses,last_used")
    .order("uses", { ascending: false }).range(0, 9999)).then((p) => {
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
  else if (splits.length > 1) readOnly = `Lançamento dividido em ${splits.length} categorias. A edição de divisões chega numa próxima versão; por ora ele só pode ser apagado.`;
  openEntry({ ...base, kind: t.kind === "income" ? "income" : "expense", account: t.account_id,
    cents: Math.round(Math.abs(t.amount) * 100), payee: state.payeeById.get(t.payee_id)?.name || "",
    category: splits[0]?.category_id || null, readOnly });
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
    category: splits.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]?.category_id || null });
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
    category: splits.length === 1 ? splits[0].category_id : null, multiSplit: splits.length > 1 ? splits.length : 0,
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
      return drawEntry();
    case "pick-cat": return openCategoryPicker();
    case "pick-tags": return openTagPicker();
    case "new-tag": {
      const tag = await must(sb.from("tags").insert({ name: el.dataset.name }).select("id,name").single());
      setTags([...state.tags, tag]);
      entry.tags.push(tag.id);
      document.getElementById("tag-search").value = "";
      return entry.redrawTags();
    }
    case "set-cat": entry.category = id; entry.categoryTouched = true; return drawEntry();
    case "back-entry": return drawEntry();
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
  }
});

document.addEventListener("input", (ev) => {
  const t = ev.target;
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
    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById("email").value.trim(),
      password: document.getElementById("password").value,
    });
    btn.disabled = false;
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
    history.replaceState(null, "", location.pathname);
    toast("Senha alterada.");
    start(state.session);
  });
}

async function start(session) {
  state.session = session;
  if (!session) { closeSheet(); return viewLogin(linkError || ""); }
  if (recovering) return viewNewPassword();
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
