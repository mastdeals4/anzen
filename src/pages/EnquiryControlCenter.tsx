import React from 'react';
import { Layout } from '../components/Layout';
import { useAuth } from '../contexts/AuthContext';
import { EnquiryControlCenter as EnquiryControlCenterComponent } from '../components/crm/enquiry-control-center';

export const EnquiryControlCenter: React.FC = () => {
  const { profile } = useAuth();
  const canManage = profile?.role === 'admin' || profile?.role === 'sales';

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-4 max-w-[1700px] mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-gray-200 pb-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">Enquiry Control Center</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              High-density operational work table for daily inquiry tracking, request resolution, and owner follow-up.
            </p>
          </div>
        </div>
        <EnquiryControlCenterComponent canManage={canManage} />
      </div>
    </Layout>
  );
};

export default EnquiryControlCenter;
