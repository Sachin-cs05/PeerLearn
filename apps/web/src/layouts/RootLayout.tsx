import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header.js';
import { IncomingCallDialog } from '../components/calls/IncomingCallDialog.js';
import { CallModal } from '../components/calls/CallModal.js';

export const RootLayout: React.FC = () => {
  const location = useLocation();
  const isLandingPage = location.pathname === '/';

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground transition-colors duration-150">
      {!isLandingPage && <Header />}
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
      {/* Real-time Call Signaling & Calling UI */}
      <IncomingCallDialog />
      <CallModal />
    </div>
  );
};
