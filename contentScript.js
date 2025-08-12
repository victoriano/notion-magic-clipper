// contentScript.js
// Collects context from the current page

function getMetaTag(name) {
  const el = document.querySelector(`meta[name='${name}']`) || document.querySelector(`meta[property='${name}']`);
  return el ? el.getAttribute('content') : undefined;
}

function tryReadabilityExtract() {
  try {
    // Guard against missing global Readability (should be injected via manifest ordering)
    if (typeof Readability !== 'function') return null;
    // Clone the document to avoid mutating the live page
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone, {
      // keepClasses: false by default; we want clean content
      // You can tweak thresholds here if needed
    });
    const article = reader.parse();
    if (!article || !article.content || !article.textContent) return null;
    // Some sites may not be considered long article, but still useful
    // We rely on Readability's own charThreshold default (500) which is fine
    return {
      title: article.title || undefined,
      byline: article.byline || undefined,
      dir: article.dir || undefined,
      siteName: article.siteName || undefined,
      lang: article.lang || undefined,
      publishedTime: article.publishedTime || undefined,
      excerpt: article.excerpt || undefined,
      length: article.length || undefined,
      html: article.content, // HTML string
      text: article.textContent // plain text
    };
  } catch (_) {
    return null;
  }
}

function convertArticleHtmlToBlocks(html, { maxBlocks = 160, maxTextLen = 2000 } = {}) {
  try {
    const container = document.createElement('div');
    container.innerHTML = html;
    const blocks = [];

    const toRichText = (text) => [{ type: 'text', text: { content: text } }];

    function pushTextBlock(type, text) {
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      const clipped = t.length > maxTextLen ? t.slice(0, maxTextLen) : t;
      blocks.push({ object: 'block', type, [type]: { rich_text: toRichText(clipped) } });
    }

    function pushImage(url) {
      if (!url || /^data:/i.test(url)) return;
      try { url = new URL(url, location.href).href; } catch {}
      blocks.push({ object: 'block', type: 'image', image: { external: { url } } });
    }

    function firstSrcFromSrcset(srcset) {
      if (!srcset) return undefined;
      const first = String(srcset).split(',')[0];
      return first ? first.trim().split(' ')[0] : undefined;
    }

    function handleFigure(fig) {
      const img = fig.querySelector('img');
      if (img) {
        const url = img.getAttribute('src') || firstSrcFromSrcset(img.getAttribute('srcset'));
        if (url) pushImage(url);
      }
      const cap = fig.querySelector('figcaption');
      if (cap) pushTextBlock('paragraph', cap.innerText || cap.textContent || '');
    }

    function walk(node) {
      if (!node || blocks.length >= maxBlocks) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = String(node.nodeValue || '').trim();
        if (t) pushTextBlock('paragraph', t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

      switch (tag) {
        case 'h1':
          pushTextBlock('heading_1', el.innerText || el.textContent || '');
          return;
        case 'h2':
          pushTextBlock('heading_2', el.innerText || el.textContent || '');
          return;
        case 'h3':
          pushTextBlock('heading_3', el.innerText || el.textContent || '');
          return;
        case 'p':
          pushTextBlock('paragraph', el.innerText || el.textContent || '');
          return;
        case 'blockquote':
          pushTextBlock('quote', el.innerText || el.textContent || '');
          return;
        case 'ul': {
          const items = el.querySelectorAll(':scope > li');
          items.forEach((li) => {
            if (blocks.length >= maxBlocks) return;
            pushTextBlock('bulleted_list_item', li.innerText || li.textContent || '');
          });
          return;
        }
        case 'ol': {
          const items = el.querySelectorAll(':scope > li');
          items.forEach((li) => {
            if (blocks.length >= maxBlocks) return;
            pushTextBlock('numbered_list_item', li.innerText || li.textContent || '');
          });
          return;
        }
        case 'img': {
          const url = el.getAttribute('src') || firstSrcFromSrcset(el.getAttribute('srcset'));
          if (url) pushImage(url);
          return;
        }
        case 'figure': {
          handleFigure(el);
          return;
        }
        default:
          // Walk children for other containers (div, section, article, etc.)
          const children = Array.from(el.childNodes);
          for (const c of children) {
            if (blocks.length >= maxBlocks) break;
            walk(c);
          }
      }
    }

    const kids = Array.from(container.childNodes);
    for (const n of kids) {
      if (blocks.length >= maxBlocks) break;
      walk(n);
    }
    return blocks;
  } catch (_) {
    return [];
  }
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

  // Attempt to parse an article with Readability
  const article = tryReadabilityExtract();
  let articleBlocks = undefined;
  if (article && article.html) {
    articleBlocks = convertArticleHtmlToBlocks(article.html);
  }

  // Only compute a paragraph sample if there's no article
  let textSample;
  if (!article) {
    const paragraphs = Array.from(document.querySelectorAll('article p, main p, p')).slice(0, 10);
    textSample = paragraphs
      .map((p) => p.innerText.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000);
  }

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
      width: img.naturalWidth || undefined,
      height: img.naturalHeight || undefined,
      renderedWidth: img.clientWidth || undefined,
      renderedHeight: img.clientHeight || undefined,
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
      renderedWidth: (picture?.clientWidth || s.clientWidth) || undefined,
      renderedHeight: (picture?.clientHeight || s.clientHeight) || undefined,
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
          renderedWidth: el.clientWidth || undefined,
          renderedHeight: el.clientHeight || undefined,
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
    ...(textSample ? { textSample } : {}),
    headings,
    listItems,
    shortSpans,
    attrTexts,
    images,
    // If Readability detected an article, expose it. Else keep undefined.
    article,
    ...(Array.isArray(articleBlocks) && articleBlocks.length ? { articleBlocks } : {})
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
