/* نظام متابعة عملاء توتال — إعداد وتصميم: رامي هادي رياني © 2026 */
(() => {
"use strict";
const CFG = window.TOTAL_CRM_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
});

const STAGES = ["جديد","مهتم","قيد المتابعة","تم تقديم عرض","تم التعاقد","معتذر","متوقف"];
const CLOSED = new Set(["تم التعاقد","معتذر","متوقف"]);
const TYPES = ["اتصال","واتساب","اجتماع","معاينة","عرض سعر","بريد","ملاحظة"];
const SOURCES = ["من خلال الشركة","من خلال الموظف"];
const PR = {"عالية":0,"متوسطة":1,"منخفضة":2,"":3};

const LOST = new Set(["معتذر","متوقف"]);
const LOST_REASONS = ["السعر مرتفع","تعاقد مع شركة أخرى","يفضّل الإدارة الفردية","لا يرغب في التغيير حالياً","عقد حالي طويل","لا يوجد رد","قرار الملاك/الجمعية","أخرى"];
const Q_STATUS = ["مسودة","مُرسل","قيد التفاوض","مقبول","مرفوض"];
const Q_OPEN = new Set(["مُرسل","قيد التفاوض"]);
const FILE_KINDS = ["عرض سعر","عقد","صورة الموقع","أخرى"];
const CITY = { "الرياض": "RUH", "جدة": "JED", "الدمام": "DMM", "الخبر": "KHB", "الظهران": "DHA", "مكة": "MKK", "المدينة": "MED", "الجبيل": "JUB", "القطيف": "QTF", "الأحساء": "HSA" };

let me = null, profile = null, deals = [], acts = [], people = {}, grants = [], quotes = [], insps = [], files = [],
    tab = "queue", openId = null, dtab = "main", confirmDel = false, booted = false, dupOk = false;
const isAdmin = () => !!profile && profile.role === "admin";
// مستوى صلاحيتي على عميل: 2 تعديل، 1 قراءة فقط. قاعدة البيانات تفرض نفس القاعدة، وهذا لعرض الشاشة فقط.
function levelOf(d){
  if (isAdmin() || d.ownerId === me.id) return 2;
  return grants.filter(g => g.grantee === me.id && (g.owner_id === d.ownerId || g.owner_id === null))
               .reduce((m, g) => Math.max(m, g.level === "edit" ? 2 : 1), 0) || 1;
}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const iso = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const todayISO = () => iso(new Date());
const addDays = (s,n) => { const d = new Date(s+"T00:00:00"); d.setDate(d.getDate()+n); return iso(d); };
let T = todayISO();
const redirectURL = () => location.origin + location.pathname;
const daysTo = s => Math.round((new Date(s + "T00:00:00") - new Date(T + "T00:00:00")) / 86400000);
const money = v => v === null || v === undefined || v === "" ? "—" : new Intl.NumberFormat("ar-SA-u-nu-latn", { maximumFractionDigits: 0 }).format(Number(v)) + " ر.س";
const kb = n => !n ? "" : n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " ك.ب" : (n / 1048576).toFixed(1) + " م.ب";
// رقم سعودي بصيغة دولية للاتصال والواتساب: 05xxxxxxxx أو 5xxxxxxxx أو 00966… ← 9665xxxxxxxx
function intlNum(p){
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "966" + d.slice(1);
  else if (d.length === 9 && d.startsWith("5")) d = "966" + d;
  return d.length >= 11 && d.length <= 15 ? d : "";
}
// تنبيه تجديد العقد: 90 / 60 / 30 يوماً قبل الانتهاء، ويبقى 30 يوماً بعده
function renewal(d){
  if (!d.contractEnd) return null;
  const n = daysTo(d.contractEnd);
  if (n < -30 || n > 90) return null;
  return { n, k: n <= 30 ? "due" : n <= 60 ? "soon" : "ok",
    t: n < 0 ? `انتهى العقد منذ ${-n} يوم` : n === 0 ? "العقد ينتهي اليوم" : `العقد ينتهي بعد ${n} يوم` };
}

function show(view){ ["authView","pendingView","mfaView","newPassView","appView"].forEach(v => $("#"+v).hidden = v !== view); }

// يمنع عرض التطبيق داخل موقع آخر (حماية من خداع النقرات)
if (window.top !== window.self) { document.documentElement.innerHTML = ""; throw new Error("framed"); }

/* ================= الخروج التلقائي ================= */
const IDLE_MIN = 30, IDLE_KEY = "tcrm_last_active";
const markActive = () => { try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch (_) {} };
const lastActive = () => { try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch (_) { return 0; } };
const idleExpired = () => { const t = lastActive(); return t && Date.now() - t > IDLE_MIN * 60000; };
let lastMark = 0;
["click","keydown","touchstart","scroll"].forEach(ev => document.addEventListener(ev, () => {
  if (Date.now() - lastMark > 15000) { lastMark = Date.now(); markActive(); }
}, { passive: true }));
setInterval(async () => {
  if (booted && idleExpired()) { await sb.auth.signOut(); location.replace(redirectURL() + "#timeout"); }
}, 60000);
function setSt(el, msg, err){ el.className = "status" + (err ? " err" : ""); el.textContent = msg || ""; }
function errMsg(e){
  const m = (e && (e.message || e.error_description)) || "";
  if (/signup_not_invited|Database error saving new user/i.test(m)) return "هذا البريد غير مدعو. اطلب من مدير النظام إضافة بريدك أولاً، ثم سجّل بنفس البريد.";
  if (/Invalid TOTP|invalid.*code|expired/i.test(m) && /totp|code|mfa|factor/i.test(m)) return "الرمز غير صحيح أو انتهت صلاحيته. اكتب الرمز الحالي من التطبيق.";
  if (/Invalid login credentials/i.test(m)) return "البريد أو كلمة المرور غير صحيحة.";
  if (/Email not confirmed/i.test(m)) return "أكّد بريدك أولاً من الرسالة التي وصلتك، ثم سجّل الدخول.";
  if (/already registered|already been registered/i.test(m)) return "هذا البريد مسجّل مسبقاً. سجّل الدخول أو استخدم (نسيت كلمة المرور).";
  if (/rate limit|too many/i.test(m)) return "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.";
  if (/Password should be/i.test(m)) return "كلمة المرور قصيرة. استخدم 8 أحرف على الأقل.";
  if (/network|fetch/i.test(m)) return "تعذّر الاتصال بالخادم. تحقّق من الإنترنت.";
  if (/row-level security|permission|Unauthorized/i.test(m)) return "ليست لديك صلاحية لهذا الإجراء.";
  if (/file_too_big|exceeded the maximum|Payload too large/i.test(m)) return "الملف أكبر من 15 ميغابايت. صغّر حجمه ثم أعد المحاولة.";
  if (/mime type|not supported|invalid_mime/i.test(m)) return "نوع الملف غير مسموح. المسموح: PDF والصور وملفات Word وExcel.";
  return "حدث خطأ: " + m;
}

/* ================= الدخول ================= */
let authMode = "login";
function setAuthMode(m){
  authMode = m;
  $("#authTitle").textContent = m === "signup" ? "حساب جديد" : m === "reset" ? "استعادة كلمة المرور" : "تسجيل الدخول";
  $("#authBtn").textContent = m === "signup" ? "إنشاء الحساب" : m === "reset" ? "أرسل رابط الاستعادة" : "دخول";
  $("#fName").hidden = m !== "signup";
  $("#fPass").hidden = m === "reset";
  $("#aPass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("#toSignup").hidden = m !== "login"; $("#toReset").hidden = m !== "login"; $("#toLogin").hidden = m === "login";
  setSt($("#authSt"), m === "signup" ? "التسجيل بدعوة فقط: استخدم البريد الذي أضافه مدير النظام." : "");
}
$("#toSignup").onclick = () => setAuthMode("signup");
$("#toReset").onclick = () => setAuthMode("reset");
$("#toLogin").onclick = () => setAuthMode("login");
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#aEmail").value.trim().toLowerCase(), pass = $("#aPass").value, st = $("#authSt"), btn = $("#authBtn");
  if (!email) return setSt(st, "اكتب بريدك الإلكتروني.", true);
  if (authMode !== "reset" && pass.length < 8) return setSt(st, "كلمة المرور 8 أحرف على الأقل.", true);
  btn.disabled = true; setSt(st, "لحظة…");
  try {
    if (authMode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      setSt(st, "");
    } else if (authMode === "signup") {
      const full_name = $("#aName").value.trim();
      if (!full_name) { btn.disabled = false; return setSt(st, "اكتب اسمك الكامل.", true); }
      const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name }, emailRedirectTo: redirectURL() } });
      if (error) throw error;
      if (!data.session) setSt(st, "أرسلنا رسالة تأكيد إلى بريدك. افتحها واضغط الرابط، ثم سجّل الدخول.");
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectURL() });
      if (error) throw error;
      setSt(st, "إن كان البريد مسجّلاً فستصلك رسالة فيها رابط لتعيين كلمة مرور جديدة.");
    }
  } catch (err) { setSt(st, errMsg(err), true); }
  finally { btn.disabled = false; }
});
$("#newPassForm").addEventListener("submit", async e => {
  e.preventDefault();
  const p = $("#np").value, st = $("#npSt");
  if (p.length < 8) return setSt(st, "8 أحرف على الأقل.", true);
  const { error } = await sb.auth.updateUser({ password: p });
  if (error) return setSt(st, errMsg(error), true);
  setSt(st, "تم حفظ كلمة المرور."); history.replaceState(null, "", redirectURL()); boot();
});
$("#logout").onclick = $("#pendingOut").onclick = async () => { await sb.auth.signOut(); location.replace(redirectURL()); };
$("#pendingRetry").onclick = () => boot();
$("#mfaOut").onclick = async () => { await sb.auth.signOut(); location.replace(redirectURL()); };
$("#mfaForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#mfaCode").value.replace(/\D/g, ""), st = $("#mfaSt"), btn = $("#mfaBtn");
  if (code.length !== 6) return setSt(st, "الرمز 6 أرقام.", true);
  btn.disabled = true; setSt(st, "جارٍ التحقق…");
  try {
    const { data, error } = await sb.auth.mfa.listFactors(); if (error) throw error;
    const f = (data.totp || []).find(x => x.status === "verified"); if (!f) throw new Error("no factor");
    const r = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code }); if (r.error) throw r.error;
    $("#mfaCode").value = ""; setSt(st, ""); await boot();
  } catch (err) { setSt(st, errMsg(err), true); }
  finally { btn.disabled = false; }
});
if (location.hash === "#timeout") { setSt($("#authSt"), `خرجت تلقائياً بعد ${IDLE_MIN} دقيقة بدون استخدام. سجّل الدخول مرة أخرى.`); history.replaceState(null, "", redirectURL()); }

let recovering = false;
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === "PASSWORD_RECOVERY") { recovering = true; show("newPassView"); return; }
  if (ev === "SIGNED_IN" && !recovering) setTimeout(boot, 0);
  if (ev === "SIGNED_OUT") { booted = false; show("authView"); }
});

async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show("authView"); setAuthMode(authMode); return; }
  if (recovering) return;
  if (idleExpired()) { await sb.auth.signOut(); show("authView"); setAuthMode("login"); setSt($("#authSt"), `خرجت تلقائياً بعد ${IDLE_MIN} دقيقة بدون استخدام. سجّل الدخول مرة أخرى.`); return; }
  markActive();
  me = session.user;
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") { show("mfaView"); setTimeout(() => $("#mfaCode").focus(), 50); return; }
  const { data: p, error } = await sb.from("profiles").select("*").eq("id", me.id).maybeSingle();
  if (error) { show("authView"); setSt($("#authSt"), errMsg(error), true); return; }
  profile = p;
  if (!p || !p.active) { $("#pendingEmail").textContent = me.email; show("pendingView"); return; }
  $("#me").textContent = (p.full_name || p.email) + (p.role === "admin" ? " · مدير" : "");
  $("#teamTab").hidden = p.role !== "admin";
  $("#dashTab").hidden = p.role !== "admin";
  $("#auditTab").hidden = p.role !== "admin";
  show("appView");
  if (!booted) { booted = true; setInterval(() => { if (!document.hidden) load(); }, 60000); }
  await load();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && booted) { T = todayISO(); load(); } });

/* ================= البيانات ================= */
function mapDeal(r){
  return { id: r.id, order: r.sort_order, name: r.name, location: r.location, units: r.units, contract: r.contract, source: r.source,
    stage: r.stage, priority: r.priority || "", lastAction: r.last_action, nextStep: r.next_step, nextDate: r.next_date || "",
    dateBasis: r.date_basis, lastActivity: r.last_activity || "", notes: r.notes, updatedAt: r.updated_at, updatedBy: r.updated_by, ownerId: r.owner_id,
    contractEnd: r.contract_end || "", lostReason: r.lost_reason || "",
    contacts: (r.contacts || []).sort((a,b) => a.sort_order - b.sort_order) };
}
async function load(){
  try {
    const [d, a, p, g, qo, ins, fi] = await Promise.all([
      sb.from("deals").select("*, contacts(*)").order("sort_order"),
      sb.from("activity").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(1000),
      sb.from("profiles").select("id, email, full_name, role, active, created_at").order("created_at"),
      sb.from("access_grants").select("*").order("created_at"),
      sb.from("quotes").select("*").order("quote_date", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("inspections").select("*").order("visit_date", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("attachments").select("*").order("created_at", { ascending: false })
    ]);
    quotes = qo.error ? [] : (qo.data || []);
    insps = ins.error ? [] : (ins.data || []);
    files = fi.error ? [] : (fi.data || []);
    if (d.error) throw d.error; if (a.error) throw a.error;
    grants = g.error ? [] : (g.data || []);
    deals = d.data.map(mapDeal);
    const byId = Object.fromEntries(deals.map(x => [x.id, x]));
    acts = a.data.map(r => ({ id: r.id, dealId: r.deal_id, dealName: byId[r.deal_id]?.name || "", date: r.date, type: r.type, contact: r.contact, summary: r.summary, createdBy: r.created_by, createdAt: r.created_at }));
    people = Object.fromEntries((p.data || []).map(x => [x.id, x]));
    $("#conn").textContent = "";
    render();
    if (tab === "team") renderTeam();
    if (tab === "dash") renderDash();
  } catch (e) { $("#conn").textContent = "تعذّر تحميل البيانات. " + errMsg(e); }
}
const who = id => { const p = people[id]; return p ? (p.full_name || p.email) : ""; };

/* ================= العرض ================= */
$("#today").textContent = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
STAGES.forEach(s => $("#fStage").insertAdjacentHTML("beforeend", `<option>${s}</option>`));

function due(d){
  if (CLOSED.has(d.stage)) return null;
  if (!d.nextStep || !d.nextDate) return { k: "due", t: "بلا موعد" };
  if (d.nextDate < T) return { k: "due", t: "متأخرة منذ " + d.nextDate };
  if (d.nextDate === T) return { k: "due", t: "اليوم" };
  if (d.nextDate <= addDays(T,7)) return { k: "soon", t: d.nextDate };
  return { k: "ok", t: d.nextDate };
}
const stagePill = s => `<span class="pill ${CLOSED.has(s) ? "stop" : ""}">${esc(s)}</span>`;
function rowHTML(d){
  const u = due(d), c = d.contacts[0], rn = renewal(d);
  return `<button class="row" data-id="${esc(d.id)}">
    <div><div class="nm">${esc(d.name)}</div><div class="sub">${esc([d.location, d.units && ("الوحدات: " + d.units)].filter(Boolean).join(" · ") || (c ? c.phone : ""))}</div></div>
    <div><div class="nx">${d.nextStep ? esc(d.nextStep) : '<span class="sub">لا توجد خطوة تالية</span>'}</div><div class="sub">${esc(d.lastAction || "")}</div></div>
    <div class="meta">${d.ownerId !== me.id ? `<span class="pill own">${esc(who(d.ownerId) || "—")}</span>` : ""}${levelOf(d) < 2 ? '<span class="pill stop">قراءة فقط</span>' : ""}${d.priority ? `<span class="pill ${d.priority === "عالية" ? "hi" : ""}">${esc(d.priority)}</span>` : ""}${stagePill(d.stage)}${u ? `<span class="pill ${u.k}">${esc(u.t)}</span>` : ""}${rn ? `<span class="pill ${rn.k}">${esc(rn.t)}</span>` : ""}</div>
  </button>`;
}
const sortQ = (a,b) => (PR[a.priority||""] - PR[b.priority||""]) || ((a.nextDate||"0") < (b.nextDate||"0") ? -1 : (a.nextDate||"0") > (b.nextDate||"0") ? 1 : 0) || a.order - b.order;

function queueParts(){
  const open = deals.filter(d => !CLOSED.has(d.stage));
  const q = open.filter(d => { const u = due(d); return u && (u.k === "due" || u.k === "soon"); });
  const renew = deals.filter(renewal).sort((a,b) => a.contractEnd < b.contractEnd ? -1 : 1);
  return { open, q, renew, dueNow: q.filter(d => due(d).k === "due" && d.nextDate && d.nextStep), noDate: q.filter(d => !d.nextDate || !d.nextStep), soon: q.filter(d => due(d).k === "soon") };
}
function filteredDeals(){
  const s = $("#q").value.trim(), fs = $("#fStage").value, fr = $("#fSrc").value, fw = $("#fOwner").value;
  return deals.filter(d => (!fs || d.stage === fs) && (!fr || d.source === fr) && (!fw || d.ownerId === fw) &&
    (!s || [d.name, d.location, d.notes, ...d.contacts.flatMap(c => [c.name, c.phone])].join(" ").includes(s)));
}
function render(){
  const { open, dueNow, noDate, soon, renew } = queueParts();
  const cnt = s => deals.filter(d => d.stage === s).length;
  $("#stats").innerHTML = [
    ["hot", dueNow.length, "مستحقة اليوم أو متأخرة"], ["", soon.length, "خلال 7 أيام"], ["", noDate.length, "بلا موعد متابعة"],
    ["hot", renew.length, "عقود تنتهي خلال 90 يوماً"],
    ["", open.length, "عملاء مفتوحون"], ["", cnt("تم تقديم عرض"), "تم تقديم عرض"], ["", cnt("تم التعاقد"), "تم التعاقد"]
  ].map(([c,n,l]) => `<div class="stat ${c && n ? c : ""}"><b>${n}</b><span>${l}</span></div>`).join("");
  const grp = (t, l) => l.length ? `<div class="group"><h2>${t} · ${l.length}</h2>${l.slice().sort(sortQ).map(rowHTML).join("")}</div>` : "";
  const grpR = l => l.length ? `<div class="group"><h2>عقود تنتهي قريباً · ${l.length}</h2>${l.map(rowHTML).join("")}</div>` : "";
  $("#queue").innerHTML = (grp("مستحقة الآن", dueNow) + grpR(renew) + grp("هذا الأسبوع", soon) + grp("بلا موعد متابعة", noDate)) || `<div class="empty">لا توجد متابعات مستحقة.</div>`;

  // فلتر المسؤول يظهر فقط إذا كان المستخدم يرى عملاء أكثر من موظف
  const owners = [...new Set(deals.map(d => d.ownerId))];
  const fo = $("#fOwner");
  fo.hidden = owners.length < 2;
  const keep = fo.value;
  fo.innerHTML = `<option value="">كل المسؤولين</option>` + owners.map(o => `<option value="${esc(o)}">${esc(o === me.id ? "عملائي" : (who(o) || "—"))}</option>`).join("");
  fo.value = owners.includes(keep) ? keep : "";
  const list = filteredDeals();
  $("#deals").innerHTML = list.map(rowHTML).join("") || `<div class="empty">لا يوجد عميل مطابق.</div>`;

  $("#log").innerHTML = acts.map(a => `<tr><td class="d">${esc(a.date)}</td><td>${esc(a.type)}</td><td>${esc(a.dealName)}</td><td>${esc(a.contact)}</td><td>${esc(a.summary)}</td><td>${esc(who(a.createdBy))}</td></tr>`).join("")
    || `<tr><td colspan="6" class="empty">لا يوجد نشاط مسجل بعد.</td></tr>`;
  if (openId) drawer(openId, true);
}

document.addEventListener("click", e => {
  const r = e.target.closest(".row"); if (r) { confirmDel = false; dupOk = false; dtab = "main"; drawer(r.dataset.id); return; }
  const t = e.target.closest("nav button"); if (t) {
    tab = t.dataset.tab;
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b === t));
    ["queue","deals","log","dash","team","audit"].forEach(n => $("#p-"+n).hidden = n !== tab);
    if (tab === "team") renderTeam();
    if (tab === "dash") renderDash();
    if (tab === "audit") loadAudit(true);
    return;
  }
  const cp = e.target.closest("[data-copy]"); if (cp) {
    const v = cp.dataset.copy;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => { cp.textContent = "نُسخ"; }, () => {});
  }
});
["#q","#fStage","#fSrc","#fOwner"].forEach(s => $(s).addEventListener("input", render));
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
function closeDrawer(){ openId = null; $("#drawer").hidden = true; $("#scrim").hidden = true; }

/* ================= تفاصيل العميل ================= */
const INSP = [
  ["buildings","عدد المباني / العمائر","num"], ["floors","عدد الأدوار","num"], ["elevators","عدد المصاعد","num"],
  ["elevatorContract","عقد صيانة للمصاعد","yn"], ["gates","عدد البوابات","num"], ["gateAuto","بوابات آلية","yn"],
  ["parking","عدد المواقف","num"], ["parkingType","نوع المواقف","مكشوفة|مظللة|قبو|مختلطة"],
  ["gardens","حدائق ومسطحات خضراء","yn"], ["pool","مسبح","yn"], ["gym","نادي رياضي","yn"],
  ["security","حراسة أمنية","yn"], ["cctv","كاميرات مراقبة","yn"], ["fire","نظام إنذار وإطفاء الحريق","yn"],
  ["tanks","خزانات المياه","أرضي|علوي|أرضي وعلوي"], ["generator","مولد كهربائي","yn"], ["waste","حاويات النفايات","yn"],
  ["cleaning","مستوى النظافة الحالي","ممتاز|جيد|مقبول|ضعيف"], ["maintenance","حالة الصيانة العامة","ممتازة|جيدة|مقبولة|ضعيفة"]
];
const INSP_L = Object.fromEntries(INSP.map(([k,l]) => [k,l]));
const inspChips = data => Object.entries(data || {}).filter(([,v]) => v !== "" && v !== null).map(([k,v]) => `<span class="chip">${esc(INSP_L[k] || k)}: <b>${esc(v)}</b></span>`).join("");

function drawer(id, refresh){
  const d = deals.find(x => x.id === id); if (!d) { closeDrawer(); return; }
  const el = $("#drawer");
  if (refresh && el.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) return;
  if (refresh && [...el.querySelectorAll("input[type=file]")].some(f => f.files && f.files.length)) return;
  openId = id;
  const admin = isAdmin(), canEdit = levelOf(d) >= 2;
  const dq = quotes.filter(q => q.deal_id === id), di = insps.filter(x => x.deal_id === id), df = files.filter(f => f.deal_id === id);
  const TABS = [["main","المتابعة"],["quotes","عروض الأسعار" + (dq.length ? " · " + dq.length : "")],["insp","المعاينة" + (di.length ? " · " + di.length : "")],["files","المرفقات" + (df.length ? " · " + df.length : "")]];
  const body = dtab === "quotes" ? quotesHTML(d, dq, canEdit, admin) : dtab === "insp" ? inspHTML(d, di, canEdit, admin)
             : dtab === "files" ? filesHTML(d, df, canEdit, admin) : mainHTML(d, canEdit, admin);
  el.innerHTML = `
    <button class="x" id="dx">إغلاق</button>
    <div><div class="eyebrow">${esc(d.source || "")}</div><h3>${esc(d.name)}</h3></div>
    ${canEdit ? "" : '<p class="note ro">لديك صلاحية <b>قراءة فقط</b> على هذا العميل. للتعديل اطلب الصلاحية من المدير.</p>'}
    <div class="dtabs" role="tablist" aria-label="أقسام العميل">${TABS.map(([k,l]) => `<button role="tab" aria-selected="${dtab === k}" data-dtab="${k}">${l}</button>`).join("")}</div>
    ${body}`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#dx").onclick = closeDrawer;
  el.querySelectorAll("[data-dtab]").forEach(b => b.onclick = () => { dtab = b.dataset.dtab; confirmDel = false; dupOk = false; drawer(id); });
  if (dtab === "quotes") wireQuotes(d); else if (dtab === "insp") wireInsp(d); else if (dtab === "files") wireFiles(d); else wireMain(d);
  fillLinks(el);
}

/* ---- تبويب المتابعة ---- */
function mainHTML(d, canEdit, admin){
  const hist = acts.filter(a => a.dealId === d.id), rn = renewal(d);
  const members = Object.values(people).filter(p => p.active);
  const [lr0, ...lrRest] = (d.lostReason || "").split(" — ");
  const lrSel = LOST_REASONS.includes(lr0) ? lr0 : (d.lostReason ? "أخرى" : "");
  const lrTxt = LOST_REASONS.includes(lr0) ? lrRest.join(" — ") : d.lostReason;
  return `
    <dl class="facts">
      <dt>المسؤول</dt><dd>${admin
        ? `<select id="dOwner" aria-label="الموظف المسؤول">${members.map(p => `<option value="${esc(p.id)}" ${p.id === d.ownerId ? "selected" : ""}>${esc(p.full_name || p.email)}</option>`).join("")}</select>`
        : esc(d.ownerId === me.id ? "أنت" : (who(d.ownerId) || "—"))}</dd>
      ${d.location ? `<dt>الموقع</dt><dd>${esc(d.location)}</dd>` : ""}
      ${d.units ? `<dt>الوحدات</dt><dd>${esc(d.units)}</dd>` : ""}
      ${d.contract ? `<dt>العقد الحالي</dt><dd>${esc(d.contract)}</dd>` : ""}
      ${d.contractEnd ? `<dt>انتهاء العقد</dt><dd>${esc(d.contractEnd)} ${rn ? `<span class="pill ${rn.k}">${esc(rn.t)}</span>` : ""}</dd>` : ""}
      ${d.lostReason ? `<dt>سبب الاعتذار</dt><dd>${esc(d.lostReason)}</dd>` : ""}
      ${d.lastActivity ? `<dt>آخر نشاط</dt><dd>${esc(d.lastActivity)}</dd>` : ""}
      ${d.dateBasis ? `<dt>أساس الموعد</dt><dd>${esc(d.dateBasis)}</dd>` : ""}
      ${d.updatedBy ? `<dt>آخر تعديل</dt><dd>${esc(who(d.updatedBy))} · ${esc((d.updatedAt || "").slice(0,10))}</dd>` : ""}
    </dl>
    <div class="box"><h4>جهات التواصل</h4>
      ${d.contacts.map(c => { const n = intlNum(c.phone); return `<div class="contact"><span>${esc(c.name)}${c.role ? ` <small class="note">(${esc(c.role)})</small>` : ""}</span>
        <span class="tools"><span class="phone">${esc(c.phone)}</span>
          ${n ? `<a class="btn ghost call" href="tel:+${n}" data-call="اتصال">اتصال</a><a class="btn ghost wa" href="https://wa.me/${n}" target="_blank" rel="noopener noreferrer" data-call="واتساب">واتساب</a>` : ""}
          <button class="btn ghost" data-copy="${esc(c.phone)}">نسخ</button>${canEdit ? `<button class="btn ghost" data-delc="${esc(c.id)}" aria-label="حذف جهة التواصل">حذف</button>` : ""}</span></div>`; }).join("") || '<span class="note">لا توجد جهة تواصل مسجلة.</span>'}
      <div class="three" ${canEdit ? "" : "hidden"}>
        <div class="field"><label for="cName">الاسم</label><input id="cName"></div>
        <div class="field"><label for="cPhone">الجوال</label><input id="cPhone" inputmode="tel" dir="ltr"></div>
        <div class="field"><label for="cRole">الصفة</label><input id="cRole" placeholder="مالك، رئيس الجمعية…"></div>
        <button class="btn ghost" id="addC">إضافة</button>
      </div>
      <div class="status err" id="cDup" role="status"></div>
    </div>
    <div class="box" ${canEdit ? "" : "hidden"}><h4>تسجيل ما حدث</h4>
      <div class="two">
        <div class="field"><label for="aType">النوع</label><select id="aType">${TYPES.map(t => `<option>${t}</option>`).join("")}</select></div>
        <div class="field"><label for="aDate">التاريخ</label><input type="date" id="aDate" value="${T}"></div>
      </div>
      <div class="field"><label for="aSum">الملخص</label><textarea id="aSum" rows="3" placeholder="مثال: اتصلت بسعد، طلب العرض قبل اجتماع الملاك يوم الخميس"></textarea></div>
      <div class="two">
        <div class="field"><label for="nStep">الخطوة التالية</label><input id="nStep" value="${esc(d.nextStep)}"></div>
        <div class="field"><label for="nDate">موعدها</label><input type="date" id="nDate" value="${esc(d.nextDate)}"></div>
      </div>
      <div class="two">
        <div class="field"><label for="nStage">المرحلة</label><select id="nStage">${STAGES.map(s => `<option ${s === d.stage ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="field"><label for="nPr">الأولوية</label><select id="nPr">${["","عالية","متوسطة","منخفضة"].map(p => `<option value="${p}" ${p === (d.priority || "") ? "selected" : ""}>${p || "—"}</option>`).join("")}</select></div>
      </div>
      <div class="two" id="lostBox" hidden>
        <div class="field"><label for="nLost">سبب الاعتذار أو التوقف (مطلوب)</label><select id="nLost"><option value="">اختر السبب</option>${LOST_REASONS.map(r => `<option ${r === lrSel ? "selected" : ""}>${r}</option>`).join("")}</select></div>
        <div class="field"><label for="nLostTxt">تفاصيل السبب</label><input id="nLostTxt" value="${esc(lrTxt)}" placeholder="مثال: تعاقدوا مع شركة أخرى بسعر أقل"></div>
      </div>
      <div class="two">
        <div class="field"><label for="nEnd">تاريخ انتهاء العقد الحالي</label><input type="date" id="nEnd" value="${esc(d.contractEnd)}"></div>
        <div class="note" style="align-self:end">يُنبّهك النظام قبل انتهاء العقد بـ 90 و60 و30 يوماً لتجهيز عرض التجديد.</div>
      </div>
      <div class="field"><label for="nNotes">ملاحظات</label><textarea id="nNotes" rows="2">${esc(d.notes)}</textarea></div>
      <button class="btn" id="save">حفظ</button>
    </div>
    <div class="status" id="st" role="status"></div>
    <div class="box"><h4>السجل</h4><div class="hist">${hist.map(a => `<div><small>${esc(a.date)} · ${esc(a.type)}${a.createdBy ? " · " + esc(who(a.createdBy)) : ""}</small><br>${esc(a.summary)}</div>`).join("") || '<span class="note">لا يوجد نشاط مسجل.</span>'}</div></div>
    ${admin ? `<div class="box"><h4>حذف العميل</h4>${confirmDel
      ? `<p class="note">سيُحذف العميل وجهات تواصله وسجله وعروضه ومعايناته ومرفقاته نهائياً.</p><div class="tools"><button class="btn danger" id="delYes">تأكيد الحذف</button><button class="btn ghost" id="delNo">إلغاء</button></div>`
      : `<button class="btn ghost" id="delDeal">حذف هذا العميل</button>`}</div>` : ""}`;
}
function wireMain(d){
  const el = $("#drawer");
  $("#save").onclick = () => save(d);
  $("#addC").onclick = () => addContact(d);
  const toggleLost = () => { $("#lostBox").hidden = !LOST.has($("#nStage").value); };
  $("#nStage").onchange = toggleLost; toggleLost();
  $("#cPhone").oninput = () => { dupOk = false; $("#cDup").textContent = ""; };
  $("#cPhone").onblur = async () => { const w = await dupInfo($("#cPhone").value, d.id); if ($("#cDup")) $("#cDup").textContent = w; };
  el.querySelectorAll("[data-call]").forEach(a => a.addEventListener("click", () => { if ($("#aType")) $("#aType").value = a.dataset.call; }));
  if ($("#dOwner")) $("#dOwner").onchange = async e => {
    const to = e.target.value;
    const { error } = await sb.from("deals").update({ owner_id: to }).eq("id", d.id);
    if (error) { e.target.value = d.ownerId; return setSt($("#st"), errMsg(error), true); }
    await load(); setSt($("#st"), `نُقل العميل إلى ${who(to)}.`);
  };
  el.querySelectorAll("[data-delc]").forEach(b => b.onclick = () => delContact(b.dataset.delc));
  if ($("#delDeal")) $("#delDeal").onclick = () => { confirmDel = true; drawer(d.id); };
  if ($("#delNo")) $("#delNo").onclick = () => { confirmDel = false; drawer(d.id); };
  if ($("#delYes")) $("#delYes").onclick = () => delDeal(d);
}

async function save(d){
  const st = $("#st"), btn = $("#save");
  const sum = $("#aSum").value.trim(), date = $("#aDate").value || T, type = $("#aType").value, stage = $("#nStage").value;
  let lost = "";
  if (LOST.has(stage)) {
    const r = $("#nLost").value, t = $("#nLostTxt").value.trim();
    if (!r && !LOST.has(d.stage)) { $("#nLost").focus(); return setSt(st, "اختر سبب الاعتذار أو التوقف قبل الحفظ.", true); }
    if (r === "أخرى" && !t) { $("#nLostTxt").focus(); return setSt(st, "اكتب سبب الاعتذار في خانة التفاصيل.", true); }
    lost = r ? (t && r !== "أخرى" ? r + " — " + t : (r === "أخرى" ? t : r)) : d.lostReason;
  }
  const upd = { next_step: $("#nStep").value.trim(), next_date: $("#nDate").value || null, stage, priority: $("#nPr").value, notes: $("#nNotes").value.trim(),
    contract_end: $("#nEnd").value || null, lost_reason: lost, updated_by: me.id };
  if (sum) { upd.last_action = type + ": " + sum.slice(0,80); if (!d.lastActivity || date > d.lastActivity) upd.last_activity = date; }
  if ((upd.next_date || "") !== (d.nextDate || "")) upd.date_basis = "";
  btn.disabled = true; setSt(st, "جارٍ الحفظ…");
  try {
    if (sum) {
      const { error } = await sb.from("activity").insert({ deal_id: d.id, date, type, contact: d.contacts[0]?.name || "", summary: sum, source: "التطبيق", created_by: me.id });
      if (error) throw error;
    }
    const { error } = await sb.from("deals").update(upd).eq("id", d.id);
    if (error) throw error;
    setSt(st, "تم الحفظ"); $("#aSum").value = "";
    await load();
  } catch (e) { setSt(st, errMsg(e), true); }
  finally { btn.disabled = false; }
}
// من يتابع هذا الرقم؟ الخادم يعيد اسم الموظف المسؤول فقط (واسم العميل للمدير أو لصاحب العميل)
async function dupInfo(phone, exceptDeal){
  if (String(phone || "").replace(/\D/g, "").length < 9) return "";
  const { data, error } = await sb.rpc("phone_owner", { p_phone: phone, p_except_deal: exceptDeal || null });
  if (error || !data || !data.length) return "";
  return "تنبيه: هذا الرقم مسجّل مسبقاً " + data.map(r => r.same_owner ? `عندك في «${r.deal_name}»` : `لدى ${r.owner_name}${r.deal_name ? ` في «${r.deal_name}»` : ""}`).join("، ") + ".";
}
async function addContact(d){
  const name = $("#cName").value.trim(), phone = $("#cPhone").value.trim(), role = $("#cRole").value.trim(), st = $("#st");
  if (!name && !phone) return setSt(st, "اكتب اسم جهة التواصل أو رقمها.", true);
  if (phone && !dupOk) {
    const w = await dupInfo(phone, d.id);
    if (w) { dupOk = true; $("#cDup").textContent = w + " اضغط «إضافة» مرة أخرى لإضافته على أي حال."; return; }
  }
  dupOk = false;
  const { error } = await sb.from("contacts").insert({ deal_id: d.id, name, phone, role, sort_order: d.contacts.length });
  if (error) return setSt(st, errMsg(error), true);
  await load(); setSt($("#st"), "أُضيفت جهة التواصل.");
}
async function delContact(cid){
  const { error } = await sb.from("contacts").delete().eq("id", cid);
  if (error) return setSt($("#st"), errMsg(error), true);
  await load();
}
async function delDeal(d){
  try {
    const paths = files.filter(f => f.deal_id === d.id).map(f => f.path);
    if (paths.length) { const s = await sb.storage.from("attachments").remove(paths); if (s.error) throw s.error; }
    let r = await sb.from("activity").delete().eq("deal_id", d.id); if (r.error) throw r.error;
    r = await sb.from("contacts").delete().eq("deal_id", d.id); if (r.error) throw r.error;
    r = await sb.from("deals").delete().eq("id", d.id); if (r.error) throw r.error;
    confirmDel = false; closeDrawer(); await load();
  } catch (e) { setSt($("#st"), errMsg(e), true); }
}
// سجل نشاط تلقائي مع تحديث آخر إجراء للعميل
async function logAuto(d, type, summary, extra){
  const r = await sb.from("activity").insert({ deal_id: d.id, date: T, type, contact: d.contacts[0]?.name || "", summary, source: "التطبيق", created_by: me.id });
  if (r.error) throw r.error;
  const upd = Object.assign({ last_action: type + ": " + summary.slice(0,80), updated_by: me.id }, extra || {});
  if (!d.lastActivity || T > d.lastActivity) upd.last_activity = T;
  const u = await sb.from("deals").update(upd).eq("id", d.id); if (u.error) throw u.error;
}

/* ---- تبويب عروض الأسعار ---- */
function nextQuoteNo(d){
  const code = CITY[Object.keys(CITY).find(k => (d.location || "").includes(k))] || "XXX";
  const max = quotes.reduce((m, q) => { const x = /(\d{3,})\s*$/.exec(q.number || ""); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  return `Q-Resi-${code}-${String(max + 1).padStart(4, "0")}`;
}
function quotesHTML(d, dq, canEdit, admin){
  const openQ = dq.find(q => Q_OPEN.has(q.status));
  return `
    ${openQ ? `<div class="box hl"><h4>العرض المفتوح الحالي</h4><div class="qv"><b>${money(openQ.annual_value)}</b> <span class="note">سنوياً · ${esc(openQ.number)} · ${esc(openQ.status)}</span></div></div>` : ""}
    <div class="box"><h4>عروض الأسعار المقدّمة</h4>
      ${dq.map(q => `<div class="qrow">
        <div><b dir="ltr">${esc(q.number || "—")}</b><div class="note">${esc(q.quote_date)}${q.created_by ? " · " + esc(who(q.created_by)) : ""}</div>${q.notes ? `<div class="note">${esc(q.notes)}</div>` : ""}</div>
        <div class="qv"><b>${money(q.annual_value)}</b><small>${q.vat_included ? "شامل الضريبة" : "غير شامل الضريبة"}</small></div>
        <div class="tools">${canEdit ? `<select data-qst="${esc(q.id)}" aria-label="حالة العرض">${Q_STATUS.map(s => `<option ${s === q.status ? "selected" : ""}>${s}</option>`).join("")}</select>` : `<span class="pill ${q.status === "مقبول" ? "ok" : q.status === "مرفوض" ? "due" : ""}">${esc(q.status)}</span>`}
          ${admin ? `<button class="btn ghost" data-qdel="${esc(q.id)}">حذف</button>` : ""}</div>
      </div>`).join("") || '<p class="note">لم يُسجَّل أي عرض سعر لهذا العميل بعد.</p>'}
    </div>
    <div class="box" ${canEdit ? "" : "hidden"}><h4>تسجيل عرض سعر</h4>
      <div class="two">
        <div class="field"><label for="qNo">رقم العرض</label><input id="qNo" dir="ltr" value="${esc(nextQuoteNo(d))}"></div>
        <div class="field"><label for="qVal">القيمة السنوية (ر.س)</label><input id="qVal" inputmode="decimal" dir="ltr" placeholder="120000"></div>
      </div>
      <div class="two">
        <div class="field"><label for="qDate">تاريخ العرض</label><input type="date" id="qDate" value="${T}"></div>
        <div class="field"><label for="qSt">الحالة</label><select id="qSt">${Q_STATUS.map(s => `<option ${s === "مُرسل" ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <label class="chk"><input type="checkbox" id="qVat" checked> القيمة شاملة ضريبة القيمة المضافة</label>
      <div class="field"><label for="qNotes">ملاحظات</label><input id="qNotes" placeholder="مثال: يشمل النظافة والحراسة، بدون صيانة المصاعد"></div>
      <button class="btn" id="qAdd">حفظ العرض</button>
      <p class="note">لإرفاق ملف العرض (PDF) استخدم تبويب «المرفقات». عند حفظ عرض مُرسل تنتقل مرحلة العميل إلى «تم تقديم عرض» تلقائياً.</p>
    </div>
    <div class="status" id="st" role="status"></div>`;
}
function wireQuotes(d){
  const el = $("#drawer"), st = () => $("#st");
  if ($("#qAdd")) $("#qAdd").onclick = async () => {
    const number = $("#qNo").value.trim(), vRaw = $("#qVal").value.replace(/[,،٬\s]/g, "").replace(/٫/g, ".").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c));
    const status = $("#qSt").value, value = vRaw === "" ? null : Number(vRaw);
    if (!number) return setSt(st(), "اكتب رقم العرض.", true);
    if (value !== null && (!isFinite(value) || value < 0)) return setSt(st(), "اكتب القيمة بالأرقام فقط.", true);
    $("#qAdd").disabled = true; setSt(st(), "جارٍ الحفظ…");
    try {
      const r = await sb.from("quotes").insert({ deal_id: d.id, number, annual_value: value, vat_included: $("#qVat").checked, quote_date: $("#qDate").value || T, status, notes: $("#qNotes").value.trim(), created_by: me.id });
      if (r.error) throw r.error;
      const extra = Q_OPEN.has(status) && ["جديد","مهتم","قيد المتابعة"].includes(d.stage) ? { stage: "تم تقديم عرض" } : {};
      await logAuto(d, "عرض سعر", `عرض سعر ${number}${value !== null ? " بقيمة " + money(value) : ""} (${status})`, extra);
      await load(); setSt($("#st"), "تم حفظ العرض" + (extra.stage ? " ونُقل العميل إلى «تم تقديم عرض»." : "."));
    } catch (e) { setSt(st(), errMsg(e), true); $("#qAdd").disabled = false; }
  };
  el.querySelectorAll("[data-qst]").forEach(s => s.onchange = async () => {
    const q = quotes.find(x => x.id === s.dataset.qst), to = s.value;
    const { error } = await sb.from("quotes").update({ status: to }).eq("id", q.id);
    if (error) { s.value = q.status; return setSt(st(), errMsg(error), true); }
    try { await logAuto(d, "عرض سعر", `تغيّرت حالة العرض ${q.number} إلى «${to}»`); } catch (_) {}
    await load();
    setSt($("#st"), to === "مقبول" && d.stage !== "تم التعاقد" ? "مبروك! حدّث مرحلة العميل إلى «تم التعاقد» من تبويب المتابعة." : "تم تحديث حالة العرض.");
  });
  el.querySelectorAll("[data-qdel]").forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "تأكيد الحذف"; b.classList.add("danger"); return; }
    const { error } = await sb.from("quotes").delete().eq("id", b.dataset.qdel);
    if (error) return setSt(st(), errMsg(error), true);
    await load();
  });
}

/* ---- تبويب المعاينة ---- */
function inspHTML(d, di, canEdit, admin){
  const photos = files.filter(f => f.deal_id === d.id && f.kind === "صورة الموقع");
  const fld = ([k, l, t]) => {
    const input = t === "num" ? `<input id="i_${k}" inputmode="numeric" dir="ltr">`
      : `<select id="i_${k}"><option value="">—</option>${(t === "yn" ? ["نعم","لا"] : t.split("|")).map(o => `<option>${o}</option>`).join("")}</select>`;
    return `<div class="field"><label for="i_${k}">${l}</label>${input}</div>`;
  };
  return `
    <div class="box"><h4>المعاينات السابقة</h4>
      ${di.map(x => `<div class="insp">
        <div class="contact"><b>معاينة ${esc(x.visit_date)}</b><span class="note">${esc(who(x.created_by))}${admin ? ` <button class="btn ghost" data-idel="${esc(x.id)}">حذف</button>` : ""}</span></div>
        <div class="chips">${inspChips(x.data) || '<span class="note">بدون بيانات تفصيلية.</span>'}</div>
        ${x.notes ? `<div class="note">${esc(x.notes)}</div>` : ""}
      </div>`).join("") || '<p class="note">لم تُسجَّل معاينة لهذا العميل بعد.</p>'}
      ${photos.length ? `<h4>صور الموقع</h4><div class="thumbs">${photos.map(f => `<a data-path="${esc(f.path)}" target="_blank" rel="noopener noreferrer" title="${esc(f.name)}"><img data-path="${esc(f.path)}" alt="${esc(f.name)}"></a>`).join("")}</div>` : ""}
    </div>
    <div class="box" ${canEdit ? "" : "hidden"}><h4>نموذج معاينة جديدة</h4>
      <div class="field"><label for="iDate">تاريخ المعاينة</label><input type="date" id="iDate" value="${T}"></div>
      <div class="grid3">${INSP.map(fld).join("")}</div>
      <div class="field"><label for="iNotes">ملاحظات المعاينة</label><textarea id="iNotes" rows="3" placeholder="مثال: الواجهات تحتاج تنظيف، تسربات في القبو، المصعد رقم 2 متوقف"></textarea></div>
      <div class="field"><label for="iPhotos">صور الموقع (اختياري)</label><input type="file" id="iPhotos" accept="image/*" multiple></div>
      <button class="btn" id="iSave">حفظ المعاينة</button>
    </div>
    <div class="status" id="st" role="status"></div>`;
}
function wireInsp(d){
  const el = $("#drawer"), st = () => $("#st");
  if ($("#iSave")) $("#iSave").onclick = async () => {
    const data = {};
    INSP.forEach(([k]) => { const v = $("#i_" + k).value.trim(); if (v) data[k] = v; });
    const notes = $("#iNotes").value.trim(), photos = [...$("#iPhotos").files];
    if (!Object.keys(data).length && !notes && !photos.length) return setSt(st(), "عبّئ بند واحد على الأقل أو اكتب ملاحظة.", true);
    $("#iSave").disabled = true; setSt(st(), photos.length ? `جارٍ الحفظ ورفع ${photos.length} صورة…` : "جارٍ الحفظ…");
    try {
      const r = await sb.from("inspections").insert({ deal_id: d.id, visit_date: $("#iDate").value || T, data, notes, created_by: me.id });
      if (r.error) throw r.error;
      if (photos.length) await uploadFiles(d, photos, "صورة الموقع");
      const brief = ["elevators","gates","parking"].filter(k => data[k]).map(k => `${INSP_L[k]} ${data[k]}`).join("، ");
      await logAuto(d, "معاينة", "تمت معاينة الموقع" + (brief ? ": " + brief : "") + (notes ? " — " + notes.slice(0,60) : ""));
      $("#iPhotos").value = "";
      await load(); setSt($("#st"), "تم حفظ المعاينة.");
    } catch (e) { setSt(st(), errMsg(e), true); $("#iSave").disabled = false; }
  };
  el.querySelectorAll("[data-idel]").forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "تأكيد الحذف"; b.classList.add("danger"); return; }
    const { error } = await sb.from("inspections").delete().eq("id", b.dataset.idel);
    if (error) return setSt(st(), errMsg(error), true);
    await load();
  });
}

/* ---- تبويب المرفقات ---- */
const isImg = f => /^image\//.test(f.mime || "") || /\.(jpe?g|png|webp)$/i.test(f.name || "");
function filesHTML(d, df, canEdit, admin){
  return `
    <div class="box"><h4>ملفات العميل</h4>
      ${df.map(f => `<div class="frow">
        ${isImg(f) ? `<a data-path="${esc(f.path)}" target="_blank" rel="noopener noreferrer"><img class="fthumb" data-path="${esc(f.path)}" alt=""></a>` : `<span class="ficon">${esc(((f.name || "").split(".").pop() || "ملف").slice(0,4).toUpperCase())}</span>`}
        <div><a class="flink" data-path="${esc(f.path)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>
          <div class="note"><span class="pill">${esc(f.kind)}</span> ${esc(kb(f.size))} · ${esc((f.created_at || "").slice(0,10))}${f.created_by ? " · " + esc(who(f.created_by)) : ""}</div></div>
        ${admin ? `<button class="btn ghost" data-fdel="${esc(f.id)}">حذف</button>` : "<span></span>"}
      </div>`).join("") || '<p class="note">لا توجد مرفقات بعد. أرفق عرض السعر أو العقد أو صور الموقع.</p>'}
    </div>
    <div class="box" ${canEdit ? "" : "hidden"}><h4>إرفاق ملف</h4>
      <div class="two">
        <div class="field"><label for="fKind">نوع الملف</label><select id="fKind">${FILE_KINDS.map(k => `<option>${k}</option>`).join("")}</select></div>
        <div class="field"><label for="fIn">الملف (حتى 15 ميغابايت)</label><input type="file" id="fIn" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,image/*"></div>
      </div>
      <button class="btn" id="fUp">رفع</button>
      <p class="note">الملفات محفوظة في مساحة خاصة؛ لا يفتحها إلا من له صلاحية على هذا العميل، والروابط تنتهي بعد ساعة.</p>
    </div>
    <div class="status" id="st" role="status"></div>`;
}
async function uploadFiles(d, list, kind){
  for (const f of list) {
    if (f.size > 15 * 1048576) throw new Error("file_too_big");
    const m = /\.([a-z0-9]{1,5})$/i.exec(f.name || ""), ext = m ? "." + m[1].toLowerCase() : "";
    const path = `${d.id}/${crypto.randomUUID()}${ext}`;
    const up = await sb.storage.from("attachments").upload(path, f, { contentType: f.type || undefined, upsert: false });
    if (up.error) throw up.error;
    const r = await sb.from("attachments").insert({ deal_id: d.id, path, name: (f.name || "ملف").slice(0,200), size: f.size, mime: f.type || "", kind, created_by: me.id });
    if (r.error) throw r.error;
  }
}
function wireFiles(d){
  const el = $("#drawer"), st = () => $("#st");
  if ($("#fUp")) $("#fUp").onclick = async () => {
    const list = [...$("#fIn").files];
    if (!list.length) return setSt(st(), "اختر ملفاً أولاً.", true);
    $("#fUp").disabled = true; setSt(st(), `جارٍ رفع ${list.length} ملف…`);
    try { await uploadFiles(d, list, $("#fKind").value); $("#fIn").value = ""; await load(); setSt($("#st"), "تم الرفع."); }
    catch (e) { setSt(st(), errMsg(e), true); $("#fUp").disabled = false; }
  };
  el.querySelectorAll("[data-fdel]").forEach(b => b.onclick = async () => {
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "تأكيد الحذف"; b.classList.add("danger"); return; }
    const f = files.find(x => x.id === b.dataset.fdel);
    const s = await sb.storage.from("attachments").remove([f.path]);
    if (s.error) return setSt(st(), errMsg(s.error), true);
    const { error } = await sb.from("attachments").delete().eq("id", f.id);
    if (error) return setSt(st(), errMsg(error), true);
    await load();
  });
}
// روابط مؤقتة (ساعة) للملفات الخاصة
const urlCache = {};
async function fillLinks(root){
  const nodes = [...root.querySelectorAll("[data-path]")]; if (!nodes.length) return;
  const now = Date.now();
  const need = [...new Set(nodes.map(n => n.dataset.path))].filter(p => !urlCache[p] || urlCache[p].exp < now + 120000);
  if (need.length) {
    const { data } = await sb.storage.from("attachments").createSignedUrls(need, 3600);
    (data || []).forEach(x => { if (x.signedUrl && x.path) urlCache[x.path] = { url: x.signedUrl, exp: now + 3600000 }; });
  }
  nodes.forEach(n => { const c = urlCache[n.dataset.path]; if (!c) return; if (n.tagName === "IMG") n.src = c.url; else n.href = c.url; });
}

/* ================= عميل جديد ================= */
$("#newDeal").onclick = () => {
  const el = $("#drawer"); openId = null;
  el.innerHTML = `
    <button class="x" id="dx">إغلاق</button>
    <h3>عميل جديد</h3>
    <div class="box">
      <div class="field"><label for="ndName">اسم العميل أو العقار</label><input id="ndName" required></div>
      <div class="two">
        <div class="field"><label for="ndLoc">الموقع</label><input id="ndLoc" placeholder="الخبر - حي الحمراء"></div>
        <div class="field"><label for="ndUnits">عدد الوحدات</label><input id="ndUnits"></div>
      </div>
      <div class="two">
        <div class="field"><label for="ndSrc">مصدر العميل</label><select id="ndSrc">${SOURCES.map(s => `<option>${s}</option>`).join("")}</select></div>
        <div class="field"><label for="ndPr">الأولوية</label><select id="ndPr"><option value="">—</option><option>عالية</option><option>متوسطة</option><option>منخفضة</option></select></div>
      </div>
      <div class="two">
        <div class="field"><label for="ndContract">العقد الحالي</label><input id="ndContract" placeholder="مثال: عقد مع شركة أخرى"></div>
        <div class="field"><label for="ndEnd">تاريخ انتهاء العقد</label><input type="date" id="ndEnd"></div>
      </div>
      ${isAdmin() ? `<div class="field"><label for="ndOwner">الموظف المسؤول</label><select id="ndOwner">${Object.values(people).filter(p => p.active).map(p => `<option value="${esc(p.id)}" ${p.id === me.id ? "selected" : ""}>${esc(p.id === me.id ? "أنا" : (p.full_name || p.email))}</option>`).join("")}</select></div>` : ""}
      <div class="two">
        <div class="field"><label for="ndCName">جهة التواصل</label><input id="ndCName"></div>
        <div class="field"><label for="ndCPhone">الجوال</label><input id="ndCPhone" inputmode="tel" dir="ltr"></div>
      </div>
      <div class="status err" id="ndDup" role="status"></div>
      <div class="two">
        <div class="field"><label for="ndStep">الخطوة التالية</label><input id="ndStep" placeholder="اتصال تعريفي"></div>
        <div class="field"><label for="ndDate">موعدها</label><input type="date" id="ndDate" value="${T}"></div>
      </div>
      <div class="field"><label for="ndNotes">ملاحظات</label><textarea id="ndNotes" rows="2"></textarea></div>
      <button class="btn" id="ndSave">إضافة العميل</button>
      <div class="status" id="ndSt" role="status"></div>
    </div>`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#dx").onclick = closeDrawer;
  dupOk = false;
  $("#ndCPhone").oninput = () => { dupOk = false; $("#ndDup").textContent = ""; };
  $("#ndCPhone").onblur = async () => { const w = await dupInfo($("#ndCPhone").value); if ($("#ndDup")) $("#ndDup").textContent = w; };
  $("#ndSave").onclick = async () => {
    const st = $("#ndSt"), name = $("#ndName").value.trim();
    if (!name) return setSt(st, "اكتب اسم العميل.", true);
    const same = deals.find(x => x.name.trim() === name);
    if (!dupOk) {
      const w = [same ? `يوجد عميل بنفس الاسم «${same.name}».` : "", await dupInfo($("#ndCPhone").value)].filter(Boolean).join(" ");
      if (w) { dupOk = true; $("#ndDup").textContent = w + " اضغط «إضافة العميل» مرة أخرى لإضافته على أي حال."; return; }
    }
    $("#ndSave").disabled = true; setSt(st, "جارٍ الحفظ…");
    try {
      const order = deals.reduce((m, d) => Math.max(m, d.order || 0), 0) + 1;
      const { data, error } = await sb.from("deals").insert({
        name, location: $("#ndLoc").value.trim(), units: $("#ndUnits").value.trim(), source: $("#ndSrc").value, priority: $("#ndPr").value,
        contract: $("#ndContract").value.trim(), contract_end: $("#ndEnd").value || null, next_step: $("#ndStep").value.trim(), next_date: $("#ndDate").value || null,
        notes: $("#ndNotes").value.trim(), stage: "جديد", sort_order: order, updated_by: me.id,
        owner_id: $("#ndOwner") ? $("#ndOwner").value : me.id
      }).select("id").single();
      if (error) throw error;
      const cn = $("#ndCName").value.trim(), cp = $("#ndCPhone").value.trim();
      if (cn || cp) { const r = await sb.from("contacts").insert({ deal_id: data.id, name: cn, phone: cp, sort_order: 0 }); if (r.error) throw r.error; }
      await load(); dtab = "main"; dupOk = false; drawer(data.id);
    } catch (e) { setSt(st, errMsg(e), true); $("#ndSave").disabled = false; }
  };
  $("#ndName").focus();
};

/* ================= الدعوات (للمدير) ================= */
async function renderInvites(){
  const { data, error } = await sb.from("invites").select("*").order("created_at", { ascending: false });
  if (error) { setSt($("#invSt"), errMsg(error), true); return; }
  $("#invites").innerHTML = (data || []).map(i => `<div class="team-row">
      <div><b>${esc(i.full_name || "—")}</b><div class="note" dir="ltr" style="text-align:right">${esc(i.email)}</div></div>
      <span class="pill ${i.used_at ? "ok" : "soon"}">${i.used_at ? "سجّل" : "لم يسجّل بعد"}</span>
      ${i.used_at ? "<span></span>" : `<button class="btn ghost" data-uninv="${esc(i.email)}">إلغاء الدعوة</button>`}
    </div>`).join("") || '<p class="note">لا توجد دعوات بعد.</p>';
  $("#invites").querySelectorAll("[data-uninv]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.from("invites").delete().eq("email", b.dataset.uninv);
    if (error) setSt($("#invSt"), errMsg(error), true); else setSt($("#invSt"), "أُلغيت الدعوة.");
    renderInvites();
  });
}
$("#invAdd").onclick = async () => {
  const email = $("#invEmail").value.trim().toLowerCase(), full_name = $("#invName").value.trim(), st = $("#invSt");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setSt(st, "اكتب بريداً إلكترونياً صحيحاً.", true);
  if (Object.values(people).some(p => p.email === email)) return setSt(st, "هذا البريد مسجّل في الفريق مسبقاً.", true);
  $("#invAdd").disabled = true;
  const { error } = await sb.from("invites").insert({ email, full_name });
  $("#invAdd").disabled = false;
  if (error) return setSt(st, /duplicate|unique/i.test(error.message) ? "هذا البريد مدعو مسبقاً." : errMsg(error), true);
  $("#invEmail").value = ""; $("#invName").value = "";
  setSt(st, `تمت الدعوة. أرسل للموظف الرابط ${redirectURL()} ليسجّل بالبريد ${email}.`);
  renderInvites();
};

/* ================= سجل المراقبة (للمدير) ================= */
const TBL_AR = { deals: "العملاء", contacts: "جهات التواصل", activity: "النشاط", profiles: "الفريق", invites: "الدعوات", settings: "الإعدادات",
  quotes: "عروض الأسعار", inspections: "المعاينات", attachments: "المرفقات", access_grants: "الصلاحيات" };
const OP_AR = { INSERT: "إضافة", UPDATE: "تعديل", DELETE: "حذف" };
const FIELD_AR = { name: "الاسم", location: "الموقع", units: "الوحدات", contract: "العقد", source: "المصدر", stage: "المرحلة", priority: "الأولوية",
  last_action: "آخر إجراء", next_step: "الخطوة التالية", next_date: "موعدها", notes: "ملاحظات", phone: "الجوال", role: "الصفة/الصلاحية",
  active: "مفعّل", full_name: "الاسم", summary: "الملخص", type: "النوع", date: "التاريخ", last_activity: "آخر نشاط", date_basis: "أساس الموعد", email: "البريد", sort_order: "الترتيب",
  contract_end: "انتهاء العقد", lost_reason: "سبب الاعتذار", number: "رقم العرض", annual_value: "القيمة السنوية", status: "الحالة", quote_date: "تاريخ العرض",
  vat_included: "شامل الضريبة", visit_date: "تاريخ المعاينة", data: "بيانات المعاينة", kind: "النوع", size: "الحجم", mime: "نوع الملف", path: "المسار", owner_id: "المسؤول", level: "الصلاحية" };
const SKIP = new Set(["updated_at","updated_by","created_at","created_by","id","deal_id"]);
let auditRows = [], auditPage = 0;
const fmtTs = s => { try { return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Riyadh" }).format(new Date(s)); } catch (_) { return s; } };
const short = v => { const s = v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0,60) + "…" : s; };
function auditLabel(r){
  const d = r.new_data || r.old_data || {};
  if (r.table_name === "deals") return d.name;
  if (r.table_name === "contacts") return [d.name, d.phone].filter(Boolean).join(" · ");
  if (r.table_name === "activity") return (deals.find(x => x.id === d.deal_id)?.name || "") + (d.summary ? " — " + short(d.summary) : "");
  const dn = deals.find(x => x.id === d.deal_id)?.name || "";
  if (r.table_name === "quotes") return [dn, d.number].filter(Boolean).join(" · ");
  if (r.table_name === "inspections") return [dn, "معاينة " + (d.visit_date || "")].filter(Boolean).join(" · ");
  if (r.table_name === "attachments") return [dn, d.name].filter(Boolean).join(" · ");
  return d.full_name || d.email || d.key || r.row_id;
}
function auditDetail(r){
  if (r.op === "UPDATE") {
    const o = r.old_data || {}, n = r.new_data || {};
    return Object.keys(n).filter(k => !SKIP.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]))
      .map(k => `${FIELD_AR[k] || k}: ${esc(short(o[k]))} ← ${esc(short(n[k]))}`).join("<br>") || "—";
  }
  const d = r.new_data || r.old_data || {};
  return Object.keys(d).filter(k => !SKIP.has(k) && d[k] !== "" && d[k] !== null).slice(0,4).map(k => `${FIELD_AR[k] || k}: ${esc(short(d[k]))}`).join("<br>");
}
async function loadAudit(reset){
  if (reset) { auditRows = []; auditPage = 0; }
  const f = $("#auF").value, size = 100;
  let q = sb.from("audit_log").select("*").order("at", { ascending: false }).range(auditPage*size, auditPage*size + size - 1);
  if (f) q = q.eq("op", f);
  const { data, error } = await q;
  if (error) { $("#audit").innerHTML = `<tr><td colspan="6" class="empty">${esc(errMsg(error))}</td></tr>`; return; }
  auditRows = auditRows.concat(data || []); auditPage++;
  $("#auMore").hidden = (data || []).length < size;
  $("#audit").innerHTML = auditRows.map(r => `<tr>
      <td class="d">${esc(fmtTs(r.at))}</td><td>${esc(r.actor ? (who(r.actor) || r.actor_email || "") : "النظام")}</td>
      <td><span class="pill ${r.op === "DELETE" ? "due" : r.op === "INSERT" ? "ok" : ""}">${OP_AR[r.op] || r.op}</span></td>
      <td>${esc(TBL_AR[r.table_name] || r.table_name)}</td><td>${esc(auditLabel(r) || "")}</td><td style="font-size:13px">${auditDetail(r)}</td></tr>`).join("")
    || `<tr><td colspan="6" class="empty">لا توجد تغييرات مسجّلة بعد.</td></tr>`;
}
$("#auF").addEventListener("input", () => loadAudit(true));
$("#auMore").onclick = () => loadAudit(false);

/* ================= حسابي والأمان ================= */
async function accountDrawer(){
  const el = $("#drawer"); openId = null;
  const { data: fl } = await sb.auth.mfa.listFactors();
  const factor = (fl?.totp || []).find(x => x.status === "verified");
  el.innerHTML = `
    <button class="x" id="dx">إغلاق</button>
    <div><div class="eyebrow">حسابي والأمان</div><h3>${esc(profile.full_name || profile.email)}</h3><div class="note" dir="ltr" style="text-align:right">${esc(profile.email)}</div></div>
    <div class="box"><h4>التحقق بخطوتين</h4>
      ${factor
        ? `<p class="note">مفعّل ✓. عند كل تسجيل دخول يُطلب منك رمز من تطبيق المصادقة على جوالك.</p><button class="btn danger" id="mfaOff">إيقاف التحقق بخطوتين</button>`
        : `<p class="note">أضف طبقة حماية: حتى لو عرف أحد كلمة مرورك، لا يدخل بدون الرمز من جوالك. تحتاج تطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator.</p><button class="btn" id="mfaOn">تفعيل التحقق بخطوتين</button>`}
      <div id="mfaSetup"></div>
      <div class="status" id="accSt" role="status"></div>
    </div>
    <div class="box"><h4>تغيير كلمة المرور</h4>
      <div class="field"><label for="accPass">كلمة المرور الجديدة (8 أحرف على الأقل)</label><input id="accPass" type="password" dir="ltr" autocomplete="new-password"></div>
      <button class="btn" id="accPassBtn">حفظ كلمة المرور</button>
      <div class="status" id="accPassSt" role="status"></div>
    </div>
    <div class="box"><h4>الجلسة</h4><p class="note">تخرج تلقائياً بعد ${IDLE_MIN} دقيقة بدون استخدام، لحماية بياناتك إذا نسيت الجهاز مفتوحاً.</p></div>`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#dx").onclick = closeDrawer;
  $("#accPassBtn").onclick = async () => {
    const p = $("#accPass").value, st = $("#accPassSt");
    if (p.length < 8) return setSt(st, "8 أحرف على الأقل.", true);
    const { error } = await sb.auth.updateUser({ password: p });
    if (error) return setSt(st, errMsg(error), true);
    $("#accPass").value = ""; setSt(st, "تم تغيير كلمة المرور.");
  };
  if ($("#mfaOff")) $("#mfaOff").onclick = async () => {
    const { error } = await sb.auth.mfa.unenroll({ factorId: factor.id });
    if (error) return setSt($("#accSt"), errMsg(error), true);
    await sb.auth.refreshSession(); accountDrawer();
  };
  if ($("#mfaOn")) $("#mfaOn").onclick = async () => {
    const st = $("#accSt");
    // إزالة أي محاولة تفعيل سابقة لم تكتمل
    for (const f of (fl?.all || []).filter(x => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "عملاء توتال " + Date.now() });
    if (error) return setSt(st, errMsg(error), true);
    $("#mfaOn").hidden = true;
    $("#mfaSetup").innerHTML = `
      <ol class="note" style="margin:0;padding-inline-start:18px">
        <li>افتح تطبيق المصادقة على جوالك واضغط «إضافة».</li>
        <li>امسح هذا الرمز، أو انسخ المفتاح وألصقه يدوياً.</li>
        <li>اكتب الرمز المكوّن من 6 أرقام الذي يظهر في التطبيق.</li>
      </ol>
      <img src="${esc(data.totp.qr_code)}" alt="رمز QR للتحقق بخطوتين" style="width:190px;height:190px;background:#fff;border-radius:8px;padding:6px;align-self:center">
      <div class="contact"><span class="note">المفتاح:</span><span><span class="phone" style="font-size:13px">${esc(data.totp.secret)}</span> <button class="btn ghost" data-copy="${esc(data.totp.secret)}">نسخ</button></span></div>
      <div class="field"><label for="enrCode">الرمز من التطبيق</label><input id="enrCode" inputmode="numeric" maxlength="6" dir="ltr" autocomplete="one-time-code"></div>
      <button class="btn" id="enrOk">تأكيد التفعيل</button>`;
    $("#enrOk").onclick = async () => {
      const code = $("#enrCode").value.replace(/\D/g, "");
      if (code.length !== 6) return setSt(st, "الرمز 6 أرقام.", true);
      const r = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code });
      if (r.error) return setSt(st, errMsg(r.error), true);
      accountDrawer(); setTimeout(() => setSt($("#accSt"), "تم تفعيل التحقق بخطوتين."), 50);
    };
  };
}
$("#account").onclick = () => accountDrawer();

/* ================= الفريق (للمدير) ================= */
function renderTeam(){
  renderInvites();
  const list = Object.values(people);
  const owned = id => deals.filter(d => d.ownerId === id).length;
  const LV = { read: "قراءة فقط", edit: "قراءة وتعديل" };
  $("#team").innerHTML = list.map(p => {
    const mine = grants.filter(g => g.grantee === p.id);
    const others = list.filter(o => o.id !== p.id);
    const showAccess = p.id !== me.id && p.active && p.role !== "admin";
    return `<div class="team-row" style="grid-template-columns:minmax(0,1fr) auto auto">
      <div><b>${esc(p.full_name || "—")}</b><div class="note" dir="ltr" style="text-align:right">${esc(p.email)}</div>
        <div class="note">مسؤول عن ${owned(p.id)} عميل</div></div>
      <span class="pill ${p.active ? "ok" : "soon"}">${p.active ? (p.role === "admin" ? "مدير" : "مفعّل") : "بانتظار التفعيل"}</span>
      ${p.id === me.id ? '<span class="note">أنت</span>' : `<div class="tools">
        <button class="btn ghost" data-act="${p.active ? "off" : "on"}" data-uid="${esc(p.id)}">${p.active ? "إيقاف" : "تفعيل"}</button>
        ${p.active ? `<button class="btn ghost" data-act="${p.role === "admin" ? "member" : "admin"}" data-uid="${esc(p.id)}">${p.role === "admin" ? "إلغاء الإدارة" : "جعله مديراً"}</button>` : ""}
      </div>`}
      ${showAccess ? `<div style="grid-column:1/-1;background:var(--card);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px">
        <b style="font-size:13px;color:var(--teal)">يرى بالإضافة لعملائه</b>
        ${mine.map(g => `<div class="contact"><span>${g.owner_id ? "عملاء " + esc(who(g.owner_id) || "—") : "<b>كل العملاء</b>"} · <span class="pill ${g.level === "edit" ? "ok" : "stop"}">${LV[g.level]}</span></span>
          <button class="btn ghost" data-ungrant="${esc(g.id)}">إزالة</button></div>`).join("") || '<span class="note">لا يرى إلا عملاءه فقط.</span>'}
        <div class="tools">
          <select data-gowner="${esc(p.id)}" aria-label="عملاء من"><option value="">كل العملاء</option>${others.map(o => `<option value="${esc(o.id)}">عملاء ${esc(o.full_name || o.email)}</option>`).join("")}</select>
          <select data-glevel="${esc(p.id)}" aria-label="نوع الصلاحية"><option value="read">قراءة فقط</option><option value="edit">قراءة وتعديل</option></select>
          <button class="btn ghost" data-grant="${esc(p.id)}">إعطاء الصلاحية</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("") || '<p class="note">لا يوجد أعضاء بعد.</p>';
  $("#team").querySelectorAll("[data-grant]").forEach(b => b.onclick = async () => {
    const uid = b.dataset.grant, owner = $(`[data-gowner="${uid}"]`).value || null, level = $(`[data-glevel="${uid}"]`).value;
    b.disabled = true;
    const exist = grants.find(g => g.grantee === uid && g.owner_id === owner);
    const r = exist ? await sb.from("access_grants").update({ level }).eq("id", exist.id)
                    : await sb.from("access_grants").insert({ grantee: uid, owner_id: owner, level });
    if (r.error) setSt($("#teamSt"), errMsg(r.error), true); else setSt($("#teamSt"), "تم تحديث الصلاحية.");
    await load();
  });
  $("#team").querySelectorAll("[data-ungrant]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    const { error } = await sb.from("access_grants").delete().eq("id", b.dataset.ungrant);
    if (error) setSt($("#teamSt"), errMsg(error), true); else setSt($("#teamSt"), "أُزيلت الصلاحية.");
    await load();
  });
  $("#team").querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
    const a = b.dataset.act, upd = a === "on" ? { active: true } : a === "off" ? { active: false } : { role: a };
    b.disabled = true;
    const { error } = await sb.from("profiles").update(upd).eq("id", b.dataset.uid);
    if (error) setSt($("#teamSt"), errMsg(error), true); else setSt($("#teamSt"), "تم التحديث.");
    await load();
  });
}

/* ================= لوحة الأداء (للمدير) ================= */
function renderDash(){
  const latest = {}; quotes.forEach(q => { if (!latest[q.deal_id]) latest[q.deal_id] = q; });
  const openQ = Object.values(latest).filter(q => Q_OPEN.has(q.status));
  const acc = quotes.filter(q => q.status === "مقبول"), rej = quotes.filter(q => q.status === "مرفوض");
  const sum = l => l.reduce((m, q) => m + Number(q.annual_value || 0), 0);
  const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "—";
  const won = deals.filter(d => d.stage === "تم التعاقد").length, lost = deals.filter(d => LOST.has(d.stage)).length;
  const { dueNow, renew } = queueParts();
  const since = addDays(T, -30);
  const kpi = [
    [money(sum(openQ)), `قيمة العروض المفتوحة (${openQ.length} عرض)`, ""],
    [money(sum(acc)), `قيمة العروض المقبولة (${acc.length})`, ""],
    [pct(acc.length, acc.length + rej.length), "نسبة قبول العروض", ""],
    [pct(won, won + lost), `نسبة التحويل إلى عقد (${won} من ${won + lost} مغلق)`, ""],
    [renew.length, "عقود تنتهي خلال 90 يوماً", renew.length ? "hot" : ""],
    [dueNow.length, "متابعات مستحقة أو متأخرة", dueNow.length ? "hot" : ""]
  ];
  const staff = Object.values(people).filter(p => p.active || deals.some(d => d.ownerId === p.id));
  const rows = staff.map(p => {
    const my = deals.filter(d => d.ownerId === p.id), ids = new Set(my.map(d => d.id));
    const oq = openQ.filter(q => ids.has(q.deal_id));
    return `<tr><td><b>${esc(p.full_name || p.email)}</b></td><td>${my.length}</td><td>${my.filter(d => !CLOSED.has(d.stage)).length}</td>
      <td class="${dueNow.some(d => ids.has(d.id)) ? "hotc" : ""}">${dueNow.filter(d => ids.has(d.id)).length}</td>
      <td>${acts.filter(a => a.createdBy === p.id && a.date >= since).length}</td>
      <td>${oq.length} · ${money(sum(oq))}</td><td>${quotes.filter(q => ids.has(q.deal_id) && q.status === "مقبول").length}</td>
      <td>${my.filter(d => d.stage === "تم التعاقد").length}</td><td>${renew.filter(d => ids.has(d.id)).length}</td></tr>`;
  }).join("");
  const bars = (items) => { const max = Math.max(1, ...items.map(x => x[1])); return `<div class="dbars">${items.map(([l, n]) => `<div class="br"><span>${esc(l)}</span><div class="tr"><i style="width:${n / max * 100}%"></i></div><b>${n}</b></div>`).join("")}</div>`; };
  const reasons = {};
  deals.filter(d => LOST.has(d.stage)).forEach(d => { const r0 = (d.lostReason || "").split(" — ")[0]; const k = !d.lostReason ? "غير محدد" : LOST_REASONS.includes(r0) ? r0 : "أخرى"; reasons[k] = (reasons[k] || 0) + 1; });
  const byId = Object.fromEntries(deals.map(d => [d.id, d]));
  const topQ = openQ.slice().sort((a, b) => Number(b.annual_value || 0) - Number(a.annual_value || 0)).slice(0, 10);
  $("#dash").innerHTML = `
    <section class="stats">${kpi.map(([n, l, c]) => `<div class="stat ${c}"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("")}</section>
    <div class="box"><h4>أداء الموظفين</h4><div class="tbl"><table>
      <thead><tr><th>الموظف</th><th>العملاء</th><th>مفتوحون</th><th>مستحقة/متأخرة</th><th>نشاط آخر 30 يوماً</th><th>عروض مفتوحة</th><th>عروض مقبولة</th><th>تعاقدات</th><th>عقود تنتهي ≤90 يوماً</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="empty">لا يوجد موظفون.</td></tr>'}</tbody></table></div></div>
    <div class="dgrid">
      <div class="box"><h4>العملاء حسب المرحلة</h4>${bars(STAGES.map(s => [s, deals.filter(d => d.stage === s).length]))}</div>
      <div class="box"><h4>أسباب الاعتذار والتوقف</h4>${Object.keys(reasons).length ? bars(Object.entries(reasons).sort((a, b) => b[1] - a[1])) : '<p class="note">لا يوجد عملاء معتذرون أو متوقفون.</p>'}</div>
    </div>
    <div class="box"><h4>أكبر العروض المفتوحة</h4><div class="tbl"><table>
      <thead><tr><th>العميل</th><th>رقم العرض</th><th>القيمة السنوية</th><th>الحالة</th><th>التاريخ</th><th>المسؤول</th></tr></thead>
      <tbody>${topQ.map(q => `<tr class="click" data-open="${esc(q.deal_id)}"><td>${esc(byId[q.deal_id]?.name || "")}</td><td dir="ltr" style="text-align:right">${esc(q.number)}</td><td>${money(q.annual_value)}</td><td>${esc(q.status)}</td><td class="d">${esc(q.quote_date)}</td><td>${esc(who(byId[q.deal_id]?.ownerId))}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">لا توجد عروض مفتوحة.</td></tr>'}</tbody></table></div></div>`;
  $("#dash").querySelectorAll("[data-open]").forEach(r => r.onclick = () => { dtab = "quotes"; confirmDel = false; drawer(r.dataset.open); });
}

/* ================= Excel: تصدير واستيراد ================= */
async function ensureXLSX(){ if (!window.XLSX) await loadScript("vendor/xlsx.full.min.js"); return window.XLSX; }
const XCOLS = [
  ["name", "اسم العميل", ["اسم العميل","العميل","اسم العميل أو العقار","العميل / العقار","العقار","اسم العقار","الاسم"]],
  ["location", "الموقع", ["الموقع","الحي","العنوان","المدينة والحي"]],
  ["units", "الوحدات", ["الوحدات","عدد الوحدات"]],
  ["source", "المصدر", ["المصدر","مصدر العميل"]],
  ["stage", "المرحلة", ["المرحلة","الحالة"]],
  ["priority", "الأولوية", ["الأولوية"]],
  ["owner", "المسؤول", []],
  ["contract", "العقد الحالي", ["العقد الحالي","العقد","نوع الإدارة"]],
  ["contract_end", "تاريخ انتهاء العقد", ["تاريخ انتهاء العقد","انتهاء العقد","نهاية العقد"]],
  ["last_action", "آخر إجراء", ["آخر إجراء","اخر اجراء"]],
  ["next_step", "الخطوة التالية", ["الخطوة التالية"]],
  ["next_date", "موعد الخطوة", ["موعد الخطوة","موعدها","موعد الخطوة التالية","تاريخ المتابعة","موعد المتابعة"]],
  ["last_activity", "آخر نشاط", []],
  ["cname", "جهة التواصل", ["جهة التواصل","اسم جهة التواصل","اسم المسؤول","المالك"]],
  ["phone", "الجوال", ["الجوال","رقم الجوال","الهاتف","رقم التواصل","رقم الهاتف"]],
  ["lost_reason", "سبب الاعتذار/التوقف", ["سبب الاعتذار/التوقف","سبب الاعتذار"]],
  ["notes", "ملاحظات", ["ملاحظات","الملاحظات"]]
];
const normH = h => String(h || "").replace(/[\s‎‏:*_\-/]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
function toISODate(v){
  const s = String(v || "").trim(); if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s); if (m) { const d = new Date(Number(m[2]), Number(m[1]), 0); return iso(d); }
  return null;
}
$("#xlsOut").onclick = async () => {
  const st = $("#xlsSt");
  try {
    setSt(st, "جارٍ تجهيز الملف…");
    const X = await ensureXLSX(), list = filteredDeals().slice().sort((a, b) => a.order - b.order);
    const val = { owner: d => who(d.ownerId), cname: d => d.contacts.map(c => c.name).filter(Boolean).join(" / "), phone: d => d.contacts.map(c => c.phone).filter(Boolean).join(" / ") };
    const key = { location: "location", units: "units", source: "source", stage: "stage", priority: "priority", contract: "contract", contract_end: "contractEnd", last_action: "lastAction", next_step: "nextStep", next_date: "nextDate", last_activity: "lastActivity", lost_reason: "lostReason", notes: "notes", name: "name" };
    const rows = list.map(d => Object.fromEntries(XCOLS.map(([k, h]) => [h, val[k] ? val[k](d) : (d[key[k]] || "")])));
    const ws = X.utils.json_to_sheet(rows, { header: XCOLS.map(c => c[1]) });
    ws["!cols"] = XCOLS.map(([k]) => ({ wch: ["name","last_action","next_step","notes","contract"].includes(k) ? 30 : k === "phone" || k === "cname" ? 22 : 14 }));
    const ids = new Set(list.map(d => d.id)), byId = Object.fromEntries(deals.map(d => [d.id, d]));
    const qs = X.utils.json_to_sheet(quotes.filter(q => ids.has(q.deal_id)).map(q => ({ "العميل": byId[q.deal_id]?.name || "", "رقم العرض": q.number, "القيمة السنوية": q.annual_value === null ? "" : Number(q.annual_value), "شامل الضريبة": q.vat_included ? "نعم" : "لا", "تاريخ العرض": q.quote_date, "الحالة": q.status, "ملاحظات": q.notes })),
      { header: ["العميل","رقم العرض","القيمة السنوية","شامل الضريبة","تاريخ العرض","الحالة","ملاحظات"] });
    qs["!cols"] = [{ wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 30 }];
    const wb = X.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
    X.utils.book_append_sheet(wb, ws, "العملاء"); X.utils.book_append_sheet(wb, qs, "عروض الأسعار");
    wb.Props = { Title: "عملاء توتال", Author: "رامي هادي رياني", Company: "توتال لإدارة المرافق" };
    X.writeFile(wb, `عملاء توتال ${T}.xlsx`);
    setSt(st, `تم تصدير ${rows.length} عميل.`);
  } catch (e) { setSt(st, "تعذّر التصدير. حاول مرة أخرى.", true); }
};
$("#xlsIn").onclick = () => { $("#xlsFile").value = ""; $("#xlsFile").click(); };
$("#xlsFile").onchange = async () => {
  const f = $("#xlsFile").files[0], st = $("#xlsSt"); if (!f) return;
  if (f.size > 5 * 1048576) return setSt(st, "الملف كبير جداً (الحد 5 ميغابايت).", true);
  setSt(st, "جارٍ قراءة الملف…");
  try {
    const X = await ensureXLSX();
    const wb = X.read(await f.arrayBuffer(), { type: "array", cellDates: true });
    const raw = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false, dateNF: "yyyy-mm-dd" });
    if (!raw.length) return setSt(st, "الملف فارغ.", true);
    const alias = {}; XCOLS.forEach(([k, , al]) => al.forEach(a => { alias[normH(a)] = k; }));
    const heads = Object.keys(raw[0]), map = {}; heads.forEach(h => { const k = alias[normH(h)]; if (k && !map[k]) map[k] = h; });
    if (!map.name) return setSt(st, "لم أجد عمود «اسم العميل» في الملف. اجعل أول صف عناوين الأعمدة.", true);
    const g = (r, k) => map[k] ? String(r[map[k]] ?? "").trim() : "";
    const names = new Set(deals.map(d => d.name.trim()));
    const items = raw.slice(0, 500).map(r => ({
      name: g(r, "name").slice(0, 200), location: g(r, "location"), units: g(r, "units"),
      source: SOURCES.includes(g(r, "source")) ? g(r, "source") : "", stage: STAGES.includes(g(r, "stage")) ? g(r, "stage") : "جديد",
      priority: ["عالية","متوسطة","منخفضة"].includes(g(r, "priority")) ? g(r, "priority") : "", contract: g(r, "contract"),
      contract_end: toISODate(g(r, "contract_end")), last_action: g(r, "last_action"), next_step: g(r, "next_step"), next_date: toISODate(g(r, "next_date")),
      lost_reason: g(r, "lost_reason"), notes: g(r, "notes"), cname: g(r, "cname"), phone: g(r, "phone").split(/\s*\/\s*/)[0]
    })).filter(x => x.name);
    setSt(st, "جارٍ فحص التكرار…");
    for (let i = 0; i < items.length; i += 10) await Promise.all(items.slice(i, i + 10).map(async x => {
      x.exists = names.has(x.name); x.dup = x.phone ? await dupInfo(x.phone) : "";
    }));
    setSt(st, "");
    importDrawer(items, Object.keys(map).length);
  } catch (e) { setSt(st, "تعذّر قراءة الملف. تأكد أنه ملف Excel أو CSV صالح.", true); }
};
function importDrawer(items, nCols){
  const el = $("#drawer"); openId = null;
  const fresh = items.filter(x => !x.exists), dupN = fresh.filter(x => x.dup).length;
  el.innerHTML = `
    <button class="x" id="dx">إغلاق</button>
    <div><div class="eyebrow">استيراد من Excel</div><h3>مراجعة قبل الاستيراد</h3></div>
    <div class="box">
      <p class="note">وجدت <b>${items.length}</b> صف (${nCols} عمود معروف). <b>${fresh.length}</b> عميل جديد، و<b>${items.length - fresh.length}</b> موجود مسبقاً بنفس الاسم وسيتم تخطيه${dupN ? `، و<b>${dupN}</b> رقمه مسجّل مسبقاً لدى الفريق` : ""}.</p>
      ${dupN ? '<label class="chk"><input type="checkbox" id="imSkipDup" checked> تخطي العملاء الذين أرقامهم مسجّلة مسبقاً</label>' : ""}
      ${isAdmin() ? `<div class="field"><label for="imOwner">الموظف المسؤول عن العملاء المستوردين</label><select id="imOwner">${Object.values(people).filter(p => p.active).map(p => `<option value="${esc(p.id)}" ${p.id === me.id ? "selected" : ""}>${esc(p.id === me.id ? "أنا" : (p.full_name || p.email))}</option>`).join("")}</select></div>` : ""}
      <button class="btn" id="imGo" ${fresh.length ? "" : "disabled"}>استيراد العملاء الجدد</button>
      <div class="status" id="imSt" role="status"></div>
    </div>
    <div class="box"><h4>معاينة الصفوف</h4>
      ${items.slice(0, 40).map(x => `<div class="contact"><span><b>${esc(x.name)}</b> <small class="note">${esc([x.location, x.phone].filter(Boolean).join(" · "))}</small>${x.dup ? `<br><small class="status err">${esc(x.dup)}</small>` : ""}</span>
        <span class="pill ${x.exists ? "stop" : x.dup ? "soon" : "ok"}">${x.exists ? "موجود - يُتخطّى" : x.dup ? "رقم مكرر" : "جديد"}</span></div>`).join("")}
      ${items.length > 40 ? `<p class="note">و${items.length - 40} صف آخر…</p>` : ""}
    </div>`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#dx").onclick = closeDrawer;
  $("#imGo").onclick = async () => {
    const skip = $("#imSkipDup") ? $("#imSkipDup").checked : false;
    const list = fresh.filter(x => !(skip && x.dup)), st = $("#imSt");
    if (!list.length) return setSt(st, "لا يوجد عملاء للاستيراد.", true);
    $("#imGo").disabled = true; setSt(st, `جارٍ استيراد ${list.length} عميل…`);
    try {
      const owner = $("#imOwner") ? $("#imOwner").value : me.id;
      let order = deals.reduce((m, d) => Math.max(m, d.order || 0), 0);
      const rows = list.map(x => ({ name: x.name, location: x.location, units: x.units, source: x.source, stage: x.stage, priority: x.priority, contract: x.contract,
        contract_end: x.contract_end, last_action: x.last_action, next_step: x.next_step, next_date: x.next_date, lost_reason: LOST.has(x.stage) ? x.lost_reason : "",
        notes: x.notes, sort_order: (x._o = ++order), owner_id: owner, updated_by: me.id }));
      const { data, error } = await sb.from("deals").insert(rows).select("id, sort_order");
      if (error) throw error;
      const idBy = Object.fromEntries(data.map(r => [r.sort_order, r.id]));
      const cs = list.filter(x => (x.cname || x.phone) && idBy[x._o]).map(x => ({ deal_id: idBy[x._o], name: x.cname, phone: x.phone, sort_order: 0 }));
      if (cs.length) { const r = await sb.from("contacts").insert(cs); if (r.error) throw r.error; }
      await load(); setSt($("#imSt"), `تم استيراد ${data.length} عميل.`); setSt($("#xlsSt"), `تم استيراد ${data.length} عميل من Excel.`);
    } catch (e) { setSt(st, errMsg(e), true); $("#imGo").disabled = false; }
  };
}

/* ================= تقرير PDF ================= */
const NAVY = "#172A7E", TEAL = "#00B6AD", SKY = "#00AEEF";
const TRI = `<i style="background:${NAVY}"></i><i style="background:${TEAL}"></i><i style="background:${SKY}"></i>`;
const SCOPE_T = { all: "تقرير كامل", open: "العملاء المفتوحون", queue: "المتابعات المستحقة" };
const LOGO = "icons/logo.png";
function loadScript(src){ return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
function newPage(stage, title){
  const p = document.createElement("div"); p.className = "rp";
  p.innerHTML = `<div class="rh"><b>${esc(title)}</b><img class="lg" src="${LOGO}" alt=""></div><div class="rb"></div>
    <div class="rf"><div class="tri">${TRI}</div><div class="ft"><span>www.totalfm.co | Info@Totalfm.co | <span class="ltr">+966 11 504 8522</span></span><span class="pg"></span></div>
    <div class="cr">© 2026 نظام متابعة عملاء توتال · إعداد وتصميم: رامي هادي رياني · جميع الحقوق محفوظة</div></div>`;
  stage.appendChild(p); return p.querySelector(".rb");
}
const over = b => b.scrollHeight > b.clientHeight + 1;
function flow(ctx, html){
  const tmp = document.createElement("div"); tmp.innerHTML = html; const el = tmp.firstElementChild;
  ctx.body.appendChild(el);
  if (over(ctx.body) && ctx.body.children.length > 1) { el.remove(); ctx.body = newPage(ctx.stage, ctx.title); ctx.body.appendChild(el); }
  return el;
}
function flowTable(ctx, title, cols, rows){
  const head = `<thead><tr>${cols.map(c => `<th style="width:${c.w}">${c.h}</th>`).join("")}</tr></thead>`;
  let sec = flow(ctx, `<div class="sec"><h2>${title}</h2><table>${head}<tbody></tbody></table></div>`), tb = sec.querySelector("tbody");
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="${cols.length}">لا يوجد.</td></tr>`; return; }
  for (const r of rows) {
    const tr = document.createElement("tr"); tr.innerHTML = r; tb.appendChild(tr);
    if (over(ctx.body)) {
      tr.remove(); ctx.body = newPage(ctx.stage, ctx.title);
      sec = flow(ctx, `<div class="sec"><h2>${title} (تابع)</h2><table>${head}<tbody></tbody></table></div>`); tb = sec.querySelector("tbody"); tb.appendChild(tr);
    }
  }
}
function buildReport(scope){
  const stage = $("#rpStage"); stage.innerHTML = "";
  const title = "تقرير متابعة العملاء", ctx = { stage, title, body: null }; ctx.body = newPage(stage, title);
  const { open, q, dueNow, noDate, soon } = queueParts();
  const cnt = s => deals.filter(d => d.stage === s).length;
  const arDate = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
  flow(ctx, `<div class="sec"><div class="brand"><div><div class="ey">تقرير متابعة العملاء · ${SCOPE_T[scope]}</div><h1>عملاء توتال لإدارة المرافق</h1><div class="sub">بتاريخ ${arDate}</div><div class="by">إعداد: ${esc(profile.full_name || "رامي هادي رياني")}</div></div>
    <img class="logo-big" src="${LOGO}" alt="شعار توتال"></div><div class="bar3">${TRI}</div></div>`);
  flow(ctx, `<div class="kp">
    <div class="${dueNow.length ? "hot" : ""}"><b>${dueNow.length}</b><span>مستحقة اليوم أو متأخرة</span></div>
    <div><b>${soon.length}</b><span>مستحقة خلال 7 أيام</span></div><div><b>${noDate.length}</b><span>بلا موعد متابعة</span></div>
    <div><b>${open.length}</b><span>عملاء مفتوحون</span></div><div><b>${cnt("تم تقديم عرض")}</b><span>تم تقديم عرض</span></div><div><b>${cnt("تم التعاقد")}</b><span>تم التعاقد</span></div></div>`);
  if (scope !== "queue") {
    const max = Math.max(1, ...STAGES.map(cnt));
    flow(ctx, `<div class="sec"><h2>العملاء حسب المرحلة</h2><div class="bars">${STAGES.map(s => `<div class="br"><span>${s}</span><div class="tr"><i style="width:${cnt(s)/max*100}%"></i></div><span class="n">${cnt(s)}</span></div>`).join("")}</div></div>`);
  }
  const phone = d => esc(d.contacts[0]?.phone || "");
  flowTable(ctx, "المتابعات المستحقة", [{h:"العميل / العقار",w:"27%"},{h:"الخطوة التالية",w:"29%"},{h:"الموعد",w:"15%"},{h:"الأولوية",w:"11%"},{h:"الجوال",w:"18%"}],
    q.slice().sort(sortQ).map(d => { const u = due(d); return `<td>${esc(d.name)}</td><td>${esc(d.nextStep || "—")}</td><td><span class="tag ${u.k}">${esc(d.nextDate ? (u.t === "اليوم" ? "اليوم" : d.nextDate) : "بلا موعد")}</span></td><td>${esc(d.priority || "—")}</td><td class="n">${phone(d)}</td>`; }));
  const { renew } = queueParts();
  if (renew.length) flowTable(ctx, "عقود تنتهي خلال 90 يوماً", [{h:"العميل / العقار",w:"30%"},{h:"انتهاء العقد",w:"16%"},{h:"المتبقي",w:"20%"},{h:"المرحلة",w:"16%"},{h:"الجوال",w:"18%"}],
    renew.map(d => { const r = renewal(d); return `<td>${esc(d.name)}</td><td class="n">${esc(d.contractEnd)}</td><td><span class="tag ${r.k}">${esc(r.t)}</span></td><td>${esc(d.stage)}</td><td class="n">${phone(d)}</td>`; }));
  if (scope !== "queue") {
    const list = (scope === "open" ? open : deals).slice().sort((a,b) => a.order - b.order);
    flowTable(ctx, scope === "open" ? "العملاء المفتوحون" : "سجل العملاء", [{h:"العميل / العقار",w:"20%"},{h:"الموقع",w:"15%"},{h:"الوحدات",w:"9%"},{h:"المرحلة",w:"11%"},{h:"آخر إجراء",w:"17%"},{h:"الخطوة التالية",w:"16%"},{h:"الجوال",w:"12%"}],
      list.map(d => `<td>${esc(d.name)}</td><td>${esc(d.location || "—")}</td><td>${esc(d.units || "—")}</td><td>${esc(d.stage)}</td><td>${esc(d.lastAction || "—")}</td><td>${esc(d.nextStep || "—")}</td><td class="n">${phone(d)}</td>`));
    flowTable(ctx, "آخر النشاط", [{h:"التاريخ",w:"13%"},{h:"النوع",w:"10%"},{h:"العميل",w:"22%"},{h:"الملخص",w:"55%"}],
      acts.slice(0,20).map(a => `<td class="n">${esc(a.date)}</td><td>${esc(a.type)}</td><td>${esc(a.dealName)}</td><td class="w">${esc(a.summary)}</td>`));
  }
  const pages = [...stage.querySelectorAll(".rp")];
  pages.forEach((p,i) => p.querySelector(".pg").textContent = `صفحة ${i+1} من ${pages.length}`);
  return pages;
}
$("#rpBtn").addEventListener("click", async () => {
  const st = $("#rpSt"), btn = $("#rpBtn");
  btn.disabled = true; setSt(st, "جارٍ تجهيز التقرير…");
  try {
    if (!window.jspdf) await loadScript("vendor/jspdf.umd.min.js");
    if (!window.html2canvas) await loadScript("vendor/html2canvas.min.js");
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const pages = buildReport($("#rpScope").value);
    await Promise.all([...$("#rpStage").querySelectorAll("img")].map(i => i.decode ? i.decode().catch(() => {}) : null));
    const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true });
    pdf.setProperties({ title: "Total FM - Client Follow-up Report " + T, author: "Rami Hadi Rayyani", creator: "Rami Hadi Rayyani - Total FM Client Follow-up System", subject: "Copyright 2026 Rami Hadi Rayyani. All rights reserved." });
    for (let i = 0; i < pages.length; i++) {
      const c = await window.html2canvas(pages[i], { scale: 2, backgroundColor: "#ffffff", logging: false });
      if (i) pdf.addPage();
      pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 210, 297);
    }
    $("#rpStage").innerHTML = "";
    pdf.save(`تقرير عملاء توتال ${T}.pdf`);
    setSt(st, `تم تنزيل التقرير (${pages.length} صفحات)`);
  } catch (e) { setSt(st, "تعذّر إنشاء التقرير. حاول مرة أخرى.", true); }
  finally { btn.disabled = false; }
});

/* ================= تطبيق الجوال ================= */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBox").hidden = false; });
$("#installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#installBox").hidden = true; };
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (isIOS && !standalone) { $("#installBox").hidden = false; $("#installBox").querySelector("span").textContent = "لتثبيته على الآيفون: اضغط زر المشاركة في Safari ثم «إضافة إلى الشاشة الرئيسية»."; $("#installBtn").hidden = true; }
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

setAuthMode("login");
boot();
})();
