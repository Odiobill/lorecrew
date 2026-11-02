import {fileURLToPath} from 'node:url';
import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
  timeout: 12000, testDir: './tests', testMatch: 'site.spec.ts', fullyParallel: true,
  forbidOnly: Boolean(process.env.CI), retries: process.env.CI ? 1 : 0,
  workers: 2, reporter: 'list', outputDir: '../test-results/website',
  use: {baseURL: process.env.LORECREW_SITE_URL ?? 'http://127.0.0.1:4321/lorecrew/', trace: 'retain-on-failure'},
  webServer: process.env.LORECREW_SITE_URL ? undefined : {
    command: 'node website/build.mjs --base /lorecrew/ --origin http://127.0.0.1:4321 --out website/dist/preview/lorecrew && python3 -m http.server 4321 --bind 127.0.0.1 --directory website/dist/preview',
    cwd: fileURLToPath(new URL('..',import.meta.url)),
    url: 'http://127.0.0.1:4321/lorecrew/', reuseExistingServer: !process.env.CI, timeout: 30000,
  },
  projects: [
    {name:'desktop', use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}},
    {name:'mobile', use:{...devices['Pixel 7'],viewport:{width:390,height:844}}},
  ],
});
