'use strict';

const MAX_SEARCH_LENGTH = 80;
const searchInput = document.querySelector('#manualSearch');
const clearButton = document.querySelector('#clearSearch');
const searchStatus = document.querySelector('#searchStatus');
const noResults = document.querySelector('#noResults');
const topics = [...document.querySelectorAll('[data-topic]')];
const topicLinks = [...document.querySelectorAll('.topic-nav a')];

if (window.location.protocol === 'file:') {
  for (const element of document.querySelectorAll('[data-server-only]')) {
    element.hidden = true;
  }
}

searchInput?.addEventListener('input', () => {
  applySearch(searchInput.value);
});

clearButton?.addEventListener('click', () => {
  if (!searchInput) return;
  searchInput.value = '';
  applySearch('');
  searchInput.focus();
});

for (const link of topicLinks) {
  link.addEventListener('click', () => {
    markCurrentTopic(link.hash);
  });
}

window.addEventListener('hashchange', () => {
  markCurrentTopic(window.location.hash);
});

applySearch('');
markCurrentTopic(window.location.hash);

function applySearch(rawQuery) {
  const query = normalizeText(String(rawQuery || '').slice(0, MAX_SEARCH_LENGTH));
  let visibleCount = 0;

  for (const topic of topics) {
    const haystack = normalizeText(`${topic.dataset.keywords || ''} ${topic.textContent || ''}`);
    const matches = !query || haystack.includes(query);
    topic.hidden = !matches;
    if (matches) visibleCount += 1;
  }

  for (const link of topicLinks) {
    const topic = document.querySelector(link.hash);
    link.hidden = Boolean(topic?.hidden);
  }

  if (clearButton) clearButton.hidden = !query;
  if (noResults) noResults.hidden = visibleCount !== 0;
  if (searchStatus) {
    searchStatus.textContent = query
      ? `${visibleCount} ${visibleCount === 1 ? 'topic' : 'topics'} found`
      : 'All topics shown';
  }
}

function markCurrentTopic(hash) {
  for (const link of topicLinks) {
    if (hash && link.hash === hash) {
      link.setAttribute('aria-current', 'true');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

function normalizeText(value) {
  return value.trim().toLocaleLowerCase();
}
