# Pharma Trading Management System - Setup Guide

## Overview
This is a complete internal web application for managing a Pharma Raw Material Trading business. The system includes:

- Product Master Management
- Batch & Inventory Tracking
- Customer Relationship Management (CRM)
- Sales & Invoicing
- Finance Dashboard
- Multi-language Support (English & Bahasa Indonesia)

## Quick Start - Database Setup

Your Supabase database is already configured! Follow these steps to get started:

### Step 1: Create Authentication Users

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project: `dkrtsqienlhpouohmfki`
3. Navigate to **Authentication** → **Users**
4. Click **Add user** (green plus button)

Create these 4 users (one at a time):

| Email | Password | Role | Auto Confirm? |
|-------|----------|------|---------------|
| admin@pharma.com | admin123 | Admin | ✅ Yes |
| accounts@pharma.com | accounts123 | Accounts | ✅ Yes |
| sales@pharma.com | sales123 | Sales | ✅ Yes |
| warehouse@pharma.com | warehouse123 | Warehouse | ✅ Yes |

**Important:** Check "Auto Confirm User" for each user, then **copy the UUID** after creation.

### Step 2: Create User Profiles

After creating each auth user, go to **SQL Editor** and run:

```sql
-- Replace <UUID> with the actual UUID from Step 1

-- Admin User
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('<ADMIN_UUID>', 'admin@pharma.com', 'Admin User', 'admin', 'en', true);

-- Accounts Manager
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('<ACCOUNTS_UUID>', 'accounts@pharma.com', 'Accounts Manager', 'accounts', 'en', true);

-- Sales Representative
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('<SALES_UUID>', 'sales@pharma.com', 'Sales Representative', 'sales', 'en', true);

-- Warehouse Staff
INSERT INTO user_profiles (id, email, full_name, role, language, is_active)
VALUES ('<WAREHOUSE_UUID>', 'warehouse@pharma.com', 'Warehouse Staff', 'warehouse', 'en', true);
```

### Step 3: Load Sample Data

1. In **SQL Editor**, create a new query
2. Copy the entire contents of `supabase/seed.sql`
3. Paste and click **Run**

This will create:
- 18 pharmaceutical products (APIs, excipients, solvents)
- 8 Indonesian customers
- 10 import batches with inventory
- 6 sales invoices
- 6 CRM leads with activities
- Financial transactions and expenses

### Step 4: Login & Start

```bash
npm run dev
```

Open `http://localhost:5173` and login with:
- **Email:** admin@pharma.com
- **Password:** admin123

---

## Test User Accounts

After setup, you can login with any of these accounts:

| Email | Password | Role | Access Level |
|-------|----------|------|--------------|
| admin@pharma.com | admin123 | Admin | Full system access |
| accounts@pharma.com | accounts123 | Accounts | Finance, invoices, customers |
| sales@pharma.com | sales123 | Sales | CRM, customers, products |
| warehouse@pharma.com | warehouse123 | Warehouse | Inventory, batches, products |

## User Roles

The system supports 4 user roles with different permissions:

1. **Admin** - Full access to all modules
2. **Accounts** - Access to Finance, Sales, Invoices, Customers
3. **Sales** - Access to CRM, Customers, Leads, Products
4. **Warehouse** - Access to Inventory, Batches, Products

## Features Implemented

### ✅ Core System
- Supabase authentication with role-based access
- Bilingual interface (English/Indonesian) with toggle
- Responsive design for desktop, tablet, and mobile
- Clean navigation with sidebar and header
- Modal-based forms for data entry

### ✅ Modules

#### Dashboard
- Real-time statistics summary
- Product count and low stock alerts
- Near-expiry batch warnings
- Sales and revenue metrics
- Pending follow-ups counter

#### Products Master
- Add/edit/delete products
- Product code and HSN code management
- Category classification (API, Excipient, Solvent, Other)
- Unit management (kg, litre, ton, piece)
- Packaging type details
- Search and filter functionality

#### Customers
- Complete customer information management
- NPWP (Tax ID) tracking
- Contact person and communication details
- Payment terms configuration
- Address and location data
- Search and filter capabilities

### Database Features
- Complete database schema with 15+ tables
- Row Level Security (RLS) enabled on all tables
- Role-based access policies
- Audit logging for sensitive operations
- Optimized indexes for performance
- Support for file attachments (structure ready)

## Next Steps for Full Implementation

To complete the remaining modules, you can add:

1. **Batch Management** - Import tracking with cost breakdown
2. **Inventory Module** - Real-time stock tracking with alerts
3. **CRM Leads** - Lead pipeline and activity tracking
4. **Sales Invoices** - Invoice generation with PDF export
5. **Finance Dashboard** - P&L statements and expense tracking
6. **Settings** - Company profile and system configuration

## Technology Stack

- **Frontend**: React + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth
- **Icons**: Lucide React

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Run type checking
npm run typecheck

# Run linter
npm run lint
```

## Support

The application is designed to be intuitive and user-friendly:
- Minimal clicks required for common operations
- Clean tables with search and sort capabilities
- Modal forms for quick data entry
- Mobile-responsive design
- Loading states and error handling

## Security Notes

- All tables have Row Level Security enabled
- Users can only access data permitted by their role
- Authentication is required for all operations
- Sensitive operations are logged in audit_logs table
- File uploads will use Supabase Storage with access policies

## Language Support

The application supports:
- **English (en)** - Default language
- **Bahasa Indonesia (id)** - Complete translation

Toggle between languages using the globe icon in the header.
