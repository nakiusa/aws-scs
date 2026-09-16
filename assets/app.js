/* AWS SCS-C03 一問一答 — 静的サイト（GitHub Pages 想定）
 *
 * 問題データは data/*.js が window.SCS_CARDS / window.SCS_SCENARIOS に push する。
 * 解答履歴は localStorage にのみ保存し、サーバーには何も送らない。
 */
(function () {
  "use strict";

  var STORE_KEY = "awsscs.c03.v1";

  var CARDS = window.SCS_CARDS || [];
  var SCEN = window.SCS_SCENARIOS || [];

  var DOMAINS = {
    1: { short: "検出", label: "第1分野: 検出（16%）" },
    2: { short: "IR", label: "第2分野: インシデント対応（14%）" },
    3: { short: "インフラ", label: "第3分野: インフラストラクチャのセキュリティ（18%）" },
    4: { short: "IAM", label: "第4分野: アイデンティティとアクセスの管理（20%）" },
    5: { short: "データ保護", label: "第5分野: データ保護（18%）" },
    6: { short: "ガバナンス", label: "第6分野: セキュリティの基礎とガバナンス（14%）" },
  };

  // ── ストレージ ──────────────────────────────────────────
  var state = load();

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        o.cards = o.cards || {};
        o.quiz = o.quiz || {};
        return o;
      }
    } catch (e) { /* 壊れていたら初期化する */ }
    return { cards: {}, quiz: {} };
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("保存できませんでした", e);
    }
  }

  function cardStat(id) {
    return state.cards[id] || (state.cards[id] = { b: 0, ok: 0, ng: 0 });
  }
  function quizStat(id) {
    return state.quiz[id] || (state.quiz[id] = { ok: 0, ng: 0, last: null });
  }

  // ── ユーティリティ ──────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // 問題文の `code` 記法だけを許可して装飾する
  function rich(s) {
    return esc(s).replace(/`([^`]+)`/g, function (_, m) { return "<code>" + m + "</code>"; });
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function el(id) { return document.getElementById(id); }

  // 文字を選択しただけのクリックを、解答や開閉として扱わない。
  // 通常のクリックは mousedown で選択が解除されるので、ここに来るのは
  // ドラッグで選択を終えた場合だけになる。
  function selectingText() {
    var sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
  }

  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

  function categories(items) {
    var seen = {}, out = [];
    items.forEach(function (x) {
      if (!seen[x.cat]) { seen[x.cat] = 1; out.push(x.cat); }
    });
    return out;
  }

  // ── 一問一答の選択肢づくり ──────────────────────────────
  // 誤選択肢は他の問題の解答を流用する。文章を生成しないので、
  // 「誤選択肢のはずが実は正しい」という事故は起こしにくい。
  // ただし解答が実質同じ問題が数組あるため、近すぎるものは弾く。

  function keyTerms(s) {
    var out = {}, m = s.match(/[A-Za-z0-9][A-Za-z0-9.+-]{2,}/g) || [];
    m.forEach(function (t) { out[t.toLowerCase()] = 1; });
    return out;
  }
  function overlap(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (!ka.length || !kb.length) return -1; // サービス名を含まない解答同士は判定不能
    var n = 0;
    ka.forEach(function (k) { if (b[k]) n++; });
    return n / (ka.length + kb.length - n);
  }
  function bigramSim(a, b) {
    var A = {}, n = 0, size = 0;
    for (var i = 0; i < a.length - 1; i++) { if (!A[a.slice(i, i + 2)]) { A[a.slice(i, i + 2)] = 1; size++; } }
    var seen = {}, bsize = 0;
    for (var j = 0; j < b.length - 1; j++) {
      var g = b.slice(j, j + 2);
      if (seen[g]) continue;
      seen[g] = 1; bsize++;
      if (A[g]) n++;
    }
    return size + bsize ? (2 * n) / (size + bsize) : 0;
  }
  // 同じことを言っている解答か
  function tooClose(a, b) {
    var ov = overlap(keyTerms(a), keyTerms(b));
    if (ov >= 0) return ov > 0.6;
    return bigramSim(a, b) > 0.5;
  }

  // 解答の「文の形」。問いに対して形がかみ合わない誤選択肢
  // （「〜のため。」が「何を強制できるか」の答えに並ぶなど）を避けるために使う。
  // 最初の一文だけを見る。
  function answerForm(a) {
    var first = a.split("。")[0];
    if (/(ため|から|ためである)$/.test(first)) return "reason";      // なぜ、への答え
    if (!/[\u3041-\u3096]$/.test(first)) return "noun";              // 名詞止め（列挙、名称）
    if (/(ない|できる|である|になる|だ|いる|ある|のみ|だけ|限る)$/.test(first)) return "state";  // 状態・可否
    return "how";                                                       // 手順・方法
  }

  function buildChoices(card) {
    // 手書きの誤選択肢があればそれを使う
    if (card.x && card.x.length >= 3) {
      var fixed = shuffle(card.x.slice(0, 3).map(function (t, i) { return { id: card.id + "#x" + i, a: t }; }).concat([card]));
      return { list: fixed, ans: fixed.indexOf(card) };
    }
    var form = answerForm(card.a);
    var sameForm = function (x) { return answerForm(x.a) === form; };
    // 近いものから順に探し、形が合うものを優先する。最後の砦だけ形を問わない
    var pools = [
      CARDS.filter(function (x) { return x.cat === card.cat && sameForm(x); }),
      CARDS.filter(function (x) { return x.d === card.d && sameForm(x); }),
      CARDS.filter(sameForm),
      CARDS
    ];
    var picks = [];
    for (var p = 0; p < pools.length && picks.length < 3; p++) {
      var cands = pools[p].filter(function (x) {
        if (x.id === card.id) return false;
        if (tooClose(x.a, card.a)) return false;
        for (var k = 0; k < picks.length; k++) {
          if (picks[k].id === x.id || tooClose(x.a, picks[k].a)) return false;
        }
        return true;
      });
      // 文の長さで正解が透けないよう、長さの近いものから選ぶ
      cands.sort(function (x, y) {
        return Math.abs(x.a.length - card.a.length) - Math.abs(y.a.length - card.a.length);
      });
      shuffle(cands.slice(0, 14)).forEach(function (c) {
        if (picks.length < 3 && picks.every(function (q) { return q.id !== c.id && !tooClose(q.a, c.a); })) picks.push(c);
      });
    }
    var list = shuffle(picks.concat([card]));
    return { list: list, ans: list.indexOf(card) };
  }

  // ── 画面の状態 ──────────────────────────────────────────
  var view = "study";
  var study = { queue: [], i: 0, shown: false, started: false, cat: "", mode: "all", shuffle: true,
                fmt: "choice", choices: null, picked: null, log: [] };
  var quiz = { queue: [], i: 0, answered: null, sel: [], log: [], started: false, done: false,
               scope: "all", count: "20", wrongOnly: false };
  var browse = { q: "", cat: "", kind: "card", open: {} };

  var main = el("main");

  function render() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("on", t.dataset.view === view);
    });
    if (view === "study") renderStudy();
    else if (view === "quiz") renderQuiz();
    else if (view === "browse") renderBrowse();
    else renderProgress();
    renderCounts();
  }

  function renderCounts() {
    var mastered = CARDS.filter(function (c) { return (state.cards[c.id] || {}).b >= 2; }).length;
    el("counts").textContent =
      "一問一答 " + CARDS.length + "問 / シナリオ " + SCEN.length + "問 ・ 習得 " + mastered;
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { view = t.dataset.view; render(); });
  });

  // ── 一問一答 ────────────────────────────────────────────
  function buildStudyQueue() {
    var list = CARDS.filter(function (c) {
      if (study.cat && c.cat !== study.cat) return false;
      var s = state.cards[c.id];
      if (study.mode === "unlearned") return !s || s.b < 2;
      if (study.mode === "wrong") return s && s.ng > 0 && s.b < 2;
      if (study.mode === "unseen") return !s || (s.ok === 0 && s.ng === 0);
      return true;
    });
    if (study.shuffle) shuffle(list);
    else list.sort(function (a, b) { return (state.cards[a.id] || { b: 0 }).b - (state.cards[b.id] || { b: 0 }).b; });
    study.queue = list;
    study.i = 0;
    study.log = [];
    resetCard();
  }

  // 出題中の1問ぶんの状態を初期化する
  function resetCard() {
    study.shown = false;
    study.picked = null;
    study.choices = null;
  }

  function renderStudy() {
    var cats = categories(CARDS);
    var h = '<div class="filters">';
    h += '<select id="s-cat"><option value="">全カテゴリ（' + CARDS.length + '）</option>';
    cats.forEach(function (c) {
      var n = CARDS.filter(function (x) { return x.cat === c; }).length;
      h += '<option value="' + esc(c) + '"' + (study.cat === c ? " selected" : "") + ">" + esc(c) + "（" + n + "）</option>";
    });
    h += "</select>";
    h += '<select id="s-mode">' +
      opt("all", "すべて", study.mode) +
      opt("unlearned", "未習得のみ", study.mode) +
      opt("wrong", "間違えた問題のみ", study.mode) +
      opt("unseen", "未出題のみ", study.mode) +
      "</select>";
    h += '<select id="s-fmt">' +
      opt("choice", "4択", study.fmt) +
      opt("card", "暗記カード", study.fmt) +
      "</select>";
    h += '<label class="small row" style="gap:5px"><input type="checkbox" id="s-shuffle"' +
      (study.shuffle ? " checked" : "") + "> シャッフル</label>";
    h += '<button class="btn primary" id="s-start">' + (study.started ? "やり直す" : "開始") + "</button>";
    h += "</div>";

    if (!study.started) {
      h += '<div class="card"><h3>使い方</h3>' +
        '<p class="mt small muted">' +
        "<b>4択</b>は、選んだ時点で正誤と<b>解説</b>、そしてその答えの背後にある<b>思想</b>が出ます。正解すると習熟度が1段上がり、2段目からは習得済みとして扱われます。" +
        "間違えると習熟度が下がり、未習得の問題として何度も出てきます。キーボードは <code>1</code>〜<code>4</code> で解答、" +
        "<code>Space</code> で次の問題へ。</p>" +
        '<p class="mt small muted">' +
        "<b>暗記カード</b>は選択肢なしで、解答を開いてから「わかった / あやふや」で自己採点します。" +
        "選択肢があると消去法で当たってしまうため、仕上げの確認にはこちらが向きます。</p>" +
        '<p class="mt small muted">シナリオ問題と併用してください。用語を覚えるのが一問一答、' +
        "要件から設計を選ぶ練習がシナリオ問題で、本試験で問われるのは後者です。</p></div>";
      main.innerHTML = h;
      bindStudyFilters();
      return;
    }

    if (!study.queue.length) {
      h += '<div class="card"><h3>該当する問題がありません</h3><p class="mt muted small">' +
        "条件を変えるか、「すべて」で出題してください。</p></div>";
      main.innerHTML = h;
      bindStudyFilters();
      return;
    }

    if (study.i >= study.queue.length) {
      h += '<div class="card">';
      if (study.fmt === "choice" && study.log.length) {
        var okN = study.log.filter(function (l) { return l.ok; }).length;
        h += '<div class="result-big">' + pct(okN, study.log.length) + "%</div>" +
          '<p class="muted">' + study.log.length + "問中 " + okN + "問正解</p>";
      } else {
        h += "<h3>この範囲は終わりです（" + study.queue.length + "問）</h3>";
      }
      h += '<p class="mt muted small">「未習得のみ」で回し直すと、間違えた問題とあやふやだった問題だけが出てきます。</p>' +
        '<div class="mt"><button class="btn primary" id="s-again">もう一周する</button></div></div>';
      main.innerHTML = h;
      bindStudyFilters();
      el("s-again").addEventListener("click", function () { buildStudyQueue(); render(); });
      return;
    }

    var c = study.queue[study.i];
    var st = state.cards[c.id] || { b: 0, ok: 0, ng: 0 };
    h += '<div class="progressbar"><i style="width:' + pct(study.i, study.queue.length) + '%"></i></div>';
    h += '<div class="card flash">';
    h += '<div class="flash-meta"><span class="badge badge-d1">' + esc(c.cat) + "</span>" +
      '<span class="badge">' + esc(DOMAINS[c.d].short) + "</span>" +
      '<span class="badge">習熟 ' + st.b + "/3</span>" +
      '<span class="muted small" style="margin-left:auto">' + (study.i + 1) + " / " + study.queue.length + "</span></div>";
    h += '<div class="flash-q">' + rich(c.q) + "</div>";

    if (study.fmt === "choice") {
      if (!study.choices) study.choices = buildChoices(c);
      var ch = study.choices;
      h += '<ul class="choices">';
      ch.list.forEach(function (item, idx) {
        var cls = "choice", mark = "ABCD"[idx];
        if (study.picked != null) {
          if (idx === ch.ans) { cls += " correct"; mark = "◯"; }
          else if (idx === study.picked) { cls += " chosen-wrong"; mark = "✕"; }
        }
        h += '<li><button class="' + cls + (study.picked != null ? " locked" : "") + '" data-i="' + idx + '"' +
          (study.picked != null ? ' aria-disabled="true"' : "") + '><span class="mark">' + mark + "</span>" +
          "<span>" + rich(item.a) + "</span></button></li>";
      });
      h += "</ul>";
      if (study.picked != null) {
        if (c.note) h += '<div class="explain"><h4>解説</h4>' + rich(c.note) + "</div>";
        if (c.idea) h += '<div class="explain idea"><h4>思想</h4>' + rich(c.idea) + "</div>";
        h += '<div class="flash-actions"><button class="btn primary" id="s-next">' +
          (study.i + 1 >= study.queue.length ? "結果を見る (Space)" : "次の問題 (Space)") + "</button>" +
          '<span class="keyhint">解答は 1〜4 キーでも選べます</span></div>';
      }
    } else if (study.shown) {
      h += '<div class="flash-a"><div class="ans">' + rich(c.a) + "</div>";
      if (c.note) h += '<div class="note">' + rich(c.note) + "</div>";
      if (c.idea) h += '<div class="note idea"><b>思想</b> ' + rich(c.idea) + "</div>";
      h += "</div>";
      h += '<div class="flash-actions"><button class="btn good" id="s-ok">わかった (1)</button>' +
        '<button class="btn bad" id="s-ng">あやふや (2)</button>' +
        '<span class="keyhint">Space で次の解答も開けます</span></div>';
    } else {
      h += '<div class="flash-actions"><button class="btn primary" id="s-show">解答を見る (Space)</button>' +
        '<button class="btn" id="s-skip">スキップ (→)</button></div>';
    }
    h += "</div>";
    main.innerHTML = h;
    bindStudyFilters();

    if (study.fmt === "choice") {
      main.querySelectorAll(".choice").forEach(function (b) {
        b.addEventListener("click", function () {
          if (selectingText()) return;
          pickChoice(parseInt(b.dataset.i, 10));
        });
      });
      if (el("s-next")) el("s-next").addEventListener("click", advanceCard);
    } else if (study.shown) {
      el("s-ok").addEventListener("click", function () { grade(true); });
      el("s-ng").addEventListener("click", function () { grade(false); });
    } else {
      el("s-show").addEventListener("click", function () { study.shown = true; render(); });
      el("s-skip").addEventListener("click", function () { study.i++; resetCard(); render(); });
    }
  }

  function pickChoice(idx) {
    if (study.picked != null || !study.choices) return;
    study.picked = idx;
    var card = study.queue[study.i];
    var ok = idx === study.choices.ans;
    applyGrade(card, ok);
    study.log.push({ id: card.id, ok: ok });
    render();
  }

  function advanceCard() {
    study.i++;
    resetCard();
    render();
  }

  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (cur === v ? " selected" : "") + ">" + label + "</option>";
  }

  function bindStudyFilters() {
    var cat = el("s-cat"), mode = el("s-mode"), sh = el("s-shuffle"), start = el("s-start"), fmt = el("s-fmt");
    if (!cat) return;
    cat.addEventListener("change", function () { study.cat = cat.value; });
    mode.addEventListener("change", function () { study.mode = mode.value; });
    sh.addEventListener("change", function () { study.shuffle = sh.checked; });
    fmt.addEventListener("change", function () {
      study.fmt = fmt.value;
      resetCard();
      render();
    });
    start.addEventListener("click", function () {
      study.started = true;
      buildStudyQueue();
      render();
    });
  }

  function applyGrade(card, ok) {
    var s = cardStat(card.id);
    if (ok) { s.ok++; s.b = Math.min(3, s.b + 1); }
    else { s.ng++; s.b = Math.max(0, s.b - 1); }
    save();
  }

  function grade(ok) {
    applyGrade(study.queue[study.i], ok);
    study.i++;
    resetCard();
    render();
  }

  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    if (view === "study" && study.started && study.i < study.queue.length) {
      if (study.fmt === "choice") {
        if (study.picked == null && "1234".indexOf(e.key) >= 0) { e.preventDefault(); pickChoice(parseInt(e.key, 10) - 1); }
        else if (study.picked != null && (e.code === "Space" || e.key === "Enter" || e.key === "ArrowRight")) {
          e.preventDefault(); advanceCard();
        }
        return;
      }
      if (e.code === "Space") { e.preventDefault(); if (!study.shown) { study.shown = true; render(); } }
      else if (study.shown && (e.key === "1" || e.key === "j")) { e.preventDefault(); grade(true); }
      else if (study.shown && (e.key === "2" || e.key === "k")) { e.preventDefault(); grade(false); }
      else if (e.key === "ArrowRight") { e.preventDefault(); study.i++; resetCard(); render(); }
    } else if (view === "quiz" && quiz.started && !quiz.done) {
      var qq = quiz.queue[quiz.i];
      if (quiz.answered != null && (e.code === "Space" || e.key === "Enter" || e.key === "ArrowRight")) {
        e.preventDefault(); nextQuiz();
      } else if (quiz.answered == null && qq) {
        if (qq.type === "match") return;                 // マッチングはセレクトで操作する
        var n = "123456789".indexOf(e.key);
        if (n >= 0 && n < (qq.c || []).length) { e.preventDefault(); pickQuiz(n); }
        else if (e.code === "Space" || e.key === "Enter") {
          if (qq.type) { e.preventDefault(); submitQuiz(); }
        }
      }
    }
  });



  // 一覧や復習で「正解」を1行で示す
  function answerText(q) {
    if (q.type === "match") {
      return q.pairs.map(function (p) { return p[0] + " → " + p[1]; }).join(" / ");
    }
    if (q.type === "order") return q.ans.map(function (i) { return q.c[i]; }).join(" → ");
    if (q.type === "multi") return q.ans.map(function (i) { return "ABCDEFG"[i] + ". " + q.c[i]; }).join(" / ");
    return "ABCDEFG"[q.ans] + ". " + q.c[q.ans];
  }


  // 出題のたびに選択肢の並びを入れ替える。
  // データ側は「正解を先頭に書く」形で書きやすくしてあるので、
  // シャッフルしないと位置だけで正解が当たってしまう。
  function prepareQuestion(q) {
    if (q.type === "match") {
      var pairs = shuffle(q.pairs.slice());
      var opts = shuffle(q.pairs.map(function (p) { return p[1]; }));
      return Object.assign({}, q, { pairs: pairs, opts: opts });
    }
    var perm = shuffle(q.c.map(function (_, i) { return i; }));   // 表示位置 → 元の位置
    var pos = [];                                                  // 元の位置 → 表示位置
    perm.forEach(function (orig, shown) { pos[orig] = shown; });
    var out = Object.assign({}, q, {
      c: perm.map(function (orig) { return q.c[orig]; })
    });
    if (q.ng) out.ng = perm.map(function (orig) { return q.ng[orig]; });
    out.ans = q.type ? q.ans.map(function (orig) { return pos[orig]; }) : pos[q.ans];
    return out;
  }

  // ── 出題形式（SCS-C03 で択一以外が加わった）──────────────
  // 単一選択（type なし）、複数選択、並べ替え、組み合わせの4種類を扱う。
  var TYPE_HINT = {
    multi: "複数選択（正解は2つ以上）",
    order: "並べ替え（正しい順に選ぶ）",
    match: "組み合わせ（それぞれに対応するものを選ぶ）"
  };

  function isOrdered(q) { return q.type === "order"; }

  // 正解の集合／並び。単一選択は数値、それ以外は配列を返す
  function correctOf(q) {
    if (q.type === "match") return q.pairs.map(function (p) { return p[1]; });
    return q.ans;
  }

  function wasCorrect() {
    var q = quiz.queue[quiz.i], v = quiz.answered;
    if (v == null) return false;
    if (!q.type) return v === q.ans;
    var want = correctOf(q);
    if (v.length !== want.length) return false;
    if (isOrdered(q) || q.type === "match") {
      return want.every(function (x, i) { return v[i] === x; });
    }
    var a = v.slice().sort(), b = want.slice().sort();          // 複数選択は順不同
    return a.every(function (x, i) { return x === b[i]; });
  }

  function answerLabel(q) {
    if (!q.type) return "なぜ " + "ABCDEFG"[q.ans] + " なのか";
    if (q.type === "multi") return "正解は " + q.ans.map(function (i) { return "ABCDEFG"[i]; }).join("、");
    if (q.type === "order") return "正しい順序は " + q.ans.map(function (i) { return "ABCDEFG"[i]; }).join(" → ");
    return "それぞれの正しい対応";
  }

  // 選択のトグル。並べ替えは押した順に積み、複数選択は入り切りする
  function pickQuiz(idx) {
    var q = quiz.queue[quiz.i];
    if (quiz.answered != null || !q.type || q.type === "match") return;
    var at = quiz.sel.indexOf(idx);
    if (isOrdered(q)) {
      if (at >= 0) quiz.sel.splice(at, 1); else quiz.sel.push(idx);
    } else {
      if (at >= 0) quiz.sel.splice(at, 1); else quiz.sel.push(idx);
    }
    render();
  }

  function submitQuiz() {
    var q = quiz.queue[quiz.i];
    if (quiz.answered != null || !q.type) return;
    if (q.type === "match") {
      if (quiz.sel.length !== q.pairs.length || quiz.sel.some(function (v) { return !v; })) {
        alert("すべての項目を選んでから解答してください。"); return;
      }
    } else if (!quiz.sel.length) {
      alert("選択肢を選んでください。"); return;
    }
    recordQuiz(quiz.sel.slice());
  }

  function renderChoices(q) {
    if (q.type === "match") return renderMatch(q);
    var done = quiz.answered != null;
    var want = q.type ? correctOf(q) : [q.ans];
    var h = '<ul class="choices">';
    q.c.forEach(function (choice, idx) {
      var cls = "choice", mark = "ABCDEFG"[idx];
      var chosenAt = done ? quiz.answered.indexOf ? quiz.answered.indexOf(idx) : -1 : quiz.sel.indexOf(idx);
      if (done) {
        var inWant = want.indexOf(idx) >= 0;
        if (isOrdered(q)) {
          // 正しい位置を番号で示し、自分が置いた位置と違うものだけを誤りとして色分けする
          mark = String(want.indexOf(idx) + 1);
          cls += (chosenAt === want.indexOf(idx)) ? " correct" : " chosen-wrong";
        } else if (inWant) {
          cls += " correct";
          mark = "◯";
        } else if (chosenAt >= 0 || quiz.answered === idx) { cls += " chosen-wrong"; mark = "✕"; }
      } else if (chosenAt >= 0) {
        cls += " picked"; mark = isOrdered(q) ? String(chosenAt + 1) : "✓";
      }
      h += '<li><button class="' + cls + (done ? " locked" : "") + '" data-i="' + idx + '"' +
        (done ? ' aria-disabled="true"' : "") + ">" +
        '<span class="mark">' + mark + "</span><span>" + rich(choice);
      if (done && want.indexOf(idx) < 0 && q.ng && q.ng[idx]) {
        h += '<span class="why">' + rich(q.ng[idx]) + "</span>";
      }
      h += "</span></button></li>";
    });
    return h + "</ul>";
  }

  function renderMatch(q) {
    var done = quiz.answered != null;
    var pool = q.opts || q.pairs.map(function (p) { return p[1]; });
    var h = '<div class="matchlist">';
    q.pairs.forEach(function (pair, i) {
      var picked = done ? quiz.answered[i] : quiz.sel[i];
      var ok = picked === pair[1];
      h += '<div class="matchrow' + (done ? (ok ? " correct" : " chosen-wrong") : "") + '">' +
        '<div class="matchq">' + rich(pair[0]) + "</div>";
      if (done) {
        h += '<div class="matcha">' + (ok ? "◯ " : "✕ ") + rich(picked || "（未選択）") +
          (ok ? "" : '<span class="why">正しくは ' + rich(pair[1]) + "</span>") + "</div>";
      } else {
        h += '<select class="match-sel" data-i="' + i + '"><option value="">選んでください</option>';
        pool.forEach(function (o) {
          h += '<option value="' + esc(o) + '"' + (picked === o ? " selected" : "") + ">" + esc(o) + "</option>";
        });
        h += "</select>";
      }
      h += "</div>";
    });
    return h + "</div>";
  }

  // 採点と履歴の記録。形式によらずここを通す
  function recordQuiz(value) {
    var q = quiz.queue[quiz.i];
    quiz.answered = value;
    var ok = wasCorrect();
    var t = quizStat(q.id);
    if (ok) t.ok++; else t.ng++;
    t.last = ok;
    quiz.log.push({ id: q.id, d: q.d, ok: ok });
    save();
    render();
  }

  // ── シナリオ問題 ────────────────────────────────────────
  function renderQuiz() {
    if (!quiz.started) return renderQuizSetup();
    if (quiz.done) return renderQuizResult();

    var q = quiz.queue[quiz.i];
    var h = '<div class="progressbar"><i style="width:' + pct(quiz.i, quiz.queue.length) + '%"></i></div>';
    h += '<div class="card">';
    h += '<div class="flash-meta"><span class="badge badge-d1">' + esc(q.cat) + "</span>" +
      '<span class="badge">' + esc(DOMAINS[q.d].short) + "</span>" +
      '<span class="muted small" style="margin-left:auto">' + (quiz.i + 1) + " / " + quiz.queue.length + "</span></div>";
    h += '<div style="font-size:16px">' + rich(q.q) + "</div>";
    if (q.type) h += '<p class="qtype">' + esc(TYPE_HINT[q.type]) + "</p>";
    h += renderChoices(q);

    if (quiz.answered != null) {
      h += '<div class="explain"><h4>' + (wasCorrect() ? "正解" : "不正解") + "：" + esc(answerLabel(q)) + "</h4>" +
        rich(q.exp) + "</div>";
      if (q.idea) h += '<div class="explain idea"><h4>思想</h4>' + rich(q.idea) + "</div>";
      h += '<div class="flash-actions"><button class="btn primary" id="q-next">' +
        (quiz.i + 1 >= quiz.queue.length ? "結果を見る" : "次の問題 (Space)") + "</button></div>";
    } else if (q.type) {
      h += '<div class="flash-actions"><button class="btn primary" id="q-submit">解答する</button>' +
        (q.type === "order" ? '<button class="btn" id="q-clear">選び直す</button>' : "") +
        '<span class="keyhint">' + (q.type === "match" ? "すべて選んでから解答してください" : "数字キーで選択、Space で解答") + "</span></div>";
    }
    h += "</div>";
    main.innerHTML = h;

    main.querySelectorAll(".choice").forEach(function (b) {
      b.addEventListener("click", function () {
        if (selectingText()) return;
        if (q.type) pickQuiz(parseInt(b.dataset.i, 10)); else answerQuiz(parseInt(b.dataset.i, 10));
      });
    });
    main.querySelectorAll(".match-sel").forEach(function (sel) {
      sel.addEventListener("change", function () { quiz.sel[parseInt(sel.dataset.i, 10)] = sel.value; });
    });
    if (el("q-submit")) el("q-submit").addEventListener("click", submitQuiz);
    if (el("q-clear")) el("q-clear").addEventListener("click", function () { quiz.sel = []; render(); });
    if (el("q-next")) el("q-next").addEventListener("click", nextQuiz);
  }

  function renderQuizSetup() {
    var cats = categories(SCEN);
    var wrong = SCEN.filter(function (s) { var t = state.quiz[s.id]; return t && t.last === false; }).length;
    var h = '<div class="card"><h3>シナリオ問題</h3>' +
      '<p class="mt small muted">本試験と同じ形式の状況設定問題です。SCS-C03 で加わった複数選択、並べ替え、組み合わせも混ざります。' +
      '要件（最小権限、運用負荷、検知の速さ、証跡の完全性、ダウンタイム）のうち' +
      "どれが優先されているかを読み取るのがコツで、選択肢は「動くかどうか」ではなく「要件に一番合うか」で選びます。</p>";
    h += '<div class="filters mt">';
    h += '<select id="q-scope">' + opt("all", "全分野（" + SCEN.length + "問）", quiz.scope);
    [1, 2, 3, 4, 5, 6].forEach(function (d) {
      var n = SCEN.filter(function (s) { return s.d === d; }).length;
      h += opt("d" + d, DOMAINS[d].short + "（" + n + "問）", quiz.scope);
    });
    cats.forEach(function (c) {
      var n = SCEN.filter(function (s) { return s.cat === c; }).length;
      h += opt("c:" + c, c + "（" + n + "問）", quiz.scope);
    });
    h += "</select>";
    h += '<select id="q-count">' + opt("10", "10問", quiz.count) + opt("20", "20問", quiz.count) +
      opt("65", "65問（本番と同じ数。170分で解く）", quiz.count) + opt("all", "全問", quiz.count) + "</select>";
    h += '<label class="small row" style="gap:5px"><input type="checkbox" id="q-wrong"' +
      (quiz.wrongOnly ? " checked" : "") + "> 前回間違えた問題のみ（" + wrong + "問）</label>";
    h += '<button class="btn primary" id="q-start">開始</button>';
    h += "</div></div>";

    // 分野別の正答率
    h += '<div class="card"><h3>分野別の正答率</h3><div class="bars mt">';
    [1, 2, 3, 4, 5, 6].forEach(function (d) {
      var list = SCEN.filter(function (s) { return s.d === d; });
      var ok = 0, ng = 0;
      list.forEach(function (s) {
        var t = state.quiz[s.id];
        if (t) { ok += t.ok; ng += t.ng; }
      });
      var rate = pct(ok, ok + ng);
      h += '<div class="barrow"><div>' + DOMAINS[d].short + "</div>" +
        '<div class="bar"><i class="b-ok" style="width:' + rate + '%"></i>' +
        '<i class="b-ng" style="width:' + (ok + ng ? 100 - rate : 0) + '%"></i></div>' +
        '<div class="muted">' + (ok + ng ? rate + "%" : "未挑戦") + "</div></div>";
    });
    h += '</div><p class="mt small muted">本試験の合格ラインは1000点満点中750点で、目安として8割前後を安定して取れる状態を目指してください。</p></div>';
    main.innerHTML = h;

    el("q-scope").addEventListener("change", function () { quiz.scope = this.value; });
    el("q-count").addEventListener("change", function () { quiz.count = this.value; });
    el("q-wrong").addEventListener("change", function () { quiz.wrongOnly = this.checked; });
    el("q-start").addEventListener("click", startQuiz);
  }

  function startQuiz() {
    var list = SCEN.filter(function (s) {
      if (quiz.scope.indexOf("d") === 0 && quiz.scope.length === 2) return s.d === parseInt(quiz.scope[1], 10);
      if (quiz.scope.indexOf("c:") === 0) return s.cat === quiz.scope.slice(2);
      return true;
    });
    if (quiz.wrongOnly) {
      list = list.filter(function (s) { var t = state.quiz[s.id]; return t && t.last === false; });
    }
    shuffle(list);
    if (quiz.count !== "all") list = list.slice(0, parseInt(quiz.count, 10));
    if (!list.length) { alert("条件に合う問題がありません。"); return; }
    quiz.queue = list.map(prepareQuestion);
    quiz.i = 0;
    quiz.answered = null;
    quiz.sel = [];
    quiz.log = [];
    quiz.started = true;
    quiz.done = false;
    render();
  }

  function answerQuiz(idx) {
    var q = quiz.queue[quiz.i];
    if (!q || q.type || idx >= q.c.length || quiz.answered != null) return;
    recordQuiz(idx);
  }

  function nextQuiz() {
    quiz.answered = null;
    quiz.sel = [];
    quiz.i++;
    if (quiz.i >= quiz.queue.length) quiz.done = true;
    render();
  }

  function renderQuizResult() {
    var ok = quiz.log.filter(function (l) { return l.ok; }).length;
    var rate = pct(ok, quiz.log.length);
    var h = '<div class="card"><div class="result-big">' + rate + "%</div>" +
      '<p class="muted">' + quiz.log.length + "問中 " + ok + "問正解" +
      (rate >= 80 ? "（合格ラインの目安を超えています）" : "（目安の8割まであと " + Math.max(0, Math.ceil(quiz.log.length * 0.8) - ok) + "問）") +
      "</p>";
    h += '<div class="bars mt">';
    [1, 2, 3, 4, 5, 6].forEach(function (d) {
      var l = quiz.log.filter(function (x) { return x.d === d; });
      if (!l.length) return;
      var o = l.filter(function (x) { return x.ok; }).length;
      var r = pct(o, l.length);
      h += '<div class="barrow"><div>' + DOMAINS[d].short + "</div>" +
        '<div class="bar"><i class="b-ok" style="width:' + r + '%"></i><i class="b-ng" style="width:' + (100 - r) + '%"></i></div>' +
        '<div class="muted">' + o + "/" + l.length + "</div></div>";
    });
    h += "</div>";
    h += '<div class="flash-actions"><button class="btn primary" id="q-retry">間違えた問題をやり直す</button>' +
      '<button class="btn" id="q-back">条件を選び直す</button></div></div>';

    var wrongIds = quiz.log.filter(function (l) { return !l.ok; }).map(function (l) { return l.id; });
    if (wrongIds.length) {
      h += '<div class="card"><h3>間違えた問題の復習</h3>';
      wrongIds.forEach(function (id) {
        var q = SCEN.filter(function (s) { return s.id === id; })[0];
        if (!q) return;
        h += '<div class="list-item"><div class="txt"><div>' + rich(q.q) + "</div>" +
          '<div class="list-a"><b>正解: ' + rich(answerText(q)) + "</b>" +
          '<div class="note">' + rich(q.exp) + "</div>" +
          (q.idea ? '<div class="note idea"><b>思想</b> ' + rich(q.idea) + "</div>" : "") + "</div></div></div>";
      });
      h += "</div>";
    }
    main.innerHTML = h;
    el("q-retry").addEventListener("click", function () {
      var retry = quiz.queue.filter(function (q) { return wrongIds.indexOf(q.id) >= 0; });
      if (!retry.length) { quiz.started = false; render(); return; }
      quiz.queue = shuffle(retry).map(prepareQuestion);
      quiz.i = 0; quiz.answered = null; quiz.sel = []; quiz.log = []; quiz.done = false;
      render();
    });
    el("q-back").addEventListener("click", function () { quiz.started = false; quiz.done = false; render(); });
  }

  // ── 一覧 ────────────────────────────────────────────────
  function renderBrowse() {
    var items = browse.kind === "card" ? CARDS : SCEN;
    var cats = categories(items);
    var q = browse.q.trim().toLowerCase();
    var list = items.filter(function (x) {
      if (browse.cat && x.cat !== browse.cat) return false;
      if (!q) return true;
      var hay = (x.q + " " + (x.a || "") + " " + (x.note || "") + " " + (x.idea || "") + " " + (x.exp || "") + " " + (x.c || []).join(" ") + " " + (x.pairs || []).map(function (p) { return p.join(" "); }).join(" ")).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    var h = '<div class="filters">';
    h += '<select id="b-kind">' + opt("card", "一問一答（" + CARDS.length + "）", browse.kind) +
      opt("scen", "シナリオ問題（" + SCEN.length + "）", browse.kind) + "</select>";
    h += '<select id="b-cat"><option value="">全カテゴリ</option>';
    cats.forEach(function (c) {
      h += '<option value="' + esc(c) + '"' + (browse.cat === c ? " selected" : "") + ">" + esc(c) + "</option>";
    });
    h += "</select>";
    h += '<input type="search" id="b-q" placeholder="キーワード検索（例: Gateway エンドポイント）" value="' + esc(browse.q) + '">';
    h += "</div>";

    h += '<div class="card"><p class="small muted">' + list.length + "件</p>";
    list.forEach(function (x) {
      var open = !!browse.open[x.id];
      h += '<div class="list-item"><div class="list-q" data-id="' + x.id + '">' +
        '<span class="badge">' + esc(x.cat) + "</span>" +
        '<span class="txt">' + rich(x.q) + "</span></div>";
      if (open) {
        if (browse.kind === "card") {
          h += '<div class="list-a"><b>' + rich(x.a) + "</b>" +
            (x.note ? '<div class="note">' + rich(x.note) + "</div>" : "") +
            (x.idea ? '<div class="note idea"><b>思想</b> ' + rich(x.idea) + "</div>" : "") + "</div>";
        } else {
          h += '<div class="list-a">';
          if (x.type === "match") {
            x.pairs.forEach(function (p) { h += "<div><b>" + rich(p[0]) + " → " + rich(p[1]) + "</b></div>"; });
          } else {
            var want = x.type ? x.ans : [x.ans];
            x.c.forEach(function (ch, i) {
              var hit = want.indexOf(i);
              h += "<div>" + (hit >= 0 ? "<b>" + (x.type === "order" ? hit + 1 + ". " : "◯ ") : "✕ ") +
                "ABCDEFG"[i] + ". " + rich(ch) + (hit >= 0 ? "</b>" : "") + "</div>";
            });
          }
          h += '<div class="note">' + rich(x.exp) + "</div>" +
            (x.idea ? '<div class="note idea"><b>思想</b> ' + rich(x.idea) + "</div>" : "") + "</div>";
        }
      }
      h += "</div>";
    });
    h += "</div>";
    main.innerHTML = h;

    el("b-kind").addEventListener("change", function () { browse.kind = this.value; browse.cat = ""; render(); });
    el("b-cat").addEventListener("change", function () { browse.cat = this.value; render(); });
    var input = el("b-q");
    input.addEventListener("input", function () {
      browse.q = this.value;
      var pos = this.selectionStart;
      render();
      var again = el("b-q");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    main.querySelectorAll(".list-q").forEach(function (n) {
      n.addEventListener("click", function () {
        if (selectingText()) return;
        var id = n.dataset.id;
        browse.open[id] = !browse.open[id];
        render();
      });
    });
  }

  // ── 進捗 ────────────────────────────────────────────────
  function renderProgress() {
    var mastered = 0, learning = 0, unseen = 0;
    CARDS.forEach(function (c) {
      var s = state.cards[c.id];
      if (!s || (s.ok === 0 && s.ng === 0)) unseen++;
      else if (s.b >= 2) mastered++;
      else learning++;
    });
    var qOk = 0, qNg = 0;
    Object.keys(state.quiz).forEach(function (k) { qOk += state.quiz[k].ok; qNg += state.quiz[k].ng; });

    var h = '<div class="card"><h3>全体</h3><div class="stat-grid mt">' +
      '<div class="stat"><b>' + mastered + "</b><span>習得済み（習熟2以上）</span></div>" +
      '<div class="stat"><b>' + learning + "</b><span>学習中</span></div>" +
      '<div class="stat"><b>' + unseen + "</b><span>未出題</span></div>" +
      '<div class="stat"><b>' + (qOk + qNg ? pct(qOk, qOk + qNg) + "%" : "—") + "</b><span>シナリオ正答率</span></div>" +
      "</div></div>";

    h += '<div class="card"><h3>カテゴリ別の習熟</h3><div class="bars mt">';
    categories(CARDS).forEach(function (cat) {
      var list = CARDS.filter(function (c) { return c.cat === cat; });
      var m = 0, l = 0;
      list.forEach(function (c) {
        var s = state.cards[c.id];
        if (!s || (s.ok === 0 && s.ng === 0)) return;
        if (s.b >= 2) m++; else l++;
      });
      h += '<div class="barrow"><div title="' + esc(cat) + '">' + esc(cat) + "</div>" +
        '<div class="bar"><i class="b-ok" style="width:' + pct(m, list.length) + '%"></i>' +
        '<i class="b-seen" style="width:' + pct(l, list.length) + '%"></i></div>' +
        '<div class="muted">' + m + "/" + list.length + "</div></div>";
    });
    h += '</div><p class="mt small muted">緑が習得済み、黄が学習中です。すべてのカテゴリが8割以上緑になり、' +
      "シナリオ問題の正答率が安定して8割を超えたら、受験して差し支えない状態と考えてよいでしょう（本試験は1000点満点中750点が合格ラインです）。</p></div>";

    h += '<div class="card"><h3>データ</h3>' +
      '<p class="small muted mt">解答履歴はこの端末のブラウザにだけ保存されます。端末を変えるときは書き出したファイルを読み込んでください。</p>' +
      '<div class="flash-actions"><button class="btn" id="p-export">JSONで書き出す</button>' +
      '<button class="btn" id="p-import">JSONを読み込む</button>' +
      '<button class="btn bad" id="p-reset">履歴をすべて消す</button></div>' +
      '<input type="file" id="p-file" accept="application/json" hidden></div>';
    main.innerHTML = h;

    el("p-export").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "aws-scs-progress-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    el("p-import").addEventListener("click", function () { el("p-file").click(); });
    el("p-file").addEventListener("change", function () {
      var f = this.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var o = JSON.parse(r.result);
          state = { cards: o.cards || {}, quiz: o.quiz || {} };
          save();
          render();
        } catch (e) { alert("読み込めませんでした: " + e.message); }
      };
      r.readAsText(f);
    });
    el("p-reset").addEventListener("click", function () {
      if (!confirm("すべての解答履歴を消します。元に戻せません。")) return;
      state = { cards: {}, quiz: {} };
      save();
      render();
    });
  }

  render();
})();
