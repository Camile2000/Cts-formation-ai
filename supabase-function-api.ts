import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const enc = new TextEncoder();
const out = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (m: string, s = 400) => out({ error: m }, s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function rnd(n: number) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle<T>(arr: T[]): T[] { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function token() { const a = new Uint8Array(32); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, "0")).join(""); }
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode() { let s = ""; for (let i = 0; i < 12; i++) s += ALPHA[rnd(ALPHA.length)]; return `CTS-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`; }
const norm = (c: string) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const QUIZ_SCOPES = ["s1", "s2", "s3", "s4", "s5", "s8", "s9"];
const SCOPES = [...QUIZ_SCOPES, "exam"];
const ORDER = SCOPES; // ordre imposé : chaque test s'ouvre après validation du précédent
const LABEL: Record<string, string> = { s1: "le quiz de la séance 1", s2: "le quiz de la séance 2", s3: "le quiz de la séance 3", s4: "le quiz de la séance 4", s5: "le quiz de la séance 5", s8: "le quiz métier de la séance 8", s9: "le quiz de la séance 9", exam: "l'examen final" };
const CFG: Record<string, { n: number; secs: number; base: number }> = {};
QUIZ_SCOPES.forEach((s) => (CFG[s] = { n: 3, secs: 360, base: 1 }));
CFG.exam = { n: 12, secs: 1500, base: 1 };
const CATS = ["concepts", "rctf", "verif", "secu", "fichiers", "integration"];
const GRACE = 15;
const POSTES = ["secretariat", "compta"];

async function tooMany(ip: string) {
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const { count } = await sb.from("login_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).eq("ok", false).gte("at", since);
  return (count || 0) >= 8;
}
async function newSession(role: string, candidate_id: string | null, hours: number) {
  const t = token();
  await sb.from("sessions").insert({ token_hash: await sha(t), role, candidate_id, expires_at: new Date(Date.now() + hours * 3600e3).toISOString() });
  return t;
}
async function auth(req: Request, role: string) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!t || t.length < 20) return null;
  const { data } = await sb.from("sessions").select("role,candidate_id,expires_at").eq("token_hash", await sha(t)).maybeSingle();
  if (!data || data.role !== role || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function finalize(att: any, status: "termine" | "expire") {
  if (att.status !== "en_cours") return att;
  const { data: qs } = await sb.from("questions").select("id,correct").in("id", att.question_ids);
  const cmap = new Map((qs || []).map((x: any) => [x.id, x.correct]));
  let score = 0;
  for (const id of att.question_ids) {
    const sel = att.answers?.[id];
    if (sel === undefined || sel === null) continue;
    const perm = att.orders?.[id];
    if (perm && perm[sel] === cmap.get(id)) score++;
  }
  const max = att.question_ids.length;
  const now = new Date();
  const dur = Math.min(Math.round((now.getTime() - new Date(att.started_at).getTime()) / 1000), CFG[att.scope].secs);
  const { data } = await sb.from("attempts").update({ status, submitted_at: now.toISOString(), score, max, passed: score * 3 >= max * 2, duration_s: dur, answers: att.answers || {} }).eq("id", att.id).eq("status", "en_cours").select().maybeSingle();
  if (data) return data;
  const { data: again } = await sb.from("attempts").select().eq("id", att.id).single();
  return again;
}
async function sweep(candId: string) {
  const lim = new Date(Date.now() - GRACE * 1000).toISOString();
  const { data } = await sb.from("attempts").select().eq("candidate_id", candId).eq("status", "en_cours").lt("deadline", lim);
  for (const a of data || []) await finalize(a, "expire");
}
async function getAttempt(id: string, candId: string) {
  if (!UUID.test(id || "")) return null;
  const { data } = await sb.from("attempts").select().eq("id", id).eq("candidate_id", candId).maybeSingle();
  return data;
}

async function draw(cand: any, scope: string) {
  const { data: prev } = await sb.from("attempts").select("question_ids").eq("candidate_id", cand.id).eq("scope", scope);
  const seen = new Set<string>();
  (prev || []).forEach((a: any) => a.question_ids.forEach((q: string) => seen.add(q)));
  let qb = sb.from("questions").select("id,cat,q,options").eq("scope", scope).eq("active", true);
  if (scope === "s8") qb = qb.eq("poste", cand.poste);
  const { data: bank } = await qb;
  const pick = (pool: any[], n: number) => {
    const fresh = shuffle(pool.filter((x) => !seen.has(x.id)));
    if (fresh.length >= n) return fresh.slice(0, n);
    return fresh.concat(shuffle(pool.filter((x) => seen.has(x.id))).slice(0, n - fresh.length));
  };
  let chosen: any[] = [];
  if (scope === "exam") { for (const c of CATS) chosen = chosen.concat(pick((bank || []).filter((x: any) => x.cat === c), 2)); }
  else chosen = pick(bank || [], CFG[scope].n);
  return shuffle(chosen);
}
function publicAttempt(att: any, rows: any[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    id: att.id, scope: att.scope, deadline: att.deadline,
    remaining_s: Math.max(0, Math.round((new Date(att.deadline).getTime() - Date.now()) / 1000)),
    duration_s: CFG[att.scope].secs,
    answers: att.answers || {},
    questions: att.question_ids.map((id: string) => { const r: any = byId.get(id); const perm: number[] = att.orders[id]; return { id, q: r.q, options: perm.map((i) => r.options[i]) }; }),
  };
}

// Résumé des tentatives terminées d'un test (toutes les tentatives, dans l'ordre)
function triesOf(list: any[]) {
  return list.filter((a: any) => a.status !== "en_cours")
    .sort((a: any, b: any) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
    .map((a: any, i: number) => ({ n: i + 1, score: a.score, max: a.max, passed: !!a.passed, status: a.status, at: a.submitted_at, duration_s: a.duration_s }));
}

async function progress(cand: any) {
  await sweep(cand.id);
  const [{ data: atts }, { data: gr }] = await Promise.all([
    sb.from("attempts").select("id,scope,status,score,max,passed,started_at,submitted_at,duration_s,deadline").eq("candidate_id", cand.id),
    sb.from("grants").select("scope,extra").eq("candidate_id", cand.id),
  ]);
  const ex = new Map((gr || []).map((g: any) => [g.scope, g.extra]));
  const prog: any = {};
  for (const s of SCOPES) {
    const list = (atts || []).filter((a: any) => a.scope === s);
    const done = list.filter((a: any) => a.status !== "en_cours");
    const best = done.reduce((m: any, a: any) => (!m || a.score > m.score ? a : m), null);
    const live = list.find((a: any) => a.status === "en_cours");
    prog[s] = { used: list.length, allowed: CFG[s].base + (ex.get(s) || 0), best: best ? best.score : null, max: best ? best.max : null, passed: best ? done.some((a: any) => a.passed) : null, validated: done.some((a: any) => a.passed), tries: triesOf(list), in_progress: live ? live.id : null, finished: done.length, locked: false, needs: null };
  }
  // Progression imposée : un test n'est ouvert que si tous les précédents sont validés.
  let first: string | null = null;
  for (const s of ORDER) {
    prog[s].needs = first; prog[s].locked = first !== null;
    if (first === null && !prog[s].validated) first = s;
  }
  const unlocked = !prog.exam.locked;
  return { nom: cand.nom, poste: cand.poste, progress: prog, exam_unlocked: unlocked, next: first };
}

async function review(att: any) {
  const { data: rows } = await sb.from("questions").select("id,q,options,correct,why").in("id", att.question_ids);
  const byId = new Map((rows || []).map((r: any) => [r.id, r]));
  return att.question_ids.map((id: string) => {
    const r: any = byId.get(id); const perm: number[] = att.orders[id];
    const sel = att.answers?.[id];
    return { q: r.q, options: perm.map((i) => r.options[i]), selected: sel === undefined ? null : sel, correct: perm.indexOf(r.correct), why: r.why };
  });
}

async function handleCandidate(action: string, b: any, req: Request, ses: any) {
  const { data: cand } = await sb.from("candidates").select().eq("id", ses.candidate_id).maybeSingle();
  if (!cand || !cand.active) return fail("Accès désactivé.", 403);
  if (action === "me") return out(await progress(cand));
  if (action === "start") {
    const scope = String(b.scope || "");
    if (!SCOPES.includes(scope)) return fail("Test inconnu.");
    await sweep(cand.id);
    const { data: lives } = await sb.from("attempts").select().eq("candidate_id", cand.id).eq("status", "en_cours");
    const live = (lives || []).find((x: any) => x.scope === scope);
    if ((lives || []).some((x: any) => x.scope !== scope)) return fail("Un autre test est en cours : terminez-le d'abord.", 409);
    if (live) {
      const { data: rows } = await sb.from("questions").select("id,q,options").in("id", live.question_ids);
      return out({ attempt: publicAttempt(live, rows || []), resumed: true });
    }
    const p = await progress(cand);
    const pr = p.progress[scope];
    if (pr.locked) return fail(`Ce test est verrouillé : validez d'abord ${LABEL[pr.needs]}.`, 403);
    if (pr.validated) return fail("Ce test est déjà validé.", 409);
    if (pr.used >= pr.allowed) return fail(scope === "exam" ? "Tentative d'examen déjà utilisée. Contactez l'administrateur." : "Nombre de tentatives atteint pour ce quiz. Contactez l'administrateur pour en obtenir une de plus.", 403);
    const rows = await draw(cand, scope);
    if (rows.length < CFG[scope].n) return fail("Banque de questions insuffisante.", 500);
    const orders: any = {};
    rows.forEach((r: any) => { orders[r.id] = shuffle(r.options.map((_: any, i: number) => i)); });
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "inconnu";
    const { data: att, error } = await sb.from("attempts").insert({ candidate_id: cand.id, scope, deadline: new Date(Date.now() + CFG[scope].secs * 1000).toISOString(), question_ids: rows.map((r: any) => r.id), orders, ip }).select().single();
    if (error) { console.error(error); return fail("Impossible de démarrer le test.", 500); }
    return out({ attempt: publicAttempt(att, rows), resumed: false });
  }
  const att = await getAttempt(String(b.attempt_id || ""), cand.id);
  if (!att) return fail("Tentative introuvable.", 404);
  if (action === "answer") {
    if (att.status !== "en_cours") return fail("Test terminé.", 409);
    if (Date.now() > new Date(att.deadline).getTime() + GRACE * 1000) return fail("Temps écoulé.", 409);
    const qid = String(b.qid || ""); const ch = Number(b.choice);
    if (!att.question_ids.includes(qid) || !Number.isInteger(ch) || ch < 0 || ch >= att.orders[qid].length) return fail("Réponse invalide.");
    const answers = { ...(att.answers || {}), [qid]: ch };
    await sb.from("attempts").update({ answers }).eq("id", att.id).eq("status", "en_cours");
    return out({ ok: true });
  }
  if (action === "event") {
    if (att.status !== "en_cours") return out({ ok: true });
    const t = String(b.type || "");
    if (t === "blur") await sb.from("attempts").update({ blur_count: att.blur_count + 1 }).eq("id", att.id);
    else if (t === "paste" || t === "copy") await sb.from("attempts").update({ paste_count: att.paste_count + 1 }).eq("id", att.id);
    return out({ ok: true });
  }
  if (action === "submit") {
    const late = Date.now() > new Date(att.deadline).getTime() + GRACE * 1000;
    if (att.status === "en_cours" && !late && b.answers && typeof b.answers === "object") {
      const merged: any = { ...(att.answers || {}) };
      for (const [k, v] of Object.entries(b.answers)) {
        const n = Number(v);
        if (att.question_ids.includes(k) && Number.isInteger(n) && n >= 0 && n < att.orders[k].length) merged[k] = n;
      }
      att.answers = merged;
    }
    const done = await finalize(att, late ? "expire" : "termine");
    const res: any = { scope: done.scope, score: done.score, max: done.max, passed: done.passed, status: done.status, duration_s: done.duration_s };
    if (done.scope !== "exam") res.review = await review(done);
    return out(res);
  }
  return fail("Action inconnue.");
}

async function handleAdmin(action: string, b: any) {
  if (action === "admin_overview") {
    const [{ data: cands }, { data: atts }, { data: gr }] = await Promise.all([
      sb.from("candidates").select("id,nom,email,poste,active,created_at,last_login").order("created_at"),
      sb.from("attempts").select("id,candidate_id,scope,status,score,max,passed,started_at,submitted_at,duration_s,blur_count,paste_count").order("started_at"),
      sb.from("grants").select("candidate_id,scope,extra"),
    ]);
    const rows = (cands || []).map((c: any) => {
      const mine = (atts || []).filter((a: any) => a.candidate_id === c.id);
      const scopes: any = {};
      for (const s of SCOPES) {
        const l = mine.filter((a: any) => a.scope === s);
        const done = l.filter((a: any) => a.status !== "en_cours");
        const best = done.reduce((m: any, a: any) => (!m || a.score > m.score ? a : m), null);
        const extra = (gr || []).find((g: any) => g.candidate_id === c.id && g.scope === s)?.extra || 0;
        scopes[s] = { attempts: l.length, allowed: CFG[s].base + extra, best: best ? best.score : null, max: best ? best.max : null, passed: best ? best.passed : null, validated: done.some((a: any) => a.passed), tries: triesOf(l), in_progress: l.some((a: any) => a.status === "en_cours") };
      }
      const exams = mine.filter((a: any) => a.scope === "exam");
      const flags: string[] = [];
      exams.forEach((a: any) => {
        if (a.blur_count >= 3) flags.push(`Examen : ${a.blur_count} sorties de la page`);
        if (a.paste_count > 0) flags.push(`Examen : ${a.paste_count} copier/coller`);
        if (a.status !== "en_cours" && a.duration_s !== null && a.duration_s < 90) flags.push(`Examen : terminé en ${a.duration_s} s`);
      });
      const quizFlags = mine.filter((a: any) => a.scope !== "exam" && a.status !== "en_cours" && ((a.blur_count || 0) >= 5 || (a.paste_count || 0) > 0)).length;
      if (quizFlags) flags.push(`${quizFlags} quiz avec sorties de page ou copier/coller`);
      let next: string | null = null;
      for (const s of ORDER) { if (!scopes[s].validated) { next = s; break; } }
      return { ...c, scopes, attempts: mine, flags, next, quizzes_done: QUIZ_SCOPES.filter((s) => scopes[s].best !== null).length, quizzes_passed: QUIZ_SCOPES.filter((s) => scopes[s].validated).length };
    });
    const fin = (atts || []).filter((a: any) => a.status !== "en_cours").map((a: any) => a.id);
    let hard: any[] = [];
    if (fin.length) {
      const { data: full } = await sb.from("attempts").select("question_ids,answers,orders").in("id", fin);
      const { data: qs } = await sb.from("questions").select("id,q,scope,correct");
      const qm = new Map((qs || []).map((q: any) => [q.id, q]));
      const st = new Map<string, { n: number; ok: number }>();
      (full || []).forEach((a: any) => a.question_ids.forEach((id: string) => {
        const q: any = qm.get(id); if (!q) return;
        const s = st.get(id) || { n: 0, ok: 0 }; s.n++;
        const sel = a.answers?.[id];
        if (sel !== undefined && a.orders[id][sel] === q.correct) s.ok++;
        st.set(id, s);
      }));
      hard = [...st.entries()].map(([id, s]) => ({ id, q: (qm.get(id) as any).q, scope: (qm.get(id) as any).scope, n: s.n, rate: Math.round((s.ok / s.n) * 100) })).filter((x) => x.n >= 2).sort((a, b) => a.rate - b.rate).slice(0, 10);
    }
    const exs = rows.map((r: any) => r.scopes.exam).filter((e: any) => e.best !== null);
    return out({ candidates: rows, hard, summary: { total: rows.length, exam_done: exs.length, exam_passed: exs.filter((e: any) => e.passed).length, exam_avg: exs.length ? Math.round((exs.reduce((t: number, e: any) => t + e.best, 0) / exs.length) * 10) / 10 : null } });
  }
  if (action === "admin_create") {
    const nom = String(b.nom || "").trim().slice(0, 80); const email = String(b.email || "").trim().slice(0, 120); const poste = String(b.poste || "");
    if (nom.length < 2 || !POSTES.includes(poste)) return fail("Nom ou poste invalide.");
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const { data, error } = await sb.from("candidates").insert({ nom, email: email || null, poste, code_hash: await sha(norm(code)) }).select("id,nom,poste").single();
      if (!error) return out({ candidate: data, code });
    }
    return fail("Création impossible.", 500);
  }
  const id = String(b.candidate_id || "");
  if (action === "admin_reset_code") {
    if (!UUID.test(id)) return fail("Identifiant invalide.");
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const { error } = await sb.from("candidates").update({ code_hash: await sha(norm(code)) }).eq("id", id);
      if (!error) { await sb.from("sessions").delete().eq("candidate_id", id); return out({ code }); }
    }
    return fail("Opération impossible.", 500);
  }
  if (action === "admin_grant") {
    const scope = String(b.scope || "");
    if (!UUID.test(id) || !SCOPES.includes(scope)) return fail("Paramètres invalides.");
    const { data: g } = await sb.from("grants").select("extra").eq("candidate_id", id).eq("scope", scope).maybeSingle();
    await sb.from("grants").upsert({ candidate_id: id, scope, extra: (g?.extra || 0) + 1 });
    return out({ ok: true });
  }
  if (action === "admin_toggle") {
    if (!UUID.test(id)) return fail("Identifiant invalide.");
    await sb.from("candidates").update({ active: !!b.active }).eq("id", id);
    if (!b.active) await sb.from("sessions").delete().eq("candidate_id", id);
    return out({ ok: true });
  }
  if (action === "admin_delete") {
    if (!UUID.test(id)) return fail("Identifiant invalide.");
    await sb.from("candidates").delete().eq("id", id);
    return out({ ok: true });
  }
  if (action === "admin_attempt") {
    const aid = String(b.attempt_id || "");
    if (!UUID.test(aid)) return fail("Identifiant invalide.");
    const { data: att } = await sb.from("attempts").select().eq("id", aid).maybeSingle();
    if (!att) return fail("Introuvable.", 404);
    const { data: rows } = await sb.from("questions").select("id,q,options,correct").in("id", att.question_ids);
    const byId = new Map((rows || []).map((r: any) => [r.id, r]));
    const items = att.question_ids.map((id2: string) => {
      const r: any = byId.get(id2); const perm: number[] = att.orders[id2]; const sel = att.answers?.[id2];
      const given = sel === undefined ? null : perm[sel];
      return { q: r.q, options: r.options, given, correct: r.correct, ok: given === r.correct };
    });
    return out({ attempt: { id: att.id, scope: att.scope, status: att.status, score: att.score, max: att.max, started_at: att.started_at, submitted_at: att.submitted_at, duration_s: att.duration_s, blur_count: att.blur_count, paste_count: att.paste_count }, items });
  }
  return fail("Action inconnue.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("Méthode non autorisée.", 405);
  try {
    const raw = await req.text();
    if (raw.length > 20000) return fail("Requête trop volumineuse.", 413);
    const b = JSON.parse(raw || "{}");
    const action = String(b.action || "");
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "inconnu";

    if (action === "ping") return out({ ok: true });

    if (action === "login" || action === "admin_login") {
      if (await tooMany(ip)) return fail("Trop de tentatives. Réessayez dans 15 minutes.", 429);
      sb.from("login_attempts").delete().lt("at", new Date(Date.now() - 86400e3).toISOString()).then(() => {});
      sb.from("sessions").delete().lt("expires_at", new Date().toISOString()).then(() => {});
      if (action === "login") {
        const code = norm(b.code);
        const { data: c } = code.length >= 10 ? await sb.from("candidates").select("id,nom,poste,active").eq("code_hash", await sha(code)).maybeSingle() : { data: null };
        await sb.from("login_attempts").insert({ ip, ok: !!(c && c.active) });
        if (!c || !c.active) return fail("Code invalide.", 401);
        await sb.from("candidates").update({ last_login: new Date().toISOString() }).eq("id", c.id);
        const t = await newSession("candidat", c.id, 8);
        return out({ token: t, nom: c.nom, poste: c.poste });
      }
      const admin = (Deno.env.get("ADMIN_CODE") || "").trim();
      const okA = admin.length >= 10 && (await sha(String(b.code || "").trim())) === (await sha(admin));
      await sb.from("login_attempts").insert({ ip, ok: okA });
      if (!okA) return fail("Code invalide.", 401);
      return out({ token: await newSession("admin", null, 4) });
    }

    if (action === "logout") {
      const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (t) await sb.from("sessions").delete().eq("token_hash", await sha(t));
      return out({ ok: true });
    }

    if (action.startsWith("admin_")) {
      const s = await auth(req, "admin");
      if (!s) return fail("Session administrateur expirée.", 401);
      return await handleAdmin(action, b);
    }

    const s = await auth(req, "candidat");
    if (!s) return fail("Session expirée. Reconnectez-vous.", 401);
    return await handleCandidate(action, b, req, s);
  } catch (e) {
    console.error(e);
    return fail("Erreur serveur.", 500);
  }
});
