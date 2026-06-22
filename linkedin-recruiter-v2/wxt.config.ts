import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'LinkedIn Recruiter Intelligence',
    version: '0.20.0',
    description:
      'n8n-driven LinkedIn recruiter scraper. Multi-tenant: each teammate sets a Team ID, pulls only their own URLs, and results are tagged per owner.',
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
