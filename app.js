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
  scheduled: [],
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
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/></svg>',
};

// Dados ------------------------------------------------------------------------

async function loadAll() {
  const [accounts, balances, categories, payees] = await Promise.all([
    must(sb.from("accounts").select("*").order("display_order")),
    must(sb.from("account_balances").select("*")),
    must(sb.from("categories").select("id,parent_id,name,kind,display_order").order("display_order")),
    must(sb.from("payee_usage").select("id,name,default_category_id,uses,last_used")
      .order("uses", { ascending: false }).range(0, 9999)),
  ]);
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
  state.scheduled = await must(sb.from("scheduled")
    .select("*, scheduled_splits(category_id, amount)")
    .eq("disabled", false).order("next_date").range(0, 999));
}

async function refreshBalances() {
  const balances = await must(sb.from("account_balances").select("*"));
  state.balances = new Map(balances.map((b) => [b.account_id, b]));
}

const dueCount = () => state.scheduled.filter((s) => s.next_date <= today()).length;

// Estrutura ----------------------------------------------------------------------

function tabbar(active) {
  const due = dueCount();
  const tab = (route, icon, label, extra = "") =>
    `<button class="tab ${active === route ? "on" : ""}" data-go="#/${route}">${ICONS[icon]}${extra}<span>${label}</span></button>`;
  return `<nav class="tabbar">
    ${tab("contas", "wallet", "Contas")}
    ${tab("agendados", "clock", "Agendados", due ? `<span class="dot">${due}</span>` : "")}
    <button class="fab" data-action="new" aria-label="Novo lançamento">+</button>
    ${tab("recentes", "list", "Recentes")}
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

const TX_SELECT = "id,kind,date,amount,description,notes,payee_id,account_id,transfer_peer_id," +
  "transaction_splits(category_id,amount),peer:transfer_peer_id(account_id,amount)";
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
  const rows = [];
  const draw = (hasMore) => {
    let running = Number(b.projected_balance || 0);
    const balances = rows.map((t) => { const r = running; running -= Number(t.amount); return r; });
    render(`<div class="topbar"><button class="back" data-go="#/contas">‹ Contas</button></div>
      <div class="hero"><div class="label">${esc(a.name)}</div>
        <div class="value ${signClass(b.current_balance)}">${money(b.current_balance, a.currency)}</div>
        <div class="sub">Previsto ${money(b.projected_balance, a.currency)}</div></div>
      ${rows.length ? groupByMonth(rows, (t, i) => txRow(t, { running: balances[i], currency: a.currency })) : '<div class="empty">Nenhum lançamento.</div>'}
      ${hasMore ? '<button class="more" data-action="more">Carregar mais</button>' : ""}`, "contas");
  };
  const loadPage = async () => {
    const page = await must(sb.from("transactions").select(TX_SELECT).eq("account_id", id)
      .order("date", { ascending: false }).order("created_at", { ascending: false })
      .range(rows.length, rows.length + PAGE - 1));
    page.forEach((t) => txCache.set(t.id, t));
    rows.push(...page);
    draw(page.length === PAGE);
  };
  pageLoader = loadPage;
  await loadPage();
}

// Tela: Recentes -----------------------------------------------------------------

async function viewRecent() {
  const rows = await must(sb.from("transactions").select(TX_SELECT)
    .lte("date", today()).neq("kind", "transfer_in")
    .order("date", { ascending: false }).order("created_at", { ascending: false }).range(0, PAGE - 1));
  rows.forEach((t) => txCache.set(t.id, t));
  render(`<div class="topbar"><h1>Recentes</h1></div>
    ${rows.length ? groupByMonth(rows, (t) => txRow(t, { withAccount: true, currency: state.accById.get(t.account_id)?.currency })) : '<div class="empty">Nenhum lançamento.</div>'}`,
    "recentes");
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

function scheduledRow(s) {
  const acc = state.accById.get(s.account_id);
  const to = s.kind === "transfer" ? state.accById.get(s.recipient_account_id) : null;
  const title = s.description || state.payeeById.get(s.payee_id)?.name || "(sem descrição)";
  const late = s.next_date < today();
  const meta = [dayLabel(s.next_date), (acc?.name || "sem conta") + (to ? " → " + to.name : "")].join(" · ");
  const parc = installment(s);
  return `<div class="row">
    <div class="main" data-action="edit-sched" data-id="${s.id}"><div class="title">${esc(title)}${parc ? `<span class="badge">${parc}</span>` : ""}${late ? '<span class="badge warn">vencido</span>' : ""}</div>
      <div class="meta">${esc(meta)}</div></div>
    <div class="amount ${signClass(s.amount)}">${money(s.amount, s.currency)}</div>
    <div class="actions"><button class="btn-ok" data-action="confirm-sched" data-id="${s.id}">Lançar</button></div>
  </div>`;
}

function viewScheduled() {
  const t = today(), in7 = addDays(t, 7), in30 = addDays(t, 30);
  const buckets = [
    ["Vencidos e hoje", (s) => s.next_date <= t],
    ["Próximos 7 dias", (s) => s.next_date > t && s.next_date <= in7],
    ["Próximos 30 dias", (s) => s.next_date > in7 && s.next_date <= in30],
  ];
  let html = `<div class="topbar"><h1>Agendados</h1><button class="back" data-action="new-sched">+ Novo</button></div>`;
  for (const [title, test] of buckets) {
    const list = state.scheduled.filter(test);
    if (list.length) html += `<div class="section-title"><span>${title}</span><span>${list.length}</span></div>
      <div class="list">${list.map(scheduledRow).join("")}</div>`;
  }
  const later = state.scheduled.filter((s) => s.next_date > in30);
  html += `<div class="section-title"><span>Depois (${later.length})</span>
    <button class="collapser" data-action="toggle-later">${state.showLater ? "Ocultar" : "Mostrar"}</button></div>`;
  if (state.showLater) html += `<div class="list">${later.map(scheduledRow).join("")}</div>`;
  if (!state.scheduled.length) html += '<div class="empty">Nenhum agendado ativo.</div>';
  render(html, "agendados");
}

// Tela: Mais ---------------------------------------------------------------------

function viewMore() {
  render(`<div class="topbar"><h1>Mais</h1></div>
    <div class="list">
      <div class="row"><div class="main"><div class="title">Conectado como</div>
        <div class="meta">${esc(state.session?.user?.email)}</div></div></div>
      <button class="row" data-action="reload"><div class="main"><div class="title">Atualizar dados</div></div></button>
    </div>
    <div class="section-title"><span>Em breve</span></div>
    <div class="list">
      <div class="row"><div class="main"><div class="title">Relatórios</div><div class="meta">Os 24 relatórios do MoneyWiz</div></div></div>
      <div class="row"><div class="main"><div class="title">Exportar para o Orçamento</div><div class="meta">CSV mensal</div></div></div>
    </div>
    <button class="danger" data-action="logout">Sair</button>`, "mais");
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
  };
  drawEntry();
  if (!entry.id && !entry.readOnly) setTimeout(() => document.getElementById("amount")?.focus(), 250);
}

function closeSheet() { $sheet.innerHTML = ""; entry = null; }

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
      ${e.schedEdit ? `<div class="field"><label>Repetição</label>
        <select id="repeat">${repeats.map(([v, l]) => `<option value="${v}" ${v === e.repeat ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      ${e.repeat !== "none" ? `<div class="field"><label>Parcelas</label>
        <input id="total" inputmode="numeric" autocomplete="off" value="${e.total ?? ""}" placeholder="Sem fim">
        ${e.done ? `<div class="hint">A próxima é a parcela ${e.done + 1}. Deixe em branco se não tiver fim.</div>`
          : '<div class="hint">Total de parcelas. Deixe em branco se não tiver fim.</div>'}</div>` : ""}` : ""}
    </div>
    ${e.id ? '<button class="danger" data-action="delete">Apagar lançamento</button>' : ""}
    ${e.scheduled ? '<button class="danger" data-action="skip-sched">Pular esta ocorrência</button>' : ""}
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
    await must(sb.rpc("save_scheduled", {
      p_id: e.schedId, p_kind: e.kind, p_account: e.account, p_amount: e.cents / 100, p_next_date: e.date,
      p_payee_name: e.kind === "transfer" ? null : e.payee || null,
      p_category: e.kind === "transfer" ? null : e.category,
      p_description: e.description || null,
      p_to_account: e.kind === "transfer" ? e.toAccount : null,
      p_repeatable: e.repeat !== "none", p_unit: unit, p_count: Number(count),
      p_total: e.repeat === "none" ? null : e.total,
    }));
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
  openEntry({ kind: s.kind, scheduled: s.id, date: s.next_date, cents: Math.round(Math.abs(s.amount) * 100),
    account: fromIsAccount ? s.account_id : s.recipient_account_id,
    toAccount: fromIsAccount ? s.recipient_account_id : s.account_id,
    payee: state.payeeById.get(s.payee_id)?.name || "", description: s.description || "",
    category: splits.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]?.category_id || null });
}

function editScheduled(id) {
  const s = state.scheduled.find((x) => x.id === id);
  if (!s) return;
  const fromIsAccount = !(s.kind === "transfer" && s.amount > 0);
  const splits = s.scheduled_splits || [];
  const { done, total } = schedProgress(s);
  openEntry({ kind: s.kind, schedEdit: true, schedId: s.id, date: s.next_date, cents: Math.round(Math.abs(s.amount) * 100),
    account: fromIsAccount ? s.account_id : s.recipient_account_id,
    toAccount: fromIsAccount ? s.recipient_account_id : s.account_id,
    payee: state.payeeById.get(s.payee_id)?.name || "", description: s.description || "",
    category: splits.length === 1 ? splits[0].category_id : null, multiSplit: splits.length > 1 ? splits.length : 0,
    repeat: s.repeatable ? `${s.interval_unit}:${s.interval_count}` : "none", total, done });
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
    case "more": return pageLoader?.();
    case "toggle-archived": state.showArchived = !state.showArchived; return viewAccounts();
    case "toggle-later": state.showLater = !state.showLater; return viewScheduled();
    case "reload": await loadAll(); toast("Dados atualizados"); return route();
    case "logout": await sb.auth.signOut(); return;
  }
});

document.addEventListener("input", (ev) => {
  const t = ev.target;
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

document.addEventListener("change", (ev) => {
  if (!entry) return;
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
