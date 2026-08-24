import { test as base, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface AuthFixtures {
  superAdminPage: Page;
  adminPage: Page;
  brokerPage: Page;
  viewerPage: Page;
  supabase: SupabaseClient;
}

// Test users that may or may not exist - we'll create them if needed
const TEST_USERS = {
  super_admin: { email: 'superadmin@test.com', password: 'TestPass123!' },
  admin: { email: 'admin@test.com', password: 'TestPass123!' },
  broker: { email: 'broker@test.com', password: 'TestPass123!' },
  viewer: { email: 'viewer@test.com', password: 'TestPass123!' },
};

export const test = base.extend<AuthFixtures>({
  supabase: async ({}, use) => {
    const client = createClient(
      'https://rnldqiwwzhjnurkguihu.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJudGRxaXd3emhqbnVya2d1aWh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4NjQ0MDAsImV4cCI6MjA3MTQ0MDQwMH0.8QxKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqK'
    );
    await use(client);
  },

  superAdminPage: async ({ page, supabase }, use) => {
    await loginAs(page, supabase, TEST_USERS.super_admin.email, TEST_USERS.super_admin.password);
    await use(page);
  },

  adminPage: async ({ page, supabase }, use) => {
    await loginAs(page, supabase, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await use(page);
  },

  brokerPage: async ({ page, supabase }, use) => {
    await loginAs(page, supabase, TEST_USERS.broker.email, TEST_USERS.broker.password);
    await use(page);
  },

  viewerPage: async ({ page, supabase }, use) => {
    await loginAs(page, supabase, TEST_USERS.viewer.email, TEST_USERS.viewer.password);
    await use(page);
  },
});

async function loginAs(page: Page, supabase: SupabaseClient, email: string, password: string) {
  await page.goto('/admin.html');
  await page.waitForSelector('#loginScreen', { state: 'visible', timeout: 10000 });
  await page.fill('#loginEmail', email);
  await page.fill('#loginPassword', password);
  await page.click('#btnLoginSubmit');
  // Wait for either success (appLayout visible) or failure (loginError visible)
  await Promise.race([
    page.waitForSelector('#appLayout', { state: 'visible', timeout: 20000 }),
    page.waitForSelector('#loginError:not([style*="display: none"])', { timeout: 5000 }),
  ]);
  await page.waitForLoadState('networkidle');
}

export const expect = test.expect;