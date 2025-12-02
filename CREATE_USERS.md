# Quick Guide: Create Sample Users

Since you've linked the database, here's the fastest way to create the sample users:

## Option 1: Using Supabase Dashboard (Recommended - 5 minutes)

### Step 1: Go to Authentication
1. Open: https://supabase.com/dashboard/project/dkrtsqienlhpouohmfki/auth/users
2. Click the **"Add user"** button (green plus icon)

### Step 2: Create Each User

**User 1 - Admin:**
- Email: `admin@pharma.com`
- Password: `admin123`
- ✅ Check **"Auto Confirm User"**
- Click "Create user"
- **COPY THE UUID** shown after creation
- 87d975a9-2a46-49a5-9014-f244d1140aba

**User 2 - Accounts:**
- Email: `accounts@pharma.com`
- Password: `accounts123`
- ✅ Check **"Auto Confirm User"**
- Click "Create user"
- **COPY THE UUID**
- 20f63eb2-75f9-4ccd-949b-7d3b60823921

**User 3 - Sales:**
- Email: `sales@pharma.com`
- Password: `sales123`
- ✅ Check **"Auto Confirm User"**
- Click "Create user"
- **COPY THE UUID**
- a82db049-ed45-4861-a115-a20155129f3a

**User 4 - Warehouse:**
- Email: `warehouse@pharma.com`
- Password: `warehouse123`
- ✅ Check **"Auto Confirm User"**
- Click "Create user"
- **COPY THE UUID**
- cd7b9d5f-d45c-4b5f-b113-68505a8cae27

### Step 3: Link Users to Profiles

1. Go to: https://supabase.com/dashboard/project/dkrtsqienlhpouohmfki/editor
2. Click **SQL Editor**
3. Click **New query**
4. Paste this SQL (replace the UUIDs with the ones you copied):

```sql
-- Replace these UUIDs with the actual UUIDs from Step 2
INSERT INTO user_profiles (id, email, full_name, role, language, is_active) VALUES
('87d975a9-2a46-49a5-9014-f244d1140aba', 'admin@anzen.com', 'Admin User', 'admin', 'en', true),
('20f63eb2-75f9-4ccd-949b-7d3b60823921', 'accounts@anzen.com', 'Accounts Manager', 'accounts', 'en', true),
('a82db049-ed45-4861-a115-a20155129f3a', 'sales@anzen.com', 'Sales Representative', 'sales', 'en', true),
('cd7b9d5f-d45c-4b5f-b113-68505a8cae27', 'warehouse@anzen.com', 'Warehouse Staff', 'warehouse', 'en', true);
```

5. Click **Run** (or press Ctrl/Cmd + Enter)

### Step 4: Login!

```bash
npm run dev
```

Login with:
- Email: **admin@pharma.com**
- Password: **admin123**

---

## Option 2: Quick SQL Method (If you want to do it manually)

If you prefer to add the profiles one at a time:

After creating each auth user in the dashboard, immediately run this in SQL Editor:

```sql
-- For admin user (replace UUID)
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('YOUR_UUID_HERE', 'admin@pharma.com', 'Admin User', 'admin', 'en', true);

-- For accounts user (replace UUID)
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('YOUR_UUID_HERE', 'accounts@pharma.com', 'Accounts Manager', 'accounts', 'en', true);

-- For sales user (replace UUID)
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('YOUR_UUID_HERE', 'sales@pharma.com', 'Sales Representative', 'sales', 'en', true);

-- For warehouse user (replace UUID)
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('YOUR_UUID_HERE', 'warehouse@pharma.com', 'Warehouse Staff', 'warehouse', 'en', true);
```

---

## Test User Credentials

After setup, you'll have these accounts:

| Email | Password | Role | Access |
|-------|----------|------|--------|
| admin@pharma.com | admin123 | Admin | Full access to everything |
| accounts@pharma.com | accounts123 | Accounts | Finance, invoices, customers |
| sales@pharma.com | sales123 | Sales | CRM, customers, products |
| warehouse@pharma.com | warehouse123 | Warehouse | Inventory, batches, products |

---

## Verification

To verify users were created correctly, run this in SQL Editor:

```sql
SELECT
  up.email,
  up.full_name,
  up.role,
  up.is_active,
  au.email_confirmed_at
FROM user_profiles up
LEFT JOIN auth.users au ON au.id = up.id
ORDER BY up.role;
```

You should see all 4 users with confirmed emails.

---

## Troubleshooting

**"Email already exists"**
- The user was already created. Skip to Step 3 to add the profile.

**"Invalid UUID"**
- Make sure you copied the full UUID (it looks like: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
- Don't include quotes or extra spaces

**"RLS policy violation"**
- Make sure the UUID in user_profiles matches exactly with the auth.users UUID

**Can't find the UUID?**
- Go to Authentication → Users
- Click on the user
- The UUID is at the top of the user details page
