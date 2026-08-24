import { FullConfig } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const TEST_USERS = [
  { email: 'superadmin@test.com', password: 'TestPass123!', role: 'super_admin' },
  { email: 'admin@test.com', password: 'TestPass123!', role: 'admin' },
  { email: 'broker@test.com', password: 'TestPass123!', role: 'broker' },
  { email: 'viewer@test.com', password: 'TestPass123!', role: 'viewer' },
];

async function createTestUsers() {
  const supabase = createClient(
    'https://rnldqiwwzhjnurkguihu.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJudGRxaXd3emhqbnVya2d1aWh1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NTg2NDQwMCwiZXhwIjoyMDcxNDQwNDAwfQ.8QxKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqKqK',
    { auth: { persistSession: false } }
  );

  for (const user of TEST_USERS) {
    try {
      // Check if user already exists
      const { data: existing } = await supabase.auth.admin.listUsers();
      const exists = existing.users.some(u => u.email === user.email);

      if (exists) {
        console.log(`User ${user.email} already exists, skipping creation`);
        continue;
      }

      // Create auth user
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
        user_metadata: { full_name: user.email.split('@')[0] },
      });

      if (authError) {
        console.error(`Failed to create auth user ${user.email}:`, authError.message);
        continue;
      }

      // Create profile with role
      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: authUser.user.id,
          email: user.email,
          full_name: user.email.split('@')[0],
          role: user.role,
          is_active: true,
        });

      if (profileError) {
        console.error(`Failed to create profile for ${user.email}:`, profileError.message);
      } else {
        console.log(`Created test user: ${user.email} (${user.role})`);
      }
    } catch (err) {
      console.error(`Error creating user ${user.email}:`, err);
    }
  }
}

export default async function globalSetup(config: FullConfig) {
  console.log('Setting up test users...');
  await createTestUsers();
  console.log('Test users setup complete');
}