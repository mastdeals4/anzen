# Reset User Password

Your users exist but you need to set/reset the password. Here's how:

## Option 1: Via Supabase Dashboard (Easiest)

1. Go to: https://supabase.com/dashboard/project/dkrtsqienlhpouohmfki/auth/users

2. Find the user: **admin@anzen.com**

3. Click on the user to open details

4. Click the **"Reset Password"** or **"Send Magic Link"** button
   - OR click the three dots menu → **"Reset password"**

5. You can either:
   - Send a password reset email (if you have email configured)
   - OR manually set a new password in the dashboard

6. Set the password to: **admin123**

7. Now you can login with:
   - Email: **admin@anzen.com**
   - Password: **admin123**

## Option 2: Set Password via SQL (Advanced)

If you have access to set encrypted passwords, use the Supabase Admin API or dashboard to set the password directly.

## Your Current Users

| Email | Role | Status |
|-------|------|--------|
| admin@anzen.com | Admin | ✅ Confirmed |
| accounts@anzen.com | Accounts | ✅ Confirmed |
| sales@anzen.com | Sales | ✅ Confirmed |
| warehouse@anzen.com | Warehouse | ✅ Confirmed |

All users are confirmed and ready - they just need passwords set.

## Quick Test

After setting the password, try logging in at: http://localhost:5173

If you still can't login:
1. Open browser console (F12)
2. Check for any error messages
3. Verify the Supabase URL and keys in your .env file
