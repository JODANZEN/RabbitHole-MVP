import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'RabbitHole',
  version: '0.5.1',
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
  icons: {
    '16': 'icon-16.png',
    '32': 'icon-32.png',
    '48': 'icon-48.png',
    '128': 'icon-128.png',
  },
  action: {
    default_title: 'RabbitHole - Analyze this page',
    default_icon: {
      '16': 'icon-16.png',
      '32': 'icon-32.png',
      '48': 'icon-48.png',
      '128': 'icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background.ts',
  },
});
