import { chromium } from 'playwright';

const BASE = 'https://rust-eight-rosy.vercel.app';
const email = `atlas-probe-${Date.now()}@meetdossie.com`;
const password = 'TestPass!23456';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

await page.getByText('Need an account? Sign up').click({ force: true });
await page.waitForTimeout(300);
await page.getByPlaceholder('First name').fill('Probe');
await page.getByPlaceholder('Email').fill(email);
await page.getByPlaceholder('Password', { exact: true }).fill(password);
await page.getByPlaceholder('Confirm Password').fill(password);
await page.getByRole('button', { name: 'Create Account' }).click({ force: true });
await page.waitForTimeout(3000);

const categories = ['free_weights','machines','plate_loaded','cables','cardio','benches_racks','bodyweight','functional','smart_connected','studio'];

const result = await page.evaluate(async (cats) => {
  // Reach into the app's module graph isn't trivial; instead read supabase config from meta and build our own client via the global if exposed.
  return { hasWindowSupabase: !!window.supabase };
}, categories);
console.log('probe result', result);

await browser.close();
