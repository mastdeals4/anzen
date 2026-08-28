import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing environment variables!');
  console.error('Make sure VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const users = [
  {
    email: 'admin@pharma.com',
    password: 'admin123',
    fullName: 'Admin User',
    role: 'admin',
  },
  {
    email: 'accounts@pharma.com',
    password: 'accounts123',
    fullName: 'Accounts Manager',
    role: 'accounts',
  },
  {
    email: 'sales@pharma.com',
    password: 'sales123',
    fullName: 'Sales Representative',
    role: 'sales',
  },
  {
    email: 'warehouse@pharma.com',
    password: 'warehouse123',
    fullName: 'Warehouse Staff',
    role: 'warehouse',
  },
];

async function createUsers() {
  console.log('Creating sample users...\n');

  for (const user of users) {
    try {
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
      });

      if (authError) {
        console.error(`❌ Failed to create auth user ${user.email}:`, authError.message);
        continue;
      }

      if (!authData.user) {
        console.error(`❌ No user data returned for ${user.email}`);
        continue;
      }

      const { error: profileError } = await supabase.from('user_profiles').insert({
        id: authData.user.id,
        email: user.email,
        full_name: user.fullName,
        role: user.role,
        language: 'en',
        is_active: true,
      });

      if (profileError) {
        console.error(`❌ Failed to create profile for ${user.email}:`, profileError.message);
        continue;
      }

      console.log(`✅ Created user: ${user.email} (${user.role})`);
      console.log(`   Password: ${user.password}`);
      console.log(`   UUID: ${authData.user.id}\n`);
    } catch (error) {
      console.error(`❌ Error creating user ${user.email}:`, error);
    }
  }

  console.log('\n✅ User creation complete!');
  console.log('\nYou can now login with any of these accounts:');
  users.forEach((u) => {
    console.log(`- ${u.email} / ${u.password} (${u.role})`);
  });
}

createUsers();
