import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'RabbitHole',
  version: '0.4.0',
  description:
    'AI learning companion: analyzes course material, explains complex terms, tracks your learning journey',
  permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'],
  host_permissions: ['*://*/*'],
  content_scripts: [
    {
      matches: ['*://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_end',
    },
  ],
  action: {
    default_title: 'RabbitHole - Analyze this page',
  },
  background: {
    service_worker: 'src/background.ts',
  },
});
