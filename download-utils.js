(function attachDownloadUtils(root) {
  const ROUTE_NAMES = new Set([
    'attachment',
    'download',
    'fetch',
    'file',
    'filedata',
    'image',
    'index',
    'index.php',
    'media',
    'view'
  ]);

  function sanitizePathSegment(value) {
    const cleaned = String(value || '')
      .replace(/[<>:"\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '')
      .slice(0, 80);
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      ? `_${cleaned}`
      : cleaned;
  }

  function sanitizeSubfolder(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part && part !== '.' && part !== '..')
      .map(sanitizePathSegment)
      .filter(Boolean)
      .slice(0, 6)
      .join('/')
      .slice(0, 240);
  }

  function filenameFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      return decodeValue(pathname.split('/').filter(Boolean).pop() || '');
    } catch (error) {
      return '';
    }
  }

  function normalizeExtension(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/^\./, '');
    return normalized === 'jpeg' ? 'jpg' : normalized.replace(/[^a-z0-9]/g, '');
  }

  function usableFilename(value) {
    const decoded = decodeValue(value).replace(/\\/g, '/');
    const leaf = decoded.split('/').pop() || '';
    const sanitized = sanitizePathSegment(leaf);
    if (!sanitized) {
      return '';
    }

    const lower = sanitized.toLowerCase();
    const stem = lower.replace(/\.[a-z0-9]{1,8}$/i, '');
    const extension = lower.match(/\.([a-z0-9]{1,8})$/i)?.[1] || '';
    if (ROUTE_NAMES.has(lower) || ROUTE_NAMES.has(stem)) {
      return '';
    }
    if (['htm', 'html', 'php', 'asp', 'aspx', 'jsp'].includes(extension)) {
      return '';
    }

    return sanitized;
  }

  function resolveFilename(item, index, page = {}) {
    const candidates = [
      item.responseFilename,
      ...(Array.isArray(item.filenameHints) ? item.filenameHints : []),
      item.filename,
      filenameFromUrl(item.finalUrl),
      filenameFromUrl(item.url),
      filenameFromUrl(item.previewUrl)
    ];
    let filename = '';

    for (const candidate of candidates) {
      filename = usableFilename(candidate);
      if (filename) {
        break;
      }
    }

    const extension = normalizeExtension(item.extension || extensionFromUrl(item.url));
    if (!filename) {
      const pagePart = pageIdentity(page);
      const type = sanitizePathSegment(item.type || 'media').toLowerCase() || 'media';
      const sequence = String(Number(index) + 1).padStart(3, '0');
      const fingerprint = shortHash(item.url || `${page.url || ''}:${index}`);
      filename = `${pagePart}_${type}_${sequence}_${fingerprint}`;
    }

    filename = sanitizePathSegment(filename);
    const currentExtension = normalizeExtension(filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]);
    if (extension && currentExtension !== extension) {
      if (!currentExtension) {
        filename = `${filename}.${extension}`;
      } else if (
        ['jpg', 'png', 'gif', 'webp', 'svg', 'webm', 'mp4', 'htm', 'html', 'php', 'asp', 'aspx', 'jsp']
          .includes(currentExtension)
      ) {
        filename = `${filename.replace(/\.[^.]+$/, '')}.${extension}`;
      }
    }

    return filename.slice(0, 160);
  }

  function resolveUniqueFilename(item, index, page, usedNames) {
    const used = usedNames || new Set();
    const filename = resolveFilename(item, index, page);
    const extensionMatch = filename.match(/(\.[a-z0-9]{1,8})$/i);
    const extension = extensionMatch ? extensionMatch[1] : '';
    const stem = extension ? filename.slice(0, -extension.length) : filename;
    let unique = filename;
    let duplicateIndex = 2;

    while (used.has(unique.toLowerCase())) {
      unique = `${stem}_${String(duplicateIndex).padStart(2, '0')}${extension}`;
      duplicateIndex += 1;
    }

    used.add(unique.toLowerCase());
    return unique;
  }

  function prepareDownloadItems(items, page = {}) {
    const usedNames = new Set();
    return items.map((item, index) => ({
      ...item,
      filename: resolveUniqueFilename(item, index, page, usedNames)
    }));
  }

  function buildSuggestedSubfolder(page = {}) {
    const host = sanitizePathSegment(hostFromUrl(page.url) || page.host || 'active-tab')
      .replace(/^www\./i, '')
      .toLowerCase();
    const identity = pageIdentity(page);
    return sanitizeSubfolder(`${host}/${identity}`);
  }

  function buildDownloadFolder(page = {}, requestedSubfolder = '') {
    const subfolder = sanitizeSubfolder(requestedSubfolder) || buildSuggestedSubfolder(page);
    return `ImageDownloader/${subfolder || 'active-tab'}`;
  }

  function pageIdentity(page = {}) {
    let parsed;
    try {
      parsed = new URL(page.url || '');
    } catch (error) {
      parsed = null;
    }

    if (parsed) {
      const segments = parsed.pathname.split('/').filter(Boolean).map(decodeValue);
      const markerIndex = segments.findIndex((segment) => /^(?:thread|threads|topic|topics|post|posts)$/i.test(segment));
      if (markerIndex >= 0 && segments[markerIndex + 1]) {
        const board = markerIndex > 0 && segments[markerIndex - 1].length <= 20
          ? `${slugify(segments[markerIndex - 1], 20)}-`
          : '';
        const marker = slugify(segments[markerIndex], 12) || 'thread';
        const id = slugify(segments[markerIndex + 1], 36);
        const tail = slugify(segments[markerIndex + 2] || '', 36);
        return [board + marker, id, tail].filter(Boolean).join('-').slice(0, 80);
      }

      for (const key of ['thread', 'topic', 'tid', 'post', 'id']) {
        const value = parsed.searchParams.get(key);
        if (value) {
          return `${key}-${slugify(value, 48)}`;
        }
      }
    }

    const title = slugify(page.title || '', 56);
    const pathTail = parsed
      ? slugify(parsed.pathname.split('/').filter(Boolean).pop() || '', 40)
      : '';
    const base = title || pathTail || 'page';
    return `${base}-${shortHash(page.url || page.host || base)}`.slice(0, 80);
  }

  function slugify(value, maxLength = 56) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
      .replace(/-+$/g, '');
  }

  function extensionFromUrl(url) {
    const filename = filenameFromUrl(url);
    return normalizeExtension(filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]);
  }

  function hostFromUrl(url) {
    try {
      return new URL(url).host;
    } catch (error) {
      return '';
    }
  }

  function decodeValue(value) {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (error) {
      return String(value || '');
    }
  }

  function shortHash(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).slice(0, 6).padStart(6, '0');
  }

  const api = {
    buildDownloadFolder,
    buildSuggestedSubfolder,
    filenameFromUrl,
    prepareDownloadItems,
    resolveFilename,
    resolveUniqueFilename,
    sanitizePathSegment,
    sanitizeSubfolder,
    shortHash
  };

  root.DownloadUtils = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
