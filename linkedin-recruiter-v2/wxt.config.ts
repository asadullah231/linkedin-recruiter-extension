import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // publicDir defaults to `<srcDir>/public` (i.e. src/public); our static assets
  // (icons/, lib/xlsx.full.min.js) live in the project-root `public/`, so point
  // WXT back there — otherwise they never get copied into the build output.
  publicDir: '../public',
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'LinkedIn Recruiter Intelligence',
    version: '0.20.0',
    description:
      'n8n-driven LinkedIn recruiter scraper. Multi-tenant: each teammate sets a Team ID, pulls only their own URLs, and results are tagged per owner.',
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'tabs',
      'notifications',
      'alarms',
    ],
    host_permissions: [
      'https://www.linkedin.com/*',
      'https://linkedin.com/*',
      'https://n8n.emergeautomation.tech/*',
      'https://*.n8n.cloud/*',
      'https://openrouter.ai/*',
    ],
    web_accessible_resources: [
      {
        resources: ['lib/xlsx.full.min.js', 'job-scraper.js'],
        matches: ['https://*.linkedin.com/*'],
      },
    ],
  },
});
