const $ = (id) => document.getElementById(id);

async function get(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, res));
}
async function set(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const d = await get(['cc_pairs', 'cc_sets', 'cc_settings']);
  const pairs = Array.isArray(d.cc_pairs) ? d.cc_pairs : [];
  const sets = d.cc_sets || {};
  const s = d.cc_settings || {};

  const total = new Set(pairs.map((p) => p.setId + '|' + String(p.en).toLowerCase())).size;
  $('summary').innerHTML = `총 <b>${total}</b>단어 · <b>${Object.keys(sets).length}</b>세트 저장됨`;

  $('hint').checked = s.hint !== false;
  $('auto').checked = !!s.auto;
  $('ctl').checked = s.controlScore !== false;
  $('target').value = Math.min(100, Math.max(80, Math.round(+s.targetScore || 85)));
  $('dmin').value = s.minDelay != null ? s.minDelay : 700;
  $('dmax').value = s.maxDelay != null ? s.maxDelay : 1800;

  // 현재 탭 상태
  const tab = await activeTab();
  if (tab && tab.url && /classcard\.net/.test(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: 'cc-get-page' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      $('pageMode').textContent = '현재: ' + resp.mode;
    });
  }

  const box = $('sets');
  const entries = Object.entries(sets).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
  if (!entries.length) {
    box.innerHTML = '<div class="empty">아직 저장된 세트가 없습니다.<br>단어장 페이지를 열면 자동 저장됩니다.</div>';
  } else {
    box.innerHTML = '';
    for (const [id, meta] of entries) {
      const div = document.createElement('div');
      div.className = 'set';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = meta.title || ('세트 ' + id);
      t.title = meta.title || id;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = (meta.count || 0) + '개';
      const btn = document.createElement('button');
      btn.textContent = '삭제';
      btn.addEventListener('click', async () => {
        const cur = await get(['cc_pairs', 'cc_sets']);
        const newSets = cur.cc_sets || {};
        delete newSets[id];
        await set({
          cc_sets: newSets,
          cc_pairs: (cur.cc_pairs || []).filter((p) => p.setId !== id),
        });
        refresh();
      });
      div.append(t, n, btn);
      box.appendChild(div);
    }
  }
}

$('hint').addEventListener('change', async () => {
  const d = await get('cc_settings');
  await set({ cc_settings: { ...(d.cc_settings || {}), hint: $('hint').checked } });
});

$('auto').addEventListener('change', async () => {
  const d = await get('cc_settings');
  await set({ cc_settings: { ...(d.cc_settings || {}), auto: $('auto').checked } });
});

async function saveDelay() {
  const d = await get('cc_settings');
  await set({
    cc_settings: {
      ...(d.cc_settings || {}),
      minDelay: +$('dmin').value || 0,
      maxDelay: +$('dmax').value || 0,
    },
  });
}
$('dmin').addEventListener('change', saveDelay);
$('dmax').addEventListener('change', saveDelay);

$('ctl').addEventListener('change', async () => {
  const d = await get('cc_settings');
  await set({ cc_settings: { ...(d.cc_settings || {}), controlScore: $('ctl').checked } });
});

$('target').addEventListener('change', async () => {
  const v = Math.min(100, Math.max(80, Math.round(+$('target').value || 85)));
  $('target').value = v;
  const d = await get('cc_settings');
  await set({ cc_settings: { ...(d.cc_settings || {}), targetScore: v } });
});

$('rescan').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !/classcard\.net/.test(tab.url || '')) {
    $('pageMode').textContent = 'ClassCard 페이지가 아닙니다';
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'cc-rescan' }, (resp) => {
    if (chrome.runtime.lastError) {
      $('pageMode').textContent = '페이지를 새로고침한 뒤 시도하세요';
      return;
    }
    if (resp && resp.ok) {
      $('pageMode').textContent = '저장 완료';
      refresh();
    }
  });
});

$('export').addEventListener('click', async () => {
  const d = await get(['cc_pairs', 'cc_sets']);
  const data = {
    exportedAt: new Date().toISOString(),
    sets: d.cc_sets || {},
    pairs: d.cc_pairs || [],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'classcard-words.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('저장된 모든 단어를 삭제할까요?')) return;
  await set({ cc_pairs: [], cc_sets: {} });
  refresh();
});

chrome.storage.onChanged.addListener(refresh);
refresh();
