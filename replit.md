# Pharma Trading Management System

## Overview
This is a comprehensive internal web application for managing a Pharma Raw Material Trading business. Built with React, TypeScript, and Vite on the frontend, and powered by Supabase (PostgreSQL) for the backend.

## Project Structure

### Frontend Application
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite 5.4
- **Styling**: Tailwind CSS
- **Icons**: Lucide React
- **PDF Export**: jsPDF and html2canvas

### Backend & Database
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth with role-based access
- **Storage**: Supabase Storage (for file attachments)

## Key Features

### Implemented Modules
1. **Dashboard**: Real-time statistics, low stock alerts, near-expiry warnings, sales metrics
2. **Products Master**: Product management with HSN codes, categories, units, packaging
3. **Customers**: Complete customer management with NPWP tracking, payment terms
4. **CRM**: Lead pipeline and activity tracking
5. **Sales**: Invoice generation with PDF export
6. **Finance**: Full accounting system with:
   - Expenses tracking
   - Bank accounts management
   - Accounts Receivable & Payable
   - Ageing reports
   - **Chart of Accounts** (Indonesian GAAP)
   - **Suppliers** with NPWP/PKP status
   - **Purchase Invoices** linked to import batches
   - **Receipt Vouchers** (customer payments)
   - **Payment Vouchers** (supplier payments with PPh)
   - **Petty Cash** - Simple Dr/Cr system (withdraw from bank, record expenses)
   - **Journal Entries** (double-entry ledger)
   - **Financial Reports** (Trial Balance, P&L, Balance Sheet)
7. **Batches**: Import tracking with cost breakdown
8. **Inventory**: Real-time stock tracking with alerts
9. **Delivery Challan**: Delivery note management
10. **Settings**: Company profile and system configuration

### Indonesian Tax Compliance
- **PPN (VAT)**: 11% on taxable supplies
- **PPh 21**: Employee income tax
- **PPh 22**: Import tax (2.5%)
- **PPh 23**: Service withholding (2%, 15%)
- **Faktur Pajak**: Tax invoice numbering support
- **NPWP**: Tax ID tracking for customers and suppliers
- **PKP Status**: VAT-registered status tracking

### User Roles
- **Admin**: Full system access
- **Accounts**: Finance, invoices, customers
- **Sales**: CRM, customers, products
- **Warehouse**: Inventory, batches, products

## Database Setup

The application requires a Supabase project with migrations applied. See `supabase/migrations/` for the complete schema.

### Test Users (After Setup)
- admin@pharma.com / admin123 (Admin)
- accounts@pharma.com / accounts123 (Accounts)
- sales@pharma.com / sales123 (Sales)
- warehouse@pharma.com / warehouse123 (Warehouse)

See `SETUP.md` for detailed database setup instructions.

## Configuration

### Environment Variables
The application uses Replit Secrets for configuration:
- `VITE_SUPABASE_URL`: Your Supabase project URL
- `VITE_SUPABASE_ANON_KEY`: Your Supabase anonymous key

### Development Server
- Host: 0.0.0.0
- Port: 5000
- HMR: Configured for Replit proxy

## Development

### Running Locally
```bash
npm install
npm run dev
```

### Building for Production
```bash
npm run build
```

### Type Checking
```bash
npm run typecheck
```

## Security Features
- Row Level Security (RLS) enabled on all tables
- Role-based access policies
- Audit logging for sensitive operations
- Secure authentication flow
- File upload policies

## Language Support
- English (en) - Default
- Bahasa Indonesia (id) - Complete translation

Toggle between languages using the globe icon in the header.

## Architecture Notes

### Database Schema
- 15+ tables with comprehensive relationships
- Optimized indexes for performance
- Foreign key constraints with cascading deletes
- Automatic timestamp tracking

### Frontend Architecture
- Context-based state management (AuthContext, LanguageContext, NavigationContext)
- Component-based architecture
- Modal-based forms for data entry
- Responsive design for all screen sizes

## Recent Changes
- 2025-12-16: **Enhanced Petty Cash with Detailed Tracking**:
  - Enhanced form with two modes: "Add Funds" (income) and "Add Expense"
  - Add Funds: Amount, Date, Source dropdown, Received By (staff), Bank Account
  - Add Expense: Amount, Date, Paid To, Paid By (staff), Description, Category
  - File attachments: Proof, Bill/Invoice, Material Photo (stored in Supabase Storage)
  - Receivables: Prominent "Record Payment" button with instructional banner
  - Auto-refresh every 30 seconds on Finance modules
- 2025-12-16: **Petty Cash Simplified & Real-time Updates**:
  - Petty Cash redesigned as simple Dr/Cr system (withdraw from bank, record expenses)
  - Receivables now has "Record Payment" button with invoice allocation
  - Auto-refresh every 30 seconds on Finance modules
  - Finance module sidebar auto-collapses like CRM/Command Center
- 2025-12-16: **Professional Finance UI Restructured**:
  - 4 grouped sections: Record Transaction, Track, Reports, Masters
  - Compact sidebar navigation within each section
  - **Bank Reconciliation** with Excel/CSV upload and auto-matching (Tally-style)
  - Instructional empty states for all modules
  - Cleaner, more professional layout
- 2025-12-16: **Complete Indonesian Accounting System** implemented:
  - Chart of Accounts (Indonesian GAAP structure)
  - Tax codes: PPN 11%, PPh 21/22/23
  - Suppliers management with NPWP/PKP tracking
  - Purchase Invoices linked to batches
  - Receipt Vouchers (customer payments) with invoice allocation
  - Payment Vouchers (supplier payments) with PPh withholding
  - Petty Cash - Simple Dr/Cr system
  - Journal Entry viewer with double-entry bookkeeping
  - Financial Reports: Trial Balance, P&L, Balance Sheet
  - Auto-posting triggers for all transaction types
- 2025-11-12: Complete database fixes applied - deletion permissions, batch save, stock page, security warnings
- 2025-11-11: Initial Replit setup - configured Vite for port 5000 with proper HMR
- 2025-11-11: Set up environment variables for Supabase connection
- 2025-11-11: Fixed CRM query to correctly show assigned user names
- 2025-11-11: Fixed deletion functionality for Batches and Products

## Database Setup Required

**IMPORTANT:** Before using the application, run this SQL file once in Supabase:

### Quick Setup (One-Time)
1. Open `RUN_THIS_FIX_EVERYTHING.sql` in this Replit
2. Copy ALL the content (Ctrl+A, Ctrl+C)
3. Go to your Supabase Dashboard → SQL Editor
4. Click "+ New query"
5. Paste and click "Run"
6. You should see: ✅ ALL FIXES APPLIED SUCCESSFULLY!

**This fixes:**
- ✅ Admin deletion permissions (batches, products, and related tables)
- ✅ Batch save functionality (trigger function)
- ✅ Stock page display (view recreation)
- ✅ Security warnings (function search paths)

**After running the SQL:**
- Admins can delete batches and products
- Batch save works correctly
- Stock page shows all products
- No security warnings (except optional password protection)

## Documentation Files
- `SETUP.md`: Complete setup guide with database instructions
- `CREATE_USERS.md`: User creation guide
- `RESET_PASSWORD.md`: Password reset instructions
- `QUICK_START.md`: Quick start guide
- `SALES_INVOICE_FIXES.md`: Sales invoice system fixes
