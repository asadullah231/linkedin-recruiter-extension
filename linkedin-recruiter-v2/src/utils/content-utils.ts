/**
 * CONTENT SCRIPT — SHARED HELPERS
 * ────────────────────────────────
 * Typed port of content/content-utils.js (+ getLoggedInUserName, which the
 * old monolith kept in content-profile.js). Pure DOM helpers shared by the
 * profile / jobs / ui content modules.
 */

/** querySelector, typed as HTMLElement by default so `.innerText` is available. */
export const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

/** querySelectorAll → array, typed as HTMLElement by default. */
export const qq = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll<T>(sel));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function extractPublicIdentifier(url: string): string | null {
  const match = url.match(/\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

/** Resolve LinkedIn's nested profile-picture artifact structure to a URL. */
export function extractPicUrl(profilePicture: unknown): string | null {
  if (!profilePicture) return null;
  if (typeof profilePicture === 'string') return profilePicture;
  const pic = profilePicture as {
    displayImageReference?: {
      vectorImage?: {
        rootUrl?: string;
        artifacts?: Array<{ fileIdentifyingUrlPathSegment?: string }>;
      };
    };
  };
  const artifacts = pic.displayImageReference?.vectorImage?.artifacts;
  if (artifacts && artifacts.length > 0) {
    const root = pic.displayImageReference!.vectorImage!.rootUrl ?? '';
    const largest = artifacts[artifacts.length - 1];
    return root + (largest.fileIdentifyingUrlPathSegment ?? '');
  }
  return null;
}

export function cleanName(s: unknown): string {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Strip LinkedIn UI artefacts that bleed into name extraction:
 *   "(1) Maria Robillard" · "•  Maria Robillard" · "Maria Robillard | LinkedIn"
 */
export function normalizeProfileName(s: unknown): string | null {
  if (!s) return null;
  let n = String(s).trim();
  // leading "(N)" or "(N+)" notification badge
  n = n.replace(/^\s*\(\s*\d+\+?\s*\)\s*/, '');
  // leading/trailing online-presence dots / pipes
  n = n.replace(/^[•·•|\s]+|[•·•|\s]+$/g, '');
  // strip trailing "| LinkedIn" or " - LinkedIn" if it slipped through
  n = n.replace(/\s*[-|]\s*LinkedIn\s*$/i, '');
  n = n.replace(/\s+/g, ' ').trim();
  return n || null;
}

/**
 * Detect the logged-in user's display name from the global nav so we can REJECT
 * it when it accidentally appears as the page's h1 (which used to cause every
 * scraped profile to come back as the viewer).
 */
export function getLoggedInUserName(): string | null {
  try {
    // Strategy 1: nav profile photo (alt text)
    const imgSelectors = [
      '.global-nav__me img.global-nav__me-photo',
      'img.global-nav__me-photo',
      'a.global-nav__me-photo img',
      'button.global-nav__primary-link-me-menu-trigger img',
      'a.global-nav__primary-link-me-menu-trigger img',
      '.global-nav img[alt]',
      'header img.evi-image',
      'nav img[width="32"][alt]',
    ];
    for (const sel of imgSelectors) {
      const el = q(sel);
      const alt = el?.getAttribute('alt') || '';
      if (!alt) continue;
      const m = alt.match(/(?:photo of|profile picture of|picture of)\s+(.+)$/i);
      if (m?.[1]) return cleanName(m[1]);
      if (alt.length > 1 && alt.length < 80 && !/linkedin|profile|photo/i.test(alt)) {
        return cleanName(alt);
      }
    }

    // Strategy 2: aria-label on me-menu trigger
    const ariaSelectors = [
      'button.global-nav__primary-link-me-menu-trigger',
      '.global-nav__me [aria-label]',
      'button[aria-label*="menu"]',
      'a[href="/in/me/"]',
    ];
    for (const sel of ariaSelectors) {
      const el = q(sel);
      const aria = el?.getAttribute('aria-label') || '';
      if (!aria) continue;
      const m = aria.match(/^(.+?)(?:'s|\s*profile|\s*menu|$)/i);
      if (m?.[1] && m[1].length < 80) return cleanName(m[1]);
    }

    // Strategy 3: voyager hidden data — look for the SELF entity
    const codeBlocks = document.querySelectorAll('code[id^="bpr-guid-"]');
    for (const code of codeBlocks) {
      try {
        const json = JSON.parse((code.textContent || '').trim());
        const items = json?.included || [];
        for (const item of items) {
          if (
            item?.$type?.includes('MiniProfile') &&
            item.firstName &&
            item.lastName &&
            /global-nav|me|self/i.test(item?.$id || '')
          ) {
            return `${item.firstName} ${item.lastName}`.trim();
          }
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* defensive */
  }
  return null;
}
