// FortifyXRB (X Region Blocker) v1.0 - Popup Script

let blockedRegions = [];
let blockMode = 'overlay';

const regionInput  = document.getElementById('regionInput');
const addBtn       = document.getElementById('addBtn');
const tagsList     = document.getElementById('tagsList');
const tagsEmpty    = document.getElementById('tagsEmpty');
const blockedCount = document.getElementById('blockedCount');
const clearBtn     = document.getElementById('clearBtn');
const statusDot    = document.getElementById('statusDot');
const toast        = document.getElementById('toast');

function saveAndSync() {
  chrome.storage.sync.set({ blockedRegions, blockMode });
  render();
}

function loadSettings() {
  chrome.storage.sync.get(['blockedRegions', 'blockMode'], (data) => {
    blockedRegions = data.blockedRegions || [];
    blockMode = data.blockMode || 'overlay';
    render();
  });
}

function render() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === blockMode);
  });

  tagsList.innerHTML = '';
  if (blockedRegions.length === 0) {
    tagsEmpty.style.display = 'block';
    tagsList.style.display  = 'none';
  } else {
    tagsEmpty.style.display = 'none';
    tagsList.style.display  = 'flex';
    blockedRegions.forEach((region, idx) => {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.innerHTML = `<span>${escapeHtml(region)}</span><button class="tag-remove" data-idx="${idx}" title="Remove">×</button>`;
      tagsList.appendChild(tag);
    });
  }

  blockedCount.textContent = blockedRegions.length;
  statusDot.classList.toggle('inactive', blockedRegions.length === 0);
}

function addRegion(value) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (blockedRegions.map(r => r.toLowerCase()).includes(trimmed.toLowerCase())) {
    showToast(`"${trimmed}" already added`);
    return;
  }
  blockedRegions.push(trimmed);
  saveAndSync();
  showToast(`Added: ${trimmed}`);
}

function removeRegion(idx) {
  const removed = blockedRegions[idx];
  blockedRegions.splice(idx, 1);
  saveAndSync();
  showToast(`Removed: ${removed}`);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

addBtn.addEventListener('click', () => {
  addRegion(regionInput.value);
  regionInput.value = '';
  regionInput.focus();
});

regionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { addRegion(regionInput.value); regionInput.value = ''; }
});

tagsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.tag-remove');
  if (btn) removeRegion(parseInt(btn.dataset.idx, 10));
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => { blockMode = btn.dataset.mode; saveAndSync(); });
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => addRegion(btn.dataset.region));
});

clearBtn.addEventListener('click', () => {
  if (blockedRegions.length === 0) return;
  blockedRegions = [];
  saveAndSync();
  showToast('Cleared all regions');
});

loadSettings();
