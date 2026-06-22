/**
 * CONTENT SCRIPT — LinkedIn Profile Pages (WXT)
 * ──────────────────────────────────────────────
 * Thin orchestrator. All extraction/UI logic lives in ../content/*.ts and
 * ../utils/content-utils.ts. The FAB styles are bundled via the CSS import.
 */
import '../content/content.css';
import { initContentScript } from '../content/ui';

export default defineContentScript({
  matches: ['https://www.linkedin.com/in/*', 'https://linkedin.com/in/*'],
  runAt: 'document_idle',
  main() {
    initContentScript();
  },
});
