import React, { useState } from 'react';
import { X, Sparkles, ArrowRight, User, Mail } from 'lucide-react';
import { useApp } from '../../state/AppContext';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SignInModal: React.FC<SignInModalProps> = ({ isOpen, onClose }) => {
  const { signIn } = useApp();
  const [name, setName] = useState('Rahul T');
  const [email, setEmail] = useState('kat2000rik@gmail.com');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() || email.trim()) {
      signIn(name.trim() || 'User', email.trim() || 'user@example.com');
      onClose();
    }
  };

  const handleQuickSignIn = (quickName: string, quickEmail: string) => {
    signIn(quickName, quickEmail);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 select-none animate-in fade-in duration-200">
      <div className="w-full max-w-sm bg-[#1b1b20] border border-[#2d2d36] rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-[#302e3b] flex items-center justify-center text-white">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <span className="text-sm font-semibold text-neutral-100">Sign in to MedioBot</span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white p-1 rounded-md hover:bg-[#26262e] transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-5 pt-2 space-y-4">
          <p className="text-xs text-neutral-400 leading-relaxed">
            Enter your details to sync conversations, workspace settings, and personalized agents.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-neutral-300 mb-1">
                Your Name
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Rahul T"
                  required
                  className="w-full bg-[#141418] border border-[#2e2e38] focus:border-neutral-300 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-neutral-500 outline-none transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-neutral-300 mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@domain.com"
                  required
                  className="w-full bg-[#141418] border border-[#2e2e38] focus:border-neutral-300 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-neutral-500 outline-none transition-colors"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-white text-black hover:bg-neutral-200 font-semibold text-xs rounded-xl transition-all shadow-md cursor-pointer active:scale-98"
          >
            <span>Sign In</span>
            <ArrowRight className="w-3.5 h-3.5 stroke-[2.5]" />
          </button>

          {/* Quick Sign-In Preset */}
          <div className="pt-2 border-t border-[#26262e]">
            <button
              type="button"
              onClick={() => handleQuickSignIn('Rahul T', 'kat2000rik@gmail.com')}
              className="w-full py-2.5 px-3 bg-[#24232c] hover:bg-[#32313a] border border-[#33323e] rounded-xl text-neutral-300 hover:text-white text-xs flex items-center justify-between transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-full bg-[#494857] text-[10px] font-bold text-white flex items-center justify-center shrink-0">
                  RT
                </div>
                <span className="truncate">Continue as Rahul T</span>
              </div>
              <span className="text-[10px] text-neutral-400 font-mono">kat2000rik</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
