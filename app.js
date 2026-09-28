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

let me = null, profile = null, deals = [], acts = [], people = {}, tab = "queue", openId = null, confirmDel = false, booted = false;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const iso = d => new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const todayISO = () => iso(new Date());
const addDays = (s,n) => { const d = new Date(s+"T00:00:00"); d.setDate(d.getDate()+n); return iso(d); };
let T = todayISO();
const redirectURL = () => location.origin + location.pathname;

function show(view){ ["authView","pendingView","newPassView","appView"].forEach(v => $("#"+v).hidden = v !== view); }
function setSt(el, msg, err){ el.className = "status" + (err ? " err" : ""); el.textContent = msg || ""; }
function errMsg(e){
  const m = (e && (e.message || e.error_description)) || "";
  if (/Invalid login credentials/i.test(m)) return "البريد أو كلمة المرور غير صحيحة.";
  if (/Email not confirmed/i.test(m)) return "أكّد بريدك أولاً من الرسالة التي وصلتك، ثم سجّل الدخول.";
  if (/already registered|already been registered/i.test(m)) return "هذا البريد مسجّل مسبقاً. سجّل الدخول أو استخدم (نسيت كلمة المرور).";
  if (/rate limit|too many/i.test(m)) return "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.";
  if (/Password should be/i.test(m)) return "كلمة المرور قصيرة. استخدم 8 أحرف على الأقل.";
  if (/network|fetch/i.test(m)) return "تعذّر الاتصال بالخادم. تحقّق من الإنترنت.";
  if (/row-level security|permission/i.test(m)) return "ليست لديك صلاحية لهذا الإجراء.";
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
  setSt($("#authSt"), "");
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
  me = session.user;
  const { data: p, error } = await sb.from("profiles").select("*").eq("id", me.id).maybeSingle();
  if (error) { show("authView"); setSt($("#authSt"), errMsg(error), true); return; }
  profile = p;
  if (!p || !p.active) { $("#pendingEmail").textContent = me.email; show("pendingView"); return; }
  $("#me").textContent = (p.full_name || p.email) + (p.role === "admin" ? " · مدير" : "");
  $("#teamTab").hidden = p.role !== "admin";
  show("appView");
  if (!booted) { booted = true; setInterval(() => { if (!document.hidden) load(); }, 60000); }
  await load();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && booted) { T = todayISO(); load(); } });

/* ================= البيانات ================= */
function mapDeal(r){
  return { id: r.id, order: r.sort_order, name: r.name, location: r.location, units: r.units, contract: r.contract, source: r.source,
    stage: r.stage, priority: r.priority || "", lastAction: r.last_action, nextStep: r.next_step, nextDate: r.next_date || "",
    dateBasis: r.date_basis, lastActivity: r.last_activity || "", notes: r.notes, updatedAt: r.updated_at, updatedBy: r.updated_by,
    contacts: (r.contacts || []).sort((a,b) => a.sort_order - b.sort_order) };
}
async function load(){
  try {
    const [d, a, p] = await Promise.all([
      sb.from("deals").select("*, contacts(*)").order("sort_order"),
      sb.from("activity").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(1000),
      sb.from("profiles").select("id, email, full_name, role, active, created_at").order("created_at")
    ]);
    if (d.error) throw d.error; if (a.error) throw a.error;
    deals = d.data.map(mapDeal);
    const byId = Object.fromEntries(deals.map(x => [x.id, x]));
    acts = a.data.map(r => ({ id: r.id, dealId: r.deal_id, dealName: byId[r.deal_id]?.name || "", date: r.date, type: r.type, contact: r.contact, summary: r.summary, createdBy: r.created_by, createdAt: r.created_at }));
    people = Object.fromEntries((p.data || []).map(x => [x.id, x]));
    $("#conn").textContent = "";
    render();
    if (tab === "team") renderTeam();
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
  const u = due(d), c = d.contacts[0];
  return `<button class="row" data-id="${esc(d.id)}">
    <div><div class="nm">${esc(d.name)}</div><div class="sub">${esc([d.location, d.units && ("الوحدات: " + d.units)].filter(Boolean).join(" · ") || (c ? c.phone : ""))}</div></div>
    <div><div class="nx">${d.nextStep ? esc(d.nextStep) : '<span class="sub">لا توجد خطوة تالية</span>'}</div><div class="sub">${esc(d.lastAction || "")}</div></div>
    <div class="meta">${d.priority ? `<span class="pill ${d.priority === "عالية" ? "hi" : ""}">${esc(d.priority)}</span>` : ""}${stagePill(d.stage)}${u ? `<span class="pill ${u.k}">${esc(u.t)}</span>` : ""}</div>
  </button>`;
}
const sortQ = (a,b) => (PR[a.priority||""] - PR[b.priority||""]) || ((a.nextDate||"0") < (b.nextDate||"0") ? -1 : (a.nextDate||"0") > (b.nextDate||"0") ? 1 : 0) || a.order - b.order;

function queueParts(){
  const open = deals.filter(d => !CLOSED.has(d.stage));
  const q = open.filter(d => { const u = due(d); return u && (u.k === "due" || u.k === "soon"); });
  return { open, q, dueNow: q.filter(d => due(d).k === "due" && d.nextDate && d.nextStep), noDate: q.filter(d => !d.nextDate || !d.nextStep), soon: q.filter(d => due(d).k === "soon") };
}
function render(){
  const { open, dueNow, noDate, soon } = queueParts();
  const cnt = s => deals.filter(d => d.stage === s).length;
  $("#stats").innerHTML = [
    ["hot", dueNow.length, "مستحقة اليوم أو متأخرة"], ["", soon.length, "خلال 7 أيام"], ["", noDate.length, "بلا موعد متابعة"],
    ["", open.length, "عملاء مفتوحون"], ["", cnt("تم تقديم عرض"), "تم تقديم عرض"], ["", cnt("تم التعاقد"), "تم التعاقد"]
  ].map(([c,n,l]) => `<div class="stat ${c && n ? c : ""}"><b>${n}</b><span>${l}</span></div>`).join("");
  const grp = (t, l) => l.length ? `<div class="group"><h2>${t} · ${l.length}</h2>${l.slice().sort(sortQ).map(rowHTML).join("")}</div>` : "";
  $("#queue").innerHTML = (grp("مستحقة الآن", dueNow) + grp("هذا الأسبوع", soon) + grp("بلا موعد متابعة", noDate)) || `<div class="empty">لا توجد متابعات مستحقة.</div>`;

  const s = $("#q").value.trim(), fs = $("#fStage").value, fr = $("#fSrc").value;
  const list = deals.filter(d => (!fs || d.stage === fs) && (!fr || d.source === fr) &&
    (!s || [d.name, d.location, d.notes, ...d.contacts.flatMap(c => [c.name, c.phone])].join(" ").includes(s)));
  $("#deals").innerHTML = list.map(rowHTML).join("") || `<div class="empty">لا يوجد عميل مطابق.</div>`;

  $("#log").innerHTML = acts.map(a => `<tr><td class="d">${esc(a.date)}</td><td>${esc(a.type)}</td><td>${esc(a.dealName)}</td><td>${esc(a.contact)}</td><td>${esc(a.summary)}</td><td>${esc(who(a.createdBy))}</td></tr>`).join("")
    || `<tr><td colspan="6" class="empty">لا يوجد نشاط مسجل بعد.</td></tr>`;
  if (openId) drawer(openId, true);
}

document.addEventListener("click", e => {
  const r = e.target.closest(".row"); if (r) { confirmDel = false; drawer(r.dataset.id); return; }
  const t = e.target.closest("nav button"); if (t) {
    tab = t.dataset.tab;
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b === t));
    ["queue","deals","log","team"].forEach(n => $("#p-"+n).hidden = n !== tab);
    if (tab === "team") renderTeam();
    return;
  }
  const cp = e.target.closest("[data-copy]"); if (cp) {
    const v = cp.dataset.copy;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => { cp.textContent = "نُسخ"; }, () => {});
  }
});
["#q","#fStage","#fSrc"].forEach(s => $(s).addEventListener("input", render));
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
function closeDrawer(){ openId = null; $("#drawer").hidden = true; $("#scrim").hidden = true; }

/* ================= تفاصيل العميل ================= */
function drawer(id, refresh){
  const d = deals.find(x => x.id === id); if (!d) { closeDrawer(); return; }
  const el = $("#drawer");
  if (refresh && el.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) return;
  openId = id;
  const hist = acts.filter(a => a.dealId === id);
  const isAdmin = profile && profile.role === "admin";
  el.innerHTML = `
    <button class="x" id="dx">إغلاق</button>
    <div><div class="eyebrow">${esc(d.source || "")}</div><h3>${esc(d.name)}</h3></div>
    <dl class="facts">
      ${d.location ? `<dt>الموقع</dt><dd>${esc(d.location)}</dd>` : ""}
      ${d.units ? `<dt>الوحدات</dt><dd>${esc(d.units)}</dd>` : ""}
      ${d.contract ? `<dt>العقد الحالي</dt><dd>${esc(d.contract)}</dd>` : ""}
      ${d.lastActivity ? `<dt>آخر نشاط</dt><dd>${esc(d.lastActivity)}</dd>` : ""}
      ${d.dateBasis ? `<dt>أساس الموعد</dt><dd>${esc(d.dateBasis)}</dd>` : ""}
      ${d.updatedBy ? `<dt>آخر تعديل</dt><dd>${esc(who(d.updatedBy))} · ${esc((d.updatedAt || "").slice(0,10))}</dd>` : ""}
    </dl>
    <div class="box"><h4>جهات التواصل</h4>
      ${d.contacts.map(c => `<div class="contact"><span>${esc(c.name)}${c.role ? ` <small class="note">(${esc(c.role)})</small>` : ""}</span>
        <span><span class="phone">${esc(c.phone)}</span> <button class="btn ghost" data-copy="${esc(c.phone)}">نسخ</button> <button class="btn ghost" data-delc="${esc(c.id)}" aria-label="حذف جهة التواصل">حذف</button></span></div>`).join("") || '<span class="note">لا توجد جهة تواصل مسجلة.</span>'}
      <div class="three">
        <div class="field"><label for="cName">الاسم</label><input id="cName"></div>
        <div class="field"><label for="cPhone">الجوال</label><input id="cPhone" inputmode="tel" dir="ltr"></div>
        <div class="field"><label for="cRole">الصفة</label><input id="cRole" placeholder="مالك، رئيس الجمعية…"></div>
        <button class="btn ghost" id="addC">إضافة</button>
      </div>
    </div>
    <div class="box"><h4>تسجيل ما حدث</h4>
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
      <div class="field"><label for="nNotes">ملاحظات</label><textarea id="nNotes" rows="2">${esc(d.notes)}</textarea></div>
      <button class="btn" id="save">حفظ</button>
      <div class="status" id="st" role="status"></div>
    </div>
    <div class="box"><h4>السجل</h4><div class="hist">${hist.map(a => `<div><small>${esc(a.date)} · ${esc(a.type)}${a.createdBy ? " · " + esc(who(a.createdBy)) : ""}</small><br>${esc(a.summary)}</div>`).join("") || '<span class="note">لا يوجد نشاط مسجل.</span>'}</div></div>
    ${isAdmin ? `<div class="box"><h4>حذف العميل</h4>${confirmDel
      ? `<p class="note">سيُحذف العميل وجهات تواصله وسجله نهائياً.</p><div class="tools"><button class="btn danger" id="delYes">تأكيد الحذف</button><button class="btn ghost" id="delNo">إلغاء</button></div>`
      : `<button class="btn ghost" id="delDeal">حذف هذا العميل</button>`}</div>` : ""}`;
  el.hidden = false; $("#scrim").hidden = false;
  $("#dx").onclick = closeDrawer;
  $("#save").onclick = () => save(d);
  $("#addC").onclick = () => addContact(d);
  el.querySelectorAll("[data-delc]").forEach(b => b.onclick = () => delContact(b.dataset.delc));
  if ($("#delDeal")) $("#delDeal").onclick = () => { confirmDel = true; drawer(id); };
  if ($("#delNo")) $("#delNo").onclick = () => { confirmDel = false; drawer(id); };
  if ($("#delYes")) $("#delYes").onclick = () => delDeal(d);
}

async function save(d){
  const st = $("#st"), btn = $("#save");
  const sum = $("#aSum").value.trim(), date = $("#aDate").value || T, type = $("#aType").value;
  const upd = { next_step: $("#nStep").value.trim(), next_date: $("#nDate").value || null, stage: $("#nStage").value, priority: $("#nPr").value, notes: $("#nNotes").value.trim(), updated_by: me.id };
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
async function addContact(d){
  const name = $("#cName").value.trim(), phone = $("#cPhone").value.trim(), role = $("#cRole").value.trim(), st = $("#st");
  if (!name && !phone) return setSt(st, "اكتب اسم جهة التواصل أو رقمها.", true);
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
    let r = await sb.from("activity").delete().eq("deal_id", d.id); if (r.error) throw r.error;
    r = await sb.from("contacts").delete().eq("deal_id", d.id); if (r.error) throw r.error;
    r = await sb.from("deals").delete().eq("id", d.id); if (r.error) throw r.error;
    confirmDel = false; closeDrawer(); await load();
  } catch (e) { setSt($("#st"), errMsg(e), true); }
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
      <div class="field"><label for="ndContract">العقد الحالي</label><input id="ndContract" placeholder="مثال: عقد ينتهي 12-2026"></div>
      <div class="two">
        <div class="field"><label for="ndCName">جهة التواصل</label><input id="ndCName"></div>
        <div class="field"><label for="ndCPhone">الجوال</label><input id="ndCPhone" inputmode="tel" dir="ltr"></div>
      </div>
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
  $("#ndSave").onclick = async () => {
    const st = $("#ndSt"), name = $("#ndName").value.trim();
    if (!name) return setSt(st, "اكتب اسم العميل.", true);
    $("#ndSave").disabled = true; setSt(st, "جارٍ الحفظ…");
    try {
      const order = deals.reduce((m, d) => Math.max(m, d.order || 0), 0) + 1;
      const { data, error } = await sb.from("deals").insert({
        name, location: $("#ndLoc").value.trim(), units: $("#ndUnits").value.trim(), source: $("#ndSrc").value, priority: $("#ndPr").value,
        contract: $("#ndContract").value.trim(), next_step: $("#ndStep").value.trim(), next_date: $("#ndDate").value || null,
        notes: $("#ndNotes").value.trim(), stage: "جديد", sort_order: order, updated_by: me.id
      }).select("id").single();
      if (error) throw error;
      const cn = $("#ndCName").value.trim(), cp = $("#ndCPhone").value.trim();
      if (cn || cp) { const r = await sb.from("contacts").insert({ deal_id: data.id, name: cn, phone: cp, sort_order: 0 }); if (r.error) throw r.error; }
      await load(); drawer(data.id);
    } catch (e) { setSt(st, errMsg(e), true); $("#ndSave").disabled = false; }
  };
  $("#ndName").focus();
};

/* ================= الفريق (للمدير) ================= */
function renderTeam(){
  const list = Object.values(people);
  $("#team").innerHTML = list.map(p => `<div class="team-row">
      <div><b>${esc(p.full_name || "—")}</b><div class="note" dir="ltr" style="text-align:right">${esc(p.email)}</div></div>
      <span class="pill ${p.active ? "ok" : "soon"}">${p.active ? (p.role === "admin" ? "مدير" : "مفعّل") : "بانتظار التفعيل"}</span>
      ${p.id === me.id ? '<span class="note">أنت</span>' : `<div class="tools">
        <button class="btn ghost" data-act="${p.active ? "off" : "on"}" data-uid="${esc(p.id)}">${p.active ? "إيقاف" : "تفعيل"}</button>
        ${p.active ? `<button class="btn ghost" data-act="${p.role === "admin" ? "member" : "admin"}" data-uid="${esc(p.id)}">${p.role === "admin" ? "إلغاء الإدارة" : "جعله مديراً"}</button>` : ""}
      </div>`}
    </div>`).join("") || '<p class="note">لا يوجد أعضاء بعد.</p>';
  $("#team").querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
    const a = b.dataset.act, upd = a === "on" ? { active: true } : a === "off" ? { active: false } : { role: a };
    b.disabled = true;
    const { error } = await sb.from("profiles").update(upd).eq("id", b.dataset.uid);
    if (error) setSt($("#teamSt"), errMsg(error), true); else setSt($("#teamSt"), "تم التحديث.");
    await load();
  });
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
