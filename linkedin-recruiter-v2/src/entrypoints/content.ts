/**
 * CONTENT SCRIPT — LinkedIn Profile Pages (WXT)
 *
 * Milestone 0 placeholder — full logic migrated in Milestone 4.
 */
export default defineContentScript({
  matches: ['https://www.linkedin.com/in/*', 'https://linkedin.com/in/*'],
  runAt: 'document_idle',
  main() {
    console.log('🟢 LRI Content Script loaded (WXT)');
  },
});
