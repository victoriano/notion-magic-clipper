// contentScript.js
// Collects context from the current page

function getMetaTag(name) {
  const el = document.querySelector(`meta[name='${name}']`) || document.querySelector(`meta[property='${name}']`);
  return el ? el.getAttribute('content') : undefined;
}

function collectPageContext() {
  const meta = {};
  const metaNames = [
    'description', 'og:title', 'og:description', 'og:url', 'og:type',
    'og:image', 'twitter:image', 'twitter:title', 'twitter:description', 'keywords'
  ];
  metaNames.forEach((n) => {
    const v = getMetaTag(n);
    if (v) meta[n] = v;
  });

  // Get some text sample: first few paragraphs
  const paragraphs = Array.from(document.querySelectorAll('article p, main p, p')).slice(0, 10);
  const textSample = paragraphs.map((p) => p.innerText.trim()).filter(Boolean).join('\n').slice(0, 4000);

  const selectionText = window.getSelection()?.toString()?.trim() || '';

  return {
    url: location.href,
    title: document.title,
    meta,
    selectionText,
    textSample
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'GET_PAGE_CONTEXT') {
    try {
      sendResponse({ ok: true, context: collectPageContext() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
    return true;
  }
});
