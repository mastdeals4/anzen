# Fix for Gmail OAuth Error and Delivery Challan Issue

## Issue 1: Gmail OAuth Error - "redirect_uri_mismatch"

### Problem
You're getting **Error 400: redirect_uri_mismatch** when trying to connect Gmail. This happens because the redirect URI in your Google Cloud Console doesn't match the one your app is using.

### ✅ SOLUTION - Step by Step

#### Step 1: Get Your App's Redirect URI

Your app's redirect URI from the error is:
```
https://yourcurrentdomain.com/auth/gmail/callback
```

Or if running locally:
```
http://localhost:5173/auth/gmail/callback
```

#### Step 2: Add Redirect URI to Google Cloud Console

1. Go to **[Google Cloud Console](https://console.cloud.google.com/apis/credentials)**
2. Find your OAuth 2.0 Client ID (the one with your `VITE_GOOGLE_CLIENT_ID`)
3. Click on it to edit
4. Scroll down to **"Authorized redirect URIs"**
5. Click **"+ ADD URI"**
6. Add BOTH of these URIs:
   ```
   http://localhost:5173/auth/gmail/callback
   https://your-production-domain.com/auth/gmail/callback
   ```

   **IMPORTANT**: Replace `your-production-domain.com` with your actual domain!

7. Click **"SAVE"** at the bottom
8. **WAIT 5 MINUTES** for changes to propagate

#### Step 3: Test the Connection

1. Go back to your CRM app
2. Navigate to **Settings → Gmail** tab
3. Click **"Connect Gmail Account"** again
4. You should now be redirected to Google login successfully!

### Common Mistakes to Avoid

❌ **DON'T**:
- Forget the protocol (`http://` or `https://`)
- Add trailing slashes (`/auth/gmail/callback/` ← wrong)
- Use different ports (`:5173` must match exactly)
- Use IP addresses instead of domain names

✅ **DO**:
- Match the URI exactly as shown in the error
- Add both development and production URIs
- Wait 5 minutes after saving for changes to take effect
- Use the exact domain/subdomain

---

## Issue 2: Delivery Challan 004 is Blank / Can't Update

### Problem
Delivery Challan #004 appears blank when viewing or can't be updated when editing.

### Possible Causes and Solutions

#### Cause 1: Missing Items in Challan

**Check**: The challan was created but no items were added

**Solution**:
1. Go to **Delivery Challan** page
2. Find Challan 004
3. Click the **Edit** (✏️) button
4. Check if the "Items" section is empty
5. If empty, add items:
   - Click **"+ Add Item"**
   - Select Product
   - Select Batch
   - Enter Quantity
   - Click **Save**

#### Cause 2: Database Query Issue ✅ FIXED!

The challan exists but items weren't loading due to wrong database column name.

**What was wrong**:
- Code was using `challan_id`
- Database column is actually `delivery_challan_id`
- This caused items to never load when viewing/editing challans

**✅ FIXED IN CODE**:
The system now correctly uses `delivery_challan_id` in all queries. Your Challan 004 should now show all items properly!

**Test the fix**:
1. Refresh your browser (Ctrl+F5 or Cmd+Shift+R)
2. Go to **Delivery Challan** page
3. Click **View** (👁️) on Challan 004
4. Items should now appear!
5. Try **Edit** (✏️) - items should be editable

---

## Summary of Fixes

### ✅ Delivery Challan Issue - FIXED AUTOMATICALLY
The database column name mismatch has been corrected in the code. After refreshing your browser, Challan 004 and all other challans will display and update correctly.

**What was fixed**:
- ✅ Loading challan items now uses correct column name
- ✅ Editing challan items now saves correctly
- ✅ Creating new challans works properly
- ✅ All delivery challans will show their items

### ⚙️ Gmail OAuth Issue - NEEDS YOUR ACTION

You need to add the redirect URI to Google Cloud Console (5-minute fix):

**Quick Steps**:
1. Go to: https://console.cloud.google.com/apis/credentials
2. Click your OAuth client ID
3. Add these URIs to "Authorized redirect URIs":
   - `http://localhost:5173/auth/gmail/callback` (for development)
   - `https://your-domain.com/auth/gmail/callback` (for production)
4. Click SAVE
5. Wait 5 minutes
6. Try connecting Gmail again from Settings → Gmail

---

## Need More Help?

### Delivery Challan Issues
If Challan 004 still appears blank after refreshing:

1. **Check if items exist**:
   - Click Edit on Challan 004
   - Look at the Items section
   - If empty, manually add items

2. **Clear browser cache**:
   - Press Ctrl+Shift+Delete (Windows) or Cmd+Shift+Delete (Mac)
   - Select "Cached images and files"
   - Click Clear data
   - Reload the page

3. **Check browser console**:
   - Press F12 to open Developer Tools
   - Click "Console" tab
   - Look for any red error messages
   - Share those errors for further help

### Gmail OAuth Issues
If still getting redirect_uri_mismatch after adding URIs:

1. **Double-check the URI**:
   - Must match EXACTLY (no extra spaces, slashes, or characters)
   - Include the protocol (`http://` or `https://`)
   - Match the port number (`:5173` for local dev)

2. **Wait longer**:
   - Google can take up to 10 minutes to propagate changes
   - Try again after 10 minutes

3. **Check you're editing the right OAuth client**:
   - The Client ID should match your `VITE_GOOGLE_CLIENT_ID` in `.env`
   - You might have multiple OAuth clients - make sure you edit the correct one

4. **Create a new OAuth client** (if nothing works):
   - Create a brand new OAuth 2.0 Client ID
   - Set up redirect URIs correctly from the start
   - Update your `.env` file with the new Client ID
   - Restart your dev server

---

## Technical Details (For Developers)

### Delivery Challan Bug Fix

**Files Changed**:
- `/src/pages/DeliveryChallan.tsx`

**Changes Made**:
1. Line 323: Changed `.eq('challan_id', challanId)` → `.eq('delivery_challan_id', challanId)`
2. Line 617: Changed `.eq('challan_id', editingChallan.id)` → `.eq('delivery_challan_id', editingChallan.id)`
3. Line 686: Changed `challan_id: challanId` → `delivery_challan_id: challanId`

**Why this happened**:
The database migration used `delivery_challan_id` as the foreign key column name (to avoid ambiguity with the challan's own `id` field), but the TypeScript code was using the shorter `challan_id`, causing the queries to fail silently.

### Gmail OAuth Configuration

**Environment Variables Required**:
```bash
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

**OAuth Flow**:
1. User clicks "Connect Gmail" in Settings
2. Popup opens to Google OAuth page
3. User authorizes access
4. Google redirects to `${window.location.origin}/auth/gmail/callback`
5. Callback handler exchanges code for tokens
6. Tokens stored encrypted in `gmail_connections` table

**Security Notes**:
- Access tokens expire after 1 hour
- Refresh tokens used to get new access tokens
- All tokens stored encrypted in Supabase
- User's Gmail password never seen by app
