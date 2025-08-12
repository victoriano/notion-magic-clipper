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

  // Get some text sample: first few paragraphs (up to 20)
  const paragraphs = Array.from(document.querySelectorAll('article p, main p, p')).slice(0, 20);
  const textSample = paragraphs
    .map((p) => p.innerText.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);

  const selectionText = window.getSelection()?.toString()?.trim() || '';

  // Additional short, relevant snippets
  function collectTexts(selector, limit, minLen = 8, maxLen = 200) {
    const out = [];
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const el of nodes) {
      if (out.length >= limit) break;
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length >= minLen && t.length <= maxLen) out.push(t);
    }
    return out;
  }

  const headings = collectTexts('h1, h2, h3', 20, 4, 200);
  const listItems = collectTexts('ul li, ol li', 20, 4, 200);
  const shortSpans = collectTexts('span, small, em, strong, mark, label', 40, 8, 160);

  // Attribute-based short texts
  function collectAttr(selector, attr, limit) {
    const out = [];
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const el of nodes) {
      if (out.length >= limit) break;
      const v = el.getAttribute(attr);
      if (v && v.trim()) out.push(v.trim());
    }
    return out;
  }
  const imgAlts = collectAttr('img[alt]', 'alt', 30);
  const aTitles = collectAttr('a[title]', 'title', 30);
  const ariaLabels = collectAttr('[aria-label]', 'aria-label', 30);
  const attrTexts = Array.from(new Set([...imgAlts, ...aTitles, ...ariaLabels]));

  // Image URLs: <img>, <source srcset>, and CSS background-image
  function toAbsolute(u) {
    try { return new URL(u, location.href).href; } catch { return u; }
  }

  function textTrim(s, max = 220) {
    if (!s) return undefined;
    const t = String(s).trim();
    if (!t) return undefined;
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  function findNearestHeading(el) {
    let node = el;
    for (let up = 0; up < 3 && node; up++) {
      // direct heading sibling
      if (node.matches && node.matches('h1,h2,h3')) return textTrim(node.innerText || node.textContent);
      // previous sibling or its descendants
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.matches && sib.matches('h1,h2,h3')) return textTrim(sib.innerText || sib.textContent);
        const h = sib.querySelector && sib.querySelector('h1,h2,h3');
        if (h) return textTrim(h.innerText || h.textContent);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return undefined;
  }

  const images = [];
  const seenImages = new Map(); // url -> entry
  function addImage(url, ctx) {
    if (!url || url.startsWith('data:')) return;
    const abs = toAbsolute(url);
    if (!abs) return;
    let entry = seenImages.get(abs);
    if (!entry) {
      entry = { url: abs, ...ctx };
      seenImages.set(abs, entry);
      images.push(entry);
    } else {
      // Merge missing context fields
      for (const k of Object.keys(ctx)) {
        if (entry[k] == null && ctx[k] != null) entry[k] = ctx[k];
      }
    }
  }

  // From <img src/srcset>
  Array.from(document.images).forEach((img) => {
    const baseCtx = {
      source: 'img',
      alt: textTrim(img.getAttribute('alt')),
      title: textTrim(img.getAttribute('title')),
      ariaLabel: textTrim(img.getAttribute('aria-label')),
      nearestHeading: findNearestHeading(img),
      figcaption: textTrim(img.closest('figure')?.querySelector('figcaption')?.innerText || ''),
      linkText: textTrim(img.closest('a')?.innerText || ''),
      parentText: textTrim(img.parentElement?.innerText || ''),
      classes: textTrim(img.className, 160),
      parentClasses: textTrim(img.parentElement?.className, 160),
      tag: img.tagName
    };
    if (img.src) addImage(img.src, baseCtx);
    const ss = img.getAttribute('srcset');
    if (ss) ss.split(',').forEach((part) => {
      const u = part.trim().split(' ')[0];
      if (u) addImage(u, { ...baseCtx, source: 'img:srcset' });
    });
  });

  // From <source srcset> (often inside <picture>)
  Array.from(document.querySelectorAll('source[srcset]')).forEach((s) => {
    const picture = s.closest('picture');
    const imgAlt = picture?.querySelector('img')?.getAttribute('alt');
    const baseCtx = {
      source: 'source:srcset',
      alt: textTrim(imgAlt),
      nearestHeading: findNearestHeading(s),
      parentText: textTrim(s.parentElement?.innerText || ''),
      parentClasses: textTrim(s.parentElement?.className || picture?.className, 160),
      tag: s.tagName
    };
    const ss = s.getAttribute('srcset');
    if (ss) ss.split(',').forEach((part) => {
      const u = part.trim().split(' ')[0];
      if (u) addImage(u, baseCtx);
    });
  });

  // From CSS background-image of top elements (cap to 300 elements)
  Array.from(document.querySelectorAll('*')).slice(0, 300).forEach((el) => {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const re = /url\(("|')?([^"')]+)("|')?\)/g;
      let m;
      while ((m = re.exec(bg))) {
        const url = m[2];
        if (!url) continue;
        addImage(url, {
          source: 'css-bg',
          nearestHeading: findNearestHeading(el),
          parentText: textTrim(el.innerText || el.textContent || ''),
          classes: textTrim(el.className, 160),
          parentClasses: textTrim(el.parentElement?.className, 160),
          tag: el.tagName
        });
      }
    } catch {}
  });
  // Cap images
  if (images.length > 60) images.length = 60;

  return {
    url: location.href,
    title: document.title,
    meta,
    selectionText,
    textSample,
    headings,
    listItems,
    shortSpans,
    attrTexts,
    images
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
