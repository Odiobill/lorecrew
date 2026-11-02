// Optional enhancements; all guides and primary links work without JavaScript.
const base = document.documentElement.dataset.base || '/';
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#primary-nav');
function closeMenu() {
  nav?.classList.remove('is-open');
  menu?.setAttribute('aria-expanded', 'false');
  menu?.setAttribute('aria-label', 'Open navigation');
}
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  nav?.classList.toggle('is-open', open);
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true' && !dialog?.open) {
    closeMenu(); menu.focus();
  }
});
const tabs = [...document.querySelectorAll('[data-demo]')];
function selectTab(selected, focus = false) {
  tabs.forEach(tab => {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  });
  if (focus) selected.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});
const guideNav = document.querySelector('.guide-navigation');
if (guideNav) {
  const small = matchMedia('(max-width: 560px)');
  guideNav.open = !small.matches;
  small.addEventListener('change', event => { guideNav.open = !event.matches; });
}
const dialog = document.querySelector('.search-dialog');
const input = document.querySelector('#site-search');
const results = document.querySelector('#search-results');
let indexRequest, searchRevision = 0;
const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function message(text) {
  const p = document.createElement('p'); p.className = 'search-message'; p.textContent = text;
  results.replaceChildren(p);
}
async function search() {
  const revision = ++searchRevision;
  const words = normalize(input.value.trim()).split(/\s+/).filter(Boolean).slice(0, 12);
  message('Loading guides…');
  try {
    indexRequest ||= fetch(base + 'search-index.json', {credentials: 'omit'})
      .then(response => { if (!response.ok) throw Error('Search unavailable'); return response.json(); })
      .catch(error => { indexRequest = undefined; throw error; });
    const index = await indexRequest;
    if (revision !== searchRevision) return;
    const matches = index.map(doc => {
      const title = normalize(doc.title), description = normalize(doc.description), text = normalize(doc.text);
      const score = words.every(word => (title + ' ' + description + ' ' + text).includes(word))
        ? words.reduce((sum, word) => sum + (title.includes(word) ? 8 : description.includes(word) ? 3 : 1), 0) + 1 : 0;
      return {doc, score};
    }).filter(item => item.score).sort((a,b) => b.score - a.score).slice(0, 8);
    if (!matches.length) { message('No matching guides. Try fewer words or browse all guides below.'); return; }
    results.replaceChildren(...matches.map(({doc}) => {
      const link = document.createElement('a'), title = document.createElement('strong'), description = document.createElement('p');
      link.href = doc.url; title.textContent = doc.title; description.textContent = doc.description;
      link.append(title, description); return link;
    }));
  } catch {
    if (revision === searchRevision) message('Search could not load. Browse all guides below, or try opening search again.');
  }
}
function openSearch() {
  if (!dialog || dialog.open) return;
  dialog.showModal(); input.value = ''; input.focus(); search();
}
document.querySelectorAll('[data-open-search]').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('[data-close-search]')?.addEventListener('click', () => dialog.close());
input?.addEventListener('input', search);
dialog?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); }
});
dialog?.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); openSearch();
  }
});
let toastTimer;
function announce(text) {
  const status = document.querySelector('#site-status');
  clearTimeout(toastTimer); status.textContent = text; status.classList.add('visible');
  toastTimer = setTimeout(() => status.classList.remove('visible'), 5500);
}
document.querySelectorAll('[data-copy-target]').forEach(button => button.addEventListener('click', async () => {
  const content = document.getElementById(button.dataset.copyTarget);
  if (!content) return;
  try { await navigator.clipboard.writeText(content.textContent); announce('Setup commands copied.'); }
  catch { announce('Copy was blocked. Select and copy the commands directly.'); }
}));
