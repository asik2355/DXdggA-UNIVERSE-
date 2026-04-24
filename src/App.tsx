import React, { useEffect, useState } from 'react';
import { Activity, ShieldCheck, AlertCircle, RefreshCw, MessageSquare, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface StatusData {
  status: string;
  logs: string[];
  lastSeen: string | null;
}

export default function App() {
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [testing, setTesting] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to fetch status', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await fetch('/api/restart', { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      console.error('Failed to restart', err);
    } finally {
      setRestarting(false);
    }
  };

  const handleTestTelegram = async () => {
    setTesting(true);
    try {
      await fetch('/api/test-telegram', { method: 'POST' });
    } catch (err) {
      console.error('Failed to test telegram', err);
    } finally {
      setTesting(false);
      setTimeout(fetchStatus, 1000);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <RefreshCw className="animate-spin text-blue-500 w-8 h-8" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-6 sm:p-10">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
              Grand Panel Forwarder
            </h1>
            <p className="text-slate-500 mt-1">Automatic OTP & Ticket Forwarding to Telegram</p>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={handleTestTelegram}
              disabled={testing}
              className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-4 py-2 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50 text-emerald-400"
            >
              <Activity className={`w-4 h-4 ${testing ? 'animate-pulse' : ''}`} />
              {testing ? 'Testing...' : 'Test Telegram'}
            </button>
            <button 
              onClick={handleRestart}
              disabled={restarting}
              className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-4 py-2 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${restarting ? 'animate-spin' : ''}`} />
              {restarting ? 'Restart' : 'Restart bot'}
            </button>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl"
          >
            <div className="flex items-center gap-3 text-slate-400 mb-2">
              <Activity className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider font-semibold">Status</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${data?.status.includes('Error') ? 'bg-red-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`} />
              <span className="text-xl font-medium">{data?.status}</span>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl"
          >
            <div className="flex items-center gap-3 text-slate-400 mb-2">
              <MessageSquare className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider font-semibold">Last Msg ID</span>
            </div>
            <span className="text-xl font-medium truncate block" title={data?.lastSeen || ''}>
              {data?.lastSeen ? data.lastSeen.substring(0, 15) + '...' : 'None yet'}
            </span>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl"
          >
            <div className="flex items-center gap-3 text-slate-400 mb-2">
              <ShieldCheck className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider font-semibold">Security</span>
            </div>
            <span className="text-xl font-medium">Encrypted Session</span>
          </motion.div>
        </div>

        {/* Logs Section */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-2xl overflow-hidden flex flex-col h-[500px]">
          <div className="p-4 border-b border-slate-800 flex items-center gap-2 bg-slate-900">
            <Terminal className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-semibold uppercase tracking-wider">System Logs</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-2">
            <AnimatePresence initial={false}>
              {data?.logs.map((log, index) => (
                <motion.div 
                  key={log + index}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`${log.includes('Error') ? 'text-red-400' : log.includes('successful') ? 'text-emerald-400' : 'text-slate-400'}`}
                >
                  {log}
                </motion.div>
              ))}
            </AnimatePresence>
            {data?.logs.length === 0 && (
              <div className="text-slate-500 italic">Waiting for activity...</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="text-center text-slate-600 text-xs">
          <p>© 2026 Grand Panel Forwarder Service</p>
          <p className="mt-1">Polling Interval: 30 seconds</p>
        </footer>
      </div>
    </div>
  );
}
