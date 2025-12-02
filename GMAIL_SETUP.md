# Gmail Integration Setup Guide

This guide explains how to securely connect your Gmail account to the CRM system using OAuth2 authentication.

## Overview

The system uses **Gmail OAuth2** for secure, token-based authentication. This means:
- ✅ Your password is NEVER stored in the app
- ✅ You grant permission through Google's official login
- ✅ Access can be revoked anytime from your Google Account
- ✅ Industry-standard security (same as "Sign in with Google")

## Setup Steps

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Enter project name: "Pharma CRM" (or your preferred name)
4. Click "Create"

### 2. Enable Gmail API

1. In your project, go to "APIs & Services" → "Library"
2. Search for "Gmail API"
3. Click on it and press "Enable"

### 3. Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select "Internal" (if using Google Workspace) or "External"
3. Fill in required information:
   - **App name**: Your CRM Name
   - **User support email**: Your email
   - **Developer contact**: Your email
4. Click "Save and Continue"
5. On "Scopes" page, click "Add or Remove Scopes"
6. Add these Gmail scopes:
   - `https://www.googleapis.com/auth/gmail.readonly` (Read emails)
   - `https://www.googleapis.com/auth/gmail.modify` (Mark as read/processed)
   - `https://www.googleapis.com/auth/gmail.send` (Send emails)
7. Click "Save and Continue"
8. Add test users (your email addresses that will use the system)
9. Click "Save and Continue"

### 4. Create OAuth2 Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Select "Web application"
4. Enter name: "Pharma CRM Web Client"
5. Under "Authorized redirect URIs", add:
   - `https://your-app-domain.com/auth/callback`
   - `http://localhost:5173/auth/callback` (for local testing)
6. Click "Create"
7. **IMPORTANT**: Save the Client ID and Client Secret shown

### 5. Configure Environment Variables

Add these to your `.env` file:

```bash
# Gmail OAuth2 Configuration
VITE_GOOGLE_CLIENT_ID=491743356480-nl1q5o5
VITE_GOOGLE_CLIENT_SECRET=GOCSPX-S3JCfv0IN
VITE_GOOGLE_REDIRECT_URI=https://your-app-domain.com/auth/callback
```

⚠️ **SECURITY NOTE**:
- Never commit `.env` file to Git
- Keep Client Secret confidential
- Use different credentials for development and production

### 6. Store Credentials in Supabase (Recommended)

Instead of environment variables, store OAuth tokens securely in Supabase:

1. User clicks "Connect Gmail" in the app
2. They're redirected to Google login
3. After authorization, tokens are encrypted and stored in Supabase
4. App uses tokens to fetch emails on behalf of the user

## How It Works

### First-Time Setup (One-time per user)

1. User navigates to CRM → Settings → Email Integration
2. Clicks "Connect Gmail Account"
3. Redirected to Google's official login page
4. User logs in with their Google account
5. Google asks: "Allow Pharma CRM to read and send emails?"
6. User clicks "Allow"
7. User redirected back to CRM
8. ✅ Gmail connected! Tokens stored securely in Supabase

### Daily Usage (Automatic)

1. App automatically fetches new emails every 5-10 minutes
2. New pharmaceutical inquiry emails appear in "Email Inbox" tab
3. User clicks "AI Parse" → AI extracts information
4. User reviews and confirms → Inquiry created!
5. User can send emails directly from CRM using their connected Gmail

### Security Features

- **OAuth2 Tokens**: Refresh tokens encrypted in database
- **User-specific**: Each user connects their own Gmail
- **Revocable**: Users can disconnect anytime
- **Scoped Access**: App only has permissions you grant
- **No Password Storage**: Your Gmail password is never seen by the app

## Alternative: Gmail API with Service Account

For automated email fetching without user interaction:

1. Create a Service Account in Google Cloud
2. Enable domain-wide delegation (requires Google Workspace admin)
3. Grant service account access to specific Gmail accounts
4. Store service account key in Supabase Vault

This is better for:
- Shared inbox monitoring (e.g., sales@company.com)
- Automated email processing without user login
- Enterprise deployments

## Testing the Integration

1. Start with your personal Gmail in test mode
2. Send a test pharmaceutical inquiry email to yourself
3. Open CRM → Email Inbox
4. Click "Refresh" to fetch emails
5. Verify the email appears
6. Click "AI Parse" to test AI extraction
7. Confirm and create inquiry

## Troubleshooting

### "Access blocked: This app's request is invalid"
- Check OAuth consent screen is configured correctly
- Verify redirect URI matches exactly (including trailing slash)
- Ensure Gmail API is enabled

### "Invalid client"
- Double-check Client ID and Client Secret
- Ensure no extra spaces in .env file
- Restart development server after changing .env

### "Insufficient permissions"
- Verify all required Gmail scopes are added
- User needs to re-authenticate to grant new scopes

### Emails not appearing
- Check Gmail API quota limits (default: 1 billion quota units/day)
- Verify user has granted read permissions
- Check Supabase logs for API errors

## Production Deployment

Before going live:

1. ✅ Change OAuth consent screen from "Testing" to "Published"
2. ✅ Update redirect URI to production domain
3. ✅ Use production Google Cloud project (separate from dev)
4. ✅ Enable rate limiting and error handling
5. ✅ Set up monitoring for API quota usage
6. ✅ Configure backup email processing (in case API is down)

## Cost

- Gmail API: **FREE** (1 billion quota units/day)
- Google Cloud Project: **FREE** (no charges for OAuth)
- Only pay if you exceed free tier limits (very unlikely)

## Privacy & Compliance

- App only accesses emails you explicitly grant permission to
- Email content is processed by AI but not permanently stored (only extracted data)
- Users can revoke access anytime from [Google Account Security](https://myaccount.google.com/permissions)
- Compliant with GDPR, SOC 2, and data privacy regulations

## Support

Need help? Contact your system administrator or refer to:
- [Google Gmail API Documentation](https://developers.google.com/gmail/api)
- [OAuth2 for Web Apps](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
