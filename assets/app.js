/* AWS SCS-C03 学習サイト（GitHub Pages に置く静的サイト）
 *
 * 問題データは data/*.js が window.SCS_CARDS / window.SCS_SCENARIOS に push する。
 * 解答履歴は localStorage にだけ保存し、サーバーには何も送らない。
 *
 * 出題は間隔反復（Leitner 方式）で管理する。正解すると次に出すまでの間隔が延び、
 * 間違えると翌日ではなくその場で出し直す。
 */
(function () {
  "use strict";

  const CARDS = window.SCS_CARDS || [];
  const SCEN = window.SCS_SCENARIOS || [];
  const BY_ID = new Map();
  CARDS.forEach((q) => BY_ID.set(q.id, { kind: "card", q }));
  SCEN.forEach((q) => BY_ID.set(q.id, { kind: "scen", q }));
  const ALL_IDS = [...BY_ID.keys()];

  const DOMAINS = {
    1: { name: "検出", w: 16 },
    2: { name: "インシデント対応", w: 14 },
    3: { name: "インフラストラクチャ", w: 18 },
    4: { name: "IAM", w: 20 },
    5: { name: "データ保護", w: 18 },
    6: { name: "基礎とガバナンス", w: 14 },
  };
  const DS = [1, 2, 3, 4, 5, 6];
  const MOCK_PER_DOMAIN = { 1: 10, 2: 9, 3: 12, 4: 13, 5: 12, 6: 9 }; // 65問を配点比で割った数
  const MOCK_SECONDS = 170 * 60;
  const TARGET = 0.8;
  const DAY = 86400000;
  const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60]; // 箱ごとの次回までの日数
  const SETTLED_BOX = 3; // 7日あけても答えられた
  const RECENT = 30; // 分野ごとの正答率は直近30問で見る
  const MIN_RECENT = 10;
  const LETTERS = "ABCDEFG";
  const TYPE_HINT = {
    multi: "複数選択",
    order: "並べ替え　正しい順にクリック",
    match: "組み合わせ",
  };

  // ── 保存 ────────────────────────────────────────────────
  const KEY = "awsscs.c03.v2";
  const OLD_KEY = "awsscs.c03.v1";

  function blank() {
    return {
      srs: {}, // id -> { box, due, ok, ng, last }
      log: [], // { id, d, k, ok, t }
      mocks: [], // { t, secs, n, ok, dom }
      mock: null, // 受験中の模擬試験
      lastMock: null, // 直近の模擬試験の見直し用
      mockSeen: {},
      prefs: { exam: "", cardMode: "recall", newPerDay: 20, official: false },
      daily: { date: "", newDone: 0 },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = Object.assign(blank(), JSON.parse(raw));
        s.prefs = Object.assign(blank().prefs, s.prefs);
        return s;
      }
    } catch (e) { /* 壊れていたら作り直す */ }
    const s = blank();
    try {
      const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null");
      if (old) migrate(old, s);
    } catch (e) { /* 旧データが読めなければ空から始める */ }
    return s;
  }

  // 旧版（習熟度0〜3の単純な記録）の履歴を引き継ぐ
  function migrate(old, s) {
    const now = Date.now();
    const put = (id, box, ok, ng) => {
      const info = BY_ID.get(id);
      if (!info || ok + ng === 0) return;
      s.srs[id] = { box, due: now + INTERVAL_DAYS[box] * DAY, ok, ng, last: 0 };
      for (let i = 0; i < ok; i++) s.log.push({ id, d: info.q.d, k: info.kind, ok: true, t: 0 });
      for (let i = 0; i < ng; i++) s.log.push({ id, d: info.q.d, k: info.kind, ok: false, t: 0 });
    };
    Object.entries(old.cards || {}).forEach(([id, v]) => put(id, Math.min(3, v.b || 0), v.ok || 0, v.ng || 0));
    Object.entries(old.quiz || {}).forEach(([id, v]) =>
      put(id, v.last === false ? 0 : (v.ok || 0) > 0 ? 2 : 0, v.ok || 0, v.ng || 0));
  }

  let state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn("保存できませんでした", e); }
  }

  // ── 小道具 ──────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  // 本文中の `code` 記法だけを装飾する
  const rich = (s) => esc(s).replace(/`([^`]+)`/g, (_, m) => "<code>" + m + "</code>");
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function ymd(t) {
    const d = new Date(t);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
  }
  // ドラッグで文字を選び終えたクリックを、解答や開閉として扱わない
  function selectingText() {
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  }
  function categories(items) {
    return [...new Set(items.map((x) => x.cat))];
  }

  // ── 間隔反復 ────────────────────────────────────────────
  function rollDaily() {
    const today = ymd(Date.now());
    if (state.daily.date !== today) state.daily = { date: today, newDone: 0 };
  }

  // result: "good"（正解） / "hard"（あやふや） / "again"（不正解）
  function grade(id, result, src) {
    rollDaily();
    const now = Date.now();
    const info = BY_ID.get(id);
    let s = state.srs[id];
    if (!s) {
      s = state.srs[id] = { box: 0, due: now, ok: 0, ng: 0, last: 0 };
      if (src !== "mock") state.daily.newDone++;
    }
    if (result === "good") s.box = Math.min(INTERVAL_DAYS.length - 1, s.box + 1);
    else if (result === "hard") s.box = Math.max(1, s.box);
    else s.box = 0;
    const days = result === "hard" ? Math.max(1, INTERVAL_DAYS[s.box] / 2) : INTERVAL_DAYS[s.box];
    s.due = now + days * DAY;
    const ok = result !== "again";
    if (ok) s.ok++; else s.ng++;
    s.last = now;
    state.log.push({ id, d: info.q.d, k: info.kind, ok, t: now });
    if (state.log.length > 5000) state.log.splice(0, state.log.length - 5000);
    save();
  }

  function dueIds() {
    const now = Date.now();
    return Object.keys(state.srs)
      .filter((id) => BY_ID.has(id) && state.srs[id].due <= now)
      .sort((a, b) => state.srs[a].due - state.srs[b].due);
  }

  function daysLeft() {
    if (!state.prefs.exam) return null;
    const [y, m, d] = state.prefs.exam.split("-").map(Number);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - today) / DAY);
  }

  // 1日の新規の数。試験日があれば、最後の1週間を模擬試験と復習に残して逆算する
  function newQuota() {
    const left = daysLeft();
    if (left == null || left <= 0) return state.prefs.newPerDay;
    const unseen = ALL_IDS.filter((id) => !state.srs[id]).length;
    return Math.min(80, Math.max(10, Math.ceil(unseen / Math.max(1, left - 7))));
  }

  // 未出題から、出題の進んでいない分野を優先して選ぶ
  function pickNew(n) {
    const pool = {};
    DS.forEach((d) => (pool[d] = shuffle(ALL_IDS.filter((id) => !state.srs[id] && BY_ID.get(id).q.d === d))));
    const total = (d) => ALL_IDS.filter((id) => BY_ID.get(id).q.d === d).length;
    const seen = {};
    DS.forEach((d) => (seen[d] = total(d) - pool[d].length));
    const out = [];
    while (out.length < n) {
      const open = DS.filter((d) => pool[d].length);
      if (!open.length) break;
      open.sort((a, b) => seen[a] / total(a) - seen[b] / total(b));
      const d = open[0];
      out.push(pool[d].shift());
      seen[d]++;
    }
    return out;
  }

  // 復習2問に新規1問の割合で編む
  function weave(due, fresh) {
    const out = [];
    while (due.length || fresh.length) {
      if (due.length) out.push(due.shift());
      if (due.length) out.push(due.shift());
      if (fresh.length) out.push(fresh.shift());
    }
    return out;
  }

  // ── 成績 ────────────────────────────────────────────────
  function domainRecent(d) {
    let n = 0, ok = 0;
    for (let i = state.log.length - 1; i >= 0 && n < RECENT; i--) {
      const e = state.log[i];
      if (e.k === "scen" && e.d === d) { n++; if (e.ok) ok++; }
    }
    return { n, ok };
  }

  function weightedAccuracy() {
    let sw = 0, sa = 0;
    for (const d of DS) {
      const r = domainRecent(d);
      if (r.n < MIN_RECENT) return null;
      sw += DOMAINS[d].w;
      sa += (DOMAINS[d].w * r.ok) / r.n;
    }
    return sa / sw;
  }

  function readiness() {
    const seenScen = SCEN.filter((q) => state.srs[q.id]).length;
    const weak = DS.filter((d) => { const r = domainRecent(d); return r.n < MIN_RECENT || r.ok / r.n < TARGET; });
    const last2 = state.mocks.slice(-2);
    const settled = CARDS.filter((q) => (state.srs[q.id] || {}).box >= SETTLED_BOX).length;
    return [
      { ok: seenScen === SCEN.length, label: "シナリオ問題を全問一度は解いた", val: seenScen + " / " + SCEN.length },
      { ok: !weak.length, label: "全分野で、直近30問の正答率が8割以上",
        val: weak.length ? weak.map((d) => DOMAINS[d].name).join("、") + " が未達" : "達成" },
      { ok: last2.length === 2 && last2.every((m) => m.ok / m.n >= TARGET), label: "模擬試験で直近2回とも8割以上",
        val: last2.length ? last2.map((m) => pct(m.ok, m.n) + "%").join(" → ") : "未受験" },
      { ok: settled / CARDS.length >= TARGET, label: "一問一答の8割を、7日あけても答えられる",
        val: pct(settled, CARDS.length) + "%" },
      { ok: state.prefs.official, label: "AWS Skill Builder の公式練習問題で8割以上取れた", manual: true },
    ];
  }

  // ── 出題の形を作る ──────────────────────────────────────
  // シナリオは出すたびに選択肢を並べ替える。データは正解を先頭に書いてあるので、
  // そのまま出すと位置だけで当たってしまう。perm を渡すと同じ並びを再現する。
  function viewOf(id, perm) {
    const { kind, q } = BY_ID.get(id);
    if (kind === "card") return { id, kind, q, type: "card" };
    if (q.type === "match") {
      const p = perm || { p: shuffle(range(q.pairs.length)), o: shuffle(range(q.pairs.length)) };
      return { id, kind, q, type: "match", perm: p,
        pairs: p.p.map((i) => q.pairs[i]), opts: p.o.map((i) => q.pairs[i][1]) };
    }
    const p = perm || shuffle(range(q.c.length));
    const pos = [];
    p.forEach((orig, shown) => (pos[orig] = shown));
    return { id, kind, q, type: q.type || "single", perm: p,
      c: p.map((i) => q.c[i]), ng: q.ng ? p.map((i) => q.ng[i]) : null,
      ans: q.type ? q.ans.map((i) => pos[i]) : pos[q.ans] };
  }

  function isCorrect(v, val) {
    if (val == null) return false;
    if (v.type === "single") return val === v.ans;
    if (v.type === "match") return v.pairs.every((p, i) => val[i] === p[1]);
    if (!Array.isArray(val) || val.length !== v.ans.length) return false;
    if (v.type === "order") return v.ans.every((x, i) => val[i] === x);
    const a = [...val].sort(), b = [...v.ans].sort(); // 複数選択は順不同
    return a.every((x, i) => x === b[i]);
  }

  function isComplete(v, val) {
    if (v.type === "single") return typeof val === "number";
    if (v.type === "match") return Array.isArray(val) && v.pairs.every((_, i) => val[i]);
    return Array.isArray(val) && val.length > 0;
  }

  // ── 一問一答の4択 ───────────────────────────────────────
  // 誤選択肢は他の問題の解答を流用する（文章を生成しないので、誤選択肢のはずが
  // 実は正しい、という事故が起きにくい）。日本語の形と話題で正解が透けないように選ぶ。

  function keyTerms(s) {
    const out = {}, m = s.match(/[A-Za-z0-9][A-Za-z0-9.+-]{2,}/g) || [];
    m.forEach((t) => (out[t.toLowerCase()] = 1));
    return out;
  }
  function overlap(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (!ka.length || !kb.length) return -1; // サービス名を含まない解答同士は判定できない
    let n = 0;
    ka.forEach((k) => { if (b[k]) n++; });
    return n / (ka.length + kb.length - n);
  }
  function bigramSim(a, b) {
    const A = new Set(), B = new Set();
    for (let i = 0; i < a.length - 1; i++) A.add(a.slice(i, i + 2));
    for (let j = 0; j < b.length - 1; j++) B.add(b.slice(j, j + 2));
    let n = 0;
    B.forEach((g) => { if (A.has(g)) n++; });
    return A.size + B.size ? (2 * n) / (A.size + B.size) : 0;
  }
  // 同じことを言っている解答か
  function tooClose(a, b) {
    const ov = overlap(keyTerms(a), keyTerms(b));
    if (ov >= 0) return ov > 0.6;
    return bigramSim(a, b) > 0.5;
  }

  // 解答の最初の一文の形。「何を強制できるか」の答えに「〜のため。」が並ぶと、
  // AWS の知識ではなく日本語で消去できてしまうので、形の合うものだけを引く
  function answerForm(a) {
    const first = a.split("。")[0];
    if (/(ため|から|ためである)$/.test(first)) return "reason";
    if (!/[ぁ-ゖ]$/.test(first)) return "noun";
    if (/(ない|できる|である|になる|だ|いる|ある|のみ|だけ|限る)$/.test(first)) return "state";
    return "how";
  }

  // 問題文と共有する語（英字のサービス名、カタカナ語、漢字語）
  function topicTerms(s) {
    return new Set((s.match(/[A-Za-z][A-Za-z0-9.\-]+|[ァ-ヶー]{2,}|[一-龠々]{2,}/g) || []).map((t) => t.toLowerCase()));
  }
  function topicScore(text, terms) {
    let n = 0;
    topicTerms(text).forEach((t) => { if (terms.has(t)) n++; });
    return n;
  }

  function buildChoices(card) {
    // 手書きの誤選択肢があればそれを使う
    if (card.x && card.x.length >= 3) {
      const fixed = shuffle(card.x.slice(0, 3).map((t, i) => ({ id: card.id + "#x" + i, a: t })).concat([card]));
      return { list: fixed, ans: fixed.indexOf(card) };
    }
    const form = answerForm(card.a);
    const qTerms = topicTerms(card.q);
    const want = topicScore(card.a, qTerms);
    // 形の合う解答から選ぶ。正解は問題文と語を共有しやすいので、
    // 問題文と同じくらい語を共有する解答を優先し、「同じ語を含むものを選ぶ」だけで
    // 当たらないようにする。同じカテゴリと分野は話題が近いので加点する
    let cands = CARDS.filter((x) => x.id !== card.id && answerForm(x.a) === form && !tooClose(x.a, card.a));
    if (cands.length < 3) cands = CARDS.filter((x) => x.id !== card.id && !tooClose(x.a, card.a));
    const rank = (x) => {
      const t = topicScore(x.a, qTerms);
      return (t >= want ? 0 : (want - t) * 30) - (x.cat === card.cat ? 12 : 0) - (x.d === card.d ? 6 : 0) +
        Math.abs(x.a.length - card.a.length) / 6 + Math.random() * 10;
    };
    const scored = cands.map((x) => [rank(x), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const picks = [];
    for (const c of scored) {
      if (picks.length >= 3) break;
      if (picks.every((q) => q.id !== c.id && !tooClose(q.a, c.a))) picks.push(c);
    }
    const list = shuffle(picks.concat([card]));
    return { list, ans: list.indexOf(card) };
  }

  // ── 共通の描画部品 ──────────────────────────────────────
  function metaHTML(q, right) {
    return '<div class="meta"><span class="pill">' + esc(q.cat) + '</span><span class="pill">' +
      esc(DOMAINS[q.d].name) + "</span>" + (right ? '<span class="meta-right">' + right + "</span>" : "") + "</div>";
  }

  function ideaHTML(t) {
    return t ? '<div class="idea"><p class="idea-h">思想</p><p>' + rich(t) + "</p></div>" : "";
  }

  function verdictText(v, val) {
    let s = isCorrect(v, val) ? "正解" : "不正解";
    if (v.type === "single") s += "　正解は " + LETTERS[v.ans];
    else if (v.type === "multi") s += "　正解は " + v.ans.map((i) => LETTERS[i]).join("、");
    else if (v.type === "order") s += "　正しい順は " + v.ans.map((i) => LETTERS[i]).join(" → ");
    return s;
  }

  function explainHTML(v, val) {
    return '<div class="explain"><p class="verdict ' + (isCorrect(v, val) ? "is-right" : "is-wrong") + '">' +
      esc(verdictText(v, val)) + "</p><p>" + rich(v.q.exp) + "</p></div>" + ideaHTML(v.q.idea);
  }

  // シナリオの選択肢。reveal で正誤と誤答の理由を出す。act はクリック時のアクション名
  function choicesHTML(v, val, reveal, act) {
    if (v.type === "match") return matchHTML(v, val, reveal);
    const want = v.type === "single" ? [v.ans] : v.ans;
    const sel = v.type === "single" ? (typeof val === "number" ? [val] : []) : val || [];
    let h = '<ol class="choices">';
    v.c.forEach((text, i) => {
      let cls = "choice", mark = LETTERS[i];
      const at = sel.indexOf(i);
      if (reveal) {
        cls += " locked";
        if (v.type === "order") {
          mark = String(v.ans.indexOf(i) + 1);
          cls += at === v.ans.indexOf(i) ? " is-right" : " is-wrong";
        } else if (want.includes(i)) { cls += " is-right"; mark = "◯"; }
        else if (at >= 0) { cls += " is-wrong"; mark = "✕"; }
      } else if (at >= 0) {
        cls += " is-picked";
        if (v.type === "order") mark = String(at + 1);
      }
      h += '<li><button type="button" class="' + cls + '" data-act="' + act + '" data-i="' + i + '"' +
        (reveal ? ' aria-disabled="true"' : "") + '><span class="mark">' + mark + '</span><span class="text">' + rich(text);
      if (reveal && !want.includes(i) && v.ng && v.ng[i]) h += '<span class="why">' + rich(v.ng[i]) + "</span>";
      h += "</span></button></li>";
    });
    return h + "</ol>";
  }

  function matchHTML(v, val, reveal) {
    let h = '<div class="match">';
    v.pairs.forEach((p, i) => {
      const picked = val ? val[i] : "";
      if (reveal) {
        const ok = picked === p[1];
        h += '<div class="match-row ' + (ok ? "is-right" : "is-wrong") + '"><div class="match-q">' + rich(p[0]) +
          '</div><div class="match-a"><span class="mark">' + (ok ? "◯" : "✕") + "</span>" + rich(picked || "未選択") +
          (ok ? "" : '<span class="why">正しくは ' + rich(p[1]) + "</span>") + "</div></div>";
      } else {
        h += '<div class="match-row"><div class="match-q">' + rich(p[0]) + '</div><select class="match-sel" data-i="' + i +
          '"><option value="">選ぶ</option>' +
          v.opts.map((o) => "<option" + (picked === o ? " selected" : "") + ">" + esc(o) + "</option>").join("") +
          "</select></div>";
      }
    });
    return h + "</div>";
  }

  function typeHintHTML(v) {
    return TYPE_HINT[v.type] ? '<p class="qtype">' + TYPE_HINT[v.type] + "</p>" : "";
  }

  // ── 画面の状態 ──────────────────────────────────────────
  let view = "today";
  const sessions = { today: null, practice: null };
  const practice = { kind: "scen", d: "", cat: "", target: "all", count: "20" };
  const browse = { q: "", kind: "scen", d: "", cat: "", open: {} };
  let mockReviewAll = false;
  let timer = null;
  const main = $("main");

  function render() {
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    clearInterval(timer);
    timer = null;
    if (view === "today") renderToday();
    else if (view === "practice") renderPractice();
    else if (view === "mock") renderMock();
    else if (view === "browse") renderBrowse();
    else renderProgress();
  }

  function go(v) {
    view = v;
    render();
    window.scrollTo(0, 0);
  }

  // ── 学習セッション（今日と演習で共用）─────────────────
  function makeItem(id) {
    const v = viewOf(id);
    const it = { id, v, val: null, answered: false, shown: false, mode: null, choices: null };
    if (v.kind === "card") {
      it.mode = state.prefs.cardMode;
      if (it.mode === "choice") it.choices = buildChoices(v.q);
    }
    return it;
  }

  function startSession(slot, ids, title) {
    if (!ids.length) return;
    sessions[slot] = { title, src: slot, items: ids.map(makeItem), i: 0, retried: new Set(), first: {}, done: false };
    render();
    window.scrollTo(0, 0);
  }

  const cur = (s) => s.items[s.i];

  // 間違えた問題は、少し後にもう一度だけ出す（選択肢は並べ直す）
  function requeue(s, id) {
    if (s.retried.has(id)) return;
    s.retried.add(id);
    s.items.splice(Math.min(s.i + 5, s.items.length), 0, makeItem(id));
  }

  function record(s, it, result) {
    grade(it.id, result, s.src);
    if (!(it.id in s.first)) s.first[it.id] = result !== "again";
    if (result === "again") requeue(s, it.id);
  }

  function sessionPick(s, i) {
    const it = cur(s);
    if (it.answered) return;
    if (it.v.kind === "card") {
      if (it.mode !== "choice") return;
      it.val = i;
      it.answered = true;
      record(s, it, i === it.choices.ans ? "good" : "again");
    } else if (it.v.type === "single") {
      it.val = i;
      it.answered = true;
      record(s, it, isCorrect(it.v, i) ? "good" : "again");
    } else if (it.v.type !== "match") {
      const sel = it.val || [];
      const at = sel.indexOf(i);
      if (at >= 0) sel.splice(at, 1); else sel.push(i);
      it.val = sel;
    }
    render();
  }

  function sessionSubmit(s) {
    const it = cur(s);
    if (it.answered || it.v.kind === "card" || it.v.type === "single") return;
    if (!isComplete(it.v, it.val)) return;
    it.answered = true;
    record(s, it, isCorrect(it.v, it.val) ? "good" : "again");
    render();
  }

  function sessionNext(s) {
    s.i++;
    if (s.i >= s.items.length) s.done = true;
    render();
    window.scrollTo(0, 0);
  }

  function sessionRecall(s, result) {
    const it = cur(s);
    record(s, it, result);
    sessionNext(s);
  }

  function renderSession(s) {
    if (s.done) return renderSessionResult(s);
    const it = cur(s);
    const v = it.v;
    let h = '<section class="read runner">';
    h += '<div class="runner-bar"><span class="mono">' + (s.i + 1) + " / " + s.items.length + "</span>" +
      '<span class="track"><i style="width:' + pct(s.i, s.items.length) + '%"></i></span>' +
      '<button type="button" class="link" data-act="quit">中断する</button></div>';
    h += '<article class="item">' + metaHTML(v.q, v.kind === "card" ? "一問一答" : "シナリオ");

    if (v.kind === "card") {
      h += '<p class="q">' + rich(v.q.q) + "</p>";
      if (it.mode === "choice") {
        const ch = it.choices;
        h += '<ol class="choices">';
        ch.list.forEach((c, i) => {
          let cls = "choice", mark = LETTERS[i];
          if (it.answered) {
            cls += " locked";
            if (i === ch.ans) { cls += " is-right"; mark = "◯"; }
            else if (i === it.val) { cls += " is-wrong"; mark = "✕"; }
          }
          h += '<li><button type="button" class="' + cls + '" data-act="pick" data-i="' + i + '"' +
            (it.answered ? ' aria-disabled="true"' : "") + '><span class="mark">' + mark + '</span><span class="text">' +
            rich(c.a) + "</span></button></li>";
        });
        h += "</ol>";
        if (it.answered) {
          h += '<div class="explain"><p class="verdict ' + (it.val === ch.ans ? "is-right" : "is-wrong") + '">' +
            (it.val === ch.ans ? "正解" : "不正解") + "</p>" + (v.q.note ? "<p>" + rich(v.q.note) + "</p>" : "") + "</div>" +
            ideaHTML(v.q.idea) + nextHTML(s);
        }
      } else if (!it.shown) {
        h += '<div class="actions"><button type="button" class="btn primary" data-act="show">答えを見る<kbd>Space</kbd></button></div>';
      } else {
        h += '<div class="answer"><p>' + rich(v.q.a) + "</p></div>" +
          (v.q.note ? '<div class="explain"><p>' + rich(v.q.note) + "</p></div>" : "") + ideaHTML(v.q.idea) +
          '<div class="actions grades">' +
          '<button type="button" class="btn" data-act="recall" data-r="again">思い出せなかった<kbd>1</kbd></button>' +
          '<button type="button" class="btn" data-act="recall" data-r="hard">あやふや<kbd>2</kbd></button>' +
          '<button type="button" class="btn primary" data-act="recall" data-r="good">答えられた<kbd>3</kbd></button></div>';
      }
    } else {
      h += typeHintHTML(v) + '<p class="q">' + rich(v.q.q) + "</p>";
      h += choicesHTML(v, it.val, it.answered, "pick");
      if (it.answered) h += explainHTML(v, it.val) + nextHTML(s);
      else if (v.type !== "single") {
        h += '<div class="actions"><button type="button" class="btn primary" data-act="submit"' +
          (isComplete(v, it.val) ? "" : " disabled") + ">解答する<kbd>Enter</kbd></button>" +
          (v.type === "order" && (it.val || []).length ? '<button type="button" class="btn" data-act="clear">選び直す</button>' : "") +
          "</div>";
      }
    }
    h += "</article></section>";
    main.innerHTML = h;
  }

  function nextHTML(s) {
    return '<div class="actions"><button type="button" class="btn primary" data-act="next">' +
      (s.i + 1 >= s.items.length ? "結果を見る" : "次へ") + "<kbd>Space</kbd></button></div>";
  }

  function renderSessionResult(s) {
    const ids = Object.keys(s.first);
    const ok = ids.filter((id) => s.first[id]).length;
    const wrong = ids.filter((id) => !s.first[id]);
    let h = '<section class="read">';
    h += '<h2 class="view-title">' + esc(s.title) + "の結果</h2>";
    h += '<div class="stats">' +
      stat("解いた", ids.length) + stat("1回目で正解", ok) + stat("正答率", pct(ok, ids.length) + "%") + "</div>";
    if (wrong.length) {
      h += '<h3 class="sec">間違えた問題</h3><ul class="rows">';
      wrong.forEach((id) => {
        const q = BY_ID.get(id).q;
        h += '<li class="row"><span class="pill">' + esc(q.cat) + "</span><span>" + rich(q.q) + "</span></li>";
      });
      h += "</ul>";
    }
    h += '<div class="actions">' +
      (wrong.length ? '<button type="button" class="btn primary" data-act="retry">間違えた問題をもう一度</button>' : "") +
      '<button type="button" class="btn" data-act="quit">終える</button></div></section>';
    main.innerHTML = h;
  }

  function stat(label, value, sub) {
    return '<div class="stat"><span class="stat-l">' + esc(label) + '</span><span class="stat-v">' + value + "</span>" +
      (sub ? '<span class="stat-s">' + sub + "</span>" : "") + "</div>";
  }

  // ── 今日 ────────────────────────────────────────────────
  function todayPlan() {
    rollDaily();
    const due = dueIds().slice(0, 60);
    const fresh = pickNew(Math.max(0, newQuota() - state.daily.newDone));
    return { due, fresh };
  }

  function renderToday() {
    if (sessions.today) return renderSession(sessions.today);
    const plan = todayPlan();
    const left = daysLeft();
    const acc = weightedAccuracy();
    let h = '<section class="today">';
    h += '<div class="neon">';
    h += '<div class="exam"><label for="exam-date">試験日</label><input type="date" id="exam-date" value="' +
      esc(state.prefs.exam) + '">' +
      '<span class="exam-left">' + (left == null ? "" : left > 0 ? "あと <b>" + left + "</b> 日" : left === 0 ? "今日" : "終了") +
      "</span></div>";
    h += '<div class="stats">' +
      stat("復習", plan.due.length, "忘れかけている問題") +
      stat("新規", plan.fresh.length, left > 7 ? "試験日から逆算" : "1日の上限") +
      stat("直近の正答率", acc == null ? "—" : Math.round(acc * 100) + "%",
        acc == null ? "全分野で10問ずつ解くと出ます" : "配点で加重。目標 80%") +
      "</div>";
    const n = plan.due.length + plan.fresh.length;
    h += '<div class="actions">' + (n
      ? '<button type="button" class="btn primary big" data-act="start-today">今日の学習を始める</button>'
      : '<p class="mute">今日の分は終わりました。続けるなら演習か模擬試験へ。</p>') + "</div>";
    h += "</div>";

    const list = readiness();
    const done = list.filter((x) => x.ok).length;
    h += '<h3 class="sec">受験の目安<span class="sec-right mono">' + done + " / " + list.length + "</span></h3>";
    h += '<ul class="checks">';
    list.forEach((x, i) => {
      h += '<li class="check' + (x.ok ? " ok" : "") + '"><span class="tick">' + (x.ok ? "✓" : "") + "</span>" +
        '<span class="check-l">' + esc(x.label) + "</span>" +
        (x.manual
          ? '<label class="check-v"><input type="checkbox" id="official"' + (x.ok ? " checked" : "") + "> 達成した</label>"
          : '<span class="check-v mono">' + esc(x.val) + "</span>") + "</li>";
    });
    h += "</ul></section>";
    main.innerHTML = h;
  }

  // ── 演習 ────────────────────────────────────────────────
  function practicePool() {
    let items = practice.kind === "card" ? CARDS
      : practice.kind === "both" ? CARDS.concat(SCEN)
      : practice.kind === "new" ? SCEN.filter((q) => q.type)
      : SCEN;
    if (practice.d) items = items.filter((q) => q.d === +practice.d);
    return items;
  }

  function renderPractice() {
    if (sessions.practice) return renderSession(sessions.practice);
    const pool = practicePool();
    const cats = categories(pool);
    if (practice.cat && !cats.includes(practice.cat)) practice.cat = "";
    const opt = (v, l, cur) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? " selected" : "") + ">" + esc(l) + "</option>";
    let h = '<section class="read">';
    h += '<h2 class="view-title">演習</h2>';
    h += '<div class="form">';
    h += field("種類", '<select data-p="kind">' + opt("scen", "シナリオ問題", practice.kind) +
      opt("new", "シナリオのうち複数選択・並べ替え・組み合わせ", practice.kind) +
      opt("card", "一問一答", practice.kind) + opt("both", "両方", practice.kind) + "</select>");
    h += field("分野", '<select data-p="d">' + opt("", "すべて", practice.d) +
      DS.map((d) => opt(d, DOMAINS[d].name, practice.d)).join("") + "</select>");
    h += field("カテゴリ", '<select data-p="cat">' + opt("", "すべて", practice.cat) +
      cats.map((c) => opt(c, c, practice.cat)).join("") + "</select>");
    h += field("対象", '<select data-p="target">' + opt("all", "すべて", practice.target) +
      opt("unseen", "まだ解いていない問題", practice.target) +
      opt("wrong", "直近で間違えた問題", practice.target) +
      opt("weak", "7日あけると答えられない問題", practice.target) + "</select>");
    h += field("問題数", '<select data-p="count">' + opt("10", "10問", practice.count) + opt("20", "20問", practice.count) +
      opt("50", "50問", practice.count) + opt("all", "すべて", practice.count) + "</select>");
    h += "</div>";
    const n = practiceIds().length;
    h += '<div class="actions"><button type="button" class="btn primary big" data-act="start-practice"' +
      (n ? "" : " disabled") + ">" + (n ? n + "問を解く" : "条件に合う問題がありません") + "</button></div>";
    h += "</section>";
    main.innerHTML = h;
  }

  function field(label, control) {
    return '<label class="field"><span class="field-l">' + esc(label) + "</span>" + control + "</label>";
  }

  function practiceIds() {
    let items = practicePool();
    if (practice.cat) items = items.filter((q) => q.cat === practice.cat);
    items = items.filter((q) => {
      const s = state.srs[q.id];
      if (practice.target === "unseen") return !s;
      if (practice.target === "wrong") return s && s.box === 0;
      if (practice.target === "weak") return s && s.box < SETTLED_BOX;
      return true;
    });
    const ids = shuffle(items.map((q) => q.id));
    return practice.count === "all" ? ids : ids.slice(0, +practice.count);
  }

  // ── 模擬試験 ────────────────────────────────────────────
  // 本番と同じく、65問を配点比で抽出し、170分で解き、終わるまで正誤を出さない。
  // 途中で再読み込みしても続きから再開できるよう、出題順と並びを保存する。
  function mockStart() {
    const ids = [];
    DS.forEach((d) => {
      const pool = shuffle(SCEN.filter((q) => q.d === d).map((q) => q.id));
      pool.sort((a, b) => (state.mockSeen[a] || 0) - (state.mockSeen[b] || 0)); // 最近の模擬試験で出たものは後回し
      ids.push(...pool.slice(0, MOCK_PER_DOMAIN[d]));
    });
    shuffle(ids);
    const perm = {};
    ids.forEach((id) => (perm[id] = viewOf(id).perm));
    state.mock = { ids, perm, ans: {}, flag: {}, start: Date.now(), i: 0 };
    save();
    render();
  }

  const mockView = (id) => viewOf(id, state.mock.perm[id]);
  const mockRemaining = () => MOCK_SECONDS - (Date.now() - state.mock.start) / 1000;

  function mockFinish() {
    const m = state.mock;
    if (!m) return;
    const dom = {};
    DS.forEach((d) => (dom[d] = [0, 0]));
    let ok = 0;
    m.ids.forEach((id) => {
      const v = mockView(id);
      const right = isCorrect(v, m.ans[id]);
      if (right) ok++;
      dom[v.q.d][1]++;
      if (right) dom[v.q.d][0]++;
      grade(id, right ? "good" : "again", "mock");
      state.mockSeen[id] = Date.now();
    });
    const secs = Math.min(MOCK_SECONDS, Math.round((Date.now() - m.start) / 1000));
    state.mocks.push({ t: Date.now(), secs, n: m.ids.length, ok, dom });
    state.lastMock = { ids: m.ids, perm: m.perm, ans: m.ans, t: Date.now() };
    state.mock = null;
    mockReviewAll = false;
    save();
    render();
    window.scrollTo(0, 0);
  }

  function renderMock() {
    const m = state.mock;
    if (m && mockRemaining() <= 0) return mockFinish();
    if (!m) return renderMockIntro();
    const id = m.ids[m.i];
    const v = mockView(id);
    const answered = m.ids.filter((x) => isComplete(mockView(x), m.ans[x])).length;
    let h = '<section class="mock">';
    h += '<div class="mock-bar"><span class="mono timer" id="mock-timer">' + mmss(mockRemaining()) + "</span>" +
      '<span class="mono mute">解答済み ' + answered + " / " + m.ids.length + "</span>" +
      '<button type="button" class="btn small" data-act="mock-submit">提出する</button></div>';
    h += '<div class="mock-body"><article class="item read">';
    h += metaHTML(v.q, '<span class="mono">' + (m.i + 1) + " / " + m.ids.length + "</span>");
    h += typeHintHTML(v) + '<p class="q">' + rich(v.q.q) + "</p>";
    h += choicesHTML(v, m.ans[id], false, "mock-pick");
    h += '<div class="actions">' +
      '<button type="button" class="btn" data-act="mock-prev"' + (m.i ? "" : " disabled") + ">前へ<kbd>←</kbd></button>" +
      '<button type="button" class="btn' + (m.flag[id] ? " flagged" : "") + '" data-act="mock-flag">' +
      (m.flag[id] ? "見直しを外す" : "あとで見直す") + "</button>" +
      (v.type === "order" && (m.ans[id] || []).length ? '<button type="button" class="btn" data-act="mock-clear">選び直す</button>' : "") +
      '<button type="button" class="btn primary" data-act="mock-next">' + (m.i + 1 < m.ids.length ? "次へ" : "最後の問題") +
      "<kbd>→</kbd></button></div>";
    h += "</article>";
    h += '<nav class="grid" aria-label="問題の一覧">';
    m.ids.forEach((x, i) => {
      const cls = ["cell"];
      if (isComplete(mockView(x), m.ans[x])) cls.push("done");
      if (m.flag[x]) cls.push("flag");
      if (i === m.i) cls.push("now");
      h += '<button type="button" class="' + cls.join(" ") + '" data-act="mock-go" data-i="' + i + '">' + (i + 1) + "</button>";
    });
    h += "</nav></div></section>";
    main.innerHTML = h;
    timer = setInterval(() => {
      const left = mockRemaining();
      if (left <= 0) { clearInterval(timer); mockFinish(); return; }
      const t = $("mock-timer");
      if (t) { t.textContent = mmss(left); t.classList.toggle("low", left < 600); }
    }, 1000);
  }

  function renderMockIntro() {
    let h = '<section class="read">';
    h += '<h2 class="view-title">模擬試験</h2>';
    h += '<p class="lead">シナリオ問題から65問を配点比で出します。制限時間は170分で、提出するまで正誤は出ません。' +
      "途中で閉じても、この端末なら続きから再開できます。</p>";
    h += '<div class="actions"><button type="button" class="btn primary big" data-act="mock-start">始める</button></div>';
    if (state.lastMock) h += mockResultHTML();
    h += "</section>";
    main.innerHTML = h;
  }

  function mockResultHTML() {
    const lm = state.lastMock;
    const rec = state.mocks[state.mocks.length - 1];
    let h = '<h3 class="sec">前回の結果<span class="sec-right mono">' + ymd(lm.t) + "</span></h3>";
    const score = pct(rec.ok, rec.n);
    h += '<div class="stats">' +
      stat("正答率", '<span class="' + (score >= 80 ? "ok-glow" : "") + '">' + score + "%</span>", rec.ok + " / " + rec.n + "問") +
      stat("かかった時間", mmss(rec.secs), "制限 170:00") + "</div>";
    h += '<ul class="bars">';
    DS.forEach((d) => {
      const [o, n] = rec.dom[d] || [0, 0];
      h += barRow(DOMAINS[d].name, o, n);
    });
    h += "</ul>";
    const wrong = lm.ids.filter((id) => !isCorrect(viewOf(id, lm.perm[id]), lm.ans[id]));
    h += '<h3 class="sec">見直し<span class="sec-right"><label class="toggle"><input type="checkbox" id="review-all"' +
      (mockReviewAll ? " checked" : "") + "> 正解した問題も出す</label></span></h3>";
    (mockReviewAll ? lm.ids : wrong).forEach((id) => {
      const v = viewOf(id, lm.perm[id]);
      h += '<article class="item review">' + metaHTML(v.q) + typeHintHTML(v) + '<p class="q">' + rich(v.q.q) + "</p>" +
        choicesHTML(v, lm.ans[id], true, "none") + explainHTML(v, lm.ans[id]) + "</article>";
    });
    return h;
  }

  function barRow(label, ok, n, sub) {
    const r = pct(ok, n);
    return '<li class="bar-row"><span class="bar-l">' + esc(label) + "</span>" +
      '<span class="bar"><i class="' + (r >= 80 ? "good" : "") + '" style="width:' + (n ? r : 0) + '%"></i><b></b></span>' +
      '<span class="bar-v mono">' + (sub || (n ? r + "%" : "—")) + "</span></li>";
  }

  function mockPick(i) {
    const m = state.mock;
    const id = m.ids[m.i];
    const v = mockView(id);
    if (v.type === "single") m.ans[id] = m.ans[id] === i ? undefined : i;
    else if (v.type !== "match") {
      const sel = m.ans[id] || [];
      const at = sel.indexOf(i);
      if (at >= 0) sel.splice(at, 1); else sel.push(i);
      m.ans[id] = sel;
    }
    save();
    render();
  }

  function mockMove(i) {
    const m = state.mock;
    m.i = Math.max(0, Math.min(m.ids.length - 1, i));
    save();
    render();
    window.scrollTo(0, 0);
  }

  function mockSubmitConfirm() {
    const m = state.mock;
    const blankN = m.ids.filter((x) => !isComplete(mockView(x), m.ans[x])).length;
    const flagN = m.ids.filter((x) => m.flag[x]).length;
    const notes = [];
    if (blankN) notes.push("未解答が " + blankN + " 問");
    if (flagN) notes.push("見直しの印が " + flagN + " 問");
    if (confirm((notes.length ? notes.join("、") + "あります。" : "") + "提出しますか？")) mockFinish();
  }

  // ── 一覧 ────────────────────────────────────────────────
  function renderBrowse() {
    const base = browse.kind === "card" ? CARDS : SCEN;
    const byD = browse.d ? base.filter((q) => q.d === +browse.d) : base;
    const cats = categories(byD);
    if (browse.cat && !cats.includes(browse.cat)) browse.cat = "";
    const needle = browse.q.trim().toLowerCase();
    const list = byD.filter((x) => {
      if (browse.cat && x.cat !== browse.cat) return false;
      if (!needle) return true;
      const hay = [x.q, x.a, x.note, x.exp, x.idea].concat(x.c || [], (x.pairs || []).flat()).join(" ").toLowerCase();
      return hay.includes(needle);
    });
    const opt = (v, l, c) => '<option value="' + esc(v) + '"' + (String(c) === String(v) ? " selected" : "") + ">" + esc(l) + "</option>";
    let h = '<section class="read">';
    h += '<h2 class="view-title">一覧</h2>';
    h += '<div class="form">';
    h += '<label class="field wide"><span class="field-l">検索</span><input type="search" id="b-q" value="' + esc(browse.q) +
      '" placeholder="KMS キーポリシー、Object Lock など"></label>';
    h += field("種類", '<select data-b="kind">' + opt("scen", "シナリオ問題", browse.kind) + opt("card", "一問一答", browse.kind) + "</select>");
    h += field("分野", '<select data-b="d">' + opt("", "すべて", browse.d) + DS.map((d) => opt(d, DOMAINS[d].name, browse.d)).join("") + "</select>");
    h += field("カテゴリ", '<select data-b="cat">' + opt("", "すべて", browse.cat) + cats.map((c) => opt(c, c, browse.cat)).join("") + "</select>");
    h += "</div>";
    h += '<ul class="rows browse">';
    list.forEach((x) => {
      const open = browse.open[x.id];
      h += '<li class="row-wrap"><button type="button" class="row" data-act="toggle" data-id="' + esc(x.id) + '">' +
        '<span class="pill">' + esc(x.cat) + "</span><span>" + rich(x.q) + "</span></button>";
      if (open) {
        if (browse.kind === "card") {
          h += '<div class="opened"><div class="answer"><p>' + rich(x.a) + "</p></div>" +
            (x.note ? '<div class="explain"><p>' + rich(x.note) + "</p></div>" : "") + ideaHTML(x.idea) + "</div>";
        } else {
          const v = viewOf(x.id, x.type === "match" ? { p: range(x.pairs.length), o: range(x.pairs.length) } : range(x.c.length));
          const val = v.type === "match" ? v.pairs.map((p) => p[1]) : v.ans;
          h += '<div class="opened">' + typeHintHTML(v) + choicesHTML(v, val, true, "none") +
            '<div class="explain"><p>' + rich(x.exp) + "</p></div>" + ideaHTML(x.idea) + "</div>";
        }
      }
      h += "</li>";
    });
    h += "</ul></section>";
    main.innerHTML = h;
  }

  // ── 進捗 ────────────────────────────────────────────────
  function renderProgress() {
    let h = '<section class="read">';
    h += '<h2 class="view-title">進捗</h2>';

    h += '<h3 class="sec">分野ごとの正答率<span class="sec-right mute">シナリオ問題の直近30問</span></h3><ul class="bars">';
    DS.forEach((d) => {
      const r = domainRecent(d);
      h += barRow(DOMAINS[d].name + "（" + DOMAINS[d].w + "%）", r.ok, r.n,
        r.n < MIN_RECENT ? "あと " + (MIN_RECENT - r.n) + " 問" : pct(r.ok, r.n) + "%");
    });
    h += "</ul>";

    h += '<h3 class="sec">解いた範囲</h3><ul class="bars">';
    DS.forEach((d) => {
      const scen = SCEN.filter((q) => q.d === d);
      const cards = CARDS.filter((q) => q.d === d);
      const seenS = scen.filter((q) => state.srs[q.id]).length;
      const settled = cards.filter((q) => (state.srs[q.id] || {}).box >= SETTLED_BOX).length;
      h += '<li class="bar-row two"><span class="bar-l">' + esc(DOMAINS[d].name) + "</span>" +
        '<span class="mini"><span class="mute">シナリオ</span> <span class="mono">' + seenS + "/" + scen.length + "</span></span>" +
        '<span class="mini"><span class="mute">一問一答の定着</span> <span class="mono">' + settled + "/" + cards.length + "</span></span></li>";
    });
    h += "</ul>";

    if (state.mocks.length) {
      h += '<h3 class="sec">模擬試験の記録</h3><ul class="rows">';
      state.mocks.slice().reverse().forEach((m) => {
        const s = pct(m.ok, m.n);
        h += '<li class="row static"><span class="mono">' + ymd(m.t) + '</span><span class="mono ' + (s >= 80 ? "ok-glow" : "") +
          '">' + s + '%</span><span class="mono mute">' + mmss(m.secs) + "</span></li>";
      });
      h += "</ul>";
    }

    const opt = (v, l, c) => '<option value="' + esc(v) + '"' + (String(c) === String(v) ? " selected" : "") + ">" + esc(l) + "</option>";
    h += '<h3 class="sec">設定</h3><div class="form">';
    h += field("一問一答の出し方", '<select id="pref-card">' +
      opt("recall", "答えを思い出してから確かめる（推奨）", state.prefs.cardMode) +
      opt("choice", "4択で答える", state.prefs.cardMode) + "</select>");
    h += field("試験日がないときの1日の新規", '<select id="pref-new">' +
      [10, 20, 30, 50].map((n) => opt(n, n + "問", state.prefs.newPerDay)).join("") + "</select>");
    h += "</div>";

    h += '<h3 class="sec">データ</h3><p class="mute">解答履歴はこのブラウザにだけ保存されます。端末を移るときは書き出したファイルを読み込んでください。</p>' +
      '<div class="actions"><button type="button" class="btn" data-act="export">書き出す</button>' +
      '<button type="button" class="btn" data-act="import">読み込む</button>' +
      '<button type="button" class="btn danger" data-act="reset">履歴を消す</button></div>' +
      '<input type="file" id="import-file" accept="application/json" hidden>';
    h += "</section>";
    main.innerHTML = h;
  }

  // ── 操作 ────────────────────────────────────────────────
  const activeSession = () => (view === "today" || view === "practice" ? sessions[view] : null);

  document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));

  main.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled || selectingText()) return;
    const act = el.dataset.act;
    const i = el.dataset.i != null ? +el.dataset.i : null;
    const s = activeSession();
    switch (act) {
      case "start-today": {
        const p = todayPlan();
        startSession("today", weave(p.due, p.fresh), "今日の学習");
        break;
      }
      case "start-practice": startSession("practice", practiceIds(), "演習"); break;
      case "pick": if (s) sessionPick(s, i); break;
      case "submit": if (s) sessionSubmit(s); break;
      case "clear": if (s) { cur(s).val = []; render(); } break;
      case "show": if (s) { cur(s).shown = true; render(); } break;
      case "recall": if (s) sessionRecall(s, el.dataset.r); break;
      case "next": if (s) sessionNext(s); break;
      case "quit": sessions[view] = null; render(); break;
      case "retry": {
        const ids = Object.keys(s.first).filter((id) => !s.first[id]);
        startSession(view, shuffle(ids), s.title);
        break;
      }
      case "mock-start": mockStart(); break;
      case "mock-pick": mockPick(i); break;
      case "mock-prev": mockMove(state.mock.i - 1); break;
      case "mock-next": mockMove(state.mock.i + 1); break;
      case "mock-go": mockMove(i); break;
      case "mock-flag": {
        const id = state.mock.ids[state.mock.i];
        state.mock.flag[id] = !state.mock.flag[id];
        save(); render();
        break;
      }
      case "mock-clear": state.mock.ans[state.mock.ids[state.mock.i]] = []; save(); render(); break;
      case "mock-submit": mockSubmitConfirm(); break;
      case "toggle": browse.open[el.dataset.id] = !browse.open[el.dataset.id]; render(); break;
      case "export": exportData(); break;
      case "import": $("import-file").click(); break;
      case "reset":
        if (confirm("解答履歴をすべて消します。元に戻せません。")) {
          state = blank(); sessions.today = sessions.practice = null; save(); render();
        }
        break;
    }
  });

  main.addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("match-sel")) {
      const i = +t.dataset.i;
      if (view === "mock" && state.mock) {
        const id = state.mock.ids[state.mock.i];
        const arr = state.mock.ans[id] || [];
        arr[i] = t.value;
        state.mock.ans[id] = arr;
        save(); render();
      } else {
        const s = activeSession();
        if (!s) return;
        const it = cur(s);
        it.val = it.val || [];
        it.val[i] = t.value;
        render();
      }
      return;
    }
    if (t.id === "exam-date") { state.prefs.exam = t.value; save(); render(); }
    else if (t.id === "official") { state.prefs.official = t.checked; save(); render(); }
    else if (t.id === "review-all") { mockReviewAll = t.checked; render(); }
    else if (t.id === "pref-card") { state.prefs.cardMode = t.value; save(); }
    else if (t.id === "pref-new") { state.prefs.newPerDay = +t.value; save(); }
    else if (t.id === "import-file") importData(t.files[0]);
    else if (t.dataset.p) { practice[t.dataset.p] = t.value; render(); }
    else if (t.dataset.b) { browse[t.dataset.b] = t.value; render(); }
  });

  main.addEventListener("input", (e) => {
    if (e.target.id !== "b-q") return;
    browse.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const again = $("b-q");
    again.focus();
    again.setSelectionRange(pos, pos);
  });

  document.addEventListener("keydown", (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key, space = e.code === "Space", enter = key === "Enter";
    const n = "123456789".indexOf(key);

    if (view === "mock" && state.mock) {
      const v = mockView(state.mock.ids[state.mock.i]);
      if (key === "ArrowRight") { e.preventDefault(); mockMove(state.mock.i + 1); }
      else if (key === "ArrowLeft") { e.preventDefault(); mockMove(state.mock.i - 1); }
      else if (n >= 0 && v.c && n < v.c.length) { e.preventDefault(); mockPick(n); }
      return;
    }

    const s = activeSession();
    if (!s || s.done) return;
    const it = cur(s);
    if (it.v.kind === "card" && it.mode !== "choice") {
      if (!it.shown && (space || enter)) { e.preventDefault(); it.shown = true; render(); }
      else if (it.shown && n >= 0 && n < 3) { e.preventDefault(); sessionRecall(s, ["again", "hard", "good"][n]); }
      return;
    }
    if (it.answered) {
      if (space || enter || key === "ArrowRight") { e.preventDefault(); sessionNext(s); }
      return;
    }
    const count = it.v.kind === "card" ? it.choices.list.length : it.v.c ? it.v.c.length : 0;
    if (n >= 0 && n < count) { e.preventDefault(); sessionPick(s, n); }
    else if ((space || enter) && it.v.kind === "scen" && it.v.type !== "single") { e.preventDefault(); sessionSubmit(s); }
  });

  // ── 書き出しと読み込み ──────────────────────────────────
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "aws-scs-progress-" + ymd(Date.now()) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const o = JSON.parse(r.result);
        if (o.srs) {
          state = Object.assign(blank(), o);
          state.prefs = Object.assign(blank().prefs, o.prefs);
        } else if (o.cards || o.quiz) {
          state = blank();
          migrate(o, state); // 旧版の書き出しファイル
        } else throw new Error("形式が違います");
        sessions.today = sessions.practice = null;
        save();
        render();
        alert("読み込みました。");
      } catch (err) {
        alert("読み込めませんでした: " + err.message);
      }
    };
    r.readAsText(file);
  }

  render();
})();
