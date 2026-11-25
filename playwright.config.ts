import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
  testDir:'tests/browser',timeout:30000,fullyParallel:false,
  use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',launchOptions:{args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}},
  projects:[
    {name:'desktop',use:{...devices['Desktop Chrome'],channel:'msedge',viewport:{width:1440,height:1000}}},
    {name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium',channel:'msedge'}}
  ],
  webServer:{command:'npm run preview -- --port 4173',url:'http://127.0.0.1:4173',reuseExistingServer:true}
});
