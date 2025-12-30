# Quick Start - Create Sample Users

Your database is fully populated with sample data! Now you just need to create the user accounts.

## Option 1: Automated Setup Page (Easiest) ⚡

1. Start the development server:
```bash
npm run dev
```

2. Open your browser and go to:
```
http://localhost:5173/setup
```

3. Click the **"Create All Users"** button

4. Once successful, click **"Go to Login"** or navigate to `http://localhost:5173`

5. Login with:
   - Email: **admin@pharma.com**
   - Password: **admin123**

That's it! The setup page will automatically create all 4 users with their profiles.

---

## Option 2: Manual Creation via Supabase Dashboard

If the automated setup doesn't work (e.g., if email confirmation is required), follow these steps:

### Step 1: Create Auth Users
1. Go to: https://supabase.com/dashboard/project/dkrtsqienlhpouohmfki/auth/users
2. Click **"Add user"** and create these 4 users:

| Email | Password | Auto Confirm? |
|-------|----------|---------------|
| admin@pharma.com | admin123 | ✅ Check |
| accounts@pharma.com | accounts123 | ✅ Check |
| sales@pharma.com | sales123 | ✅ Check |
| warehouse@pharma.com | warehouse123 | ✅ Check |

**Important:** Copy each user's UUID after creation!

### Step 2: Create User Profiles
1. Go to: https://supabase.com/dashboard/project/dkrtsqienlhpouohmfki/editor
2. Click **SQL Editor** → **New query**
3. Paste this (replace UUIDs):

```sql
INSERT INTO user_profiles (id, email, full_name, role, language, is_active) VALUES
('PASTE_ADMIN_UUID', 'admin@pharma.com', 'Admin User', 'admin', 'en', true),
('PASTE_ACCOUNTS_UUID', 'accounts@pharma.com', 'Accounts Manager', 'accounts', 'en', true),
('PASTE_SALES_UUID', 'sales@pharma.com', 'Sales Representative', 'sales', 'en', true),
('PASTE_WAREHOUSE_UUID', 'warehouse@pharma.com', 'Warehouse Staff', 'warehouse', 'en', true);
```

4. Click **Run**

---

## What's Already Set Up

Your database already contains:
- ✅ **18 Products** (APIs, excipients, solvents, packaging)
- ✅ **8 Customers** (Indonesian pharmaceutical companies)
- ✅ **10 Import Batches** with inventory tracking
- ✅ **6 CRM Leads** at various stages
- ✅ **6 Sales Invoices** with line items
- ✅ **Financial Transactions** and expenses

---

## Test User Accounts

Once created, you can login with:

| Email | Password | Role | Access |
|-------|----------|------|--------|
| admin@pharma.com | admin123 | Admin | Full system access |
| accounts@pharma.com | accounts123 | Accounts | Finance, invoices, customers |
| sales@pharma.com | sales123 | Sales | CRM, leads, customers, products |
| warehouse@pharma.com | warehouse123 | Warehouse | Inventory, batches, products |

---

## Troubleshooting

**Setup page shows "Auth error: Email signups are disabled"**
- Go to Supabase Dashboard → Authentication → Providers → Email
- Enable "Email provider"
- Try the setup page again

**"Email confirmation required"**
- Go to Supabase Dashboard → Authentication → Email Auth
- Disable "Confirm email"
- Try again

**"User already exists"**
- The user was already created! Just skip to login

**Can't login after creating users**
- Make sure you ran the SQL to create user_profiles
- Verify in SQL Editor: `SELECT * FROM user_profiles;`

---

## Next Steps

After logging in, explore:
1. **Dashboard** - View key metrics and statistics
2. **Products** - Browse pharmaceutical products
3. **Customers** - View customer database
4. **More modules** coming soon (batches, invoices, CRM, finance)

---

Need help? Check:
- `SETUP.md` - Detailed setup instructions
- `CREATE_USERS.md` - Manual user creation guide
