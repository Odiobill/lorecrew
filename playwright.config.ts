import { defineConfig } from '@playwright/test';
// Playwright controls worker color itself; avoid inheriting a conflicting terminal preference.
delete process.env.NO_COLOR;
export default defineConfig({testDir:'tests/e2e',timeout:60_000,expect:{timeout:15_000},fullyParallel:false,workers:1,reporter:'list',use:{launchOptions:{args:['--host-resolver-rules=MAP lorecrew.test 127.0.0.1','--no-proxy-server']},headless:true,actionTimeout:15_000,trace:'retain-on-failure'},projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844}}}]});
