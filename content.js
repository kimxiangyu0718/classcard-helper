/* ClassCard 단어 도우미 - content script
 *  1) /set/... 단어장 페이지: 단어 자동 저장
 *  2) 테스트(영→한/한→영): 문제 식별 → 저장된 단어에서 번역 → 패널 표시 + 정답 보기 강조
 *  3) 자동 풀이 모드: 정답 클릭 → 다음 버튼 클릭
 */
(() => {
  'use strict';
  if (window.__ccWordHelper) return;
  window.__ccWordHelper = true;

  const DEFAULTS = {
    hint: true, auto: false, minDelay: 700, maxDelay: 1800,
    controlScore: true, targetScore: 85,
  };
  let S = { ...DEFAULTS };

  // 저장 데이터 캐시
  let pairs = [];            // [{setId, en, ko, audio, idx}]
  let dict = new Map();      // strict(텍스트) -> entry[]
  let audioMap = new Map();  // mp3 파일명(확장자 제외) -> entry
  let idxMap = new Map();    // 카드 data-idx -> entry
  let setsMeta = {};         // setId -> {title, count, updated}

  const st = {
    panel: null,
    els: {},
    lastKey: '',
    token: null,
    answered: 0,
    mode: '대기',
    lastCardCount: 0,
    autoSavedFor: null,
    idleSince: null,
    stats: { planned: 0, wrong: 0 }, // 오답 조절: 계획한 문항 수 / 일부러 틀린 수
  };

  /* ---------------- 유틸 ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function norm(s) {
    return (s || '').replace(/\u200B-\u200D\uFEFF/g, '').replace(/\s+/g, ' ').trim();
  }

  // 비교용 정규화: 공백/기호 제거, 소문자화
  function strict(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, '')
      .replace(/[.,!?;:'"()[\]{}·…~-]/g, '');
  }

  function stripPos(s) {
    // "[명] 범죄자" → "범죄자"
    return norm(s).replace(/^\[[^\]]*\]\s*/, '').replace(/\.$/, '').trim();
  }

  function hangulRatio(s) {
    const t = norm(s).replace(/\s/g, '');
    if (!t) return 0;
    return (t.match(/[\uAC00-\uD7A3]/g) || []).length / t.length;
  }

  function clickEl(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    el.click();
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    }
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'ccw-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 30);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2200);
  }

  /* ---------------- 저장소 ---------------- */
  function storageGet(keys) {
    return new Promise((res) => chrome.storage.local.get(keys, res));
  }
  function storageSet(obj) {
    return new Promise((res) => chrome.storage.local.set(obj, res));
  }

  async function loadAll() {
    const d = await storageGet(['cc_pairs', 'cc_sets', 'cc_settings', 'cc_panel_pos']);
    pairs = Array.isArray(d.cc_pairs) ? d.cc_pairs : [];
    setsMeta = d.cc_sets || {};
    if (d.cc_settings) S = { ...DEFAULTS, ...d.cc_settings };
    rebuildDict();
    return d;
  }

  function rebuildDict() {
    dict = new Map();
    audioMap = new Map();
    idxMap = new Map();
    for (const p of pairs) {
      const en = norm(p.en), koFull = norm(p.ko);
      if (!en || !koFull) continue;
      const koClean = stripPos(koFull) || koFull;
      const entry = { en, ko: koFull, koClean, setId: p.setId, idx: p.idx };
      const push = (key) => {
        if (!key) return;
        const arr = dict.get(key) || [];
        if (!arr.some((e) => e.en === entry.en && e.ko === entry.ko)) arr.push(entry);
        dict.set(key, arr);
      };
      push(strict(en));
      push(strict(koClean));
      push(strict(koFull));
      if (p.audio) {
        const base = String(p.audio).split('/').pop().replace(/\.[^.]+$/, '');
        if (base && !audioMap.has(base)) audioMap.set(base, entry);
      }
      if (p.idx != null && !idxMap.has(p.idx)) idxMap.set(String(p.idx), entry);
    }
  }

  async function persistPairs(newPairsForSet, setId, title) {
    // 해당 세트의 기존 데이터를 교체 (다른 페이지 = 다시 저장)
    const kept = pairs.filter((p) => p.setId !== setId);
    const merged = kept.concat(newPairsForSet);
    const seen = new Set();
    const dedup = [];
    for (const p of merged) {
      const k = p.setId + '|' + strict(p.en) + '|' + strict(p.ko);
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(p);
    }
    pairs = dedup;
    setsMeta[setId] = { title, count: newPairsForSet.length, updated: Date.now() };
    rebuildDict();
    await storageSet({ cc_pairs: pairs, cc_sets: setsMeta });
  }

  /* ---------------- 단어장 긁기 ---------------- */
  function getSetId() {
    const m = location.pathname.match(/\/set\/(\d+)/);
    return m ? m[1] : null;
  }

  // 뒷면 .text-left 에서 첫 <br> 앞의 텍스트(뜻 줄)만 추출
  function meaningFromBack(back) {
    const tl = $('.text-left', back) || back;
    let buf = '';
    for (const n of tl.childNodes) {
      if (n.nodeType === 3) buf += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.tagName === 'BR') { if (buf.trim()) break; continue; }
        break;
      }
    }
    return norm(buf);
  }

  function scrapeCards() {
    const words = [];
    for (const card of $$('.flip-card')) {
      const front = $('.flip-card-front', card);
      const back = $('.flip-card-back', card);
      if (!front || !back) continue;
      const fe = $('.font-bold', front) || front;
      let en = norm(fe.textContent);
      let ko = meaningFromBack(back);
      if (!ko) ko = norm((back.textContent || '').split('\n').map(norm).find((l) => l) || '');
      if (!en || !ko) continue;
      if (hangulRatio(en) > 0.5) { const t = en; en = ko; ko = t; }
      const a = $('.btn-audio', card);
      words.push({
        en, ko,
        audio: a ? (a.getAttribute('data-src') || '') : '',
        idx: card.getAttribute('data-idx') || null,
      });
    }
    return words;
  }

  // 예전/다른 레이아웃 폴백: 카드 항목 텍스트 줄 파싱
  function scrapeFallback() {
    const items = $$('#tab_set_all > div:nth-child(2) > div, .card-item, .list-item');
    const words = [];
    for (const it of items) {
      const src = it.innerText && it.innerText.trim() ? it.innerText : it.textContent;
      const lines = (src || '').split('\n').map(norm).filter(Boolean);
      let en = '', ko = '';
      for (const l of lines) {
        if (/^\d+$/.test(l) || /^(암기|리콜|스펠|테스트)/.test(l)) continue;
        if (!en && hangulRatio(l) < 0.3) en = l;
        else if (!ko && hangulRatio(l) >= 0.3) ko = l;
        if (en && ko) break;
      }
      if (en && ko) words.push({ en, ko, audio: '', idx: it.getAttribute('data-idx') || null });
    }
    return words;
  }

  async function saveCurrentSet(manual) {
    const setId = getSetId();
    if (!setId) { toast('단어장(/set/...) 페이지에서만 저장됩니다'); return; }
    let words = scrapeCards();
    if (words.length < 3) {
      const fb = scrapeFallback();
      if (fb.length > words.length) words = fb;
    }
    if (!words.length) {
      if (manual) toast('이 페이지에서 단어를 찾지 못했습니다');
      updatePanelInfo();
      return;
    }
    const title = norm(document.title.replace(/^클래스카드\s*\|\s*/, '')).slice(0, 90);
    await persistPairs(words, setId, title);
    st.autoSavedFor = setId;
    chrome.runtime.sendMessage({ type: 'cc-badge', count: words.length });
    toast(`단어 ${words.length}개 저장 완료`);
    updatePanelInfo();
    renderSetsInPanel();
  }

  /* ---------------- 번역 조회 ---------------- */
  function lookup(text) {
    const keys = [strict(text), strict(stripPos(text))];
    for (const k of keys) {
      const hit = dict.get(k);
      if (hit && hit.length) return hit;
    }
    return null;
  }

  function answersFor(question) {
    let hits = lookup(question);
    // 듣기 문제: 오디오 파일명으로 역조회
    if (!hits && question && question.__audio) {
      const base = String(question.__audio).split('/').pop().replace(/\.[^.]+$/, '');
      const e = audioMap.get(base);
      hits = e ? [e] : null;
    }
    // 카드 idx로 역조회 (문제 텍스트를 못 읽은 경우의 보험)
    if (!hits && question && question.__idx != null) {
      const e = idxMap.get(String(question.__idx));
      hits = e ? [e] : null;
    }
    if (!hits) return null;
    const qKo = hangulRatio(typeof question === 'string' ? question : question.text) > 0.3;
    const outs = new Set();
    for (const h of hits) {
      if (qKo) outs.add(h.en);
      else { outs.add(h.ko); if (h.koClean && h.koClean !== h.ko) outs.add(h.koClean); }
    }
    return Array.from(outs);
  }

  function choiceTextOf(el) {
    const inner = $('.cc-table', el) || el;
    return norm(inner.textContent || '');
  }

  function strictOf(s) { return strict(stripPos(s)); }

  function pickChoice(answerList, choiceEls) {
    if (!answerList || !choiceEls.length) return -1;
    const answers = [];
    for (const a of answerList) {
      answers.push(strictOf(a));
      const sp = stripPos(a);
      if (sp) answers.push(strict(sp));
      for (const part of a.split(/[,;/·、]/)) {
        const ps = strict(stripPos(part));
        if (ps) answers.push(ps);
      }
    }
    let best = -1, bestScore = 0;
    choiceEls.forEach((c, i) => {
      const cs = strictOf(c.text);
      if (!cs) return;
      let score = 0;
      for (const as of answers) {
        if (!as) continue;
        if (cs === as) { score = 100; break; }
        if (cs.includes(as) || as.includes(cs)) score = Math.max(score, 70);
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return bestScore >= 70 ? best : -1;
  }

  /* ---------------- 모드 감지 ---------------- */
  function getQuizCard() {
    const card = $('.flip-card.showing');
    if (!card || !visible(card)) return null;
    if (!$('input[type=radio]', card)) return null;
    return card;
  }

  function quizQuestion(card) {
    const fh = $('.flip-card-front .front-hidden', card);
    const text = fh ? norm(fh.textContent) : '';
    const a = $('.flip-card-front [data-src]', card) || $('[data-src]', card);
    return { text, audio: a ? a.getAttribute('data-src') || '' : '', idx: card.getAttribute('data-idx') };
  }

  function quizChoices(card) {
    let labels = $$('input[type=radio] + label', card);
    if (!labels.length) labels = $$('label input[type=radio]', card).map((i) => i.closest('label')).filter(Boolean);
    return labels
      .map((l) => ({ el: l, text: choiceTextOf(l) }))
      .filter((c) => c.text);
  }

  function getLearnCard(want) {
    const card = $$('.CardItem.current.showing').find(visible);
    if (!card) return null;
    if (want === 'spell' && !$('.spell-answer', card)) return null;
    if (want === 'recall' && !$('.card-quest-front', card)) return null;
    if (want === 'memorize' && !$('.card-cover', card)) return null;
    return card;
  }

  function learnQuestion(card) {
    const el = $('.card-top .normal-body', card) || $('.card-top .text-normal', card) || $('.card-top', card);
    return { text: norm(el ? el.textContent : ''), audio: '', idx: card.getAttribute('data-idx') };
  }

  function visibleStep() {
    return $$('.step').find((e) => visible(e)) || null;
  }

  /* ---------------- 강조 / 정답 처리 ---------------- */
  function clearMarks() {
    $$('.ccw-correct').forEach((e) => e.classList.remove('ccw-correct'));
  }

  function markCorrect(el) {
    if (!el) return;
    el.classList.add('ccw-correct');
  }

  function setQA(qText, answer, choiceIdx, extra) {
    if (!st.els.qa) return;
    const q = qText || (extra && extra.audio ? '🎧 듣기 문제' : '-');
    st.els.qa.innerHTML = '';
    const qDiv = document.createElement('div');
    qDiv.className = 'ccw-q';
    qDiv.textContent = '문제: ' + q;
    const aDiv = document.createElement('div');
    aDiv.className = 'ccw-a';
    aDiv.textContent = answer ? '정답: ' + answer : '정답: 사전에 없음 (페이지 단어를 먼저 저장하세요)';
    st.els.qa.append(qDiv, aDiv);
    if (choiceIdx >= 0) {
      const cDiv = document.createElement('div');
      cDiv.className = 'ccw-c';
      cDiv.textContent = `→ ${choiceIdx + 1}번 보기`;
      st.els.qa.appendChild(cDiv);
    }
    if (extra && extra.note) {
      const nDiv = document.createElement('div');
      nDiv.className = 'ccw-note';
      nDiv.textContent = extra.note;
      st.els.qa.appendChild(nDiv);
    }
  }

  /* ---------------- 자동 풀이 ---------------- */
  function nextToken() {
    st.token = {};
    return st.token;
  }
  function alive(tok) { return S.auto && st.token === tok; }

  function findNextButton() {
    for (const sel of ['.btn-quiz-next', '.btn-next', '.btn-condition-next', '.btn-quiz-start', '.btn-opt-start']) {
      const el = $$(sel).find(visible);
      if (el && !el.closest('#ccw-panel')) return el;
    }
    const btns = $$('a, button, [role=button], div[class*=btn]').filter((el) =>
      visible(el) && !el.closest('#ccw-panel') && !$('input[type=radio]', el)
    );
    return btns.find((el) => {
      const t = norm(el.textContent);
      return t.length <= 10 && /^(다음|제출|확인|네|계속|시작|테스트 시작|시험 시작|결과 보기)\.?$/.test(t);
    }) || null;
  }

  async function autoSequence(tok, steps) {
    for (const step of steps) {
      if (!alive(tok)) return;
      await sleep(randInt(S.minDelay, S.maxDelay));
      if (!alive(tok)) return;
      step();
    }
  }

  /* ---------------- 오답 조절 (점수 컨트롤) ---------------- */
  function targetScore() {
    return Math.min(100, Math.max(80, Math.round(+S.targetScore || 85)));
  }

  // 이 문제를 일부러 틀릴지 결정.
  // 안전 규칙: "지금까지 i문항 중 오답 w개"가 어느 시점에도 (1-목표점수) 비율을 넘지 않게
  // 막으므로, 시험이 중간에 끝나도 최종 점수가 목표(≥80) 미만이 되는 일이 없다.
  function planWrong(canSacrifice) {
    if (!S.auto || S.controlScore === false || !canSacrifice) return false;
    const budget = 1 - targetScore() / 100;
    if (budget <= 0) return false;
    const i = st.stats.planned + 1;
    const w = st.stats.wrong;
    if ((w + 1) / i > budget + 1e-9) return false; // 상한 도달 → 무조건 정답
    const expected = budget * i;
    let p = budget;
    if (w < Math.floor(expected)) p = Math.min(0.9, budget + 0.35); // 목표보다 부족하면 확률 상향
    return Math.random() < p;
  }

  function recordDecision(wrong) {
    st.stats.planned++;
    if (wrong) st.stats.wrong++;
    updateStatus();
  }

  function corruptAnswer(s) {
    if (!s) return s;
    return s.length >= 3 ? s.slice(0, -1) : s + 'x';
  }

  function appendNote(text) {
    if (!st.els.qa) return;
    const n = document.createElement('div');
    n.className = 'ccw-note';
    n.textContent = text;
    st.els.qa.appendChild(n);
  }

  /* ---------------- 메인 루프 ---------------- */
  function enterMode(m) {
    if (st.mode !== m) st.stats = { planned: 0, wrong: 0 };
    st.idleSince = null;
    st.mode = m;
    setMode(m);
  }

  function tick() {
    if (document.hidden) return;

    // 1) 테스트(퀴즈) 카드
    const quiz = getQuizCard();
    if (quiz) {
      enterMode('테스트');
      handleQuiz(quiz);
      return;
    }

    // 2) 리콜 (4지선다, 정답이 DOM에 .answer 로 있음)
    const recall = getLearnCard('recall');
    if (recall) { enterMode('리콜'); handleRecall(recall); return; }

    // 3) 스펠
    const spell = getLearnCard('spell');
    if (spell) { enterMode('스펠'); handleSpell(spell); return; }

    // 4) 암기
    const memo = getLearnCard('memorize');
    if (memo) { enterMode('암기'); handleMemorize(memo); return; }

    // 5) 테스트/학습 시작·설정 화면 (자동 모드: 테스트 전용 클래스 버튼만 클릭)
    if (S.auto) {
      const step = visibleStep();
      let btn = null;
      if (step) {
        btn = $$( 'a, button, [role=button]', step).find((el) =>
          visible(el) && /^(다음|계속|시작|학습 시작|테스트 시작)\.??$/.test(norm(el.textContent))
        ) || null;
      } else {
        btn = $$('.btn-condition-next, .btn-quiz-start').find(visible) || null;
      }
      if (btn && !btn.closest('#ccw-panel')) {
        const key = 'screen:' + (btn.className || '') + ':' + norm(btn.textContent);
        if (st.lastKey !== key) {
          st.lastKey = key;
          const tok = nextToken();
          setQA('시작 화면', norm(btn.textContent), -1, { note: '자동 모드: "' + norm(btn.textContent) + '" 클릭' });
          autoSequence(tok, [() => clickEl(btn)]);
          return;
        }
      }
    }

    // 6) 학습 화면이 잠깐 사라진 건 전환 애니메이션일 수 있으니 2.5초 지속되면 세션 종료 처리
    if (st.mode !== '대기') {
      if (!st.idleSince) st.idleSince = Date.now();
      if (Date.now() - st.idleSince > 2500) {
        const est = st.stats.planned
          ? Math.round(((st.stats.planned - st.stats.wrong) / st.stats.planned) * 100)
          : null;
        setQA('-', '', -1, {
          note: est != null
            ? `세션 종료 · 예상 점수 ~${est}점 (오답 ${st.stats.wrong}/${st.stats.planned})`
            : '학습/테스트 화면 감지 대기 중...',
        });
        st.mode = '대기';
        st.lastKey = '';
        st.idleSince = null;
        st.stats = { planned: 0, wrong: 0 };
        st.answered = 0;
        updateStatus();
      }
    }
    setMode(st.mode);
  }

  function handleQuiz(card) {
    const q = quizQuestion(card);
    const choices = quizChoices(card);
    const key = 'quiz:' + (q.idx || '') + ':' + strict(q.text || q.audio);
    const answers = answersFor(q.text ? q.text : { __audio: q.audio, __idx: q.idx, text: q.text });

    const ci = pickChoice(answers, choices);
    const answerText = answers && answers.length ? answers[0] : '';
    // 사전에 아예 없는 듣기 문제만 무작위 선택(자동 진행 유지), 그 외엔 정답을 못 찾으면 클릭하지 않음
    const audioNoMap = !q.text && q.audio && !answers;

    if (S.hint) {
      clearMarks();
      if (ci >= 0) markCorrect(choices[ci].el);
    }

    const note = audioNoMap
      ? '🎧 듣기 문제(사전에 오디오 없음) - 자동 모드는 무작위로 선택'
      : (answers ? '' : '이 페이지에서 저장되지 않은 단어입니다');

    setQA(q.text || (q.audio ? '🎧 듣기 문제' : '-'), answerText, ci, { note });

    if (S.auto && st.lastKey !== key) {
      st.lastKey = key;
      const tok = nextToken();

      // 오답 조절: 정답을 알고 보기가 2개 이상일 때만 일부러 틀릴 수 있음
      let targetIdx = ci;
      let deliberateWrong = false;
      if (ci >= 0 && choices.length > 1) {
        deliberateWrong = planWrong(true);
        if (deliberateWrong) {
          const wrongs = choices.map((_, i) => i).filter((i) => i !== ci);
          targetIdx = wrongs[randInt(0, wrongs.length - 1)];
        }
      }
      let target = targetIdx >= 0 ? choices[targetIdx].el : null;
      const unknownAudio = !target && audioNoMap && choices.length > 0;
      if (unknownAudio) target = choices[randInt(0, choices.length - 1)].el;

      if (deliberateWrong) appendNote('🎯 오답 조절: 이 문제는 일부러 틀립니다');

      const steps = [];
      if (target) steps.push(() => clickEl(target));
      if (target && choices.length) {
        steps.push(() => {
          if (!alive(tok)) return;
          const nb = findNextButton();
          if (nb) clickEl(nb);
          else pressEnter(document.body);
        });
      }
      if (target) {
        autoSequence(tok, steps);
        st.answered++;
        recordDecision(deliberateWrong || unknownAudio);
      }
    }
  }

  function handleRecall(card) {
    const q = learnQuestion(card);
    const ansEl = $('.card-quest-front .answer', card);
    const choices = $$('.card-quest-front .cc-ellipsis', card).map((e) => ({ el: e, text: norm(e.textContent) }));
    let answerText = '', ci = -1;

    if (ansEl) {
      answerText = choiceTextOf(ansEl);
      ci = choices.findIndex((c) => c.el.closest('.answer') === ansEl || ansEl.contains(c.el));
    }
    if (!answerText) {
      const answers = answersFor(q.text ? q.text : { __idx: q.idx, text: q.text });
      if (answers && answers.length) answerText = answers[0];
      ci = pickChoice(answers, choices);
    }
    if (S.hint) { clearMarks(); markCorrect(ansEl || (ci >= 0 && choices[ci].el)); }
    setQA(q.text, answerText, ci);

    const key = 'recall:' + (q.idx || '') + ':' + strict(q.text);
    if (S.auto && st.lastKey !== key) {
      st.lastKey = key;
      const tok = nextToken();
      let target = ansEl && visible(ansEl) ? ansEl : (ci >= 0 && choices[ci] ? choices[ci].el.closest('.answer') || choices[ci].el : null);
      let deliberateWrong = false;
      if (target && ci >= 0 && choices.length > 1) {
        deliberateWrong = planWrong(true);
        if (deliberateWrong) {
          const wrongs = choices.map((_, i) => i).filter((i) => i !== ci);
          const wi = wrongs[randInt(0, wrongs.length - 1)];
          target = choices[wi].el.closest('.answer') || choices[wi].el;
          appendNote('🎯 오답 조절: 이 문제는 일부러 틀립니다');
        }
      }
      const steps = [];
      if (target) steps.push(() => clickEl(target));
      steps.push(() => {
        if (!alive(tok)) return;
        const nb = findNextButton();
        if (nb && visible(nb)) clickEl(nb);
      });
      if (target) {
        autoSequence(tok, steps);
        st.answered++;
        recordDecision(deliberateWrong);
      }
    }
  }

  function handleSpell(card) {
    const wordEl = $('.spell-answer .spell-content', card) || $('.spell-answer', card);
    const shown = norm(wordEl ? wordEl.textContent : '');
    const answers = answersFor(shown);
    const answer = answers && answers.length ? answers[0] : '';
    setQA(shown, answer, -1, { note: answer ? '자동 모드: 입력란에 입력됩니다' : '' });

    const key = 'spell:' + (card.getAttribute('data-idx') || '') + ':' + strict(shown);
    if (S.auto && answer && st.lastKey !== key) {
      st.lastKey = key;
      const tok = nextToken();
      const deliberateWrong = planWrong(true);
      const toType = deliberateWrong ? corruptAnswer(answer) : answer;
      const input = $$("input[name='input_answer']", card).find(visible)
        || $$("input[type=text]", card).find(visible);
      const steps = [];
      if (input) {
        if (deliberateWrong) appendNote('🎯 오답 조절: 이 문제는 일부러 틀립니다');
        steps.push(() => { setNativeValue(input, toType); input.focus(); });
        steps.push(() => { if (!alive(tok)) return; pressEnter(input); });
        steps.push(() => {
          if (!alive(tok)) return;
          const nb = findNextButton();
          if (nb && visible(nb)) clickEl(nb);
        });
        autoSequence(tok, steps);
        st.answered++;
        recordDecision(deliberateWrong);
      }
    }
  }

  function handleMemorize(card) {
    const q = learnQuestion(card);
    const answers = answersFor(q.text ? q.text : { __idx: q.idx, text: q.text });
    const answer = answers && answers.length ? answers[0] : '';
    setQA(q.text, answer, -1);
    const key = 'memo:' + (q.idx || '') + ':' + strict(q.text);
    if (S.auto && st.lastKey !== key) {
      st.lastKey = key;
      const tok = nextToken();
      const cover = $('.card-cover', card);
      const steps = [];
      if (cover && visible(cover)) steps.push(() => clickEl(cover));
      steps.push(() => {
        if (!alive(tok)) return;
        const nb = $('.btn-short-change-card', document);
        if (nb && visible(nb)) clickEl(nb);
        else pressEnter(document.body);
      });
      autoSequence(tok, steps);
      st.answered++;
      updateStatus();
    }
  }

  /* ---------------- 패널 UI ---------------- */
  function buildPanel() {
    if (st.panel || !document.body) return;
    const p = document.createElement('div');
    p.id = 'ccw-panel';
    p.innerHTML = `
      <div class="ccw-head" id="ccw-head">
        <span class="ccw-title">단어 도우미</span>
        <span class="ccw-mode" id="ccw-mode">대기</span>
        <button class="ccw-min" id="ccw-min" title="최소화">—</button>
      </div>
      <div class="ccw-body" id="ccw-body">
        <div class="ccw-qa" id="ccw-qa"><div class="ccw-note">단어장 페이지에서 자동 저장됩니다. 테스트를 시작하면 문제/정답이 여기 표시됩니다.</div></div>
        <div class="ccw-info" id="ccw-info"></div>
        <div class="ccw-controls">
          <label class="ccw-tg"><input type="checkbox" id="ccw-hint"> 정답 강조</label>
          <label class="ccw-tg"><input type="checkbox" id="ccw-auto"> 자동 풀이</label>
          <button class="ccw-btn" id="ccw-save">단어 다시 저장</button>
        </div>
        <div class="ccw-delay">
          클릭 지연 <input type="number" id="ccw-dmin" min="0" step="100"> ~
          <input type="number" id="ccw-dmax" min="0" step="100"> ms
          <span id="ccw-cnt" class="ccw-cnt"></span>
        </div>
        <div class="ccw-delay">
          <label class="ccw-tg"><input type="checkbox" id="ccw-ctl"> 오답 조절</label>
          목표 <input type="number" id="ccw-target" min="80" max="100" step="5">점
        </div>
      </div>`;
    document.body.appendChild(p);
    st.panel = p;
    st.els = {
      qa: $('#ccw-qa', p), info: $('#ccw-info', p), mode: $('#ccw-mode', p),
      hint: $('#ccw-hint', p), auto: $('#ccw-auto', p), save: $('#ccw-save', p),
      dmin: $('#ccw-dmin', p), dmax: $('#ccw-dmax', p), cnt: $('#ccw-cnt', p),
      ctl: $('#ccw-ctl', p), target: $('#ccw-target', p),
      min: $('#ccw-min', p), body: $('#ccw-body', p),
    };

    st.els.hint.checked = S.hint;
    st.els.auto.checked = S.auto;
    st.els.dmin.value = S.minDelay;
    st.els.dmax.value = S.maxDelay;
    st.els.ctl.checked = S.controlScore !== false;
    st.els.target.value = targetScore();

    st.els.hint.addEventListener('change', () => saveSettings({ hint: st.els.hint.checked }));
    st.els.auto.addEventListener('change', () => {
      saveSettings({ auto: st.els.auto.checked });
      if (!S.auto) { st.lastKey = ''; clearMarks(); }
    });
    st.els.save.addEventListener('click', () => saveCurrentSet(true));
    const onDelay = () => saveSettings({ minDelay: +st.els.dmin.value || 0, maxDelay: +st.els.dmax.value || 0 });
    st.els.dmin.addEventListener('change', onDelay);
    st.els.dmax.addEventListener('change', onDelay);
    st.els.ctl.addEventListener('change', () => saveSettings({ controlScore: st.els.ctl.checked }));
    st.els.target.addEventListener('change', () => {
      st.els.target.value = targetScore();
      saveSettings({ targetScore: targetScore() });
    });

    st.els.min.addEventListener('click', () => p.classList.toggle('ccw-minimized'));

    // 드래그 이동
    const head = $('#ccw-head', p);
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target === st.els.min) return;
      const r = p.getBoundingClientRect();
      drag = { ox: e.clientX - r.left, oy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.ox));
      const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.oy));
      p.style.left = x + 'px';
      p.style.top = y + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      const r = p.getBoundingClientRect();
      storageSet({ cc_panel_pos: { left: r.left, top: r.top } });
    });

    // 저장된 위치 복원
    storageGet(['cc_panel_pos']).then((d) => {
      if (d.cc_panel_pos && Number.isFinite(d.cc_panel_pos.left)) {
        p.style.left = Math.min(d.cc_panel_pos.left, window.innerWidth - 100) + 'px';
        p.style.top = Math.min(d.cc_panel_pos.top, window.innerHeight - 60) + 'px';
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      }
    });

    renderSetsInPanel();
    updatePanelInfo();
  }

  function renderSetsInPanel() {
    if (!st.els.info) return;
    const setId = getSetId();
    const meta = setId && setsMeta[setId];
    let html = '';
    if (meta) {
      const ago = Math.round((Date.now() - meta.updated) / 60000);
      html += `이 페이지: <b>${meta.count}</b>개 저장됨 (${ago < 1 ? '방금' : ago + '분 전'})`;
    } else if (setId) {
      html += '이 페이지: 아직 저장 안 됨';
    }
    const total = new Set(pairs.map((x) => x.setId + '|' + strict(x.en))).size;
    html += `<br>전체 사전: <b>${total}</b>단어 / ${Object.keys(setsMeta).length}세트`;
    st.els.info.innerHTML = html;
  }

  function updatePanelInfo() { renderSetsInPanel(); }

  function setMode(m) {
    st.mode = m;
    if (st.els.mode) st.els.mode.textContent = m;
  }

  function updateStatus() {
    if (!st.els.cnt) return;
    const parts = [];
    if (st.answered) parts.push(`풀이 ${st.answered}`);
    if (st.stats.planned) {
      const est = Math.round(((st.stats.planned - st.stats.wrong) / st.stats.planned) * 100);
      parts.push(`오답 ${st.stats.wrong}/${st.stats.planned}`);
      parts.push(`예상 ~${est}점`);
    }
    st.els.cnt.textContent = parts.join(' · ');
  }

  async function saveSettings(patch) {
    S = { ...S, ...patch };
    await storageSet({ cc_settings: S });
  }

  /* ---------------- 팝업 메시지 ---------------- */
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'cc-get-page') {
      const setId = getSetId();
      sendResponse({
        setId,
        meta: setId ? setsMeta[setId] || null : null,
        total: new Set(pairs.map((x) => x.setId + '|' + strict(x.en))).size,
        mode: st.mode,
        hint: S.hint,
        auto: S.auto,
      });
      return;
    }
    if (msg.type === 'cc-rescan') {
      saveCurrentSet(true).then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  /* ---------------- 저장소 변경 동기화 ---------------- */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cc_settings) S = { ...DEFAULTS, ...changes.cc_settings.newValue };
    if (changes.cc_pairs) { pairs = changes.cc_pairs.newValue || []; rebuildDict(); renderSetsInPanel(); }
    if (changes.cc_sets) { setsMeta = changes.cc_sets.newValue || {}; renderSetsInPanel(); }
  });

  /* ---------------- 페이지 변화 감시 ---------------- */
  let tickQueued = false;
  function scheduleTick(ms = 150) {
    if (tickQueued) return;
    tickQueued = true;
    setTimeout(() => { tickQueued = false; tick(); }, ms);
  }

  const mo = new MutationObserver(() => {
    // 단어장 페이지: 카드 수가 늘어나면 자동 재저장 (더보기/전체 전환 대응)
    const setId = getSetId();
    if (setId && st.autoSavedFor === setId) {
      const cnt = $$('.flip-card').length;
      if (cnt > st.lastCardCount + 2) {
        st.lastCardCount = cnt;
        clearTimeout(mo._t);
        mo._t = setTimeout(() => saveCurrentSet(false), 1500);
      }
    }
    scheduleTick();
  });

  async function init() {
    await loadAll();
    buildPanel();
    const setId = getSetId();
    if (setId) {
      st.lastCardCount = $$('.flip-card').length;
      if (st.lastCardCount > 0) await saveCurrentSet(false);
    }
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tick, 400);

    // 페이지 이동 감지: 세트가 바뀌면 그 페이지 단어를 다시 저장
    let lastPath = location.pathname + location.search;
    setInterval(() => {
      const p = location.pathname + location.search;
      if (p === lastPath) return;
      lastPath = p;
      st.autoSavedFor = null;
      st.lastCardCount = 0;
      st.lastKey = '';
      st.answered = 0;
      updateStatus();
      renderSetsInPanel();
      if (getSetId()) setTimeout(() => saveCurrentSet(false), 800);
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
